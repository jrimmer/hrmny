/**
 * Cytale web-push handler — imported into the generated service worker.
 *
 * The build produces its worker with workbox `generateSW`, which emits only
 * precache/routing logic and cannot be extended with build-time code. So the
 * push half lives here and is pulled in with workbox's `importScripts`, which
 * is the supported way to add a handler to a generated worker.
 *
 * Lifetime matters, and it is the opposite of a page's: a service worker is
 * killed between events, so NOTHING may be held in a module-level variable.
 * Every handler re-derives what it needs from the event, the notification's
 * own data, or the client list.
 *
 * `importScripts` in this file would throw at install time, so it deliberately
 * has no dependencies — plain ES5-compatible code, no imports, no bundler
 * helpers.
 */

/* eslint-env serviceworker */

var NOTIFICATION_TAG_PREFIX = 'cytale:';

/**
 * Show a notification and carry the routing target on it.
 *
 * The target rides `data` rather than the tag so a click handler can read it
 * without a lookup, and the TAG is the logical key the server can later use to
 * dismiss the same notification on another device — one notification per
 * conversation rather than a stack of them.
 */
function cytaleShowNotification(payload) {
  var target = payload.target || {};
  var tag = NOTIFICATION_TAG_PREFIX + (target.channel_id || target.channelId || 'generic');

  var options = {
    body: payload.body || '',
    tag: tag,
    renotify: true,
    // The routing target, which the click handler reads back. Deliberately the
    // whole object: a click must land on the exact message, and reconstructing
    // the target from a rendered title is not possible.
    data: { target: target, url: payload.url || null },
  };

  if (payload.icon) options.icon = payload.icon;
  if (payload.badge) options.badge = payload.badge;

  return self.registration.showNotification(payload.title || 'Hrmny', options);
}

self.addEventListener('push', function (event) {
  var payload = {};

  if (event.data) {
    try {
      payload = event.data.json();
    } catch (err) {
      // A push that is not JSON still deserves to reach the member — a
      // malformed body must not be a silent drop, which is the failure this
      // whole feature exists to avoid.
      payload = { title: 'Hrmny', body: event.data.text() };
    }
  }

  event.waitUntil(cytaleShowNotification(payload));
});

/**
 * The in-app address of a notification's message, built from the target ids
 * the server carries on every notification. Grammar (the permalink builder's,
 * mirrored here because a plain importScripts file cannot import app modules
 * — keep the two in lockstep):
 *
 *   #/workspace/{ws}/channel/{ch}[/thread/{t}]/message/{id}   workspace msg
 *   #/channel/{ch}[/thread/{t}]/message/{id}                  DM (no ws)
 *
 * Returned ROOTED ("/#/…"). In a service worker, openWindow() and
 * client.navigate() resolve a relative URL against the WORKER SCRIPT's URL,
 * so a bare "#/…" became "/sw.js#/…" and a notification click opened the
 * worker's own JavaScript (a black page of code) instead of the app.
 */
function cytaleTargetPath(target) {
  if (!target) return '/';
  var ch = target.channel_id || target.channelId;
  var id = target.message_id || target.messageId;
  if (!ch || !id) return '/';
  var t = target.thread_id || target.threadId;
  var mid = (t ? '/thread/' + t : '') + '/message/' + id;
  var ws = target.workspace_id || target.workspaceId;
  return ws
    ? '/#/workspace/' + ws + '/channel/' + ch + mid
    : '/#/channel/' + ch + mid;
}

self.addEventListener('notificationclick', function (event) {
  event.notification.close();

  var data = event.notification.data || {};
  var target = data.target || null;
  var path = cytaleTargetPath(target);

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (clientList) {
        // Prefer the window the member already has — opening a second tab
        // for a message they are arguably already looking at is the
        // behaviour that makes people distrust notification clicks. The
        // focused window is NAVIGATED to the message (the permalink router
        // jumps and flash-focuses the row), and the target also rides
        // postMessage for the app-side listener (belt and braces: a client
        // whose navigate() is unavailable still routes).
        for (var i = 0; i < clientList.length; i += 1) {
          var client = clientList[i];
          if ('focus' in client) {
            client.postMessage({ type: 'cytale:notification-click', target: target });
            var focused = client.focus();
            if (client.navigate) {
              focused = focused
                .then(function () {
                  return client.navigate(path);
                })
                .catch(function () {
                  return undefined;
                });
            }
            return focused;
          }
        }

        // No window on THIS origin: cold-start at the message itself. The
        // app boots, the permalink router jumps to the row, and a session
        // already on this origin carries the login. (A tab on a DIFFERENT
        // origin is invisible to a service worker by design — that half is
        // a canonical-origin decision, not code.)
        if (self.clients.openWindow) {
          return self.clients
            .openWindow(path)
            .then(function (windowClient) {
              if (windowClient && 'postMessage' in windowClient) {
                windowClient.postMessage({
                  type: 'cytale:notification-click',
                  target: target,
                });
              }
              return windowClient;
            })
            .catch(function () {
              return undefined;
            });
        }

        return undefined;
      }),
  );
});

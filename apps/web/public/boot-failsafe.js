/**
 * Boot-cover fail-safe (a file, not inline — same-origin only under the CSP).
 * The cover must never outlive a bundle that failed to execute: if main.tsx
 * never runs (chunk 404, a syntax error, a thrown module-level exception), no
 * application code is left to take the cover down, so this timer does it.
 * When the app IS alive it has already dismissed the cover and this is a
 * no-op.
 *
 * Lane D #4: once the entry module runs, the app OWNS the cover — it keeps it
 * up while a stored session restores and the shell hydrates, which can take
 * longer than this timer on a slow link. The entry therefore pushes the
 * deadline out (`__hrmnyExtendBootFailsafe`) instead of letting this blind
 * timer reveal a half-built page (an empty App renders nothing during
 * restore). The fail-safe itself stays: an app that runs and then hangs is
 * still bounded, just by the app's own, longer deadline.
 */
(function () {
  var timer = 0;
  function reveal() {
    var el = document.getElementById('boot-cover');
    if (!el || el.getAttribute('data-state') === 'ready') return;
    el.setAttribute('data-state', 'ready');
    el.setAttribute('aria-busy', 'false');
    window.setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 200);
  }
  function arm(ms) {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(reveal, ms);
  }
  window.__hrmnyRevealBootCover = reveal;
  window.__hrmnyExtendBootFailsafe = arm;
  arm(4000);
})();

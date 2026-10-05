/**
 * Theme + style before the first paint (loaded as a file, not inline: the
 * endpoint's CSP allows only same-origin scripts). #151 extends the dark
 * boot to BOTH axes: data-theme (mode) and data-style (harmony | pixel —
 * pixel being the fully implemented Starbase theme) resolve on the very
 * first frame, so neither axis can flash. prefs.ts performs the same
 * resolution after the bundle loads; this file must stay in lockstep with
 * it (keys, defaults, prefers-color-scheme).
 */
(function () {
  var doc = document.documentElement;
  var theme = 'dark';
  var style = 'harmony';
  try {
    var t = localStorage.getItem('cytale.theme');
    if (t === 'dark' || t === 'light') theme = t;
    else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      theme = 'light';
    }
    var s = localStorage.getItem('cytale.style');
    if (s === 'harmony' || s === 'pixel') style = s;
  } catch (e) {
    /* storage unavailable — defaults stand */
  }
  doc.setAttribute('data-theme', theme);
  doc.setAttribute('data-style', style);
})();

/**
 * Name the shell before first paint: the Tauri webview gets
 * data-shell="desktop", which flips the boot cover's logo to the BLACK-plate
 * variant (its first frame is not guaranteed dark — the transparent H would
 * float on an unknown ground). Tauri injects its internals bundle ahead of
 * page scripts, so the flag is set before the cover's markup parses.
 */
if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
  document.documentElement.setAttribute('data-shell', 'desktop');
}

// Theme boot. The real theme lives in the server's settings table, which the
// store only reads AFTER the first paint, so without this the app starts light
// on every reload. That is not merely a flash: `VisualBlock` bakes the
// light/dark palette into an AI visual's SVG at render time, so a chart that
// rendered during that window stayed dark-on-dark until it was remounted. The
// store mirrors the resolved theme + accent here on every change; this replays
// it synchronously before anything renders. Server settings remain the source
// of truth and overwrite this cache a moment later.
//
// A file, not an inline <script> in index.html: a script-src policy without
// 'unsafe-inline' runs only scripts the app serves, and this one has to run
// before the first paint, so it is a plain (classic, blocking) script in the
// head. It is served from `public/` unhashed, with `no-cache` like index.html,
// so a new build's copy is picked up on the next load.
(function () {
    try {
        var cached = localStorage.getItem('terramentor-theme');
        if (!cached) return;
        var t = JSON.parse(cached);
        var root = document.documentElement;
        if (t.theme) {
            root.classList.toggle('dark', t.theme === 'dark');
            root.setAttribute('data-theme', t.theme);
        }
        // The surfaces themselves. The theme is no longer four named
        // blocks in a stylesheet — it is twelve variables generated
        // from the mode and a tint (`src/utils/themeRamp.ts`), and this
        // script runs before any module is parsed, so it cannot call
        // the generator. The store caches the COMPUTED values here for
        // exactly that reason; without them the first paint is the
        // untinted ramp and the whole app re-colours a frame later.
        if (t.themeVars) {
            for (var name in t.themeVars) {
                if (name.indexOf('--c-') === 0) root.style.setProperty(name, t.themeVars[name]);
            }
        }
        // UI scale is on the root font size, so it must land before the
        // first paint too: applied afterwards it re-lays out the whole
        // app in front of the user on every load.
        if (t.uiScale) root.style.fontSize = ((16 * t.uiScale) / 100) + 'px';
        if (t.accentRgb) root.style.setProperty('--accent-rgb', t.accentRgb);
        if (t.accentFgRgb) root.style.setProperty('--accent-fg-rgb', t.accentFgRgb);
        // The phone's status bar / URL bar is painted from this, and it
        // was a fixed teal — so on three of the four themes the strip
        // above the app was a colour the app does not use anywhere. It
        // has to match the HEADER (the surface directly under it), not
        // the accent and not the canvas. Cached beside the variables
        // now, rather than looked up in a table of theme names that a
        // tint would have made wrong.
        var surface = t.themeSurface;
        var meta = document.querySelector('meta[name="theme-color"]');
        if (surface && meta) meta.setAttribute('content', surface);
        // The icon is a setting too (Settings → General → App icon), and
        // the tab paints long before the store has read it: without this
        // line every load shows the shipped mark and then swaps to the
        // chosen one. Same cache, same reasoning as the theme above;
        // `src/utils/appIcon.ts` writes the value and owns the real tags.
        var ic = document.querySelector('link[rel="icon"][type="image/svg+xml"]');
        if (t.iconHref && ic) ic.setAttribute('href', t.iconHref);
    } catch (e) { /* private mode / corrupt cache — fall back to defaults */ }
})();

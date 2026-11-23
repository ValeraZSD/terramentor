// Language boot. The interface language is applied once its locale file has
// loaded (`src/i18n/index.ts`), and the first render waits for it, so while the
// page loads the root is empty and the only language the page states is
// index.html's `lang`. A browser decides there whether to offer a translation:
// with `lang="en"` Edge offered to translate a Russian welcome screen "from
// English". This sets `lang` to the language the app is about to show, before
// anything loads, by the same rule `detectLanguage` uses: the language this
// device showed last, else the first of the browser's languages the app has,
// else English. `src/i18n/index.ts` still sets it again, and owns it after.
//
// A file, not an inline <script>, for the reason theme-boot.js gives: the
// script-src policy runs only scripts the app serves. The list below must name
// the same codes as LANGUAGES in src/i18n/index.ts (tools/i18n-gates.mjs).
// It sets `dir` too: the splash and the first frame of an Arabic interface are
// laid out right to left from the start, not flipped once React mounts.
(function () {
    var SUPPORTED = ['en', 'ar', 'de', 'es', 'fr', 'it', 'ja', 'nl', 'pl', 'pt', 'ru', 'tr', 'uk', 'zh'];
    var RTL = ['ar'];
    try {
        var pick = null;
        var cached = null;
        try { cached = localStorage.getItem('terramentor-lang'); } catch (e) { /* private mode */ }
        if (cached && cached !== 'auto' && SUPPORTED.indexOf(cached) >= 0) pick = cached;
        if (!pick) {
            var tags = navigator.languages || [navigator.language];
            for (var i = 0; i < tags.length && !pick; i++) {
                var base = String(tags[i] || '').toLowerCase().split(/[-_]/)[0];
                if (SUPPORTED.indexOf(base) >= 0) pick = base;
            }
        }
        document.documentElement.lang = pick || 'en';
        document.documentElement.dir = RTL.indexOf(pick) >= 0 ? 'rtl' : 'ltr';
    } catch (e) { /* keep index.html's lang */ }
})();

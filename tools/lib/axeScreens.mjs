// The parts of tools/axe-gates.mjs that need no browser, so a plain gate can
// hold them: when a screen counts as drawn, and how --accept may move the
// allowlist.

/**
 * What each scanned screen draws once its data has arrived, as a page-side
 * expression. A screen is scanned only after it is true: a loading skeleton
 * or an error page has few controls, and scanned in its place it reads as a
 * clean screen. Keyed by screen name; a `settings-*` screen uses `settings`.
 */
export const READY = {
    home: `document.querySelector('main [aria-label^="Open "]')`,
    projects: `document.querySelector('[data-card-grid] h3')`,
    // The window opens on its two choices; the form is one press further.
    'new-course': `document.querySelector('[role="dialog"] [data-tile]')`,
    'new-course-form': `document.querySelector('[role="dialog"] input, [role="dialog"] textarea')`,
    'course-dashboard': `document.querySelector('main [data-band]')`,
    outline: `document.querySelector('main [data-category-id]')`,
    topic: `document.querySelector('[aria-label="Close detail panel"]')`,
    // The pressed tab wears the accent underline at once; its two lists stand
    // in their sections only once both have been read (a spinner until then).
    'topic-questions': `document.querySelector('[data-tab="questions"].border-accent') && document.querySelector('[data-section="questions"]') && document.querySelector('[data-section="cards"]')`,
    lesson: `document.querySelector('main h1') && document.querySelector('main .prose :is(h2, h3, p)')`,
    vault: `document.body.innerText.includes('Drop files or click to upload')`,
    // A phone keeps the region list in a closed sheet: the count line is drawn
    // on both, and reads all zeros until the library has arrived.
    atlas: `document.querySelector('[role="application"]') && /[1-9]/.test((document.body.innerText.match(/\\d+ proven · \\d+ in progress · \\d+ not started/) || [''])[0])`,
    'card-front': `document.querySelector('[data-review-card]')`,
    'card-answer': `document.querySelector('[data-review-card]') && document.querySelector('[role="group"]:not([aria-hidden="true"]) [data-rating]')`,
    assistant: `document.querySelector('aside[aria-label="Assistant"] textarea')`,
    // A section's own controls; a phone's settings home is the list of sections.
    settings: `document.querySelector('[data-settings-root] .min-w-0 :is(input, select, textarea, button)') || document.querySelector('[data-settings-root] nav ul [data-section]')`,
};

/** The readiness expression for a screen, or undefined when it has none. */
export function readyFor(screen) {
    return READY[screen] ?? (screen.startsWith('settings-') ? READY.settings : undefined);
}

/** Text an error boundary draws: a screen showing it is broken, not clean. */
export const BROKEN = `/Something went wrong|An unexpected error occurred/.test(document.body.innerText)`;

/**
 * The allowlist --accept writes from what the screens show now (`counts`:
 * screen → rule → failing elements). It only ever LOWERS a number: one that
 * would rise is refused, whatever the list held before (an empty list is
 * the strictest, not a blank cheque). `bootstrap` writes rises too, for
 * starting a list by hand; the commit then says why.
 */
export function acceptAllowlist(allowed, counts, { bootstrap = false } = {}) {
    const raised = [];
    const next = { ...allowed };
    for (const [state, now] of Object.entries(counts)) {
        const before = allowed[state] ?? {};
        for (const [rule, n] of Object.entries(now)) if (n > (before[rule] ?? 0)) raised.push(`${state} ${rule}: ${before[rule] ?? 0} -> ${n}`);
        if (Object.keys(now).length) next[state] = Object.fromEntries(Object.entries(now).sort());
        else delete next[state];
    }
    if (raised.length && !bootstrap) return { refused: raised };
    return { allowed: Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b))), raised };
}

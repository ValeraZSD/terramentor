// tools/review-queue-gates.mjs — the session queue, driven as a real React hook.
//
// Run:  node tools/review-queue-gates.mjs
//
// Why this exists: `useReviewQueue` is the layer that decides whether a card
// comes back. Every other layer of the (re)learning ladder can be right — FSRS
// schedules ten minutes, the scheduler writes the timestamp, the endpoint
// stores it — and the learner still never sees the card again in that session,
// because the queue marked it done. That failure is silent in exactly the way
// scheduling bugs are: nothing throws, the summary screen reads correctly, and
// the repetition the feature exists to produce simply does not happen.
//
// It is also where undo lives, and undo is the part that must not be
// "mostly right": a card can now be rated several times in one session, so a
// step back has to put back the ladder position as well as the cursor.
//
// The hook is mounted for real (jsdom + react-dom/client + React.act) against
// the shipped TypeScript, bundled with esbuild — the same trick as the atlas
// label gates. No component, no styling, no server: a probe that exposes the
// queue object and nothing else, so what is asserted here is the hook.

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

// The bundle is written INSIDE the project, not into the OS temp directory,
// because `react` is left external below: Node resolves a bare specifier from
// the importing file's location, and a module sitting in %TEMP% has no
// node_modules above it. `node_modules/.cache` is already ignored by git.
const cache = join(fileURLToPath(new URL('../node_modules/.cache', import.meta.url)));
mkdirSync(cache, { recursive: true });
const scratch = mkdtempSync(join(cache, 'queue-gates-'));
const out = join(scratch, 'queue.mjs');

await esbuild.build({
    // fileURLToPath, never `.pathname` — this repo's path contains a space,
    // which stays percent-encoded in a URL and esbuild cannot resolve it.
    entryPoints: [fileURLToPath(new URL('../src/hooks/useReviewQueue.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    // React is a peer here, not something to inline: the probe below must use
    // the SAME React instance as the hook or the hooks dispatcher is null.
    external: ['react'],
    logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// `navigator` is a getter-only global on modern Node, so it is defined rather
// than assigned. react-dom reads it during hydration checks.
Object.defineProperty(globalThis, 'navigator', {
    value: dom.window.navigator, configurable: true, writable: true,
});
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = require('react');
const { createRoot } = require('react-dom/client');
const { useReviewQueue, LEARN_AHEAD_MS } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

/**
 * Mount the real hook and hand back a live handle on it.
 *
 * `latest()` re-reads after every act(), because the queue object is rebuilt on
 * each render and holding on to a stale one is precisely the class of bug the
 * hook's own comments are about.
 */
function mountQueue(total) {
    let current = null;
    const Probe = () => { current = useReviewQueue(total); return null; };
    const host = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(host);
    const root = createRoot(host);
    React.act(() => { root.render(React.createElement(Probe)); });
    return {
        get q() { return current; },
        act: (fn) => { React.act(() => { fn(current); }); },
        unmount: () => { React.act(() => { root.unmount(); }); },
    };
}

const MIN = 60_000;

// ---- the plain path, unchanged ---------------------------------------------
console.log('\n--- a session with nothing on a ladder ---');
{
    const h = mountQueue(3);
    check('starts at the first card', h.q.index === 0 && h.q.reviewedCount === 0);
    check('an empty session is not "complete"', mountQueue(0).q.isComplete === false);
    h.act(q => q.advance());
    check('advance moves on and counts the card', h.q.index === 1 && h.q.reviewedCount === 1);
    check('nothing is pending', h.q.pendingCount === 0);
    h.act(q => q.advance());
    h.act(q => q.advance());
    check('the session completes when every card has graduated',
        h.q.isComplete && h.q.reviewedCount === 3);
    h.unmount();
}

// ---- a card that comes back ------------------------------------------------
console.log('\n--- a card rated Again comes back in the same session ---');
{
    const h = mountQueue(3);
    const soon = Date.now() + 10 * MIN;
    h.act(q => q.advance(soon));
    check('a requeued card is NOT counted as reviewed', h.q.reviewedCount === 0, String(h.q.reviewedCount));
    check('it is on the ladder instead', h.q.pendingCount === 1);
    check('the queue moves to the next unseen card', h.q.index === 1);
    h.act(q => q.advance());
    h.act(q => q.advance());
    check('with cards 1 and 2 done, the ladder card is served again even though '
        + 'its ten minutes are not up', h.q.index === 0, `index ${h.q.index}`);
    check('...and the session is NOT complete while it is outstanding',
        !h.q.isComplete && h.q.reviewedCount === 2 && h.q.pendingCount === 1);
    h.act(q => q.advance());
    check('rating it again without a requeue graduates it and ends the session',
        h.q.isComplete && h.q.reviewedCount === 3 && h.q.pendingCount === 0);
    h.unmount();
}

console.log('\n--- a ladder card whose time HAS come jumps the queue ---');
{
    const h = mountQueue(4);
    // Due in the past: the learner sat on the next card long enough.
    h.act(q => q.advance(Date.now() - 1));
    check('the due ladder card is served immediately, before unseen cards',
        h.q.index === 0, `index ${h.q.index}`);
    h.unmount();
}

console.log('\n--- the earliest-due ladder card goes first ---');
{
    const h = mountQueue(3);
    const now = Date.now();
    h.act(q => q.advance(now + 10 * MIN));   // card 0, due later
    check('moved to card 1', h.q.index === 1);
    h.act(q => q.advance(now + 1 * MIN));    // card 1, due sooner
    check('moved to card 2', h.q.index === 2);
    h.act(q => q.advance());                 // card 2 graduates
    check('nothing unseen is left, so the soonest ladder card is served',
        h.q.index === 1, `index ${h.q.index}`);
    h.unmount();
}

// ---- undo ------------------------------------------------------------------
console.log('\n--- undo puts the ladder back, not just the cursor ---');
{
    const h = mountQueue(3);
    const soon = Date.now() + 10 * MIN;
    h.act(q => q.advance(soon));
    check('one card on the ladder', h.q.pendingCount === 1 && h.q.index === 1);
    h.act(q => q.back());
    check('back returns to the card', h.q.index === 0);
    check('and takes it OFF the ladder — the rating that put it there is undone',
        h.q.pendingCount === 0, `pending ${h.q.pendingCount}`);
    check('the answer is shown again, since this corrects a rating', h.q.flipped === true);
    check('there is nothing further to step back to', h.q.canGoBack === false);
    h.unmount();
}

console.log('\n--- undoing a graduation puts the card back ON the ladder ---');
{
    const h = mountQueue(2);
    const soon = Date.now() - 1;
    h.act(q => q.advance(soon));      // card 0 -> ladder, immediately due
    check('served straight back', h.q.index === 0 && h.q.pendingCount === 1);
    h.act(q => q.advance());          // card 0 graduates
    check('it graduated', h.q.pendingCount === 0 && h.q.reviewedCount === 1);
    h.act(q => q.back());
    check('undo restores the ladder position it had before the graduation',
        h.q.pendingCount === 1 && h.q.reviewedCount === 0,
        `pending ${h.q.pendingCount}, reviewed ${h.q.reviewedCount}`);
    h.unmount();
}

console.log('\n--- undo unwinds several ratings of the SAME card, in order ---');
{
    // The bug this is here for: with the undo record keyed by card index rather
    // than by step, the second rating of a card overwrote the first, and the
    // second undo silently restored nothing.
    const h = mountQueue(2);
    const past = Date.now() - 1;
    h.act(q => q.advance(past));   // step 1: card 0 onto the ladder
    h.act(q => q.advance(past));   // step 2: card 0 again, still on the ladder
    check('two steps recorded for one card', h.q.canGoBack && h.q.index === 0);
    const seen = [];
    h.act(q => seen.push(q.back()));
    h.act(q => seen.push(q.back()));
    check('both steps are walked back, and both name the same card',
        seen.length === 2 && seen[0] === 0 && seen[1] === 0, JSON.stringify(seen));
    check('the card ends up off the ladder, as it was before either rating',
        h.q.pendingCount === 0 && h.q.canGoBack === false);
    h.unmount();
}

console.log('\n--- skip, reset, clearHistory ---');
{
    const h = mountQueue(3);
    h.act(q => q.skip());
    check('a skip settles nothing', h.q.reviewedCount === 0 && h.q.pendingCount === 0);
    check('...but it moves', h.q.index === 1);
    check('...and can be taken back', h.q.canGoBack);
    h.act(q => q.back());
    check('back from a skip returns to the card', h.q.index === 0 && h.q.reviewedCount === 0);

    h.act(q => q.advance(Date.now() + MIN));
    h.act(q => q.clearHistory());
    check('clearHistory removes the way back', h.q.canGoBack === false);
    check('...without disturbing the ladder', h.q.pendingCount === 1);
    h.act(q => q.reset());
    check('reset clears everything, ladder included',
        h.q.index === 0 && h.q.reviewedCount === 0 && h.q.pendingCount === 0 && !h.q.canGoBack);
    h.unmount();
}

console.log('\n--- a single-card session on a ladder does not spin ---');
{
    // One card, rated Again: there is nothing else to serve, so it must be
    // served again straight away rather than the session ending or hanging.
    const h = mountQueue(1);
    h.act(q => q.advance(Date.now() + 10 * MIN));
    check('the only card is served again immediately',
        h.q.index === 0 && !h.q.isComplete, `index ${h.q.index}`);
    h.act(q => q.advance());
    check('and graduating it ends the session', h.q.isComplete);
    h.unmount();
}

// ---- the learn-ahead limit --------------------------------------------------
//
// Anki's rule, from its manual: "cards should be shown early if they have a
// delay of less than 20 minutes and there's nothing else to do", and at 0 it
// "will always wait the full delay, showing the congratulations screen until the
// remaining cards are ready". Ours is the same shape. With the default
// 1m/10m/10m ladder nothing can ever land outside a 20-minute window, so these
// assertions drive it with due times that could only come from a longer ladder —
// which is exactly the case the limit exists for and the only way to see it work.
console.log('\n--- the learn-ahead limit ---');
{
    check('the window is Anki own default of 20 minutes', LEARN_AHEAD_MS === 20 * 60_000, String(LEARN_AHEAD_MS));

    const h = mountQueue(2);
    // Card 0 onto a ladder an hour out — beyond any default step, so the limit bites.
    h.act(q => q.advance(Date.now() + 60 * MIN));
    check('the queue moves on to the unseen card', h.q.index === 1);
    check('not waiting yet: there is still something to show', h.q.waitingUntil === null);
    h.act(q => q.advance());
    check('now every card is dealt with and one is too far out',
        h.q.waitingUntil !== null, `waitingUntil ${h.q.waitingUntil}`);
    check('...which is NOT the same as being complete', !h.q.isComplete);
    check('...and it names the moment, so the screen can count down',
        Math.abs(h.q.waitingUntil - (Date.now() + 60 * MIN)) < 5000);
    check('the card is still owed', h.q.pendingCount === 1 && h.q.reviewedCount === 1);

    // The learner overruling the wait.
    h.act(q => q.serveNow());
    check('serveNow puts the card back on screen', h.q.index === 0);
    check('...and clears the waiting state', h.q.waitingUntil === null);
    h.act(q => q.advance());
    check('rating it then ends the session', h.q.isComplete);
    h.unmount();
}

console.log('\n--- inside the window, nothing waits ---');
{
    const h = mountQueue(2);
    // Ten minutes is the longest our own ladder can produce, and it is inside
    // the window — so this is the ONLY path the shipped configuration takes.
    h.act(q => q.advance(Date.now() + 10 * MIN));
    h.act(q => q.advance());
    check('a card ten minutes out is served early, never waited for',
        h.q.waitingUntil === null && h.q.index === 0,
        `waitingUntil ${h.q.waitingUntil}, index ${h.q.index}`);
    h.unmount();
}

console.log('\n--- back() on an untouched queue is a no-op, not a crash ---');
{
    const h = mountQueue(2);
    let r = 'unset';
    h.act(q => { r = q.back(); });
    check('back returns null with nothing to undo', r === null && h.q.index === 0);
    h.unmount();
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// The task dock, driven the way a finger drives it.
//
// Three things are asserted here, each of them broken in a way no unit could
// see, because each piece was individually correct.
//
//  1. THE ✕ MUST REMOVE THE CHIP, LOCALLY, NOW. Dismiss used to send the DELETE
//     and wait for the server's next task snapshot to bring back a list without
//     it. On a desktop that is one round trip; on a phone it can be a minute,
//     because the OS drops a backgrounded SSE socket without ever raising an
//     error and the reader only finds out when it times out. Reported from a
//     phone as "the ✕ doesn't work — maybe it did in the backend". So the store
//     removes it first and lets the snapshot confirm, and a snapshot that still
//     carries a dismissed task (they are coalesced over 250ms, so one sent just
//     before the DELETE landed still lists it) must not put the chip back.
//
//     "Now" is not "this instant" any more — the chip plays a short exit (the
//     words fade, then it collapses horizontally) and is in the DOM for about a
//     third of a second after the press. What must be true on the PRESS frame is
//     that it has stopped being a control: hidden from the accessibility tree,
//     taking no clicks, unpressable a second time. What must be true after the
//     exit is that it is gone and the server has been told — on the dock's own
//     clock, having never waited for an answer. That is what is asserted below;
//     a dismiss that waits for the server fails it just as it always did.
//
//  1b. A FINISHED CHIP CLEARS ITSELF, and the countdown lives in the DOCK, not
//     in the chip: only the first three chips are mounted, so a timer inside one
//     never fires for anything clipped behind the "+N" pill — it would sit in
//     the list until the server's own (much longer) TTL dropped it and reappear
//     the moment the queue drained. Timed from the server's `finishedAt`, so it
//     is not restarted by a re-sort, a re-mount or the pill being opened.
//
//  2. THE FAILURE DIALOG MUST NOT BE INSIDE THE DOCK. The dock is `fixed` WITH
//     a transform on it, and a transform makes that element the containing
//     block for every fixed descendant — so a dialog rendered in place resolves
//     `inset-0` to the dock's pill rather than to the screen, which is how the
//     reader ended up with the footer buttons on screen and the failure itself
//     off it. The invariant is about the DOM, not about pixels.
//
//  3. EVERY KIND THE SERVER CAN START HAS A NAME. A kind the client does not
//     know still draws a chip — it just draws it as the generic "AI task", so
//     the gap is invisible from either side: the server is right, the dock is
//     right, and the reader is told nothing. `KIND_LABEL` is keyed by the union
//     in `src/types.ts`, so tsc catches a kind added there and never named; but
//     nothing kept that union honest against the SERVER, and `media_describe`,
//     `srs_optimize` and `visual` were unnamed for as long as they existed.
//     So the kinds are read out of the source that creates the tasks, and one
//     chip of each is pushed through the real dock.
//
// No model, no network, no database: `src/api` is stubbed, everything else is
// the real module.
//
// Run:  node tools/dock-harness/run.mjs

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { serverFiles, readServer } from '../lib/serverSource.mjs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    ok ? pass++ : fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true, url: 'http://localhost/',
});
const { window } = dom;
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event',
    'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
    'localStorage', 'sessionStorage']) {
    try { globalThis[k] = window[k]; }
    catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.ResizeObserver = globalThis.ResizeObserver = class { observe() { } unobserve() { } disconnect() { } };
window.matchMedia = window.matchMedia || (q => ({ matches: false, media: q, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } }));
globalThis.fetch = async () => { throw new Error('the harness makes no network calls'); };

// --- the stub network --------------------------------------------------------
// Every call the store makes here is recorded; `dismissTask` can be told to
// fail, which is the "it is still running, you may not dismiss it" answer.
const calls = [];
let dismissFails = false;
globalThis.__api = {
    dismissTask: async (id) => {
        calls.push(['dismiss', id]);
        // Answering on a later tick, as a request does: the point of the
        // assertion after this is that the chip goes BEFORE the answer.
        await new Promise(r => setTimeout(r, 5));
        if (dismissFails) throw new Error('Task is still active — cancel it first');
        return { success: true };
    },
    cancelTask: async (id) => { calls.push(['cancel', id]); return { success: true }; },
    // The record resolves an origin's node id to its title the way the
    // assistant's topic chips do; the task itself carries no title.
    resolveNodeLabels: async (ids) => ids.filter(id => id === 42).map(id => ({
        id, title: 'Doppler Effect for Sound and Light', projectId: 7, projectName: 'Physics', status: 'in_progress', projectStatus: 'active', kind: 'topic',
    })),
    // The task feed, held open: the harness pushes snapshots through the real
    // reader instead of a server, and never ends the stream — which is also
    // what a phone's dropped socket looks like from in here.
    streamTaskList: async (onList) => {
        globalThis.__pushTasks = (list) => act(() => onList(list));
        return new Promise(() => { });
    },
};

const task = (over = {}) => ({
    id: 't1', kind: 'atlas', label: 'Naming 60 regions', status: 'done',
    queuePosition: 0, projectColor: '#4F46E5', createdAt: '2026-09-09T21:12:00.000Z',
    progress: { percent: 100, content: 0, thinking: 0, phase: '', message: '' },
    ...over,
});

await require('esbuild').build({
    entryPoints: [join(here, 'entry.tsx')],
    bundle: true, format: 'cjs', platform: 'browser', jsx: 'automatic',
    outfile: join(here, 'bundle.cjs'), logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{
        name: 'api-stub',
        setup(build) {
            // The store's own `./api` — the only thing that would leave the
            // process. Everything else (the store, the dock, i18n) is real.
            // `../api` too: the record's title lookup (hooks/useOriginTitle)
            // reaches it from one directory down.
            build.onResolve({ filter: /^\.\.?\/api$/ }, () => ({ path: 'api-stub', namespace: 'stub' }));
            build.onLoad({ filter: /^api-stub$/, namespace: 'stub' }, () => ({
                contents: `export const api = new Proxy({}, {
                    get: (_t, k) => (globalThis.__api[k] || (async () => { throw new Error('no stub for api.' + String(k)); })),
                });`,
                loader: 'js',
            }));
        },
    }],
});

require('./bundle.cjs');
const act = globalThis.__act;
const store = globalThis.__store;
const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 25)); }); };

globalThis.__mount(window.document.getElementById('root'));

const $$ = (sel) => [...window.document.querySelectorAll(sel)];
const chips = () => $$('[aria-label^="Open"], [aria-label^="Why"]').map(b => b.textContent);
// What the reader can still see and press: a chip mid-exit is in the DOM but is
// aria-hidden, so it is not one of these.
const liveChips = () => $$('[aria-label^="Open"], [aria-label^="Why"]')
    .filter(b => !b.closest('[aria-hidden="true"]')).map(b => b.textContent);
const click = (el) => act(() => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
const dismissButton = () => $$('button').find(b => (b.getAttribute('aria-label') || '').startsWith('Dismiss'));
// Long enough for the exit (140ms fade + 200ms collapse) to finish and the
// store call behind it to land.
const afterExit = async () => { await act(async () => { await new Promise(r => setTimeout(r, 450)); }); };

console.log('\n--- the ✕ on a finished task ---------------------------------------');

// Through the real feed reader, not by setting state: the snapshot path is half
// of what is being tested.
store.getState().startAiTaskFeed();
await settle();
globalThis.__pushTasks([task()]);
check('the chip arrives on a snapshot', chips().length, 1);

const x = dismissButton();
check('a finished chip carries a Dismiss button, not Cancel', !!x, true);
await click(x);
// The press frame: it is on its way out and is no longer anything the reader
// can reach — no second press, no announcement, no click through to a task that
// is being cleared.
check('the chip stops being a control the moment it is pressed', liveChips().length, 0);
check('it is still drawn, mid-exit', chips().length, 1);
check('...and takes no more clicks', $$('[aria-hidden="true"] > [style*="pointer-events: none"]').length, 1);
await settle();
// 25ms in: the exit is still playing, and — the thing that matters — the dock
// has not been waiting on the network either way.
check('the server has not been asked yet, and nothing waits on it', calls, []);
await afterExit();
check('the chip is gone when the exit ends', chips().length, 0);
check('...and the server was told', calls, [['dismiss', 't1']]);

// The server coalesces its list over 250ms, so a snapshot already in flight when
// the ✕ was pressed still carries the task. Putting the chip back for a quarter
// of a second reads as the button having failed.
globalThis.__pushTasks([task()]);
check('a snapshot from before the DELETE does not bring it back', chips().length, 0);
// Once the server agrees it is gone, the dock stops filtering it — so an id the
// server reuses (or a task genuinely recreated) is not suppressed forever.
globalThis.__pushTasks([]);
globalThis.__pushTasks([task({ label: 'Naming 12 regions' })]);
check('a task the server lists again after that IS shown', chips().length, 1);
globalThis.__pushTasks([]);

console.log('\n--- when the server refuses ----------------------------------------');
dismissFails = true;
calls.length = 0;
globalThis.__pushTasks([task({ id: 't2', status: 'error', error: 'failed' })]);
check('the chip is on screen', chips().length, 1);
await click(dismissButton());
check('it goes at once, on the reader\'s word', liveChips().length, 0);
await afterExit();
check('...and comes back when the server says no', liveChips().length, 1);
check('the server was asked', calls, [['dismiss', 't2']]);
dismissFails = false;
globalThis.__pushTasks([]);

console.log('\n--- three at a time, and the three are the newest -------------------');
calls.length = 0;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const done = (id, label, finishedMs) => task({
    id, label, status: 'done', createdAt: ago(finishedMs + 1000), finishedAt: ago(finishedMs),
});
const has = (label) => liveChips().some(c => c.includes(label));

// A running task and a queue behind it: the bar shows what is running and what
// is next, never more than three, and the rest go behind the pill.
globalThis.__pushTasks([
    task({ id: 'r1', label: 'Running now', status: 'running', queuePosition: null, finishedAt: null }),
    task({ id: 'q2', label: 'Queued two', status: 'queued', queuePosition: 1, finishedAt: null }),
    task({ id: 'q3', label: 'Queued three', status: 'queued', queuePosition: 2, finishedAt: null }),
    task({ id: 'q4', label: 'Queued four', status: 'queued', queuePosition: 3, finishedAt: null }),
    task({ id: 'q5', label: 'Queued five', status: 'queued', queuePosition: 4, finishedAt: null }),
]);
check('never more than three chips', liveChips().length, 3);
check('the running one is one of them', has('Running now'), true);
check('so is the one that runs next', has('Queued two'), true);
check('the far end of the queue is not', has('Queued five'), false);
check('the rest are behind a "+N" pill',
    $$('button').filter(b => b.textContent === '+2').length, 1);

// Finished chips: the three on the bar are the three that finished LAST. The
// sort puts a queue oldest-first (the next to run is what you want to see) and
// a finished trail newest-first (the result that just landed is what you came
// to look at) — clipping the other way round kept the stalest chips on screen.
globalThis.__pushTasks([
    done('d1', 'Oldest result', 5000),
    done('d2', 'Older result', 4000),
    done('d3', 'Middle result', 3000),
    done('d4', 'Newer result', 2000),
    done('d5', 'Newest result', 1000),
]);
check('still only three', liveChips().length, 3);
check('the newest finished is shown', has('Newest result'), true);
check('and the next newest', has('Newer result'), true);
check('the oldest is clipped', has('Oldest result'), false);

console.log('\n--- a finished chip clears itself ----------------------------------');
calls.length = 0;
// The countdown is read from the server's own `finishedAt`, so a chip can be
// handed to the dock already old. 10s for a result, 30s for a failure: a
// failure is the one the reader has to decide something about.
globalThis.__pushTasks([
    task({ id: 'k1', label: 'Still running', status: 'running', queuePosition: null, finishedAt: null }),
    done('k2', 'Long done', 11000),
    task({ id: 'k3', label: 'Just failed', status: 'error', error: 'failed', createdAt: ago(12000), finishedAt: ago(11000) }),
    task({ id: 'k4', label: 'Failed a while ago', status: 'error', error: 'failed', createdAt: ago(32000), finishedAt: ago(31000) }),
]);
check('all four are in the list', store.getState().aiTasks.length, 4);
await act(async () => { await new Promise(r => setTimeout(r, 1800)); });
const left = store.getState().aiTasks.map(t => t.id).sort();
check('the 10s result cleared, and so did the failure past 30s', left, ['k1', 'k3']);
check('a running task is never cleared', store.getState().aiTasks.some(t => t.id === 'k1'), true);
check('a failure inside its 30s is still there', store.getState().aiTasks.some(t => t.id === 'k3'), true);
check('each one was dismissed exactly once', calls.length, 2);

console.log('\n--- a chip clipped behind the pill still clears ---------------------');
// The countdown lives in the dock, not in the chip: only three chips are
// mounted, so a timer inside one would never fire for the fourth.
calls.length = 0;
globalThis.__pushTasks([]);
globalThis.__pushTasks([
    done('c1', 'Shown one', 11000),
    done('c2', 'Shown two', 11500),
    done('c3', 'Shown three', 12000),
    done('c4', 'Clipped one', 12500),
    done('c5', 'Clipped two', 13000),
]);
check('only three of the five are drawn', liveChips().length, 3);
check('the newest three are the drawn ones', has('Shown one'), true);
check('the older two are clipped', has('Clipped one') || has('Clipped two'), false);
await act(async () => { await new Promise(r => setTimeout(r, 1800)); });
check('all five cleared, drawn or not', store.getState().aiTasks.length, 0);

console.log('\n--- the countdown is held while it is being read --------------------');
calls.length = 0;
globalThis.__pushTasks([done('h1', 'Under the pointer', 11000)]);
const chipButton = $$('button').find(b => (b.getAttribute('aria-label') || '').startsWith('Open'));
act(() => { chipButton.focus(); });
await act(async () => { await new Promise(r => setTimeout(r, 1800)); });
check('a held chip is not cleared out from under the reader', store.getState().aiTasks.length, 1);
act(() => { chipButton.blur(); });
await act(async () => { await new Promise(r => setTimeout(r, 1800)); });
check('...and goes once the hold is released', store.getState().aiTasks.length, 0);

console.log('\n--- the failure dialog is not inside the transformed dock -----------');
// `feed`, because that is the chain that authors a paper exercise — a `kind`
// nothing creates draws the generic fallback the section below exists to
// forbid, so the fixture must name a real one.
const failing = task({
    id: 't3', kind: 'feed', label: 'Doppler exercise', status: 'error', error: 'failed',
    failure: {
        id: 'f1', kind: 'feed', label: 'Doppler exercise', at: Date.now() - 5000,
        message: 'The model did not answer.', phase: 'generating', lastMessage: '',
        model: 'qwen3.6-35b', provider: 'ollama', endpoint: 'http://127.0.0.1:8888/v1/chat/completions',
        httpStatus: 500, code: 'ECONNRESET', elapsedMs: 4200,
        produced: { contentChars: 137, thinkingChars: 0 },
        causes: ['socket hang up'], stack: 'Error: socket hang up\n    at x',
        responseBody: '{"error":"upstream exited"}',
    },
});
globalThis.__pushTasks([failing]);
// Looked up with the dock on screen — it renders nothing at all when no task
// is listed, and the sections above leave the list empty.
const dock = $$('div').find(d => d.style && d.style.transform && d.style.transform.includes('translateX'));
check('the dock carries the transform that causes this', !!dock, true);
check('no dialog before the chip is clicked', $$('[role=dialog]').length, 0);
await click($$('button').find(b => (b.getAttribute('aria-label') || '').startsWith('Why')));
const dialog = $$('[role=dialog]')[0];
check('the dialog opens', !!dialog, true);
check('it is NOT inside the transformed dock', dock.contains(dialog), false);
check('its backdrop is a direct child of body',
    dialog.parentElement.parentElement === window.document.body, true);
check('the message is rendered', !!$$('p').find(e => e.textContent.includes('The model did not answer.')), true);
// A real key press starts at the focused element and bubbles through the
// document, where the shared dialog stack listens; one sent to `window` skips it.
act(() => (window.document.activeElement ?? window.document.body).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
check('Escape closes it', $$('[role=dialog]').length, 0);

console.log('\n--- every kind the server can start has a name ----------------------');
// The kinds, read out of the calls that create them rather than from a list
// someone has to remember to update. A ternary contributes both of its arms
// (`kind: masteryCheck ? 'mastery_check' : 'quiz'`) — which is exactly the shape a
// grep for `kind: '…'` misses. `tasks.js` is the registry itself: its own
// `kind` is the parameter, not a job.
// Every server module, routes/ included.
const taskModules = serverFiles().filter(n => n !== 'tasks.js');
const serverKinds = new Set();
for (const file of taskModules) {
    const src = readServer(file);
    for (const call of src.matchAll(/(?:createTask|registerExternal)\s*\(\s*\{/g)) {
        const kindExpr = src.slice(call.index, call.index + 600).match(/kind:\s*([^\n]*)/);
        if (!kindExpr) { fail++; console.log(` FAIL  ${file}: a task is created with no kind on it`); continue; }
        for (const literal of kindExpr[1].matchAll(/'([a-z_]+)'/g)) serverKinds.add(literal[1]);
    }
}
// A floor, not the count: a new kind must not make this assertion fail, but a
// scan that has quietly stopped matching must.
// 18 since 2026-10-03, when the tutor's `chat` kind went with the tutor.
check('the scan reaches the calls that start tasks', serverKinds.size >= 18, true);

globalThis.__pushTasks([]);
const unnamed = [];
for (const kind of [...serverKinds].sort()) {
    globalThis.__pushTasks([task({
        id: `n-${kind}`, kind, label: 'A job', status: 'running',
        queuePosition: null, finishedAt: null,
    })]);
    // The chip draws the kind under the label and repeats it in the button's
    // own name: "Open <kind> task: <label> (<detail>)".
    const button = $$('button').find(b => (b.getAttribute('aria-label') || '').startsWith('Open'));
    const named = button ? button.getAttribute('aria-label') : '';
    if (!named || named.includes('ai task')) unnamed.push(kind);
    globalThis.__pushTasks([]);
}
check('no kind falls through to the generic "AI task"', unnamed, []);

console.log('\n--- a chip is coloured by its OWN project ---------------------------');
// THE DOT IS THE ONLY THING ON A CHIP THAT SAYS WHICH COURSE THE WORK IS FOR,
// and it was tracking the reader instead. The dock is `position: fixed` at the
// bottom of the screen, so it inherits `--accent-rgb` from wherever it lands in
// the tree — which is inside the open project's subtree on a dashboard and
// outside it on the library feed. The same "Preparing feed lessons" chip was
// therefore blue on one screen and orange on the next (reported with
// screenshots, 2026-09-21).
//
// Two halves, and a fix to either alone leaves the bug: the chip has to scope
// the accent to its own task, AND the task has to carry a colour to scope it to.
{
    const chipSrc = readFileSync(join(here, '..', '..', 'src', 'components', 'TaskDock.tsx'), 'utf8');
    // The pair of variables is derived in one place now (`useAccentVars`, which
    // also resolves the SURFACE the accent's text lands on from the theme's
    // tint); what has to hold here is unchanged — the chip names the colour it
    // wants rather than taking whatever the dock landed in.
    check('the chip scopes the accent to its task rather than inheriting it',
        /useAccentVars\(color\)/.test(chipSrc)
        && /const color = projectColor \|\| appAccent/.test(chipSrc), true);
    // The fallback is the APP accent read from the store, never the ambient CSS
    // variable — the variable is the bug.
    check('nothing in the dock falls back to the ambient var(--accent-rgb)',
        /rgb\(var\(--accent-rgb\)\)/.test(chipSrc), false);

    // …and the server side: a task that names a project must name its colour.
    // A `projectId` with no `projectColor` is a chip that has a course and
    // cannot say which.
    const colourless = [];
    for (const file of taskModules) {
        const src = readServer(file);
        for (const call of src.matchAll(/(?:createTask|registerExternal)\s*\(\s*\{/g)) {
            const body = src.slice(call.index, call.index + 700);
            const end = body.indexOf('\n    });');
            const args = body.slice(0, end === -1 ? 700 : end);
            // The lookahead holds the spaces too: `\s*(?!null)` backtracks to
            // zero spaces and reads `projectId: null` as a project.
            const named = /\bprojectId:(?!\s*null\b)/.test(args);
            const coloured = /\bprojectColor:/.test(args);
            // `setProject` later is the other way to say it — the feed sweep
            // walks the whole library, so it has no one project for its lifetime
            // and hands over the one it is on at each step.
            const handsOver = /\.setProject\(/.test(src);
            if (named && !coloured && !handsOver) {
                colourless.push(`${file}: ${(args.match(/kind:\s*[^\n,]+/) || ['?'])[0]}`);
            }
        }
    }
    check('every task that names a project names its colour', colourless, []);
}

console.log('\n--- a press on a chip is never nothing ------------------------------');
// THE BAR WAS DECORATION FOR MOST OF WHAT IT SHOWED. `openAiTask` was a switch
// over nine kinds; the server starts nineteen. The other ten — indexing, region
// naming, PDF recovery, image descriptions, interval tuning, the widget and
// visual builders, bulk generation, placement, capture — drew a chip, drew a
// label, drew a percentage, and did absolutely nothing when pressed. A switch
// with no default is silent from both sides: the server was right, the dock was
// right, and the reader learned to stop pressing.
//
// So: every kind the server can start, pressed, in both shapes it can arrive in
// — carrying its project and node, and carrying neither, which is what a visual
// repaired inside a feed card or a document indexed on upload actually looks
// like. Each press must GO somewhere or OPEN the task's own record. Nothing may
// do neither.
const routes = [];
act(() => { store.getState().setNavigate((to) => { routes.push(String(to)); }); });
const escape = () => act(() => (window.document.activeElement ?? window.document.body).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
const openButton = () => $$('button').find(b => (b.getAttribute('aria-label') || '').startsWith('Open'));
const detailButton = () => $$('button').find(b => (b.getAttribute('aria-label') || '').startsWith('Details of'));

// A task as the dock really sees a running one: started a minute ago, four
// tenths of the way through, no estimate of its own.
const runningTask = (over = {}) => task({
    id: 'p1', status: 'running', queuePosition: null, finishedAt: null,
    startedAt: ago(60000), createdAt: ago(65000),
    progress: { percent: 40, content: 0, thinking: 0, phase: '', message: 'topic 4 of 10' },
    ...over,
});

const press = async (over, which = openButton) => {
    globalThis.__pushTasks([]);
    act(() => { store.setState({ assistantOpen: false }); });
    globalThis.__pushTasks([runningTask(over)]);
    routes.length = 0;
    const button = which();
    if (!button) return { routes: [], assistant: false, dialog: false, missing: true };
    await click(button);
    const dialog = $$('[role=dialog]')[0] || null;
    const out = {
        routes: [...routes],
        assistant: store.getState().assistantOpen === true,
        dialog: !!dialog,
        text: dialog ? dialog.textContent : '',
    };
    if (dialog) escape();
    return out;
};

const deadPresses = [];
for (const kind of [...serverKinds].sort()) {
    for (const [shape, ids] of [
        ['carrying its ids', { projectId: 7, nodeId: 42 }],
        ['carrying neither', { projectId: null, nodeId: null }],
    ]) {
        const r = await press({ kind, ...ids });
        if (!r.routes.length && !r.assistant && !r.dialog) deadPresses.push(`${kind} ${shape}`);
    }
}
check('every kind the server can start does something when pressed', deadPresses, []);

// And WHERE each one goes, pinned — a mapping that silently drifts to the wrong
// screen is the same bug wearing a coat.
check('a quiz opens its topic', (await press({ kind: 'quiz', projectId: 7, nodeId: 42 })).routes, ['/project/7/tree/42']);
check('an assistant turn opens the assistant, not a page', await press({ kind: 'today_chat', projectId: null, nodeId: null }).then(r => ({ routes: r.routes, assistant: !!r.assistant })), { routes: [], assistant: true });
check('insights open the project', (await press({ kind: 'insights', projectId: 7, nodeId: null })).routes, ['/project/7/dashboard']);
check('bulk generation opens the project', (await press({ kind: 'bulk', projectId: 7, nodeId: null })).routes, ['/project/7/dashboard']);
check('the feed opens the home page', (await press({ kind: 'feed', projectId: null, nodeId: null })).routes, ['/']);
check('region naming opens the atlas', (await press({ kind: 'atlas', projectId: null, nodeId: null })).routes, ['/atlas']);
check('indexing opens the panel that runs it', (await press({ kind: 'embed', projectId: null, nodeId: null })).routes, ['/settings#ai']);
check('interval tuning opens its own panel', (await press({ kind: 'srs_optimize', projectId: null, nodeId: null })).routes, ['/settings#learning']);

// The planner is a DRAWER over whatever is on screen: reaching it must open the
// drawer and navigate nowhere. Sending the reader to '/' instead would take them
// off their page and still not open the one thing they pressed the chip for.
const planner = await press({ kind: 'today_chat', projectId: null, nodeId: null });
check('the planner opens the assistant', planner.assistant, true);
check('...and navigates nowhere', planner.routes, []);

// A background job with nothing to open falls through to its own record rather
// than swallowing the press.
const orphan = await press({ kind: 'visual', projectId: null, nodeId: null });
check('a visual with no topic opens its record instead', [orphan.dialog, orphan.routes.length], [true, 0]);

console.log('\n--- the record says when it started and how long is left ------------');
// The two facts the chip has no room for. The estimate is derived here (this
// task reports no etaMs of its own): a minute in at 40% has about another
// minute and a half to go.
const detail = await press({ kind: 'embed', projectId: null, nodeId: null }, detailButton);
check('the progress badge opens the record', detail.dialog, true);
check('it says when the task started', detail.text.includes('1 min ago'), true);
check('it says how long is left', /about\s*2 min/.test(detail.text), true);
check('it says what the job is doing now', detail.text.includes('topic 4 of 10'), true);
check('a running task can be stopped from it', detail.text.includes('Stop this task'), true);
// The record also carries the way out: a job with a home says where, and a job
// the app started by itself says it has none rather than offering a button that
// goes nowhere. `orphan` is the visual with no topic, pressed above.
check('a record names the screen the job belongs to', detail.text.includes('Open Settings'), true);
check('...and one with no screen says so', orphan.text.includes('no screen it came from'), true);

// Same dialog, same containing-block trap as the failure record: the dock is
// `fixed` WITH a transform on it, so anything `fixed` rendered inside it
// resolves `inset-0` to the dock's own pill rather than to the screen.
globalThis.__pushTasks([]);
globalThis.__pushTasks([runningTask({ kind: 'embed', projectId: null, nodeId: null })]);
const dock2 = $$('div').find(d => d.style && d.style.transform && d.style.transform.includes('translateX'));
await click(detailButton());
const record = $$('[role=dialog]')[0];
check('the record opens', !!record, true);
check('it is NOT inside the transformed dock', dock2.contains(record), false);
escape();
check('Escape closes it', $$('[role=dialog]').length, 0);

// A finished task is a record too — and the control on it is Dismiss, not Stop.
globalThis.__pushTasks([]);
globalThis.__pushTasks([task({ id: 'p2', status: 'done', finishedAt: ago(1000), createdAt: ago(9000), startedAt: ago(8000) })]);
await click(detailButton());
const settled = $$('[role=dialog]')[0];
check('a finished task opens a record too', !!settled, true);
check('...whose control is Dismiss, not Stop', [settled.textContent.includes('Dismiss'), settled.textContent.includes('Stop this task')], [true, false]);
check('...and it offers no estimate for work that is over', /Time left/.test(settled.textContent), false);
escape();
globalThis.__pushTasks([]);

console.log('\n--- the estimate, measured against its own arithmetic ---------------');
// A wrong number here is worse than no number: the reader plans around it. So
// the function answers only when it has evidence, and says nothing otherwise.
const { taskEta, durationParts } = globalThis.__place;
const at = (over) => runningTask(over);
check('a job that times itself is believed',
    taskEta(at({ progress: { percent: 5, content: 0, thinking: 0, phase: '', message: '', etaMs: 42000 } })),
    { ms: 42000, measured: true });
// The clock is INJECTED: read live, the milliseconds between building the
// task and judging it land in the answer (90002 on a slow CI runner).
const CLOCK = Date.now();
check('a percentage and a clock make an estimate',
    taskEta(at({ startedAt: new Date(CLOCK - 60000).toISOString(), progress: { percent: 40, content: 0, thinking: 0, phase: '', message: '' } }), CLOCK),
    { ms: 90000, measured: false });
check('nothing is estimated from 0%',
    taskEta(at({ progress: { percent: 0, content: 0, thinking: 0, phase: '', message: '' } })), null);
check('nor from three seconds of evidence',
    taskEta(at({ startedAt: ago(3000), progress: { percent: 2, content: 0, thinking: 0, phase: '', message: '' } })), null);
check('nor for a task that has not started',
    taskEta(at({ status: 'queued', startedAt: null, queuePosition: 2 })), null);
check('nor for one that is over',
    taskEta(at({ status: 'done', finishedAt: ago(10) })), null);
// No unit is ever inflected — "1 minutes" is a bug in twelve languages at once.
check('a span is written without plurals', [
    durationParts(4000).key, durationParts(95000).key, durationParts(3600000).key, durationParts(5000000).key,
], ['{{n}} s', '{{n}} min', '{{n}} h', '{{h}} h {{m}} min']);

console.log('\n--- every task records where it came from ----------------------------');
// The record used to GUESS the place from the kind and the ids, and a widget
// built under an assistant answer carries neither — so it said "The app
// started this one by itself, so there is no screen it came from" about a build
// the learner had watched begin under their own question. The place is known
// when the task is made, so every call that makes one must say it.
{
    const originless = [];
    for (const file of taskModules) {
        const src = readServer(file);
        for (const call of src.matchAll(/(?:createTask|registerExternal)\s*\(\s*\{/g)) {
            const body = src.slice(call.index, call.index + 900);
            const end = body.indexOf('\n    });');
            const args = body.slice(0, end === -1 ? 900 : end);
            if (!/\borigin\s*[:,]/.test(args)) originless.push(`${file}: ${(args.match(/kind:\s*[^\n,]+/) || ['?'])[0]}`);
        }
    }
    check('every createTask / registerExternal call passes an origin', originless, []);

    // The server keeps a closed vocabulary and integer ids — a request cannot
    // put a title, a prompt or anything else on the record.
    const tasksMod = await import(new URL('../../server/tasks.js', import.meta.url).href);
    const n = tasksMod.normalizeOrigin;
    check('an origin keeps its surface, detail and ids',
        n({ surface: 'topic', detail: 'overview', nodeId: 42, projectId: '7' }), { surface: 'topic', detail: 'overview', projectId: 7, nodeId: 42 });
    check('an unknown surface is no origin at all', n({ surface: 'Doppler Effect for Sound and Light' }), null);
    check('text in an id, an unknown detail and a smuggled title are dropped',
        n({ surface: 'topic', nodeId: 'Doppler', detail: 'my notes', title: 'Doppler', messageId: -3 }), { surface: 'topic' });
    check('the tutor is no longer a surface (it is the assistant now)', n({ surface: 'tutor', nodeId: 4 }), null);
    check('a job is only kept for the app\'s own work', [n({ surface: 'app', job: 'feed' }), n({ surface: 'assistant', job: 'feed' })],
        [{ surface: 'app', job: 'feed' }, { surface: 'assistant' }]);
    const { task } = tasksMod.createTask({ kind: 'widget', label: 'W', origin: { surface: 'assistant', messageId: 9 }, run: () => new Promise(() => { }) });
    const listed = tasksMod.listTasks().find(t => t.id === task.id);
    check('the dock\'s snapshot carries it', listed?.origin, { surface: 'assistant', messageId: 9 });
    tasksMod.cancelTask(task.id);
    const ext = tasksMod.registerExternal({ kind: 'feed', label: 'Preparing feed lessons', origin: { surface: 'app', job: 'feed' }, cancel: () => { } });
    ext.setOrigin({ surface: 'app', job: 'feed', nodeId: 42, projectId: 7 });
    check('a job that walks many topics says which one it is on now',
        tasksMod.listTasks().find(t => t.id === ext.id)?.origin, { surface: 'app', job: 'feed', projectId: 7, nodeId: 42 });
    ext.fail('model refused');
    check('…and the failure record carries it too', tasksMod.listTasks().find(t => t.id === ext.id)?.failure?.origin, { surface: 'app', job: 'feed', projectId: 7, nodeId: 42 });
}

// The record says where, in words, and its button goes there.
const settleLabels = async () => { await act(async () => { await new Promise(r => setTimeout(r, 30)); }); };
{
    // The widget from the report: built under an assistant answer, no project.
    globalThis.__pushTasks([]);
    act(() => { store.setState({ assistantOpen: false }); });
    globalThis.__pushTasks([runningTask({ id: 'o1', kind: 'widget', label: 'Wavefront crowding = Doppler shift', projectId: null, nodeId: null, origin: { surface: 'assistant', messageId: 12 } })]);
    routes.length = 0;
    await click(detailButton());
    await settleLabels();
    let dialog = $$('[role=dialog]')[0];
    check('a widget built under an assistant answer says so', dialog?.textContent.includes('Started from the assistant.'), true);
    check('…and no longer says it came from nowhere', dialog?.textContent.includes('no screen it came from'), false);
    const openBtn = [...dialog.querySelectorAll('button')].find(b => b.textContent.includes('Open the assistant'));
    check('…and offers to open the assistant', !!openBtn, true);
    await click(openBtn);
    check('…which opens the drawer and navigates nowhere', [store.getState().assistantOpen, routes], [true, []]);
    if ($$('[role=dialog]').length) escape();

    // The feed generator, on a named topic.
    globalThis.__pushTasks([]);
    globalThis.__pushTasks([runningTask({ id: 'o2', kind: 'feed', label: 'Preparing feed lessons', projectId: 7, nodeId: null, origin: { surface: 'app', job: 'feed', projectId: 7, nodeId: 42 } })]);
    routes.length = 0;
    await click(detailButton());
    await settleLabels();
    dialog = $$('[role=dialog]')[0];
    const said = dialog?.querySelector('[data-task-origin]')?.textContent ?? '';
    check('the feed generator says what it is preparing, by name',
        said, 'Prepared by the app for your feed: “Doppler Effect for Sound and Light”.');
    const studyBtn = [...dialog.querySelectorAll('button')].find(b => b.textContent.includes("Open the topic's study feed"));
    await click(studyBtn);
    check('…and opens that topic\'s own stream', routes, ['/project/7/study/42']);
    if ($$('[role=dialog]').length) escape();

    // A drawing repaired inside a topic's Overview goes back to the topic.
    check('an Overview repair opens its topic',
        (await press({ kind: 'visual', projectId: 7, nodeId: 42, origin: { surface: 'topic', detail: 'overview', projectId: 7, nodeId: 42 } })).routes,
        ['/project/7/tree/42']);

    // A failure says where it came from as well, and goes back there.
    globalThis.__pushTasks([]);
    act(() => { store.setState({ assistantOpen: false }); });
    globalThis.__pushTasks([task({
        id: 'o3', kind: 'widget', label: 'Wavefront crowding', status: 'error', error: 'failed', projectId: null, nodeId: null,
        origin: { surface: 'assistant' },
        failure: {
            kind: 'widget', label: 'Wavefront crowding', at: Date.now() - 5000, message: 'The build is not an HTML document.',
            origin: { surface: 'assistant' }, phase: null, lastMessage: null, model: 'm', provider: 'p', endpoint: null,
            httpStatus: null, code: null, elapsedMs: 1000, produced: { contentChars: 10, thinkingChars: 0 }, causes: [], stack: null,
            responseBody: null, rawResponse: null,
        },
    })]);
    await click($$('button').find(b => (b.getAttribute('aria-label') || '').startsWith('Why')));
    const failDialog = $$('[role=dialog]')[0];
    check('the failure record says where the failed task came from', failDialog?.textContent.includes('Started from the assistant.'), true);
    const back = failDialog && [...failDialog.querySelectorAll('button')].find(b => b.textContent.includes('Open the assistant'));
    await click(back);
    check('…and its button goes back there', store.getState().assistantOpen, true);
    if ($$('[role=dialog]').length) escape();
    globalThis.__pushTasks([]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

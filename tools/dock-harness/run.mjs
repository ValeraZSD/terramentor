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
import { readdirSync, readFileSync } from 'node:fs';

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
            build.onResolve({ filter: /^\.\/api$/ }, () => ({ path: 'api-stub', namespace: 'stub' }));
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
// `feed`, because that is the chain that authors a paper exercise — the
// fixture used to say `paper`, a kind nothing creates, so this chip drew the
// generic fallback the section below exists to forbid.
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
act(() => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
check('Escape closes it', $$('[role=dialog]').length, 0);

console.log('\n--- every kind the server can start has a name ----------------------');
// The kinds, read out of the calls that create them rather than from a list
// someone has to remember to update. A ternary contributes both of its arms
// (`kind: bossFight ? 'boss_fight' : 'quiz'`) — which is exactly the shape a
// grep for `kind: '…'` misses. `tasks.js` is the registry itself: its own
// `kind` is the parameter, not a job.
const serverDir = join(here, '..', '..', 'server');
const serverKinds = new Set();
for (const file of readdirSync(serverDir).filter(n => n.endsWith('.js') && n !== 'tasks.js')) {
    const src = readFileSync(join(serverDir, file), 'utf8');
    for (const call of src.matchAll(/(?:createTask|registerExternal)\s*\(\s*\{/g)) {
        const kindExpr = src.slice(call.index, call.index + 600).match(/kind:\s*([^\n]*)/);
        if (!kindExpr) { fail++; console.log(` FAIL  ${file}: a task is created with no kind on it`); continue; }
        for (const literal of kindExpr[1].matchAll(/'([a-z_]+)'/g)) serverKinds.add(literal[1]);
    }
}
// A floor, not the count: a new kind must not make this assertion fail, but a
// scan that has quietly stopped matching must.
check('the scan reaches the calls that start tasks', serverKinds.size >= 19, true);

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

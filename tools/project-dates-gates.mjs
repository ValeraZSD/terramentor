// tools/project-dates-gates.mjs — the dates strip on a Projects card does what it says.
//
// Run:  node tools/project-dates-gates.mjs                 (the working tree)
//       node tools/project-dates-gates.mjs --from <rev|path>
//                                                          (another ProjectDates.tsx: a
//                                                           commit, or a saved copy, to
//                                                           watch the cases fail on it)
//
// WHY. The Schedule screen merged into Projects as a strip on each card that is
// both the dates and the control that changes them (src/components/schedule/
// ProjectDates.tsx). A code review of that merge found the editor doing things
// its buttons promise not to:
//   - Enter on the focused Cancel SAVED and rescheduled every open topic, since
//     the row's Enter handler answered every element in it;
//   - before the schedule overview arrived (or when it failed) a save took the
//     plain window write and the open topics silently kept their old dates;
//   - "Reschedule them" inside an unchanged window left the drift line up,
//     because the grid re-read the overview only when a project field changed;
//   - Escape closed the editor while a save was still in flight;
//   - closing the editor dropped focus on the page body;
//   - the strip's aria-label replaced the range and the pace with a verb, so a
//     screen reader heard neither;
//   - "The deadline is before the start." flashed, as an alert, on every digit
//     of a year typed into the deadline (0002, 0020, 0202 are all "before").
// And one placement he asked for: Remove schedule sits in the editor with
// cancel and apply, not in the card's Study corner, so Study never hides.
// The REAL component and store are bundled into jsdom; the store's two writes
// are spies.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const REL = 'src/components/schedule/ProjectDates.tsx';
const fromAt = process.argv.indexOf('--from');
const FROM = fromAt > 0 ? process.argv[fromAt + 1] : null;

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

const swap = {
    name: 'from',
    setup(build) {
        if (!FROM) return;
        build.onLoad({ filter: /[\\/]src[\\/]components[\\/]schedule[\\/]ProjectDates\.tsx$/ }, () => ({
            contents: existsSync(FROM)
                ? readFileSync(FROM, 'utf8')
                : execFileSync('git', ['show', `${FROM}:${REL}`], { cwd: root, encoding: 'utf8' }),
            loader: 'tsx',
        }));
    },
};
const bundle = (await esbuild.build({
    stdin: {
        contents: `
            import { useStore } from './src/store';
            import ProjectDates from './src/components/schedule/ProjectDates';
            import { createElement as h, useState, act } from 'react'; import { createRoot } from 'react-dom/client';
            // The card holds the editing flag; this host is that card, minus the card.
            function Host(props) {
                const [editing, setEditing] = useState(false);
                return h(ProjectDates, { ...props, isDeck: false, editing, onEditingChange: setEditing });
            }
            const mount = (el, props) => { const root = createRoot(el); act(() => root.render(h(Host, props))); return root; };
            window.__gate = { useStore, mount, act };`,
        resolveDir: root, loader: 'tsx',
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.css': 'empty', '.svg': 'dataurl' },
    plugins: [swap],
})).outputFiles[0].text;

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const project = {
    id: 7, name: 'Calculus', color: '#8B5CF6', icon: 'book', status: 'active',
    start_date: day(-10), deadline: day(30), study_days: '[1,2,3,4,5]',
    topic_count: 5, completed_topic_count: 2,
};
const row = {
    id: 7, openLeaves: 3, firstScheduledStart: day(-10), lastScheduledEnd: day(30),
    pace: { paceStatus: 'falling_behind', expectedProgress: 40, actualProgress: 30, drift: -10, totalDays: 40 },
};

/** One strip, mounted; `write` decides what the store's writes answer. */
async function show({ p = project, r = row, write = async () => true } = {}) {
    const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false, addEventListener() { }, removeEventListener() { } });
    w.IS_REACT_ACT_ENVIRONMENT = true;
    w.MessageChannel = MessageChannel;
    w.fetch = () => new Promise(() => { });
    w.eval(bundle);
    const { useStore, mount, act } = w.__gate;
    const calls = [];
    useStore.setState({
        scheduleProject: (...a) => { calls.push(['schedule', ...a]); return write(); },
        updateProject: (...a) => { calls.push(['update', ...a]); return write(); },
    });
    let saved = 0, removed = 0;
    const host = w.document.getElementById('root');
    const rootEl = mount(host, { project: p, row: r, onSaved: () => { saved++; }, onRemove: () => { removed++; } });
    await act(async () => { await settle(); });
    const $ = (sel) => w.document.querySelector(sel);
    const strip = () => $('[data-strip="dates"]');
    const fields = () => [...w.document.querySelectorAll('input[type="date"]')];
    const buttons = () => [...w.document.querySelectorAll('button')];
    const press = async (el) => { await act(async () => { el.click(); await settle(); }); };
    const key = async (el, k) => {
        await act(async () => { el.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); await settle(); });
    };
    const type = async (el, value) => {
        const set = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set;
        await act(async () => { set.call(el, value); el.dispatchEvent(new w.Event('input', { bubbles: true })); await settle(); });
    };
    const open = async () => { await press(strip()); };
    // The editor's two buttons are its last two: Cancel, then the tick.
    const cancel = () => buttons().at(-2), tick = () => buttons().at(-1);
    return {
        w, strip, fields, buttons, cancel, tick, press, key, type, open, calls, saved: () => saved, removed: () => removed, act,
        close: () => { act(() => rootEl.unmount()); w.close(); },
    };
}

// ---------------------------------------------------------------------------
section('Enter is a field\'s, never a button\'s');
{
    const s = await show();
    await s.open();
    check('the strip opens the editor', s.fields().length === 2);
    s.cancel().focus();
    await s.key(s.cancel(), 'Enter');
    check('Enter on the focused Cancel writes nothing', s.calls.length === 0, JSON.stringify(s.calls));
    s.close();
}
{
    const s = await show();
    await s.open();
    await s.key(s.fields()[1], 'Enter');
    check('Enter in a date field saves (it applies the window)', s.calls.length === 1, JSON.stringify(s.calls));
    s.close();
}

section('before the overview arrives, open topics are still rescheduled');
{
    const s = await show({ r: null }); // null: `undefined` would take the default row
    await s.open();
    await s.type(s.fields()[1], day(60));
    await s.press(s.tick());
    check('a new deadline with no overview row goes through scheduleProject, not the plain window write',
        s.calls.length === 1 && s.calls[0][0] === 'schedule', JSON.stringify(s.calls.map(c => c[0])));
    s.close();
}

section('a write that went through is reported, so the grid re-reads the pace');
{
    const s = await show();
    await s.open();
    await s.press(s.tick());
    check('the tick on an unchanged window with open topics reschedules them', s.calls[0]?.[0] === 'schedule', JSON.stringify(s.calls.map(c => c[0])));
    check('…and calls onSaved once', s.saved() === 1, `onSaved ran ${s.saved()} times`);
    s.close();
}
{
    const s = await show({ write: async () => false });
    await s.open();
    await s.press(s.tick());
    check('a refused write calls no onSaved and keeps the editor open', s.saved() === 0 && s.fields().length === 2);
    s.close();
}

section('Escape waits for a save in flight');
{
    let finish;
    const s = await show({ write: () => new Promise(r => { finish = r; }) });
    await s.open();
    await s.press(s.tick());
    await s.key(s.fields()[0], 'Escape');
    check('Escape while the save runs leaves the editor open', s.fields().length === 2);
    await s.act(async () => { finish(true); await settle(); });
    check('…and the save, landing, closes it', s.fields().length === 0);
    s.close();
}

section('closing the editor hands focus back to the strip');
{
    const s = await show();
    await s.open();
    await s.press(s.cancel());
    check('after Cancel, focus is on the strip, not the page body', s.w.document.activeElement === s.strip(),
        s.w.document.activeElement?.tagName);
    s.close();
}

section('a screen reader hears the dates and the pace, not only a verb');
{
    const s = await show();
    const b = s.strip();
    const year = project.deadline.slice(0, 4);
    check('the strip has no aria-label hiding its text', !b.hasAttribute('aria-label'), b.getAttribute('aria-label') ?? '');
    check('its text (its accessible name) carries the action, the range and the pace',
        /Change the dates for/.test(b.textContent) && b.textContent.includes(year) && /days behind/.test(b.textContent), b.textContent);
    check('…and the pace\'s reason, which was only a tooltip', /the plan expects/.test(b.textContent), b.textContent);
    s.close();
}

section('Remove schedule is in the editor, beside cancel and apply');
{
    const s = await show();
    const remove = () => s.buttons().find(b => /Remove schedule/.test(b.textContent));
    check('closed, the strip offers no Remove schedule', !remove());
    await s.open();
    check('open on a dated project, the editor has Remove schedule', !!remove());
    check('…before cancel and apply, so the tick stays last', remove() && s.buttons().indexOf(remove()) === s.buttons().length - 3);
    await s.press(remove());
    check('…and pressing it asks the card (which confirms), writing nothing itself', s.removed() === 1 && s.calls.length === 0,
        `removed ${s.removed()}, calls ${JSON.stringify(s.calls)}`);
    s.close();
}
{
    const s = await show({ p: { ...project, start_date: null, deadline: null } });
    await s.open();
    check('an undated project\'s editor has nothing to remove', !s.buttons().some(b => /Remove schedule/.test(b.textContent)));
    s.close();
}

section('"The deadline is before the start." waits for a whole year');
{
    const s = await show();
    await s.open();
    const alert = () => s.w.document.querySelector('[role="alert"]');
    await s.type(s.fields()[1], '0002-06-15');
    check('a deadline year half typed (0002) raises no alert', !alert());
    await s.type(s.fields()[1], '0202-06-15');
    check('…nor at 0202', !alert());
    check('…while the tick is already off', s.tick().disabled);
    await s.type(s.fields()[1], day(-400));
    check('a whole year before the start says so, once', !!alert() && /before the start/.test(alert().textContent));
    check('…and both fields point at the sentence', s.fields().every(f => f.getAttribute('aria-describedby') === alert().id));
    s.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

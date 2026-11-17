// tools/project-forms-gates.mjs — the schedule dialog, the import zone and the pace pill say what is true.
//
// Run:  node tools/project-forms-gates.mjs
//
// WHY. Four things in the forms around a project were wrong, each one visible
// to a learner:
//   - the schedule dialog stays mounted and only set a field when the project HAD
//     a value, so after "Remove schedule" the dialog opened again with the removed
//     dates in it, and one press of Generate made the schedule they had deleted;
//   - an import with two or more warnings glued them into one run-on sentence;
//   - the import zone took a second file while one was importing (two copies),
//     and never cleared its file input, so choosing the same file again after a
//     failed import did nothing;
//   - a pace under half a day behind rounded to "On plan" in amber in the
//     workspace's compact pill, while its tooltip said "Slightly behind schedule".
// The REAL components and the real store are bundled into jsdom; the store's
// writes are spies and the network is a fake `fetch`.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

const bundle = (await esbuild.build({
    stdin: {
        contents: `
            import { useStore } from './src/store';
            import ScheduleModal from './src/components/ScheduleModal';
            import ProjectImportZone from './src/components/ProjectImportZone';
            import PaceIndicator from './src/components/PaceIndicator';
            import { createElement as h, act } from 'react'; import { createRoot } from 'react-dom/client';
            const mount = (el, node) => { const root = createRoot(el); act(() => root.render(node)); return root; };
            window.__gate = { useStore, mount, act, h, ScheduleModal, ProjectImportZone, PaceIndicator };`,
        resolveDir: root, loader: 'tsx',
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.css': 'empty', '.svg': 'dataurl' },
})).outputFiles[0].text;

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };

/** A jsdom page with the bundle loaded; `fetch` answers what `answer(url)` says. */
function page(answer = () => ({ ok: true, status: 200, body: {} })) {
    const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false, addEventListener() { }, removeEventListener() { } });
    w.IS_REACT_ACT_ENVIRONMENT = true;
    w.MessageChannel = MessageChannel;
    w.Headers = Headers;
    const fetched = [];
    w.fetch = (url) => {
        fetched.push(String(url));
        const r = answer(String(url));
        if (r instanceof Promise) return r.then(x => ({ ok: x.ok, status: x.status, json: async () => x.body, text: async () => JSON.stringify(x.body) }));
        return Promise.resolve({ ok: r.ok, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) });
    };
    w.eval(bundle);
    return { w, g: w.__gate, host: w.document.getElementById('root'), fetched };
}

// ---------------------------------------------------------------------------
section('the schedule dialog starts from the project it opens on');
{
    const { w, g, host } = page();
    const dated = { id: 1, name: 'Physics', kind: 'curriculum', start_date: '2026-11-01', deadline: '2027-02-01', study_days: '[2,4]' };
    const undated = { id: 2, name: 'Chemistry', kind: 'curriculum', start_date: null, deadline: null, study_days: null };
    const calls = [];
    g.useStore.setState({
        showScheduleModal: false, scheduleModalProjectId: 1, projects: [dated, undated], tree: [], paceData: null,
        setShowScheduleModal: () => { }, scheduleProject: async (...a) => { calls.push(a); return true; },
    });
    g.mount(host, g.h(g.ScheduleModal));
    const dates = () => [...w.document.querySelectorAll('input[type="date"]')];
    const days = () => [...w.document.querySelectorAll('[data-day-toggle]')].filter(b => b.getAttribute('aria-pressed') === 'true').length;
    const open = async (id, projects) => {
        await g.act(async () => { g.useStore.setState({ showScheduleModal: false }); await settle(); });
        await g.act(async () => { g.useStore.setState({ scheduleModalProjectId: id, ...(projects ? { projects } : {}), showScheduleModal: true }); await settle(); });
    };

    await open(1);
    check('a dated project opens with its deadline and its study days', dates().length === 2 && dates()[1].value === '2027-02-01' && days() === 2,
        `deadline ${dates()[1]?.value}, ${days()} days on`);

    await open(1, [{ ...dated, start_date: null, deadline: null, study_days: null }, undated]);
    check('after the schedule is removed, the dialog opens with an empty deadline', dates()[1]?.value === '', `deadline "${dates()[1]?.value}"`);
    check('...and the default study days (Mon-Fri), not the removed ones', days() === 5, `${days()} days on`);

    await open(1);
    await open(2);
    check('an unscheduled second project does not show the first one\'s deadline', dates()[1]?.value === '', `deadline "${dates()[1]?.value}"`);
    w.close();
}

// ---------------------------------------------------------------------------
section('an import with several warnings keeps them apart');
const asFile = (name) => new File(['{"project":{"name":"Course"},"nodes":[]}'], name, { type: 'application/json' });
/** A mounted zone whose server accepts a course; `hold` keeps the import pending. */
function zone({ hold = false, fail = false } = {}) {
    let finish;
    const imports = () => p.fetched.filter(u => /\/import$/.test(u)).length;
    const p = page((url) => {
        if (/course-updates/.test(url)) return { ok: false, status: 404, body: { error: 'not a course update' } };
        if (/\/import$/.test(url)) {
            if (fail) return { ok: false, status: 400, body: { error: 'refused' } };
            const done = { ok: true, status: 200, body: { id: 9, name: 'Course', warnings: ['First note.', 'Second note.'] } };
            return hold ? new Promise(r => { finish = () => r(done); }) : done;
        }
        return { ok: true, status: 200, body: {} };
    });
    const toasts = [], opened = [];
    p.g.useStore.setState({
        addToast: (...a) => toasts.push(a), loadProjects: async () => { }, openProject: (id) => opened.push(id),
    });
    p.g.mount(p.host, p.g.h(p.g.ProjectImportZone, { onDone: () => { } }));
    const el = p.w.document.querySelector('[role="button"]');
    const input = p.w.document.querySelector('input[type="file"]');
    let clicks = 0;
    input.click = () => { clicks++; };
    const assigned = [];
    Object.defineProperty(input, 'value', { configurable: true, get: () => '', set: (v) => { assigned.push(v); } });
    const drop = async (file) => {
        const ev = new p.w.Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'dataTransfer', { value: { files: [file] } });
        await p.g.act(async () => { el.dispatchEvent(ev); await settle(); });
    };
    const pick = async (file) => {
        Object.defineProperty(input, 'files', { configurable: true, value: [file] });
        await p.g.act(async () => { input.dispatchEvent(new p.w.Event('change', { bubbles: true })); await settle(); });
    };
    const click = async () => { await p.g.act(async () => { el.click(); await settle(); }); };
    return { p, toasts, opened, imports, drop, pick, click, assigned, clicks: () => clicks, finish: async () => { await p.g.act(async () => { finish(); await settle(); }); } };
}
{
    const z = zone();
    await z.drop(asFile('course.json'));
    const t = z.toasts.find(a => a[0] === 'info');
    check('two warnings reach the toast on separate lines', t?.[2] === 'First note.\nSecond note.', JSON.stringify(t?.[2]));
    z.p.w.close();
}

section('the import zone takes one file at a time');
{
    const z = zone({ hold: true });
    await z.drop(asFile('one.json'));
    await z.drop(asFile('two.json'));
    check('a second drop while one imports starts no second import', z.imports() === 1, `${z.imports()} imports`);
    await z.pick(asFile('three.json'));
    check('...nor does a second pick', z.imports() === 1, `${z.imports()} imports`);
    await z.click();
    check('...and a click does not open the file picker again', z.clicks() === 0, `${z.clicks()} picker opens`);
    await z.finish();
    await z.click();
    check('once it is done, a click opens the picker again', z.clicks() === 1, `${z.clicks()} picker opens`);
    z.p.w.close();
}

section('choosing the same file again after a failed import works');
{
    const z = zone({ fail: true });
    await z.pick(asFile('broken.json'));
    check('the import failed and said so', z.toasts.some(a => a[0] === 'error'), JSON.stringify(z.toasts));
    check('the file input was emptied, so the same file fires `change` next time', z.assigned.includes(''), JSON.stringify(z.assigned));
    z.p.w.close();
}

// ---------------------------------------------------------------------------
section('a pace under half a day behind is not "On plan" in amber');
{
    const { w, g, host } = page();
    g.useStore.setState({
        paceData: {
            hasSchedule: true, paceStatus: 'falling_behind', expectedProgress: 40, actualProgress: 34,
            startDate: '2026-11-01', deadline: '2026-11-08', drift: 6, totalDays: 7,
        },
    });
    g.mount(host, g.h(g.PaceIndicator, { full: false }));
    const text = host.textContent;
    check('the compact pill does not say "On plan"', !/On plan/.test(text), text);
    check('...it says the same words as its tooltip', /Slightly behind schedule/.test(text) && host.querySelector('[title]')?.getAttribute('title') === 'Slightly behind schedule', text);
    w.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

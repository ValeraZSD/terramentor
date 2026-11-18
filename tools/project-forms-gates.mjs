// tools/project-forms-gates.mjs — the plan panel, the import zone and the pace line say what is true.
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
//   - the course header's pace said one thing in its words and another in its
//     colour; it now shows the verdict alone (the band and one line).
// A date marked "cannot move" is read-only in the panel, has no Remove, and a
// Save sends the mark the box shows; a pace that cannot be read says so.
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
    check('...and its start date', dates()[0]?.value === '2026-11-01', `start "${dates()[0]?.value}"`);

    await open(1, [{ ...dated, start_date: null, deadline: null, study_days: null }, undated]);
    check('after the schedule is removed, the dialog opens with an empty deadline', dates()[1]?.value === '', `deadline "${dates()[1]?.value}"`);
    check('...and not the removed start date', !!dates()[0]?.value && dates()[0].value !== '2026-11-01', `start "${dates()[0]?.value}"`);
    check('...and the default study days (Mon-Fri), not the removed ones', days() === 5, `${days()} days on`);

    await open(1, [dated, undated]);
    await open(2);
    check('an unscheduled second project does not show the first one\'s deadline', dates()[1]?.value === '', `deadline "${dates()[1]?.value}"`);
    check('...nor its start date', !!dates()[0]?.value && dates()[0].value !== '2026-11-01', `start "${dates()[0]?.value}"`);

    // A project the store does not hold yet (a refetch in flight): the dialog
    // opens on the defaults, not on the project before it, then fills in.
    await open(1, [dated, undated]);
    await open(3);
    // The plan panel shows nothing until it holds the project, so there is no
    // field that could carry the last project's dates.
    check('a project the store does not hold yet shows no fields, never the last project\'s',
        dates().length === 0 && days() === 0,
        `${dates().length} date fields: ${dates().map(d => d.value).join(', ')}`);
    const maths = { id: 3, name: 'Maths', kind: 'curriculum', start_date: '2026-12-01', deadline: '2027-03-01', study_days: '[6]' };
    await g.act(async () => { g.useStore.setState({ projects: [dated, undated, maths] }); await settle(); });
    check('...and fills in when the project arrives', dates()[1]?.value === '2027-03-01' && dates()[0]?.value === '2026-12-01' && days() === 1,
        `start "${dates()[0]?.value}", deadline "${dates()[1]?.value}", ${days()} days on`);
    w.close();
}

// ---------------------------------------------------------------------------
section('a date marked "cannot move" is read-only in the panel and has no Remove');
{
    const { w, g, host } = page((url) => /\/pace$/.test(url)
        ? { ok: false, status: 500, body: { error: 'down' } }
        : { ok: true, status: 200, body: {} });
    const exam = { id: 7, name: 'Physics', kind: 'curriculum', start_date: '2026-11-01', deadline: '2027-02-01', study_days: '[1,2,3,4,5]', deadline_fixed: 1 };
    const calls = [];
    g.useStore.setState({
        showScheduleModal: false, scheduleModalProjectId: 7, projects: [exam], tree: [], paceData: null,
        setShowScheduleModal: () => { }, scheduleProject: async (...a) => { calls.push(a); return true; },
    });
    g.mount(host, g.h(g.ScheduleModal));
    await g.act(async () => { g.useStore.setState({ showScheduleModal: true }); await settle(); });
    const doc = w.document;
    const deadlineField = () => doc.querySelectorAll('input[type="date"]')[1];
    const buttons = () => [...doc.querySelectorAll('button')].map(b => b.textContent.trim());
    const box = () => doc.querySelector('[role="dialog"] [role="checkbox"], [role="dialog"] input[type="checkbox"]');
    check('the locked deadline is read-only', deadlineField()?.readOnly === true, `readOnly ${deadlineField()?.readOnly}`);
    check('...and the footer has no Remove schedule', !buttons().includes('Remove schedule'), buttons().join(' | '));
    check('a pace that cannot be read says so, with a way to try again',
        doc.querySelector('[role="dialog"] [role="alert"]')?.textContent.includes('Could not read your pace.') && buttons().includes('Try again'),
        doc.querySelector('[role="dialog"]')?.textContent.slice(0, 200));
    // Untick, then Save: the write names the lock as off, so the server lets it go.
    await g.act(async () => { box()?.click(); await settle(); });
    check('unticking frees the field', deadlineField()?.readOnly === false, `readOnly ${deadlineField()?.readOnly}`);
    const saveBtn = [...doc.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save');
    await g.act(async () => { saveBtn?.click(); await settle(); });
    check('Save sends the mark the box shows', calls.length === 1 && calls[0][1]?.deadlineFixed === false, JSON.stringify(calls));
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
section('the course header names the verdict, never the plan\'s day count');
{
    // The header once counted days against the plan, and a drift under half a
    // day read "On plan" in amber. It now shows the verdict on the learner's
    // own pace; the old plan fields are still in the payload and must not leak.
    const { w, g, host } = page();
    const verdict = {
        unit: 'topics', band: 'under_pace', early: false, open: 3, deadline: '2026-11-08', daysLeft: 7,
        needed: 3, recent: 1, best: 4, bestStretch: null, fits: null, weeksOfData: 8, quietWeeks: 0,
        ranges: { recent: null, best: null }, owner: 'learner', fixed: false, offers: [],
    };
    g.useStore.setState({
        paceData: {
            hasSchedule: true, paceStatus: 'falling_behind', expectedProgress: 40, actualProgress: 34,
            startDate: '2026-11-01', deadline: '2026-11-08', drift: 6, totalDays: 7, verdict,
        },
    });
    g.mount(host, g.h(g.PaceIndicator, { full: true }));
    const text = host.textContent;
    check('the header shows the verdict and its reason', /Under pace/.test(text) && /Needs 3 a week/.test(text), text);
    check('...and no day count or "On plan"', !/On plan|days? (behind|ahead)|\d+d (behind|ahead)/.test(text), text);
    await g.act(async () => { g.useStore.setState({ paceData: { hasSchedule: false, verdict: { ...verdict, band: 'no_date' } } }); await settle(); });
    check('a course with no date shows nothing there', host.textContent === '', host.textContent);
    w.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

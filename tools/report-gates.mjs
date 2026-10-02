// tools/report-gates.mjs — Report a problem: the app's form, GitHub's form, and
// the assistant's prompt must name the same fields.
//
// Run:  node tools/report-gates.mjs
//
// The in-app dialog asks the questions the GitHub issue forms ask, and hands the
// answers over as URL parameters named by each form field's `id`
// (src/utils/report.ts → REPORT_FORMS). GitHub drops a parameter with no
// matching field WITHOUT A WORD, so every kind of drift here is silent: a
// renamed id in a template empties its box on every report filed through the
// app; a label reworded on one side asks the learner one question and shows the
// maintainer another; a field id the assistant's prompt still names produces a
// draft whose answer goes nowhere. Three lists, one set of names, asserted.
//
// Then the link itself: GitHub pre-fills only `input` and `textarea` from a URL
// (the form schema's `id` is "the canonical identifier for the field in URL
// query parameter prefills"; dropdowns and checkboxes are ignored), refuses a
// link past its length limit (414 signed in, a failed sign-in round trip past
// ~7,000 characters signed out — measured 2026-09-28), and 404s a link that
// asks for `labels` from someone without triage rights. Each of those is a
// report that silently never happens, so each is asserted.
//
// No DOM, no model, no network.

import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'report-gates-'));
const out = join(scratch, 'report.mjs');
await esbuild.build({
    entryPoints: [join(root, 'src', 'utils', 'report.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
});
const R = await import(pathToFileURL(out).href);
const { REPORT_FORMS, REPORT_KINDS, templateOf, reportUrl, reportText, issueUrl, URL_MAX, CUT_NOTE } = R;

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);

/**
 * The body of an issue form, read by indentation — the forms are written in one
 * shape (`  - type:` at 2, element keys at 4, attributes at 6), so a reader for
 * exactly that shape is enough, and an unexpected shape shows up as a missing
 * field rather than a silent pass.
 */
function readForm(file) {
    const text = readFileSync(file, 'utf8');
    const name = text.match(/^name:\s*(.+)$/m)?.[1].trim() ?? null;
    const elements = [];
    let el = null, block = null;
    for (const line of text.split(/\r?\n/)) {
        let m;
        if ((m = line.match(/^ {2}- type:\s*(\S+)/))) { el = { type: m[1], id: null, label: null, required: false, placeholder: null }; elements.push(el); block = null; continue; }
        if (!el) continue;
        if ((m = line.match(/^ {4}id:\s*(\S+)/))) { el.id = m[1]; continue; }
        if ((m = line.match(/^ {4}(attributes|validations):/))) { block = m[1]; continue; }
        if (block === 'attributes' && (m = line.match(/^ {6}label:\s*(.+)$/))) { el.label = m[1].trim(); continue; }
        if (block === 'attributes' && (m = line.match(/^ {6}placeholder:\s*(.*)$/))) { el.placeholder = m[1].replace(/^[|>][-+]?/, '').trim(); el._ph = true; continue; }
        if (el._ph && (m = line.match(/^ {8}(.*)$/))) { el.placeholder = `${el.placeholder} ${m[1]}`.trim(); continue; }
        if (/^ {6}\S/.test(line)) el._ph = false;
        if (block === 'validations' && (m = line.match(/^ {6}required:\s*(true|false)/))) { el.required = m[1] === 'true'; continue; }
    }
    return { name, elements: elements.filter(e => e.type !== 'markdown') };
}

const tplDir = join(root, '.github', 'ISSUE_TEMPLATE');

section('the app asks what each GitHub form asks, by the same id');
for (const kind of REPORT_KINDS) {
    const form = REPORT_FORMS[kind];
    const file = join(tplDir, templateOf(kind));
    check(`${kind}: its form ${templateOf(kind)} exists`, existsSync(file));
    if (!existsSync(file)) continue;
    const tpl = readForm(file);
    check(`${kind}: the dialog calls the kind what the form calls itself`, tpl.name === form.name, `${tpl.name} vs ${form.name}`);
    const byId = new Map(tpl.elements.map(e => [e.id, e]));
    for (const f of form.fields) {
        const e = byId.get(f.id);
        check(`${kind}: "${f.id}" is a field of the form`, !!e);
        if (!e) continue;
        check(`${kind}: "${f.id}" is the same kind of box (${f.type})`, e.type === f.type, e.type);
        check(`${kind}: "${f.id}" asks the same question`, e.label === f.label, `${JSON.stringify(e.label)} vs ${JSON.stringify(f.label)}`);
        check(`${kind}: "${f.id}" is required on both sides or neither`, e.required === f.required);
    }
    const asked = new Set(form.fields.map(f => f.id));
    const typed = tpl.elements.filter(e => e.type === 'input' || e.type === 'textarea');
    check(`${kind}: every text box on the form is asked in the app`,
        typed.every(e => asked.has(e.id)), typed.filter(e => !asked.has(e.id)).map(e => e.id).join(', '));
    const lists = tpl.elements.filter(e => e.type === 'dropdown' || e.type === 'checkboxes');
    const onGitHub = new Map(form.onGitHub.map(g => [g.id, g]));
    check(`${kind}: every list and tick-box on the form is one the dialog says GitHub will ask`,
        lists.every(e => onGitHub.get(e.id)?.type === e.type && onGitHub.get(e.id)?.label === e.label),
        lists.map(e => `${e.id}:${e.type}:${e.label}`).join(' | '));
    check(`${kind}: the dialog names no list the form does not have`,
        form.onGitHub.every(g => byId.has(g.id)));
    check(`${kind}: no form field lacks an id (an id-less field cannot be pre-filled or checked)`,
        tpl.elements.every(e => e.id));
}

section('the forms\' placeholders are guidance, not a story');
// The idea form's placeholder was a whole scenario ("I study on the train with
// no signal…"): an invented story in a box reads as the expected answer, and
// people bend their report to fit it.
for (const f of readdirSync(tplDir).filter(n => n.endsWith('.yml') && n !== 'config.yml')) {
    for (const e of readForm(join(tplDir, f)).elements) {
        if (!e.placeholder) continue;
        const words = (e.placeholder.match(/\p{L}+/gu) || []).length;
        check(`${f} "${e.id}": its placeholder is at most five words`, words <= 5, JSON.stringify(e.placeholder));
    }
}

section('the assistant\'s prompt names the same fields');
const aiSrc = readFileSync(join(root, 'server', 'ai.js'), 'utf8');
const guide = aiSrc.match(/const PROBLEM_REPORT_GUIDE = `((?:\\[\s\S]|[^`\\])*)`/)?.[1] ?? '';
check('server/ai.js has the report guide in its own constant', guide.length > 200);
check('the global assistant is given it', /\$\{PROBLEM_REPORT_GUIDE\}/.test(aiSrc.slice(aiSrc.indexOf('today_planner:'))));
check('the guide shows the fence the app parses', /\\`\\`\\`report\r?\n/.test(guide) && /kind: bug \| content \| idea/.test(guide));
for (const kind of REPORT_KINDS) {
    const line = guide.match(new RegExp(`^\\s+${kind} — [^:]+: (.+)$`, 'm'))?.[1] ?? '';
    const named = [...line.matchAll(/(?:^|, |\) )([a-z][a-z-]*) \(/g)].map(m => m[1]).sort();
    const writable = REPORT_FORMS[kind].fields.filter(f => !f.auto).map(f => f.id).sort();
    check(`${kind}: the prompt names exactly the fields the model may fill`, JSON.stringify(named) === JSON.stringify(writable),
        `prompt ${named.join(',')} vs app ${writable.join(',')}`);
}
check('the prompt never asks the model for the machine report', !/\benvironment\b/.test(guide));

section('the link GitHub opens');
const ctx = {
    version: { version: '1.0.0', commit: 'a'.repeat(40), commitShort: 'aaaaaaa', builtAt: null, node: '22.15.0',
        platform: 'win32-x64', deployment: 'source', updateCommand: null, repoUrl: 'https://github.com/o/r' },
    aiProvider: 'openai', aiModel: 'z-ai/glm-5.3-flash',
};
const REPO = 'https://github.com/o/r';
const bug = { kind: 'bug', title: 'Study shows an empty screen', fields: { 'what-happened': 'I pressed Study and nothing appeared.', steps: '1. Open a deck\n2. Press Study' } };
const got = reportUrl(REPO, bug, ctx);
const q = new URL(got.url).searchParams;
check('it opens the bug FORM', got.url.startsWith('https://github.com/o/r/issues/new?') && q.get('template') === 'bug_report.yml');
check('the title travels', q.get('title') === 'Study shows an empty screen');
check('each answer travels under its form id', q.get('what-happened') === 'I pressed Study and nothing appeared.' && q.get('steps') === '1. Open a deck\n2. Press Study');
check('the machine report fills the environment box', (q.get('environment') || '').includes('AI model: z-ai/glm-5.3-flash'));
check('an empty answer is left out, not sent blank', !q.has('extra'));
check('no parameter needs triage rights (GitHub 404s the link otherwise)',
    !['labels', 'assignees', 'milestone', 'projects'].some(p => q.has(p)));
check('no list or tick-box is sent (GitHub cannot pre-fill them)',
    !['area', 'frequency', 'surface', 'roadmap'].some(p => q.has(p)));
check('a normal report is not cut', got.shortened.length === 0);
const idea = reportUrl(REPO, { kind: 'idea', title: 'Offline decks', fields: { problem: 'x' } }, ctx);
check('an idea carries no machine report', !new URL(idea.url).searchParams.has('environment'));
check('an answer typed under another kind does not ride along',
    !new URL(reportUrl(REPO, { kind: 'idea', title: 't', fields: { problem: 'p', 'what-happened': 'stray' } }, ctx).url).searchParams.has('what-happened'));
check('the older entry point is the same link with nothing typed',
    issueUrl(REPO, 'bug', ctx) === reportUrl(REPO, { kind: 'bug', title: '', fields: {} }, ctx).url);

section('a report longer than one link can carry');
const longRu = 'Я нажимаю «Учить», и экран остаётся пустым. '.repeat(90);
const long = reportUrl(REPO, { kind: 'bug', title: 'Пустой экран', fields: { 'what-happened': longRu, steps: '1. Открыть колоду' } }, ctx);
check(`the link stays under ${URL_MAX} characters (measured failure starts near 7,000)`, long.url.length <= URL_MAX, String(long.url.length));
check('the cut field is named, so the dialog can say so', long.shortened.map(s => s.id).join() === 'what-happened', JSON.stringify(long.shortened));
const cut = new URL(long.url).searchParams.get('what-happened') || '';
check('the cut field says it was cut, for the reader on GitHub', cut.endsWith(CUT_NOTE.trim()) || cut.endsWith(CUT_NOTE));
check('it keeps as much as fits: most of the budget, not a stub', cut.length > 500, String(cut.length));
check('the short field beside it arrives whole', new URL(long.url).searchParams.get('steps') === '1. Открыть колоду');
check('the machine report arrives whole', (new URL(long.url).searchParams.get('environment') || '').includes('AI model:'));
check('no character is split in half (a surrogate pair survives)',
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(new URL(reportUrl(REPO, { kind: 'bug', title: 't', fields: { 'what-happened': '😀'.repeat(4000) } }, ctx).url).searchParams.get('what-happened') || ''));
const two = reportUrl(REPO, { kind: 'bug', title: 't', fields: { 'what-happened': 'a'.repeat(5000), steps: 'b'.repeat(1200) } }, ctx);
check('the LONGEST field gives way first, and the other is left whole when that suffices',
    two.shortened.length === 1 && two.shortened[0].id === 'what-happened' && new URL(two.url).searchParams.get('steps') === 'b'.repeat(1200));
check('Copy report carries every word the link could not', reportText({ kind: 'bug', title: 'Пустой экран', fields: { 'what-happened': longRu } }, ctx).includes(longRu.trim()));
const text = reportText(bug, ctx);
check('Copy report reads like the issue GitHub renders: the form\'s questions as headings',
    text.startsWith('Study shows an empty screen\n\n### What happened?\n\nI pressed Study') && text.includes('### Version and environment'));

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

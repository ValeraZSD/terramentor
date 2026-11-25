#!/usr/bin/env node
/**
 * tools/merge-robot-gates.mjs — the merge robot merges only what every rule allows.
 *
 * Run:  node tools/merge-robot-gates.mjs
 *
 * Part one replays recorded pull requests (tools/fixtures/merge-robot/, real
 * GitHub answers trimmed to what the rules read) and compares the robot's
 * reasons with ones written by hand from each recording: which labels it has,
 * which checks failed, which main commits after CI touched which of its files.
 *
 * Part two starts from one recording made green by hand (the `automerge` label
 * and an `ai-review` success from Actions added) and changes one fact at a time,
 * each change naming the single reason it must produce.
 *
 * Part three drives main() against a fake GitHub: a dry run sends nothing but
 * GETs; a live run merges one pull request, by the head SHA it judged, with the
 * squash subject and Signed-off-by body, then dispatches Gates on main.
 *
 * No network: every call goes to the recordings or the fake.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    CONFIG, collect, decide, replaying, makeApi, main, globRe, matchesAny, signoffs, commitMessage, labelState, latestRuns,
} from './merge-robot.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, 'fixtures', 'merge-robot');
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ok    ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const load = (n) => JSON.parse(readFileSync(join(fixtureDir, `pr-${n}.json`), 'utf8'));
const factsOf = async (n) => { const fx = load(n); return collect(replaying(fx.book), fx.repo, fx.number); };
const codes = (v) => [...new Set(v.reasons.map((r) => r.code))].sort();
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const text = (v) => v.reasons.map((r) => r.text).join(' | ');

// ---------------------------------------------------------------- part one: recordings
console.log('recorded pull requests');
{
    // #331: no labels; GitHub says dirty; no ai-review status; main commit b4c2c00
    // (after CI started on 21 Nov 14:14) rewrote server/auth.js and server/hosted.js, both in the PR.
    const v = decide(await factsOf(331));
    check('#331 skips for label, review, conflict and main', same(codes(v), ['no-label', 'review', 'conflict', 'main']), codes(v).join(','));
    check('#331 names b4c2c00 and a file it shares', /b4c2c00/.test(text(v)) && /server\/(auth|hosted)\.js/.test(text(v)), text(v));
    check('#331 is not steered by labels (no automerge)', !v.addLabels.length && !v.removeLabels.length);
}
{
    // #358: a draft; signoff and both Node jobs failed; GitHub says blocked; no main commit after
    // CI touched tools/model-bench/** (later commits are UI, docs and the release).
    const v = decide(await factsOf(358));
    check('#358 skips for draft, label, checks, review, blocked', same(codes(v), ['draft', 'no-label', 'checks', 'review', 'mergeable']), codes(v).join(','));
    for (const ctx of ['signoff', 'Node 24 on ubuntu-latest', 'Node 24 on windows-latest']) {
        check(`#358 lists ${ctx} as failed`, v.reasons.some((r) => r.code === 'checks' && r.text === `${ctx} failure`), text(v));
    }
    check('#358 does not blame the green ones', !v.reasons.some((r) => /^(check|license\/cla) /.test(r.text)));
}
{
    // #364: changes AssistantDrawer.tsx and en.json; `visual-seen` went on at 11:48:51, after its last
    // commit (11:44:06); main's later commits do not touch its files. Only the label and review miss.
    const v = decide(await factsOf(364));
    check('#364 skips only for label and review', same(codes(v), ['no-label', 'review']), codes(v).join(','));
}
{
    // #365: visual (en.json) and seen; Node ubuntu failed once and passed on a re-run;
    // main commit e6f6945 (25 Nov, after CI on 24 Nov) changed src/types.ts, which the PR also changes.
    // 624513a landed at 21:36:34, before CI started at 21:37:48, so it does not count.
    const v = decide(await factsOf(365));
    check('#365 skips for label, review and main', same(codes(v), ['no-label', 'review', 'main']), codes(v).join(','));
    check('#365 names e6f6945 and src/types.ts', /e6f6945/.test(text(v)) && /src\/types\.ts/.test(text(v)), text(v));
    check('#365 does not name 624513a (before CI)', !/624513a/.test(text(v)));
    check('#365 takes the re-run of Node ubuntu, not the failed attempt', !v.reasons.some((r) => r.code === 'checks'));
}
{
    // #367: server and docs only (not visual); every required check green (ubuntu after a re-run);
    // the main commits after CI do not touch its files.
    const v = decide(await factsOf(367));
    check('#367 skips only for label and review', same(codes(v), ['no-label', 'review']), codes(v).join(','));
}

// ---------------------------------------------------------------- part two: one fact at a time
console.log('one fact at a time, from a green #367');
const AI_OK = { context: 'ai-review', state: 'success', description: 'no blocking findings', created_at: '2026-11-25T13:30:00Z', creator: { login: 'github-actions[bot]' } };
const base367 = await factsOf(367);
const green = () => {
    const f = structuredClone(base367);
    f.pull.labels.push({ name: 'automerge' });
    f.statuses.push(structuredClone(AI_OK));
    return f;
};
const only = (name, mutate, expect) => {
    const f = green();
    mutate(f);
    const v = decide(f);
    check(name, expect === 'MERGE' ? v.merge : same(codes(v), [expect]), `${v.merge ? 'MERGE' : codes(v).join(',')}: ${text(v)}`);
    return v;
};
{
    const v = decide(green());
    check('green #367 merges', v.merge, text(v));
    const msg = commitMessage(green());
    check('subject is the title plus (#367)', msg.title === "Keep learner text out of a site operator's log (#367)", msg.title);
    check('body is the one Signed-off-by line, once', msg.message === 'Signed-off-by: ValeraZSD <valerazsd@gmail.com>', JSON.stringify(msg.message));
}
only('a hold label stops it', (f) => f.pull.labels.push({ name: 'hold' }), 'hold');
only('a release label stops it', (f) => f.pull.labels.push({ name: 'release' }), 'reserved');
only('a draft stops it', (f) => { f.pull.draft = true; }, 'draft');
only('a closed pull request stops it', (f) => { f.pull.state = 'closed'; }, 'closed');
only('a fork stops it', (f) => { f.pull.head.repo.full_name = 'someone/terramentor'; }, 'fork');
only('without automerge it waits', (f) => { f.pull.labels = []; }, 'no-label');
only('an ai-review failure stops it', (f) => { f.statuses.at(-1).state = 'failure'; }, 'review');
only('an ai-review pending stops it', (f) => { f.statuses.at(-1).state = 'pending'; }, 'review');
only('an ai-review set by a person does not count', (f) => { f.statuses.at(-1).creator.login = 'ValeraZSD'; }, 'review');
only('a later ai-review failure beats an earlier success', (f) => f.statuses.push({ ...AI_OK, state: 'failure', created_at: '2026-11-25T14:00:00Z' }), 'review');
only('a red required check stops it', (f) => f.checkRuns.push({ id: 9e9, name: 'check', status: 'completed', conclusion: 'failure', started_at: '2026-11-25T15:00:00Z', app: 'github-actions' }), 'checks');
only('a required check still running stops it', (f) => f.checkRuns.push({ id: 9e9, name: 'signoff', status: 'in_progress', conclusion: null, started_at: '2026-11-25T15:00:00Z', app: 'github-actions' }), 'checks');
only('a missing required check stops it', (f) => { f.checkRuns = f.checkRuns.filter((r) => r.name !== 'Node 24 on windows-latest'); }, 'checks');
only('the CLA status failing stops it', (f) => f.statuses.push({ context: 'license/cla', state: 'failure', created_at: '2026-11-25T15:00:00Z', creator: { login: 'x' } }), 'checks');
only('a red check outside the required list stops it', (f) => f.checkRuns.push({ id: 9e9, name: 'Docker image', status: 'completed', conclusion: 'failure', started_at: '2026-11-25T15:00:00Z', app: 'github-actions' }), 'checks');
only('a non-required check still running stops it', (f) => f.checkRuns.push({ id: 9e9, name: 'Docker image', status: 'queued', conclusion: null, started_at: '2026-11-25T15:00:00Z', app: 'github-actions' }), 'checks');
only('a red CodeRabbit run is advisory', (f) => f.checkRuns.push({ id: 9e9, name: 'CodeRabbit', status: 'completed', conclusion: 'failure', started_at: '2026-11-25T15:00:00Z', app: 'coderabbitai' }), 'MERGE');
only('GitHub saying conflict stops it', (f) => { f.pull.mergeable = false; f.pull.mergeable_state = 'dirty'; }, 'conflict');
only('mergeability not worked out yet waits', (f) => { f.pull.mergeable = null; }, 'mergeable');
only('a blocked merge waits', (f) => { f.pull.mergeable_state = 'blocked'; }, 'mergeable');

const mainCommit = (files, extra = {}) => ({ sha: 'f'.repeat(40), date: '2026-11-25T23:00:00Z', files, truncated: false, ...extra });
{
    const v = only('main changing one of its files after CI stops it', (f) => f.mainAfterCi.push(mainCommit(['server/slowLog.js'])), 'main');
    check('and asks for needs-main-merge', same(v.addLabels, ['needs-main-merge']), JSON.stringify(v.addLabels));
}
only('main changing other files after CI is fine', (f) => f.mainAfterCi.push(mainCommit(['src/components/Sidebar.tsx'])), 'MERGE');
only('a main commit listing 300+ files stops it', (f) => f.mainAfterCi.push(mainCommit(['README.md'], { truncated: true })), 'main');
only('main further ahead than GitHub lists stops it', (f) => { f.mainAhead = 300; f.mainListed = 250; }, 'main');
only('no required check ever started stops it', (f) => { f.ciStart = null; }, 'main');
{
    const v = only('a stale needs-main-merge label comes off', (f) => f.pull.labels.push({ name: 'needs-main-merge' }), 'MERGE');
    check('removeLabels says so', same(v.removeLabels, ['needs-main-merge']), JSON.stringify(v.removeLabels));
}
{
    // collect() itself: a main commit dated before CI started is not read at all.
    const fx = load(367);
    const facts = await collect(replaying(fx.book), fx.repo, fx.number);
    check('collect reads only main commits after CI started', same(facts.mainAfterCi.map((c) => c.sha.slice(0, 7)), ['e6f6945', '1d894c4', 'b5839f2']),
        facts.mainAfterCi.map((c) => c.sha.slice(0, 7)).join(','));
    check('collect dates CI from the first required attempt (11:19:19)', facts.ciStart === '2026-11-25T11:19:19Z', facts.ciStart);
}

const addFile = (f, filename, extra = {}) => { f.files.push({ filename, status: 'modified', ...extra }); f.pull.changed_files += 1; };
{
    const v = only('a component change without visual-seen stops it', (f) => addFile(f, 'src/components/Foo.tsx'), 'visual');
    check('and asks for needs-visual-seen', same(v.addLabels, ['needs-visual-seen']), JSON.stringify(v.addLabels));
}
only('en.json counts as visual', (f) => addFile(f, 'src/locales/en.json'), 'visual');
only('a screenshot counts as visual', (f) => addFile(f, 'docs/screenshots/new-shot.webp'), 'visual');
only('a component test does not', (f) => addFile(f, 'src/components/Foo.test.tsx'), 'MERGE');
only('a nested locale other than en.json does not', (f) => addFile(f, 'src/locales/nl.json'), 'MERGE');
const seenAt = (f, at) => { f.pull.labels.push({ name: 'visual-seen' }); f.events.push({ event: 'labeled', label: { name: 'visual-seen' }, created_at: at }); };
{
    const v = only('visual-seen lets a visual change through', (f) => { addFile(f, 'src/components/Foo.tsx'); seenAt(f, '2026-11-25T12:00:00Z'); }, 'MERGE');
    check('no label asked for then', !v.addLabels.length);
}
only('a visual commit after visual-seen makes it stale', (f) => {
    addFile(f, 'src/components/Foo.tsx'); seenAt(f, '2026-11-25T12:00:00Z');
    f.afterSeen = [{ sha: 'e'.repeat(40), files: ['src/components/Foo.tsx'] }];
}, 'visual');
only('a server-only commit after visual-seen does not', (f) => {
    addFile(f, 'src/components/Foo.tsx'); seenAt(f, '2026-11-25T12:00:00Z');
    f.afterSeen = [{ sha: 'e'.repeat(40), files: ['server/app.js'] }];
}, 'MERGE');
only('visual-seen removed again does not count', (f) => {
    addFile(f, 'src/components/Foo.tsx'); seenAt(f, '2026-11-25T12:00:00Z');
    f.pull.labels = f.pull.labels.filter((l) => l.name !== 'visual-seen');
    f.events.push({ event: 'unlabeled', label: { name: 'visual-seen' }, created_at: '2026-11-25T12:10:00Z' });
}, 'visual');
{
    const v = only('a stale needs-visual-seen comes off when nothing is visual', (f) => f.pull.labels.push({ name: 'needs-visual-seen' }), 'MERGE');
    check('removeLabels says so', same(v.removeLabels, ['needs-visual-seen']));
}

for (const p of ['.github/workflows/gates.yml', '.github/CODEOWNERS', 'tools/merge-robot.mjs', 'tools/ai-review.mjs', 'tools/no-ai-attribution.mjs', '.coderabbit.yaml']) {
    only(`changing ${p} is merged by hand`, (f) => addFile(f, p), 'by-hand');
}
only('the robot\'s own tests are not machinery', (f) => addFile(f, 'tools/merge-robot-gates.mjs'), 'MERGE');
only('a title like "Release 1.7.0" is a release', (f) => { f.pull.title = 'Release 1.7.0'; }, 'release');
only('a title like "v1.7.0" is a release', (f) => { f.pull.title = 'v1.7.0 notes'; }, 'release');
// main's release commit b5839f2 (after CI) changed package.json, so these start from a main that did not.
only('a package.json "version" change is a release', (f) => (f.mainAfterCi = []) && addFile(f, 'package.json', { patch: '@@ -2,3 +2,3 @@\n-  "version": "1.6.0",\n+  "version": "1.7.0",' }), 'release');
only('a package.json dependency change is not', (f) => (f.mainAfterCi = []) && addFile(f, 'package.json', { patch: '@@ -20,3 +20,3 @@\n-    "zod": "^4.1.0",\n+    "zod": "^4.2.0",' }), 'MERGE');
only('a 50-character title fits', (f) => { f.pull.title = 'x'.repeat(50); }, 'MERGE');
only('a 51-character title does not', (f) => { f.pull.title = 'x'.repeat(51); }, 'title');
// The squash body is only the Signed-off-by lines, so the title is the one way an attribution line could get in.
only('an attribution line as the title stops it', (f) => { f.pull.title = 'Generated with Claude Code'; }, 'attribution');
only('a commit trailer does not reach the squash message', (f) => {
    f.commits.at(-1).commit.message += '\nCo-Authored-By: Claude <noreply@anthropic.com>';
}, 'MERGE');
only('more files than GitHub listed stops it', (f) => { f.pull.changed_files = 3001; }, 'files');
{
    const f = green();
    f.pull.labels = []; f.mainAfterCi.push(mainCommit(['server/slowLog.js'])); addFile(f, 'src/components/Foo.tsx');
    const v = decide(f);
    check('without automerge no labels are steered', !v.addLabels.length && !v.removeLabels.length, JSON.stringify(v));
    check('every reason is listed, not only the first', same(codes(v), ['no-label', 'visual', 'main']), codes(v).join(','));
}

// ---------------------------------------------------------------- helpers
console.log('helpers');
check('signoffs: unique, in order, merge commits skipped', JSON.stringify(signoffs([
    { parents: [{}], commit: { message: 'a\n\nSigned-off-by: A <a@x.org>' } },
    { parents: [{}, {}], commit: { message: 'Merge main\n\nSigned-off-by: M <m@x.org>' } },
    { parents: [{}], commit: { message: 'b\n\nSigned-off-by: B <b@x.org>\nSigned-off-by: A <a@x.org>' } },
])) === JSON.stringify(['Signed-off-by: A <a@x.org>', 'Signed-off-by: B <b@x.org>']));
check('glob ** crosses folders', globRe('src/components/**').test('src/components/a/b/C.tsx'));
check('glob * stays in one folder', !globRe('src/*.css').test('src/a/b.css') && globRe('src/**/*.css').test('src/a/b.css') && globRe('src/**/*.css').test('src/b.css'));
check('glob braces expand', matchesAny('docs/a/b.webp', ['docs/**/*.{png,webp}']) && !matchesAny('docs/a/b.md', ['docs/**/*.{png,webp}']));
check('glob dots are literal', !globRe('index.html').test('indexXhtml'));
check('labelState: labelled with no events is on', labelState([], ['x'], 'x').on);
check('labelState: label then unlabel is off', !labelState([{ event: 'labeled', label: { name: 'x' }, created_at: '1' }, { event: 'unlabeled', label: { name: 'x' }, created_at: '2' }], [], 'x').on);
check('latestRuns keeps the newest attempt', latestRuns([
    { id: 1, name: 'a', started_at: '2026-01-02', conclusion: 'success' }, { id: 2, name: 'a', started_at: '2026-01-01', conclusion: 'failure' },
]).get('a').conclusion === 'success');
{
    let called = 0;
    const api = makeApi({ token: 't', fetch: async () => { called++; return { ok: true, status: 200, text: async () => '{}' }; }, readOnly: true });
    let refused = 0;
    for (const call of [() => api.post('/x', {}), () => api.put('/x', {}), () => api.del('/x')]) {
        try { await call(); } catch (e) { if (/read-only/.test(e.message)) refused++; }
    }
    check('the read-only client refuses POST, PUT and DELETE before any request', refused === 3 && called === 0, `${refused} refused, ${called} sent`);
}

// ---------------------------------------------------------------- part three: main()
console.log('main() against a fake GitHub');
const API = 'https://api.github.com';
const MERGED_SHA = 'd'.repeat(40);
/** A GitHub that answers from recorded books, merges, and records every call. */
function fakeGitHub(books, { mergeStatus = 200, author = 'ValeraZSD' } = {}) {
    const calls = [];
    const all = Object.assign({}, ...books.map((b) => b.book));
    const pulls = books.map((b) => Object.entries(b.book).find(([k]) => /\/pulls\/\d+$/.test(k))[1]);
    const reply = (status, body) => ({ ok: status < 300, status, text: async () => (body == null ? '' : JSON.stringify(body)) });
    const fetch = async (url, init) => {
        const path = url.slice(API.length);
        calls.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : null });
        if (init.method === 'GET') {
            if (/\/pulls\?state=open/.test(path)) return reply(200, /page=1$/.test(path) ? pulls : []);
            if (path.endsWith(`/commits/${MERGED_SHA}`)) return reply(200, { sha: MERGED_SHA, author: { login: author }, files: [] });
            if (path in all) return reply(200, all[path]);
            return reply(404, { message: `not faked: ${path}` });
        }
        if (init.method === 'PUT' && /\/merge$/.test(path)) return mergeStatus === 200 ? reply(200, { sha: MERGED_SHA, merged: true }) : reply(mergeStatus, { message: 'Head branch was modified' });
        if (init.method === 'POST' && /\/dispatches$/.test(path)) return reply(204, null);
        if (init.method === 'POST' && /\/labels$/.test(path)) return reply(200, []);
        return reply(404, { message: `not faked: ${init.method} ${path}` });
    };
    return { fetch, calls };
}
/** Recording #367 made green: labelled automerge, ai-review success. Optionally renumbered. */
function greenBook(number = 367) {
    const fx = load(367);
    const book = {};
    for (const [k, v] of Object.entries(fx.book)) {
        const key = k.replace(/\/(pulls|issues)\/367(?=\/|$)/, `/$1/${number}`);
        book[key] = structuredClone(v);
        if (/\/pulls\/\d+$/.test(key)) { book[key].number = number; book[key].labels = [{ name: 'automerge' }]; }
        if (/\/statuses\?/.test(key)) book[key].push(structuredClone(AI_OK));
    }
    return { repo: fx.repo, number, book };
}
const run = async (env, fake, argv = ['--repo', 'ValeraZSD/terramentor']) => {
    const lines = [];
    const code = await main(argv, { GITHUB_TOKEN: 'fake', ...env }, (l) => lines.push(l), fake.fetch);
    return { code, out: lines.join('\n') };
};
{
    const fake = fakeGitHub([greenBook()]);
    const { code, out } = await run({}, fake);
    check('dry run (MERGE_ROBOT unset) says it would merge #367', code === 0 && /Would merge #367/.test(out) && /dry run/.test(out), out);
    check('dry run sends only GETs', fake.calls.every((c) => c.method === 'GET'), fake.calls.filter((c) => c.method !== 'GET').map((c) => c.method).join(','));
}
{
    const fake = fakeGitHub([greenBook()]);
    const { out } = await run({ MERGE_ROBOT: 'on' }, fake, ['--repo', 'ValeraZSD/terramentor', '--dry-run']);
    check('--dry-run wins over MERGE_ROBOT=on', fake.calls.every((c) => c.method === 'GET') && /Would merge/.test(out), out);
}
{
    const fake = fakeGitHub([greenBook()]);
    await run({ MERGE_ROBOT: 'yes' }, fake);
    check('MERGE_ROBOT must be exactly "on"', fake.calls.every((c) => c.method === 'GET'));
}
{
    const fake = fakeGitHub([greenBook(), greenBook(9367)]);
    const { code, out } = await run({ MERGE_ROBOT: 'on' }, fake);
    const puts = fake.calls.filter((c) => c.method === 'PUT');
    check('live: exactly one merge per run', code === 0 && puts.length === 1, `${puts.length} merges`);
    const m = puts[0]?.body || {};
    check('live: merges the oldest (#367)', puts[0]?.path === '/repos/ValeraZSD/terramentor/pulls/367/merge', puts[0]?.path);
    check('live: squash, pinned to the judged head', m.merge_method === 'squash' && m.sha === 'a69449c4df6c92f2abc705b8ed8370f99c8282b1', JSON.stringify(m));
    check('live: subject and Signed-off-by body', m.commit_title === "Keep learner text out of a site operator's log (#367)" && m.commit_message === 'Signed-off-by: ValeraZSD <valerazsd@gmail.com>', JSON.stringify(m));
    const dispatch = fake.calls.find((c) => c.method === 'POST' && /dispatches$/.test(c.path));
    check('live: dispatches gates.yml on main after the merge', dispatch?.path === '/repos/ValeraZSD/terramentor/actions/workflows/gates.yml/dispatches' && dispatch.body.ref === 'main',
        JSON.stringify(dispatch));
    check('live: reports the squash commit\'s author', /Author of ddddddd: ValeraZSD/.test(out), out);
}
{
    const fake = fakeGitHub([greenBook()], { author: 'github-actions[bot]' });
    const { out } = await run({ MERGE_ROBOT: 'on' }, fake);
    check('live: warns when the author is not the opener', /::warning::the squash commit's author is github-actions\[bot\]/.test(out), out);
}
{
    const fake = fakeGitHub([greenBook()], { mergeStatus: 409 });
    const { code, out } = await run({ MERGE_ROBOT: 'on' }, fake);
    check('live: a 409 (head moved) is reported, nothing dispatched, run ends 0',
        code === 0 && /GitHub refused to merge #367/.test(out) && !fake.calls.some((c) => /dispatches$/.test(c.path)), out);
}
{
    const b = greenBook();
    const filesKey = Object.keys(b.book).find((k) => /\/files\?/.test(k));
    b.book[filesKey].push({ filename: 'src/components/Foo.tsx', status: 'modified' });
    Object.entries(b.book).find(([k]) => /\/pulls\/\d+$/.test(k))[1].changed_files += 1;
    const fake = fakeGitHub([b]);
    const { out } = await run({ MERGE_ROBOT: 'on' }, fake);
    const label = fake.calls.find((c) => c.method === 'POST' && /\/labels$/.test(c.path));
    check('live: a visual change gets needs-visual-seen and no merge',
        label?.body?.labels?.[0] === 'needs-visual-seen' && !fake.calls.some((c) => c.method === 'PUT'), out);
}
{
    const b = greenBook();
    Object.entries(b.book).find(([k]) => /\/pulls\/\d+$/.test(k))[1].labels = [];
    const fake = fakeGitHub([b]);
    const { out } = await run({ MERGE_ROBOT: 'on' }, fake);
    const reads = fake.calls.filter((c) => !/\/pulls\?state=open/.test(c.path));
    check('an unlabelled pull request is not even read', reads.length === 0 && /Nothing to merge/.test(out) && !fake.calls.some((c) => c.method !== 'GET'), `${reads.length} reads: ${out}`);
}
{
    const fake = fakeGitHub([greenBook()]);
    const { out } = await run({ MERGE_ROBOT_REQUIRED: 'check, Shard 1 of 4' }, fake);
    check('MERGE_ROBOT_REQUIRED replaces the required list', /Shard 1 of 4 has not reported/.test(out) && /Nothing to merge/.test(out), out);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

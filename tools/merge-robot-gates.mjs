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
    mainSince, pushTimes,
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
    // #331: no labels; GitHub says dirty; no ai-review status; its head was pushed on 21 Nov and
    // main has since taken 17 merges that change 300+ files, more than GitHub lists in one comparison.
    const v = decide(await factsOf(331));
    check('#331 skips for label, review, conflict and main', same(codes(v), ['no-label', 'review', 'conflict', 'main']), codes(v).join(','));
    check('#331 cannot list what main changed, so it asks for main', /300 or more files/.test(text(v)), text(v));
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
    // push (first run 11:44:17); main's merges since (e6f6945, 1d894c4, b5839f2) do not touch its
    // files. Only the label and review miss.
    const v = decide(await factsOf(364));
    check('#364 skips only for label and review', same(codes(v), ['no-label', 'review']), codes(v).join(','));
}
{
    // #365: visual (en.json) and seen; Node ubuntu failed once and passed on a re-run; head pushed
    // 24 Nov 21:37:45. Main's merges after that (e6f6945 on 25 Nov changed src/types.ts, which the
    // PR also changes) count; so does 624513a, merged 70 s before the push, inside the 2-minute margin.
    const v = decide(await factsOf(365));
    check('#365 skips for label, review and main', same(codes(v), ['no-label', 'review', 'main']), codes(v).join(','));
    check('#365 names src/types.ts and starts from 624513a', /src\/types\.ts/.test(text(v)) && /\(624513a, e6f6945/.test(text(v)), text(v));
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
const addFile = (f, filename, extra = {}) => { f.files.push({ filename, status: 'modified', ...extra }); f.pull.changed_files += 1; };
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
    check('body is the one Signed-off-by line, once', msg.message === 'Signed-off-by: ValeraZSD <owner@example.test>', JSON.stringify(msg.message));
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
const status = (context, state, at = '2026-11-25T15:00:00Z') => ({ context, state, created_at: at, creator: { login: 'x' } });
only('another status failing stops it', (f) => f.statuses.push(status('security-scan', 'failure')), 'checks');
only('another status pending stops it', (f) => f.statuses.push(status('security-scan', 'pending')), 'checks');
only('another status green keeps it', (f) => f.statuses.push(status('security-scan', 'success')), 'MERGE');
only('a status green after its failure keeps it', (f) => f.statuses.push(status('security-scan', 'failure'), status('security-scan', 'success', '2026-11-25T16:00:00Z')), 'MERGE');
only('a CodeRabbit status is advisory', (f) => f.statuses.push(status('CodeRabbit', 'pending')), 'MERGE');
only('the CLA status failing stops it',(f) => f.statuses.push({ context: 'license/cla', state: 'failure', created_at: '2026-11-25T15:00:00Z', creator: { login: 'x' } }), 'checks');
only('a red check outside the required list stops it', (f) => f.checkRuns.push({ id: 9e9, name: 'Docker image', status: 'completed', conclusion: 'failure', started_at: '2026-11-25T15:00:00Z', app: 'github-actions' }), 'checks');
only('a non-required check still running stops it', (f) => f.checkRuns.push({ id: 9e9, name: 'Docker image', status: 'queued', conclusion: null, started_at: '2026-11-25T15:00:00Z', app: 'github-actions' }), 'checks');
only('a red CodeRabbit run is advisory', (f) => f.checkRuns.push({ id: 9e9, name: 'CodeRabbit', status: 'completed', conclusion: 'failure', started_at: '2026-11-25T15:00:00Z', app: 'coderabbitai' }), 'MERGE');
only('GitHub saying conflict stops it', (f) => { f.pull.mergeable = false; f.pull.mergeable_state = 'dirty'; }, 'conflict');
only('mergeability not worked out yet waits', (f) => { f.pull.mergeable = null; }, 'mergeable');
only('a blocked merge waits', (f) => { f.pull.mergeable_state = 'blocked'; }, 'mergeable');

const mainFiles = (files) => (f) => { f.mainMoved = { known: true, before: 'b'.repeat(40), commits: ['f'.repeat(40)], files }; };
{
    const v = only('main changing one of its files after CI stops it', mainFiles(['server/slowLog.js']), 'main');
    check('and asks for needs-main-merge', same(v.addLabels, ['needs-main-merge']), JSON.stringify(v.addLabels));
}
only('main changing other files after CI is fine', mainFiles(['src/components/Sidebar.tsx']), 'MERGE');
only('main changing the old name of a file it renames stops it', (f) => {
    f.files[0].previous_filename = 'server/oldName.js'; mainFiles(['server/oldName.js'])(f);
}, 'main');
only('main unknown since CI stops it', (f) => { f.mainMoved = { known: false, why: 'main was rewritten after CI started' }; }, 'main');
{
    const v = only('a stale needs-main-merge label comes off', (f) => f.pull.labels.push({ name: 'needs-main-merge' }), 'MERGE');
    check('removeLabels says so', same(v.removeLabels, ['needs-main-merge']), JSON.stringify(v.removeLabels));
}
only('a pull request into another branch is not merged', (f) => { f.pull.base.ref = 'feat/photo-courses'; }, 'base');
only('a lock file change is merged by hand', (f) => { mainFiles([])(f); addFile(f, 'package-lock.json'); }, 'by-hand');
{
    // collect() itself, from the recording: the head's push time is its first run; main's
    // merges are read from the activity log after that time less the margin.
    const fx = load(367);
    const facts = await collect(replaying(fx.book), fx.repo, fx.number);
    check('collect dates CI from the first run on the head (11:19:16)', facts.ciStart === '2026-11-25T11:19:16Z', facts.ciStart);
    check('collect lists the merges after it (e6f6945, 1d894c4, b5839f2) from 624513a',
        facts.mainMoved.known && facts.mainMoved.before.startsWith('624513a')
        && same(facts.mainMoved.commits.map((c) => c.slice(0, 7)), ['e6f6945', '1d894c4', 'b5839f2']), JSON.stringify(facts.mainMoved));
    const noRuns = structuredClone(fx.book);
    for (const k of Object.keys(noRuns)) if (/\/actions\/runs\?/.test(k)) noRuns[k] = { workflow_runs: [] };
    const blind = await collect(replaying(noRuns), fx.repo, fx.number);
    check('no run on the head: what CI tested is unknown', !blind.mainMoved.known && decide(blind).reasons.some((r) => r.code === 'main'));
}

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
only('a .gitattributes change is merged by hand', (f) => addFile(f, '.gitattributes'), 'by-hand');
only('renaming the review rules away is merged by hand', (f) => addFile(f, 'docs/x.txt', { status: 'renamed', previous_filename: '.coderabbit.yaml' }), 'by-hand');
only('renaming a workflow away is merged by hand', (f) => addFile(f, 'docs/old.yml', { status: 'renamed', previous_filename: '.github/workflows/gates.yml' }), 'by-hand');
only('renaming a component out of src is visual', (f) => addFile(f, 'docs/Foo.txt', { status: 'renamed', previous_filename: 'src/components/Foo.tsx' }), 'visual');
only('the robot\'s own tests are not machinery', (f) => addFile(f, 'tools/merge-robot-gates.mjs'), 'MERGE');
only('a title like "Release 1.7.0" is a release', (f) => { f.pull.title = 'Release 1.7.0'; }, 'release');
only('a title like "v1.7.0" is a release', (f) => { f.pull.title = 'v1.7.0 notes'; }, 'release');
// main's release commit b5839f2 (after CI) changed package.json, so these start from a main that did not.
only('a package.json "version" change is a release', (f) => mainFiles([])(f) || addFile(f, 'package.json', { patch: '@@ -2,3 +2,3 @@\n-  "version": "1.6.0",\n+  "version": "1.7.0",' }), 'release');
only('a package.json dependency change is not', (f) => mainFiles([])(f) || addFile(f, 'package.json', { patch: '@@ -20,3 +20,3 @@\n-    "zod": "^4.1.0",\n+    "zod": "^4.2.0",' }), 'MERGE');
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
    f.pull.labels = []; mainFiles(['server/slowLog.js'])(f); addFile(f, 'src/components/Foo.tsx');
    const v = decide(f);
    check('without automerge no labels are steered', !v.addLabels.length && !v.removeLabels.length, JSON.stringify(v));
    check('every reason is listed, not only the first', same(codes(v), ['no-label', 'visual', 'main']), codes(v).join(','));
}

// ---------------------------------------------------------------- collect(): visual-seen against push times
console.log('visual-seen against push times (from #364)');
{
    // #364 as recorded: visual-seen at 11:48:51, its head 007e35c first run at 11:44:17.
    const fx = load(364);
    const key = (re) => Object.keys(fx.book).find((k) => re.test(k));
    const head = fx.book[key(/\/pulls\/364$/)].head.sha;
    const variant = (edit) => { const b = structuredClone(fx.book); edit(b); return collect(replaying(b), fx.repo, 364); };
    const asIs = await variant(() => {});
    check('as recorded, nothing was pushed after visual-seen', asIs.afterSeen.length === 0 && !asIs.seenUnknown);

    // The label went on at 11:40, before the head's push at 11:44:17. The head's commit date is moved
    // to 11:00, so only the push time can tell that it went up after the label.
    const late = await variant((b) => {
        b[key(/\/issues\/364\/events/)] = [{ event: 'labeled', label: { name: 'visual-seen' }, created_at: '2026-11-25T11:40:00Z' }];
        b[key(/\/pulls\/364\/commits/)].at(-1).commit.committer.date = '2026-11-25T11:00:00Z';
        b[`/repos/${fx.repo}/commits/${head}`] = { sha: head, files: [{ filename: 'src/components/AssistantDrawer.tsx' }] };
    });
    check('a commit dated before the label but pushed after it is read', late.afterSeen.map((c) => c.sha).join() === head, JSON.stringify(late.afterSeen));
    check('and makes the visual change stale', decide(late).reasons.some((r) => r.code === 'visual' && /changed after/.test(r.text)), text(decide(late)));

    // 100 other events on the first page, the label on the second: both pages are read.
    const paged = await variant((b) => {
        delete b[key(/\/issues\/364\/events/)];
        b[`/repos/${fx.repo}/issues/364/events?per_page=100&page=1`] = Array.from({ length: 100 }, () => ({ event: 'head_ref_force_pushed', created_at: '2026-11-25T11:00:00Z' }));
        b[`/repos/${fx.repo}/issues/364/events?per_page=100&page=2`] = [{ event: 'labeled', label: { name: 'visual-seen' }, created_at: '2026-11-25T11:40:00Z' }];
        b[`/repos/${fx.repo}/commits/${head}`] = { sha: head, files: [{ filename: 'src/components/AssistantDrawer.tsx' }] };
    });
    check('the label event on the second page of events is found', paged.events.length === 101 && paged.afterSeen.length === 1, `${paged.events.length} events`);

    // Labelled, but no record of when: every commit counts as after it.
    const noRecord = await variant((b) => {
        b[key(/\/issues\/364\/events/)] = [];
        for (const c of b[key(/\/pulls\/364\/commits/)]) {
            b[`/repos/${fx.repo}/commits/${c.sha}`] = { sha: c.sha, files: [{ filename: 'src/hooks/useStickToBottom.ts' }] };
            for (const p of c.parents.slice(1)) b[`/repos/${fx.repo}/compare/${p.sha}...${c.sha}`] = { files: [] };
        }
        b[`/repos/${fx.repo}/commits/${head}`] = { sha: head, files: [{ filename: 'src/components/AssistantDrawer.tsx' }] };
    });
    check('a label with no event on record does not excuse anything', decide(noRecord).reasons.some((r) => r.code === 'visual'), text(decide(noRecord)));

    // Ten full pages of events, the most the robot reads: the label may have come off later unseen.
    const capped = await variant((b) => {
        delete b[key(/\/issues\/364\/events/)];
        for (let p = 1; p <= 10; p++) {
            b[`/repos/${fx.repo}/issues/364/events?per_page=100&page=${p}`] = Array.from({ length: 100 }, (_, i) => (p === 1 && i === 0
                ? { event: 'labeled', label: { name: 'visual-seen' }, created_at: '2026-11-25T11:40:00Z' }
                : { event: 'head_ref_force_pushed', created_at: '2026-11-25T11:00:00Z' }));
        }
        b[`/repos/${fx.repo}/commits/${head}`] = { sha: head, files: [{ filename: 'src/components/AssistantDrawer.tsx' }] };
    });
    check('a label history longer than the robot reads stops a visual change',
        decide(capped).reasons.some((r) => r.code === 'visual' && /longer than the robot reads/.test(r.text)), text(decide(capped)));

    // The label went on at 11:40 and the head was pushed at 11:44:17; what the head changed decides.
    const afterLabel = (files, more = () => {}) => variant((b) => {
        b[key(/\/issues\/364\/events/)] = [{ event: 'labeled', label: { name: 'visual-seen' }, created_at: '2026-11-25T11:40:00Z' }];
        b[`/repos/${fx.repo}/commits/${head}`] = { sha: head, files };
        more(b);
    });
    const stale = (facts) => decide(facts).reasons.some((r) => r.code === 'visual');
    check('renaming a visual file away after visual-seen makes it stale',
        stale(await afterLabel([{ filename: 'archive/icon.svg', previous_filename: 'public/icon.svg' }])));
    check('renaming a non-visual file after it does not',
        !stale(await afterLabel([{ filename: 'docs/b.md', previous_filename: 'docs/a.md' }])));

    // GitHub lists a commit's files 300 a page.
    const filler = Array.from({ length: 300 }, (_, i) => ({ filename: `server/f${i}.js` }));
    check('a visual file on the second page of a commit is read', stale(await afterLabel(filler, (b) => {
        b[`/repos/${fx.repo}/commits/${head}?page=2`] = { sha: head, files: [{ filename: 'src/components/AssistantDrawer.tsx' }] };
    })));
    const tooMany = await afterLabel(filler, (b) => {
        for (let p = 2; p <= 10; p++) b[`/repos/${fx.repo}/commits/${head}?page=${p}`] = { sha: head, files: filler };
    });
    check('a commit longer than the robot reads asks for the label again',
        decide(tooMany).reasons.some((r) => r.code === 'visual' && /more files than the robot reads/.test(r.text)), text(decide(tooMany)));

    // The head made a merge commit of main: against its first parent it shows main's files, against
    // main the branch's own. Only a path that differs from both was edited in the merge itself.
    const MAIN = 'd'.repeat(40);
    const asMerge = (againstBranch, againstMain) => afterLabel(againstBranch, (b) => {
        b[key(/\/pulls\/364\/commits/)].at(-1).parents.push({ sha: MAIN });
        b[`/repos/${fx.repo}/compare/${MAIN}...${head}`] = { status: 'ahead', ahead_by: 3, commits: [], files: againstMain };
    });
    check('a merge of main that only brings main\'s visual changes keeps visual-seen', !stale(await asMerge(
        [{ filename: 'src/components/Sidebar.tsx' }],
        [{ filename: 'src/components/AssistantDrawer.tsx' }, { filename: 'src/locales/en.json' }])));
    check('a merge that also edits a visual file makes it stale', stale(await asMerge(
        [{ filename: 'src/components/Sidebar.tsx' }, { filename: 'src/components/AssistantDrawer.tsx' }],
        [{ filename: 'src/components/AssistantDrawer.tsx' }, { filename: 'src/locales/en.json' }])));
}
check('pushTimes keeps the first pull_request run of each head', (() => {
    const at = pushTimes([
        { head_sha: 'a', event: 'pull_request', created_at: '2026-11-25T10:05:00Z' },
        { head_sha: 'a', event: 'pull_request', created_at: '2026-11-25T10:00:00Z' },
        { head_sha: 'a', event: 'push', created_at: '2026-11-25T09:00:00Z' },
    ]);
    return at.get('a') === '2026-11-25T10:00:00Z' && !at.has('b');
})());

// ---------------------------------------------------------------- mainSince(): the activity log
console.log('what landed on main, from the activity log');
{
    const R = 'o/r';
    const act = (ts, before, after) => ({ timestamp: ts, before, after, activity_type: 'pr_merge' });
    const book = (acts, cmp) => ({
        [`/repos/${R}/activity?ref=refs/heads/main&per_page=100`]: acts,
        ...(cmp ? { [`/repos/${R}/compare/${cmp.from}...main`]: cmp.body } : {}),
    });
    const since = Date.parse('2026-11-25T12:00:00Z');
    const quiet = await mainSince(replaying(book([act('2026-11-25T11:00:00Z', 'a'.repeat(40), 'b'.repeat(40))])), R, 'main', since);
    check('nothing after the time: known, no files', quiet.known && quiet.files.length === 0);
    const two = await mainSince(replaying(book(
        [act('2026-11-25T11:00:00Z', 'a'.repeat(40), 'b'.repeat(40)), act('2026-11-25T14:00:00Z', 'c'.repeat(40), 'd'.repeat(40)), act('2026-11-25T13:00:00Z', 'b'.repeat(40), 'c'.repeat(40))],
        { from: 'b'.repeat(40), body: { status: 'ahead', commits: [{ sha: 'c'.repeat(40) }, { sha: 'd'.repeat(40) }], files: [{ filename: 'x.js' }, { filename: 'new.js', previous_filename: 'old.js' }] } })), R, 'main', since);
    check('compares from the state before the first landing after the time', two.known && two.before === 'b'.repeat(40) && same(two.files, ['x.js', 'new.js', 'old.js']), JSON.stringify(two));
    const all = await mainSince(replaying(book(Array.from({ length: 100 }, (_, i) => act(`2026-11-26T${String(i % 24).padStart(2, '0')}:00:00Z`, 'a'.repeat(40), 'b'.repeat(40))))), R, 'main', since);
    check('100 landings all after the time: unknown', !all.known && /100 or more/.test(all.why));
    const rewritten = await mainSince(replaying(book([act('2026-11-25T13:00:00Z', 'b'.repeat(40), 'c'.repeat(40)), act('2026-11-25T11:00:00Z', 'a'.repeat(40), 'b'.repeat(40))],
        { from: 'b'.repeat(40), body: { status: 'diverged', commits: [], files: [] } })), R, 'main', since);
    check('a force-push since (diverged): unknown', !rewritten.known && /rewritten/.test(rewritten.why));
    const wide = await mainSince(replaying(book([act('2026-11-25T13:00:00Z', 'b'.repeat(40), 'c'.repeat(40)), act('2026-11-25T11:00:00Z', 'a'.repeat(40), 'b'.repeat(40))],
        { from: 'b'.repeat(40), body: { status: 'ahead', commits: [], files: Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}` })) } })), R, 'main', since);
    check('300 files since: unknown', !wide.known && /300 or more/.test(wide.why));
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
function fakeGitHub(books, { mergeStatus = 200, author = 'ValeraZSD', reread = null } = {}) {
    const calls = [];
    const seen = new Map();
    const all = Object.assign({}, ...books.map((b) => b.book));
    const pulls = books.map((b) => Object.entries(b.book).find(([k]) => /\/pulls\/\d+$/.test(k))[1]);
    const reply = (status, body) => ({ ok: status < 300, status, text: async () => (body == null ? '' : JSON.stringify(body)) });
    const fetch = async (url, init) => {
        const path = url.slice(API.length);
        calls.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : null });
        if (init.method === 'GET') {
            if (/\/pulls\?state=open/.test(path)) return reply(200, /page=1$/.test(path) ? pulls : []);
            if (path.endsWith(`/commits/${MERGED_SHA}`)) return reply(200, { sha: MERGED_SHA, author: { login: author }, files: [] });
            seen.set(path, (seen.get(path) || 0) + 1);
            if (reread && seen.get(path) > 1 && reread.path === path) return reply(200, reread.body(structuredClone(all[path])));
            if (path in all) return reply(200, all[path]);
            return reply(404, { message: `not faked: ${path}` });
        }
        const status = typeof mergeStatus === 'function' ? mergeStatus(path) : mergeStatus;
        if (init.method === 'PUT' && /\/merge$/.test(path)) return status === 200 ? reply(200, { sha: MERGED_SHA, merged: true }) : reply(status, { message: 'Head branch was modified' });
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
    check('live: subject and Signed-off-by body', m.commit_title === "Keep learner text out of a site operator's log (#367)" && m.commit_message === 'Signed-off-by: ValeraZSD <owner@example.test>', JSON.stringify(m));
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
    // `hold` goes on while the robot judges the others: the read just before the merge sees it.
    const fake = fakeGitHub([greenBook()], { reread: { path: '/repos/ValeraZSD/terramentor/pulls/367',
        body: (p) => ({ ...p, labels: [...p.labels, { name: 'hold' }] }) } });
    const { code, out } = await run({ MERGE_ROBOT: 'on' }, fake);
    check('live: a pull request held after it was judged is not merged',
        code === 0 && !fake.calls.some((c) => c.method === 'PUT') && /changed while the others were judged/.test(out), out);
}
{
    // GitHub refuses the oldest: the next candidate is merged in the same run.
    const fake = fakeGitHub([greenBook(), greenBook(9367)], { mergeStatus: (p) => (/\/pulls\/367\/merge$/.test(p) ? 405 : 200) });
    const { code, out } = await run({ MERGE_ROBOT: 'on' }, fake);
    const puts = fake.calls.filter((c) => c.method === 'PUT').map((c) => c.path);
    check('live: a refused pull request does not hold up the next one',
        code === 0 && puts.join() === '/repos/ValeraZSD/terramentor/pulls/367/merge,/repos/ValeraZSD/terramentor/pulls/9367/merge'
        && /GitHub refused to merge #367/.test(out) && /Merged #9367/.test(out), `${puts.join()} | ${out}`);
}
{
    // A label write GitHub rejects is a warning; the merge still happens.
    const b = greenBook(); const v = greenBook(9367);
    Object.entries(v.book).find(([k]) => /\/files\?/.test(k))[1].push({ filename: 'src/components/Foo.tsx', status: 'modified' });
    Object.entries(v.book).find(([k]) => /\/pulls\/\d+$/.test(k))[1].changed_files += 1;
    const fake = fakeGitHub([b, v]);
    const inner = fake.fetch;
    fake.fetch = async (url, init) => (init.method === 'POST' && /\/labels$/.test(url)
        ? { ok: false, status: 403, text: async () => JSON.stringify({ message: 'Resource not accessible' }) } : inner(url, init));
    const { code, out } = await run({ MERGE_ROBOT: 'on' }, fake);
    check('live: a failed label write warns and the merge goes on',
        code === 0 && /::warning::could not label #9367/.test(out) && /Merged #367/.test(out), out);
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

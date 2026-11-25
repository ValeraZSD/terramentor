#!/usr/bin/env node
/**
 * tools/merge-robot.mjs — squash-merges a pull request when every rule holds. No model.
 *
 * Run by .github/workflows/merge-robot.yml (on a schedule, after Gates and the
 * AI review finish, and by hand). It reads the open pull requests and merges at
 * most one per run, the oldest that passes all of these:
 *
 *   - not a draft; from this repository, not a fork
 *   - labelled `automerge`, not labelled `hold`, `owner-merge` or `release`
 *   - not a release: title like a version or "Release …", no `"version"` change
 *     in package.json
 *   - touches nothing the merge machinery itself runs on (workflows, this
 *     script, the review script, the review rules): those merge by hand
 *   - every required check is green on the head, every other check finished
 *     and none red (the review bot's comments are advisory and not counted)
 *   - the commit status `ai-review` is success on the head, set by Actions
 *   - a visual change carries `visual-seen`, added after the last commit that
 *     touched a visual file (else the robot labels it `needs-visual-seen`)
 *   - GitHub says it merges cleanly
 *   - main has not changed any of its files since the head's checks started
 *     (else `needs-main-merge`): CI tested the head merged with main as it was
 *   - the title fits a 50-character subject and nothing in the commit message
 *     is an AI-attribution line
 *
 * The squash commit is "<title> (#N)" with the pull request's Signed-off-by
 * lines as its body, and the merge names the head SHA it judged, so a push in
 * between makes GitHub refuse it.
 *
 * Dry run unless the repository variable MERGE_ROBOT is `on`: then it says
 * what it would do and why not, and its GitHub client refuses every call that
 * is not a GET. Locally:
 *
 *   GH_TOKEN=$(gh auth token) node tools/merge-robot.mjs --repo OWNER/REPO [--all] [--pr N]
 *   node tools/merge-robot.mjs --replay tools/fixtures/merge-robot/<file>.json
 *   ... --record DIR     save what was read, trimmed, as a replayable fixture
 *
 * A merge made with the workflow's token starts no workflow (GitHub's rule for
 * that token), so main's push-triggered Gates run would not happen. After a
 * merge the robot dispatches Gates on main itself; `workflow_dispatch` is the
 * one event that token may start.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAiAttributionLine } from './no-ai-attribution.mjs';

export const CONFIG = {
    // Mirrors main's branch protection (which this token cannot read); MERGE_ROBOT_REQUIRED overrides it.
    required: ['license/cla', 'check', 'signoff', 'Node 24 on ubuntu-latest', 'Node 24 on windows-latest'],
    reviewStatus: 'ai-review',
    reviewStatusCreator: 'github-actions[bot]',
    labels: {
        go: 'automerge', hold: 'hold', visualSeen: 'visual-seen',
        needsVisual: 'needs-visual-seen', needsMain: 'needs-main-merge',
        reserved: ['owner-merge', 'release'],
    },
    // What a person looks at before a merge: the screens, their text, the pictures.
    visual: [
        'src/components/**', 'src/**/*.css', 'src/**/*.tsx', 'src/locales/en.json',
        'index.html', 'tailwind.config.js', 'postcss.config.js',
        'public/**', 'brand/**', 'docs/screenshots/**', 'docs/**/*.{png,jpg,jpeg,gif,webp,svg,mp4}',
        'desktop/**/*.html', 'desktop/**/*.css',
    ],
    visualIgnore: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', 'tools/**', 'server/**'],
    // A change to what decides a merge is merged by a person.
    byHand: ['.github/**', 'tools/merge-robot.mjs', 'tools/ai-review.mjs', 'tools/no-ai-attribution.mjs', '.coderabbit.yaml'],
    advisoryCheck: (run) => /^coderabbit/i.test(run.app || '') || run.name.toLowerCase() === 'coderabbit',
    maxTitle: 50,
    releaseTitle: /^(release|bump version)\b|^v?\d+\.\d+\.\d+\b/i,
    gatesWorkflow: 'gates.yml',
};

const OK = new Set(['success', 'neutral', 'skipped']);

// --------------------------------------------------------------- globs

export function globRe(pattern) {
    const alts = expand(pattern);
    const one = (p) => {
        let out = '';
        for (let i = 0; i < p.length;) {
            if (p.startsWith('**/', i)) { out += '(?:.*/)?'; i += 3; }
            else if (p.startsWith('**', i)) { out += '.*'; i += 2; }
            else if (p[i] === '*') { out += '[^/]*'; i += 1; }
            else if (p[i] === '?') { out += '[^/]'; i += 1; }
            else { out += p[i].replace(/[.+^${}()|[\]\\]/g, '\\$&'); i += 1; }
        }
        return out;
    };
    return new RegExp(`^(?:${alts.map(one).join('|')})$`);
}
function expand(p) {
    const m = p.match(/^(.*?)\{([^{}]*)\}(.*)$/);
    return m ? m[2].split(',').flatMap((a) => expand(`${m[1]}${a}${m[3]}`)) : [p];
}
export const matchesAny = (path, patterns) => patterns.some((p) => globRe(p).test(path));

// --------------------------------------------------------------- reading GitHub

/** GitHub REST over fetch. `readOnly` refuses anything but GET before it leaves the process. */
export function makeApi({ token, fetch = globalThis.fetch, readOnly = true, base = 'https://api.github.com' }) {
    const call = async (method, path, body) => {
        if (readOnly && method !== 'GET') throw new Error(`read-only: refused ${method} ${path}`);
        const res = await fetch(`${base}${path}`, {
            method,
            headers: {
                ...(token ? { authorization: `Bearer ${token}` } : {}),
                accept: 'application/vnd.github+json',
                'x-github-api-version': '2022-11-28',
                ...(body ? { 'content-type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        const json = text ? JSON.parse(text) : null;
        if (!res.ok) {
            const err = new Error(`GitHub ${method} ${path}: ${res.status} ${json?.message || ''}`.trim());
            err.status = res.status;
            throw err;
        }
        return json;
    };
    return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}

/** Wraps an api so every GET is kept, trimmed, for a fixture. */
export function recording(api) {
    const book = {};
    return { book, get: async (p) => (book[p] = trimFor(p)(await api.get(p))) };
}

/** An api that answers GETs from a recorded book and nothing else. */
export function replaying(book) {
    return {
        get: async (p) => {
            if (!(p in book)) throw new Error(`not in the recording: GET ${p}`);
            return structuredClone(book[p]);
        },
    };
}

// Trimmed to what the rules read; each trim is idempotent, so a replay trims again harmlessly.
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && k in o).map((k) => [k, o[k]]));
export const trim = {
    pull: (p) => ({
        ...pick(p, ['number', 'title', 'draft', 'state', 'mergeable', 'mergeable_state', 'changed_files', 'html_url', 'created_at']),
        user: { login: p.user?.login },
        labels: (p.labels || []).map((l) => ({ name: l.name })),
        head: { sha: p.head?.sha, ref: p.head?.ref, repo: { full_name: p.head?.repo?.full_name ?? null } },
        base: { ref: p.base?.ref, repo: { full_name: p.base?.repo?.full_name } },
    }),
    files: (fs) => fs.map((f) => ({ filename: f.filename, status: f.status, ...(f.filename === 'package.json' && f.patch ? { patch: f.patch } : {}) })),
    checkRuns: (r) => ({ check_runs: (r.check_runs || []).map((c) => ({ ...pick(c, ['id', 'name', 'status', 'conclusion', 'started_at', 'completed_at']), app: c.app?.slug ?? c.app ?? null })) }),
    statuses: (ss) => ss.map((s) => ({ ...pick(s, ['context', 'state', 'description', 'created_at']), creator: { login: s.creator?.login } })),
    events: (es) => es.filter((e) => e.event === 'labeled' || e.event === 'unlabeled')
        .map((e) => ({ event: e.event, label: { name: e.label?.name }, created_at: e.created_at })),
    commits: (cs) => cs.map((c) => ({ sha: c.sha, parents: (c.parents || []).map((p) => ({ sha: p.sha })), commit: { message: c.commit?.message, committer: { date: c.commit?.committer?.date } } })),
    compare: (c) => ({ ahead_by: c.ahead_by ?? 0, commits: (c.commits || []).map((x) => ({ sha: x.sha, commit: { committer: { date: x.commit?.committer?.date } } })) }),
    commit: (c) => ({ sha: c.sha, files: (c.files || []).map((f) => ({ filename: f.filename })), author: c.author ? { login: c.author.login } : null }),
};

/** Which trim a GET path's answer goes through. */
export function trimFor(path) {
    const p = path.split('?')[0];
    if (/\/pulls$/.test(p)) return (ps) => ps.map(trim.pull);
    if (/\/pulls\/\d+$/.test(p)) return trim.pull;
    if (/\/pulls\/\d+\/files$/.test(p)) return trim.files;
    if (/\/check-runs$/.test(p)) return trim.checkRuns;
    if (/\/statuses$/.test(p)) return trim.statuses;
    if (/\/issues\/\d+\/events$/.test(p)) return trim.events;
    if (/\/pulls\/\d+\/commits$/.test(p)) return trim.commits;
    if (/\/compare\//.test(p)) return trim.compare;
    if (/\/commits\/[0-9a-f]{7,40}$/.test(p)) return trim.commit;
    return (x) => x;
}

async function pages(api, path, trimmer, unwrap = (x) => x, max = 30) {
    const out = [];
    for (let page = 1; page <= max; page++) {
        const got = unwrap(trimmer(await api.get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)));
        out.push(...got);
        if (got.length < 100) break;
    }
    return out;
}

export function latestRuns(checkRuns) {
    const newer = (a, b) => (a.started_at || '') > (b.started_at || '')
        || ((a.started_at || '') === (b.started_at || '') && (a.id || 0) > (b.id || 0));
    const byName = new Map();
    for (const r of checkRuns) {
        const prev = byName.get(r.name);
        if (!prev || newer(r, prev)) byName.set(r.name, r);
    }
    return byName;
}

/** When CI on this head first started: the earliest start of any attempt of a required check run. */
export function ciStart(checkRuns, required) {
    const starts = checkRuns.filter((r) => required.includes(r.name) && r.started_at).map((r) => r.started_at).sort();
    return starts[0] || null;
}

export function labelState(events, labels, name) {
    let on = labels.includes(name), since = null;
    const mine = events.filter((e) => e.label?.name === name).sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (mine.length) {
        const lastEv = mine[mine.length - 1];
        on = lastEv.event === 'labeled' && labels.includes(name);
        since = on ? lastEv.created_at : null;
    }
    return { on, since };
}

/** Everything the rules read about one pull request. */
export async function collect(api, repo, number, cfg = CONFIG) {
    const pull = trim.pull(await api.get(`/repos/${repo}/pulls/${number}`));
    const head = pull.head.sha;
    const files = await pages(api, `/repos/${repo}/pulls/${number}/files`, trim.files);
    const checkRuns = await pages(api, `/repos/${repo}/commits/${head}/check-runs?filter=all`, trim.checkRuns, (r) => r.check_runs);
    const statuses = await pages(api, `/repos/${repo}/commits/${head}/statuses`, trim.statuses, (x) => x, 3);
    const events = await pages(api, `/repos/${repo}/issues/${number}/events`, trim.events, (x) => x, 5);
    const commits = await pages(api, `/repos/${repo}/pulls/${number}/commits`, trim.commits, (x) => x, 3);
    const compare = trim.compare(await api.get(`/repos/${repo}/compare/${head}...${encodeURIComponent(pull.base.ref)}`));

    const start = ciStart(checkRuns, cfg.required);
    const mainAfterCi = [];
    for (const c of compare.commits) {
        if (start && c.commit.committer.date > start) {
            const detail = trim.commit(await api.get(`/repos/${repo}/commits/${c.sha}`));
            // GitHub lists at most 300 files of one commit; a longer list may hide one of ours.
            mainAfterCi.push({ sha: c.sha, date: c.commit.committer.date, files: detail.files.map((f) => f.filename),
                truncated: detail.files.length >= 300 });
        }
    }

    // Commits of the pull request itself after `visual-seen` went on, with their files.
    const labels = pull.labels.map((l) => l.name);
    const seen = labelState(events, labels, cfg.labels.visualSeen);
    const afterSeen = [];
    if (seen.on && seen.since) {
        for (const c of commits) {
            if (c.parents.length < 2 && c.commit.committer.date > seen.since) {
                const detail = trim.commit(await api.get(`/repos/${repo}/commits/${c.sha}`));
                afterSeen.push({ sha: c.sha, files: detail.files.map((f) => f.filename) });
            }
        }
    }
    return { repo, pull, files, checkRuns, statuses, events, commits, mainAfterCi, afterSeen, ciStart: start,
        mainAhead: compare.ahead_by, mainListed: compare.commits.length };
}

// --------------------------------------------------------------- the rules

export function signoffs(commits) {
    const lines = [];
    for (const c of commits) {
        if (c.parents.length > 1) continue;
        for (const line of (c.commit.message || '').split(/\r?\n/)) {
            const t = line.trim();
            if (/^Signed-off-by: .+ <.+@.+>$/.test(t) && !lines.includes(t)) lines.push(t);
        }
    }
    return lines;
}

export function commitMessage(facts) {
    return { title: `${facts.pull.title} (#${facts.pull.number})`, message: signoffs(facts.commits).join('\n') };
}

/**
 * The verdict for one pull request: { merge, reasons[], addLabels[], removeLabels[] }.
 * Every reason is listed, not only the first, so a dry run says all that is missing.
 */
export function decide(facts, cfg = CONFIG) {
    const { pull, files, checkRuns, statuses } = facts;
    const L = cfg.labels;
    const labels = pull.labels.map((l) => l.name);
    const reasons = [];
    const addLabels = [], removeLabels = [];
    const why = (code, text) => reasons.push({ code, text });
    const names = files.map((f) => f.filename);

    if (pull.state && pull.state !== 'open') why('closed', `the pull request is ${pull.state}`);
    if (pull.draft) why('draft', 'still a draft');
    if (!labels.includes(L.go)) why('no-label', `no \`${L.go}\` label`);
    if (labels.includes(L.hold)) why('hold', `labelled \`${L.hold}\``);
    const reserved = labels.filter((l) => cfg.labels.reserved.includes(l));
    if (reserved.length) why('reserved', `labelled ${reserved.map((l) => `\`${l}\``).join(', ')}: the owner merges it`);
    if (pull.head.repo.full_name !== pull.base.repo.full_name) why('fork', 'the head is in another repository');

    if (cfg.releaseTitle.test(pull.title || '')) why('release', 'the title reads as a release');
    const pkg = files.find((f) => f.filename === 'package.json');
    if (pkg?.patch && /^[+-]\s*"version"\s*:/m.test(pkg.patch)) why('release', 'package.json changes "version"');
    if ((pull.title || '').length > cfg.maxTitle) why('title', `title is ${pull.title.length} characters, over ${cfg.maxTitle}`);
    const msg = commitMessage(facts);
    if ([msg.title, ...msg.message.split('\n')].some(isAiAttributionLine)) why('attribution', 'the commit message would carry an AI-attribution line');

    if ((pull.changed_files ?? names.length) > names.length) why('files', `GitHub listed ${names.length} of ${pull.changed_files} files`);
    const machinery = names.filter((f) => matchesAny(f, cfg.byHand));
    if (machinery.length) why('by-hand', `changes merge machinery (${machinery.slice(0, 3).join(', ')}): merge by hand`);

    // Checks on the head.
    const runs = latestRuns(checkRuns);
    const latestStatus = new Map();
    for (const s of [...statuses].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
        if (!latestStatus.has(s.context)) latestStatus.set(s.context, s);
    }
    for (const ctx of cfg.required) {
        const r = runs.get(ctx), s = latestStatus.get(ctx);
        if (r) {
            if (r.status !== 'completed') why('checks', `${ctx} still running`);
            else if (!OK.has(r.conclusion)) why('checks', `${ctx} ${r.conclusion}`);
        } else if (s) {
            if (s.state === 'pending') why('checks', `${ctx} pending`);
            else if (s.state !== 'success') why('checks', `${ctx} ${s.state}`);
        } else why('checks', `${ctx} has not reported`);
    }
    for (const [name, r] of runs) {
        if (cfg.required.includes(name) || cfg.advisoryCheck(r)) continue;
        if (r.status !== 'completed') why('checks', `${name} still running`);
        else if (!OK.has(r.conclusion)) why('checks', `${name} ${r.conclusion}`);
    }
    const review = latestStatus.get(cfg.reviewStatus);
    if (!review) why('review', `no \`${cfg.reviewStatus}\` status on the head`);
    else if (review.creator?.login !== cfg.reviewStatusCreator) why('review', `\`${cfg.reviewStatus}\` was set by ${review.creator?.login}, not Actions`);
    else if (review.state !== 'success') why('review', `\`${cfg.reviewStatus}\` ${review.state}: ${review.description || ''}`.trim());

    // A visual change a person has seen as it is now.
    const visual = names.filter((f) => matchesAny(f, cfg.visual) && !matchesAny(f, cfg.visualIgnore));
    if (visual.length) {
        const seen = labelState(facts.events, labels, L.visualSeen);
        const later = (facts.afterSeen || []).filter((c) => c.files.some((f) => matchesAny(f, cfg.visual) && !matchesAny(f, cfg.visualIgnore)));
        if (!seen.on) why('visual', `visual change (${visual.slice(0, 3).join(', ')}${visual.length > 3 ? ` and ${visual.length - 3} more` : ''}) without \`${L.visualSeen}\``);
        else if (later.length) why('visual', `visual files changed after \`${L.visualSeen}\` (${later.map((c) => c.sha.slice(0, 7)).join(', ')})`);
    }
    const visualReason = reasons.some((r) => r.code === 'visual');
    if (visualReason && !labels.includes(L.needsVisual)) addLabels.push(L.needsVisual);
    if (!visualReason && labels.includes(L.needsVisual)) removeLabels.push(L.needsVisual);

    if (pull.mergeable === false || pull.mergeable_state === 'dirty') why('conflict', 'conflicts with main');
    else if (pull.mergeable == null) why('mergeable', 'GitHub has not worked out mergeability yet');
    else if (pull.mergeable_state === 'blocked') why('mergeable', 'GitHub reports the merge as blocked');

    // Main moved on its files after CI took main in.
    if (!facts.ciStart) why('main', 'no required check has started, so what CI tested is unknown');
    // GitHub lists at most 250 commits of a comparison; the ones it left out cannot be checked.
    if ((facts.mainAhead || 0) > (facts.mainListed || 0)) why('main', `main is ${facts.mainAhead} commits ahead, more than GitHub lists: merge main in`);
    const huge = (facts.mainAfterCi || []).filter((c) => c.truncated);
    if (huge.length) why('main', `main commit ${huge[0].sha.slice(0, 7)} after CI lists 300+ files: merge main in`);
    const moved = (facts.mainAfterCi || []).filter((c) => c.files.some((f) => names.includes(f)));
    if (moved.length) {
        const touched = [...new Set(moved.flatMap((c) => c.files.filter((f) => names.includes(f))))];
        why('main', `main changed ${touched.slice(0, 3).join(', ')}${touched.length > 3 ? ` and ${touched.length - 3} more` : ''} after CI ran (${moved.map((c) => c.sha.slice(0, 7)).join(', ')}): merge main in`);
    }
    if (moved.length && !labels.includes(L.needsMain)) addLabels.push(L.needsMain);
    if (!moved.length && labels.includes(L.needsMain)) removeLabels.push(L.needsMain);

    // Labels steer only pull requests that asked to be merged.
    const steer = labels.includes(L.go);
    return { number: pull.number, title: pull.title, head: pull.head.sha, merge: reasons.length === 0, reasons,
        addLabels: steer ? addLabels : [], removeLabels: steer ? removeLabels : [] };
}

// --------------------------------------------------------------- acting

export async function merge(api, facts) {
    const { title, message } = commitMessage(facts);
    const res = await api.put(`/repos/${facts.repo}/pulls/${facts.pull.number}/merge`, {
        merge_method: 'squash', sha: facts.pull.head.sha, commit_title: title, commit_message: message,
    });
    return res;
}

function render(v) {
    const head = `#${v.number} ${v.head.slice(0, 7)} "${v.title}"`;
    if (v.merge) return `- ${head}: MERGE`;
    return [`- ${head}: skip`, ...v.reasons.map((r) => `  - ${r.text}`)].join('\n');
}

function parseArgs(argv) {
    const a = { prs: [], all: false, dryRun: false };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--repo') a.repo = argv[++i];
        else if (k === '--pr') a.prs.push(Number(argv[++i]));
        else if (k === '--all') a.all = true;
        else if (k === '--dry-run') a.dryRun = true;
        else if (k === '--record') a.record = argv[++i];
        else if (k === '--replay') a.replay = argv[++i];
        else throw new Error(`unknown argument ${k}`);
    }
    return a;
}

export async function main(argv = process.argv.slice(2), env = process.env, out = console.log, fetchImpl = globalThis.fetch) {
    const args = parseArgs(argv);
    const cfg = { ...CONFIG, ...(env.MERGE_ROBOT_REQUIRED ? { required: env.MERGE_ROBOT_REQUIRED.split(',').map((s) => s.trim()).filter(Boolean) } : {}) };
    const lines = [];
    const say = (l) => { lines.push(l); out(l); };

    if (args.replay) {
        const fx = JSON.parse(readFileSync(args.replay, 'utf8'));
        const facts = await collect(replaying(fx.book), fx.repo, fx.number, cfg);
        say(render(decide(facts, cfg)));
        return 0;
    }

    const repo = args.repo || env.GITHUB_REPOSITORY;
    if (!repo) throw new Error('give --repo OWNER/NAME');
    const live = env.MERGE_ROBOT === 'on' && !args.dryRun && !args.record;
    const api = makeApi({ token: env.GH_TOKEN || env.GITHUB_TOKEN, readOnly: !live, fetch: fetchImpl });

    const mode = live ? 'live' : env.MERGE_ROBOT === 'on' ? 'dry run (asked for on the command line)' : 'dry run (repository variable MERGE_ROBOT is not "on")';
    say(`## Merge robot: ${mode}`);
    const open = (await pages(api, `/repos/${repo}/pulls?state=open&sort=created&direction=asc`, (ps) => ps.map(trim.pull)))
        .filter((p) => !args.prs.length || args.prs.includes(p.number));
    const verdicts = [];
    for (const p of open) {
        const labelled = p.labels.some((l) => l.name === cfg.labels.go);
        if (!labelled && !args.all && !args.prs.length) {
            verdicts.push({ number: p.number, title: p.title, head: p.head.sha, merge: false, reasons: [{ code: 'no-label', text: `no \`${cfg.labels.go}\` label` }] });
            continue;
        }
        const reader = args.record ? recording(api) : api;
        const facts = await collect(reader, repo, p.number, cfg);
        if (args.record) {
            mkdirSync(args.record, { recursive: true });
            const file = join(args.record, `pr-${p.number}.json`);
            writeFileSync(file, `${JSON.stringify({ repo, number: p.number, recorded_at: new Date().toISOString(), book: reader.book }, null, 1)}\n`);
        }
        verdicts.push({ ...decide(facts, cfg), facts });
    }

    for (const v of verdicts) say(render(v));

    if (live) {
        for (const v of verdicts.filter((x) => x.addLabels?.length || x.removeLabels?.length)) {
            if (v.addLabels.length) await api.post(`/repos/${repo}/issues/${v.number}/labels`, { labels: v.addLabels });
            for (const l of v.removeLabels) await api.del(`/repos/${repo}/issues/${v.number}/labels/${encodeURIComponent(l)}`).catch(() => {});
        }
        const next = verdicts.find((v) => v.merge);
        if (next) {
            let res;
            try {
                res = await merge(api, next.facts);
            } catch (e) {
                // 405 not mergeable, 409 the head moved since it was judged: the next run judges it again.
                if (e.status !== 405 && e.status !== 409) throw e;
                say(`\nGitHub refused to merge #${next.number}: ${e.message}`);
                if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
                return 0;
            }
            say(`\nMerged #${next.number} as ${res.sha}.`);
            // Who GitHub made the author of a squash merge done with this token, checked every time.
            const made = trim.commit(await api.get(`/repos/${repo}/commits/${res.sha}`));
            const author = made.author?.login, opener = next.facts.pull.user.login;
            say(`Author of ${res.sha.slice(0, 7)}: ${author ?? 'no account'}; pull request opened by ${opener}.`);
            if (author !== opener) out(`::warning::the squash commit's author is ${author}, not ${opener}`);
            await api.post(`/repos/${repo}/actions/workflows/${cfg.gatesWorkflow}/dispatches`, { ref: next.facts.pull.base.ref });
            say(`Dispatched ${cfg.gatesWorkflow} on ${next.facts.pull.base.ref}.`);
        } else say('\nNothing to merge.');
    } else {
        const next = verdicts.find((v) => v.merge);
        say(next ? `\nWould merge #${next.number} now (one per run).` : '\nNothing to merge.');
        for (const v of verdicts.filter((x) => x.addLabels?.length || x.removeLabels?.length)) {
            say(`Would label #${v.number}: ${[...v.addLabels.map((l) => `+${l}`), ...v.removeLabels.map((l) => `-${l}`)].join(' ')}`);
        }
    }
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
    return 0;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/merge-robot.mjs')) {
    main().then((code) => process.exit(code)).catch((e) => { console.error(e.message); process.exit(1); });
}

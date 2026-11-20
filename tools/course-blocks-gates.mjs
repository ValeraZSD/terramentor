#!/usr/bin/env node
// tools/course-blocks-gates.mjs — Today is one course at a time.
//
// Run:  node tools/course-blocks-gates.mjs [--root <checkout>]
//
// The home stream (Today) is a run of COURSE BLOCKS: a course's whole share of
// the day, then the next course's, never a card of one course between two of
// another's (server/feed.js composeFeed, "Course blocks"). Each block opens
// with its own course's look back and recall round, once per visit, and a
// round is never cut across pages. On screen each block has one header naming
// its course and no card under it repeats the name (CourseBlock.tsx,
// courseBlocks.ts).
//
//   1. one page: no course comes back lower on it, and each block opens with
//      its own round;
//   2. paging (the client sends the blocks it holds, `courses`): the whole
//      stream still never interleaves courses, a round opens once per course
//      and is never split, a card-only course and a review-only course get
//      their own blocks, and the block the reader is in continues before a
//      course that became more urgent opens;
//   3. a course's page and a topic's page are one block, and ignore `courses`;
//   4. the client: grouping, the blocks it reports, where a card rated Again
//      goes back in;
//   5. on screen: one header per block, the course named once, the topic one
//      heading level below it.
//
// --root runs the same cases against another checkout; on the code before the
// blocks the gate fails. A scratch library, no model, no network; every
// fading stamp sits in 2020 and the stream is composed at a pinned instant.
import { createRequire } from 'node:module';
import http from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ROOT = resolve(argOf('--root') || repo);

// Set in-process, before any server module is imported.
const scratch = mkdtempSync(join(tmpdir(), 'course-blocks-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;
process.env.HOST = '127.0.0.1';

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const block = async (title, fn) => {
    console.log(`\n--- ${title} ---`);
    try { await fn(); } catch (err) { check(`${title}: ran without throwing`, false, err?.stack?.split('\n').slice(0, 3).join(' | ') || String(err)); }
};

const S = pathToFileURL(join(ROOT, 'server') + '/').href;
const { default: db } = await import(S + 'database.js');
if (!process.env.DB_PATH.startsWith(scratch)) throw new Error('refusing: not the scratch library');
const { composeFeed } = await import(S + 'feed.js');

// ---- fixture -------------------------------------------------------------------
const NOW = new Date('2026-06-11T12:00:00.000Z');
const OLD = (d) => `2020-01-${String(d).padStart(2, '0')} 09:00:00`;
const DUE = '2020-01-01T09:00:00.000Z';

const project = (name, kind = 'curriculum') =>
    db.prepare('INSERT INTO projects (name, kind) VALUES (?, ?)').run(name, kind).lastInsertRowid;
/** A course with dates: its topics are scheduled work, not a standing slot. */
const course = (name) => {
    const id = project(name);
    db.prepare(`UPDATE projects SET start_date = '2020-01-01', deadline = '2027-01-01' WHERE id = ?`).run(id);
    return id;
};
const text = (word) => `${word} ${'is explained here in plain words, one idea after another. '.repeat(24)}`;
/** An open topic overdue since 2020: what the stream teaches today. */
const lesson = (pid, title) => db.prepare(`INSERT INTO nodes (project_id, title, status, description, scheduled_start, scheduled_end)
    VALUES (?, ?, 'in_progress', ?, '2020-01-01', '2020-01-02')`).run(pid, title, text(title)).lastInsertRowid;
/** A finished topic, answered well in 2020 and left alone since: fading, with one question to ask. */
const fading = (pid, title, day) => {
    const id = db.prepare(`INSERT INTO nodes (project_id, title, status) VALUES (?, ?, 'completed')`).run(pid, title).lastInsertRowid;
    db.prepare('INSERT INTO node_mastery (node_id, mastery_score, total_attempts, correct_attempts, last_updated) VALUES (?, 0.9, 6, 5, ?)')
        .run(id, OLD(day));
    db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(id, 'bank', JSON.stringify([
        { question: `${title}: which is right?`, type: 'multiple_choice', options: ['this', 'that'], correct_answer: 'this', explanation: 'e' },
    ]));
    return id;
};
const cards = (nodeId, n, due = true) => {
    for (let i = 0; i < n; i++) {
        db.prepare('INSERT INTO flashcards (node_id, front, back, next_review) VALUES (?, ?, ?, ?)')
            .run(nodeId, `front ${nodeId}-${i}`, `back ${nodeId}-${i}`, due ? DUE : null);
    }
};

// Physics: the most overdue course, three topics, two fading, cards due.
const physics = course('Physics');
const P = ['Lenses', 'Mirrors', 'Prisms'].map(t => lesson(physics, t));
const PF = [fading(physics, 'Refraction', 1), fading(physics, 'Waves', 2)];
cards(P[0], 3);
// Dutch: one topic overdue, one fading, cards due.
const dutch = course('Dutch');
const D = [lesson(dutch, 'Lidwoorden')];
const DF = [fading(dutch, 'Klinkers', 3)];
cards(D[0], 2);
// Kaishi: a deck, nothing but due cards.
const kaishi = project('Kaishi', 'deck');
const K = db.prepare(`INSERT INTO nodes (project_id, title, status) VALUES (?, 'Kaishi 1.5k', 'not_started')`).run(kaishi).lastInsertRowid;
cards(K, 4);
// History: nothing to teach or review but one fading topic.
const history = project('History');
const HF = [fading(history, 'Treaties', 4)];

const NAMES = { [physics]: 'Physics', [dutch]: 'Dutch', [kaishi]: 'Kaishi', [history]: 'History' };
const courseOf = (i) => i.kind === 'flashcard' ? i.card.project_id : i.kind === 'notice' ? null : i.projectId;
/** The course blocks a list of cards makes, in order, as the client names them. */
const blocksOf = (items) => items.map(courseOf).filter((c, i, all) => c != null && c !== all[i - 1]);
const named = (ids) => ids.map(id => NAMES[id] ?? id).join(', ');
const feed = (opts = {}) => composeFeed({ now: NOW, limit: 15, excludeKeys: new Set(), ...opts });

// The client's merge of a page (store.ts extendFeed): appended, a late
// checkpoint after its own topic. Imported from the checkout under test.
const placementPath = join(ROOT, 'src', 'utils', 'feedPlacement.ts');
const { placeCheckpoints } = await import(pathToFileURL(placementPath).href);
// The client's own helpers; a checkout without them falls back to the gate's
// reading of the blocks, and fails section 4.
const blocksPath = join(ROOT, 'src', 'components', 'feed', 'courseBlocks.ts');
const cb = existsSync(blocksPath) ? await import(pathToFileURL(blocksPath).href).catch(e => ({ error: e })) : {};
const heldCourses = typeof cb.heldCourses === 'function' ? cb.heldCourses : blocksOf;

/** The client's paging: each page asked after the cards it holds, naming its blocks. */
function pageThrough(limit, { useCourses = true, between } = {}) {
    let held = [];
    const pages = [];
    let last = null;
    for (let n = 0; n < 40; n++) {
        last = feed({ limit, excludeKeys: new Set(held.map(c => c.key)), courses: useCourses ? heldCourses(held) : [] });
        const seen = new Set(held.map(c => c.key));
        const fresh = last.items.filter(c => !seen.has(c.key));
        held = placeCheckpoints(held, fresh);
        pages.push(fresh);
        if (last.exhausted || fresh.length === 0) break;
        between?.(n, held);
    }
    return { held, pages, last };
}
/** Every course's recall cards sit together at the head of its block. */
const roundsLead = (items) => {
    for (const course of new Set(items.map(courseOf).filter(c => c != null))) {
        const own = items.filter(i => courseOf(i) === course);
        const recall = own.filter(i => i.kind === 'recall');
        if (recall.length && !own.slice(0, recall.length).every(i => i.kind === 'recall')) return course;
    }
    return null;
};

let firstPage = null;
await block('1. one page of Today', async () => {
    const page = feed();
    firstPage = page;
    const order = blocksOf(page.items);
    check('no course comes back lower on the page', new Set(order).size === order.length, named(order));
    check('the most overdue course comes first', order[0] === physics, named(order));
    check('each block opens with its own course’s round', roundsLead(page.items) === null, String(NAMES[roundsLead(page.items)]));
    const physicsRound = page.items.filter(i => i.kind === 'recall' && i.projectId === physics).map(i => i.nodeId);
    check('Physics’ round is Physics’ fading topics, oldest first, and nothing of another course',
        JSON.stringify(physicsRound) === JSON.stringify(PF), JSON.stringify(physicsRound));
    const physicsRun = page.items.filter(i => courseOf(i) === physics);
    check('Physics’ due cards are in Physics’ block', physicsRun.filter(i => i.kind === 'flashcard').length > 0
        && page.items.filter(i => i.kind === 'flashcard' && courseOf(i) === physics).length === physicsRun.filter(i => i.kind === 'flashcard').length);
});

await block('2. paging through the whole visit', async () => {
    // Every limit from 3 to 15: the stream ends by saying so, and only once each
    // topic's checkpoint went out (a page that fills before an earlier block's
    // late checkpoint must not call the stream over).
    const unended = [], unfinished = [];
    for (let limit = 3; limit <= 15; limit++) {
        const { held, last } = pageThrough(limit);
        if (last?.exhausted !== true) unended.push(limit);
        const missing = [...P, ...D].filter(n => !held.some(i => i.key === `checkpoint-${n}`));
        if (missing.length) unfinished.push(`${limit}: ${missing.join(' ')}`);
    }
    check('at every page size the last page says the stream is over', unended.length === 0, unended.join(', '));
    check('...and by then every topic taught today has had its checkpoint', unfinished.length === 0, unfinished.join('; '));
    for (const limit of [15, 6, 4]) {
        const { held, pages } = pageThrough(limit);
        const order = blocksOf(held);
        check(`limit ${limit}: the whole stream never interleaves courses`, new Set(order).size === order.length, named(order));
        check(`limit ${limit}: every course with anything today gets a block`,
            [physics, dutch, kaishi, history].every(c => order.includes(c)), named(order));
        check(`limit ${limit}: each block opens with its own round`, roundsLead(held) === null, String(NAMES[roundsLead(held)]));
        const recall = held.filter(i => i.kind === 'recall');
        check(`limit ${limit}: one round per course per visit, each fading topic once`,
            JSON.stringify(recall.map(i => i.nodeId).sort((a, b) => a - b)) === JSON.stringify([...PF, ...DF, ...HF].sort((a, b) => a - b)),
            JSON.stringify(recall.map(i => i.nodeId)));
        const split = [physics, dutch, history].filter(c => pages.filter(p => p.some(i => i.kind === 'recall' && i.projectId === c)).length > 1);
        check(`limit ${limit}: a round is never cut across pages`, split.length === 0, named(split));
        const kaishiRun = held.filter(i => courseOf(i) === kaishi);
        check(`limit ${limit}: the deck’s block is its cards alone`, kaishiRun.length === 4 && kaishiRun.every(i => i.kind === 'flashcard'),
            JSON.stringify(kaishiRun.map(i => i.kind)));
        const historyRun = held.filter(i => courseOf(i) === history);
        check(`limit ${limit}: a course with only a fading topic gets a block that is its round`,
            historyRun.length === 1 && historyRun[0].kind === 'recall' && historyRun[0].nodeId === HF[0], JSON.stringify(historyRun.map(i => i.kind)));
    }

    // The reader is mid-Physics when Dutch becomes more urgent (new overdue
    // topics): Physics continues before Dutch opens.
    const page1 = feed({ limit: 5 });
    check('a short first page ends inside Physics’ block', courseOf(page1.items.at(-1)) === physics, named(blocksOf(page1.items)));
    const extra = ['Werkwoorden', 'Bijzinnen', 'Voorzetsels', 'Telwoorden', 'Klokkijken'].map(t => lesson(dutch, t));
    try {
        const exclude = new Set(page1.items.map(i => i.key));
        const told = feed({ limit: 5, excludeKeys: exclude, courses: blocksOf(page1.items) });
        const untold = feed({ limit: 5, excludeKeys: exclude });
        const firstOf = (items) => items.find(i => courseOf(i) != null);
        check('...and the next page, told which block it is in, continues Physics before the more urgent Dutch',
            courseOf(firstOf(told.items)) === physics, named(blocksOf(told.items)));
        check('...where a page told nothing would have opened Dutch (the case is real)',
            courseOf(firstOf(untold.items)) === dutch, named(blocksOf(untold.items)));
        check('...and a page told nothing opens no round past the first page', !untold.items.some(i => i.kind === 'recall'));

        // The same through the route the client calls (GET /api/feed?courses=).
        const { createApp } = await import(S + 'app.js');
        const server = createApp().listen(0, '127.0.0.1');
        await new Promise(ok => server.once('listening', ok));
        try {
            const { port } = server.address();
            const get = (path) => new Promise((ok, no) => {
                http.get({ host: '127.0.0.1', port, path }, (res) => {
                    let text = '';
                    res.setEncoding('utf8');
                    res.on('data', c => { text += c; });
                    res.on('end', () => { try { ok(JSON.parse(text)); } catch (e) { no(new Error(`${res.statusCode}: ${text.slice(0, 200)}`)); } });
                }).on('error', no);
            });
            const ask = (courses) => get(`/api/feed?limit=5&exclude=${encodeURIComponent([...exclude].join(','))}`
                + (courses ? `&courses=${courses.join(',')}` : ''));
            const viaTold = await ask(heldCourses(page1.items));
            const viaUntold = await ask(null);
            check('over HTTP, `courses=` reaches the stream: told, it continues Physics; untold, it opens Dutch',
                courseOf(firstOf(viaTold.items)) === physics && courseOf(firstOf(viaUntold.items)) === dutch,
                `${named(blocksOf(viaTold.items))} / ${named(blocksOf(viaUntold.items))}`);
            const viaLong = await ask([...Array(250).fill(dutch), ...heldCourses(page1.items)]);
            check('...and a list past the 200 cap keeps its END, the block the reader is in',
                courseOf(firstOf(viaLong.items)) === physics, named(blocksOf(viaLong.items)));
        } finally {
            await new Promise(ok => server.close(ok));
        }
    } finally {
        for (const id of extra) db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
    }
});

await block('3. a course’s page and a topic’s page', async () => {
    const course = feed({ projectId: physics });
    check('a course’s page is one block', JSON.stringify(blocksOf(course.items)) === JSON.stringify([physics]), named(blocksOf(course.items)));
    check('...opening with its round', roundsLead(course.items) === null && course.items.some(i => i.kind === 'recall'));
    const keys = (r) => JSON.stringify(r.items.map(i => i.key));
    // Regression guards: these two held before the blocks too.
    check('...and `courses` changes nothing on it (a guard: true before the blocks too)', keys(feed({ projectId: physics, courses: [dutch, kaishi] })) === keys(course));
    const topicPage = feed({ nodeId: P[1] });
    check('a topic’s page ignores `courses` too (a guard: true before the blocks too)', keys(feed({ nodeId: P[1], courses: [dutch] })) === keys(topicPage));
});

// ---- the client ------------------------------------------------------------------

await block('4. the client: blocks, what it reports, where Again goes', async () => {
    check('courseBlocks.ts exists and loads', typeof cb.courseBlocks === 'function', cb.error?.message ?? 'missing');
    if (typeof cb.courseBlocks !== 'function') return;
    const blocks = cb.courseBlocks(cb.groupCards(firstPage.items));
    const withCourse = blocks.filter(b => b.course != null);
    check('one block per course on the page', JSON.stringify(withCourse.map(b => b.course)) === JSON.stringify(blocksOf(firstPage.items)),
        named(withCourse.map(b => b.course)));
    check('no block holds a card of another course', withCourse.every(b => b.groups.every(g =>
        (g.type === 'chapter' ? g.cards : g.type === 'review' ? g.cards : [g.card]).every(c => courseOf(c) === b.course))));

    const recall = (key, projectId) => ({ key, kind: 'recall', review: true, projectId, projectName: NAMES[projectId], nodeId: 1, question: {} });
    const flash = (key, projectId) => ({ key, kind: 'flashcard', card: { id: key.length, project_id: projectId, project_name: NAMES[projectId] } });
    const pair = cb.groupCards([recall('r1', physics), recall('r2', physics), recall('r3', dutch)]);
    check('two courses’ rounds side by side are two rounds', pair.length === 2 && pair[0].cards.length === 2, JSON.stringify(pair.map(g => g.cards.length)));
    const again = cb.courseBlocks(cb.groupCards([flash('a', physics), flash('b', dutch), flash('c', physics)]));
    check('a course back lower down is a block marked continued',
        JSON.stringify(again.map(b => [b.course, b.continued])) === JSON.stringify([[physics, false], [dutch, false], [physics, true]]));
    check('the client names the blocks it holds in order, each run once',
        JSON.stringify(cb.heldCourses([flash('a', physics), flash('bb', physics), flash('c', dutch), flash('dd', physics)])) === JSON.stringify([physics, dutch, physics]));
    const stream = [flash('a', physics), flash('bb', physics), flash('c', dutch)];
    check('a card rated Again goes back at the end of its own course’s block, not after the next course', cb.blockEnd(stream, 0) === 2);
    check('...and on a one-course stream at its end, as before', cb.blockEnd([flash('a', physics), flash('bb', physics)], 0) === 2);
    const taught = [{ key: 'l', kind: 'lesson', nodeId: 7, projectId: physics }, { key: 'cp', kind: 'checkpoint', nodeId: 7, projectId: physics }];
    const merged = placeCheckpoints(taught, [recall('r9', dutch), { ...recall('r7', physics), nodeId: 7 }]);
    check('a merged page never puts a recall card inside a chapter, before its checkpoint',
        JSON.stringify(merged.map(c => c.key)) === JSON.stringify(['l', 'cp', 'r9', 'r7']), JSON.stringify(merged.map(c => c.key)));
});

await block('5. on screen: the header, the name once, the headings', async () => {
    const view = readFileSync(join(ROOT, 'src', 'components', 'feed', 'FeedView.tsx'), 'utf8');
    check('Today draws its groups as course blocks', /courseBlocks\(/.test(view) && /<CourseBlock\b/.test(view));
    const store = readFileSync(join(ROOT, 'src', 'store.ts'), 'utf8');
    check('both ways the stream pages name the blocks they hold',
        (store.match(/api\.getFeed\(exclude, 15, get\(\)\.feedScope, heldCourses\(get\(\)\.feedCards\)\)/g) ?? []).length === 2);
    const extend = store.slice(store.indexOf('extendFeed: async'), store.indexOf('pullFeedUpdates: async'));
    check('the next page puts a late checkpoint after its own topic, as the paging above does',
        /feedCards:[^\n]*placeCheckpoints\(state\.feedCards, fresh\)/.test(extend));
    const requeue = store.slice(store.indexOf('requeueFeedCard: (key, card, dueAt) =>'));
    check('a card rated Again goes back at its block’s end (`blockEnd`, tested above), where the store inserts it',
        /const end = blockEnd\(state\.feedCards, at\);/.test(requeue.slice(0, 2500)) && /splice\(end\b|slice\(0, end\)/.test(requeue.slice(0, 3500)));
    const blockPath = join(ROOT, 'src', 'components', 'feed', 'CourseBlock.tsx');
    if (!existsSync(blockPath)) { check('CourseBlock.tsx exists', false); return; }

    const require = createRequire(join(ROOT, 'package.json'));
    const esbuild = require('esbuild');
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
    const { window } = dom;
    globalThis.window = window;
    globalThis.document = window.document;
    Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
    for (const k of ['HTMLElement', 'Element', 'Node', 'Event', 'MutationObserver', 'SVGSVGElement']) if (window[k]) globalThis[k] = window[k];
    globalThis.getComputedStyle = window.getComputedStyle.bind(window);
    globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
    globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
    class Observer { observe() { } unobserve() { } disconnect() { } }
    globalThis.ResizeObserver = window.ResizeObserver = Observer;
    globalThis.IntersectionObserver = window.IntersectionObserver = Observer;
    window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } });
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;

    const stubs = {
        'react-i18next': `export const useTranslation = () => ({ t: (k, o) => k.replace(/\\{\\{(\\w+)\\}\\}/g, (_, n) => String(o?.[n] ?? '')), i18n: { language: 'en' } });`,
        'i18n': `export default { t: (k) => k, language: 'en' }; export const k = (s) => s; export const currentLocale = () => 'en';`,
        'store': `const state = { addToast() { }, theme: 'light', themeTint: null, searchProviders: [], projects: [], a11y: {} };
            export const useStore = (sel) => sel(state); useStore.getState = () => state; useStore.setState = () => { }; useStore.subscribe = () => () => { };
            export const isDarkTheme = () => false; export const themeKeyOf = () => 'light';`,
        'api': `export const api = new Proxy({}, { get: () => () => new Promise(() => { }) }); export const newAttemptId = () => 'a';`,
    };
    // Beside the checkout's node_modules, so the bundle's `require('react')` resolves.
    const cacheDir = join(ROOT, 'node_modules', '.cache');
    mkdirSync(cacheDir, { recursive: true });
    const buildDir = mkdtempSync(join(cacheDir, 'course-blocks-gates-'));
    const build = join(buildDir, 'blocks.cjs');
    process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }));
    await esbuild.build({
        stdin: {
            contents: `export { default as CourseBlock } from './src/components/feed/CourseBlock';
                export { default as ChapterGroup } from './src/components/feed/ChapterGroup';
                export { default as FeedCardShell } from './src/components/feed/FeedCardShell';`,
            resolveDir: ROOT, loader: 'tsx',
        },
        bundle: true, format: 'cjs', platform: 'node', outfile: build, jsx: 'automatic',
        loader: { '.css': 'empty', '.svg': 'dataurl' }, packages: 'external',
        define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
        logLevel: 'silent',
        plugins: [{
            name: 'stubs',
            setup(b) {
                b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: 'react-i18next', namespace: 'stub' }));
                b.onResolve({ filter: /^(\.\.\/)+store$/ }, () => ({ path: 'store', namespace: 'stub' }));
                b.onResolve({ filter: /^(\.\.\/)+i18n$/ }, () => ({ path: 'i18n', namespace: 'stub' }));
                b.onResolve({ filter: /^(\.\.\/)+api$/ }, () => ({ path: 'api', namespace: 'stub' }));
                b.onLoad({ filter: /.*/, namespace: 'stub' }, a => ({ contents: stubs[a.path], loader: 'js', resolveDir: ROOT }));
            },
        }],
    });
    const { CourseBlock, ChapterGroup, FeedCardShell } = require(build);
    const React = require('react');
    const { createRoot } = require('react-dom/client');
    const h = React.createElement;
    const mount = async (el) => {
        const host = window.document.createElement('div');
        window.document.body.appendChild(host);
        const root = createRoot(host);
        await React.act(() => root.render(el));
        return host;
    };
    const chapter = h(ChapterGroup, { projectName: 'Physics', projectColor: '#2563eb', projectId: physics, nodeTitle: 'Lenses', nodeId: P[0] },
        h('p', null, 'A lens bends light.'));
    const card = h(FeedCardShell, { projectName: 'Physics', projectColor: '#2563eb', nodeTitle: 'A due card' }, h('p', null, 'Front'));
    const host = await mount(h(CourseBlock, { name: 'Physics', color: '#2563eb', icon: 'atom', continued: false }, chapter, card));
    const said = (host.textContent.match(/Physics/g) ?? []).length;
    check('the course is named once in its block: in the header, by no card under it', said === 1, `${said} times`);
    const header = host.querySelector('[role="group"] > h2');
    check('the header is the block’s heading and stays pinned', header?.textContent.includes('Physics') && /\bsticky\b/.test(header.className)
        && host.querySelector('[role="group"]')?.getAttribute('aria-labelledby') === header.id);
    check('a block is a named group, not a landmark per course', !host.querySelector('section, [role="region"]'));
    check('the header is opaque: nothing scrolls through it', /\bbg-slate-100\b/.test(header?.className ?? '') && !/\/\d+\b/.test((header?.className ?? '').match(/bg-slate-\S+/g)?.join(' ') ?? ''));
    check('a topic in a block is one heading level below the course', host.querySelector('h3')?.textContent.includes('Lenses'), host.innerHTML.slice(0, 200));
    check('...and a card’s title one below that', host.querySelector('h4')?.textContent.includes('A due card'));
    const bare = await mount(h(ChapterGroup, { projectName: 'Physics', projectColor: '#2563eb', projectId: physics, nodeTitle: 'Lenses', nodeId: P[0] }, h('p', null, 'x')));
    check('outside a block the same chapter still names its course (the case is real)', bare.textContent.includes('Physics')
        && bare.querySelector('h2')?.textContent.includes('Lenses'));
});

db.close();
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

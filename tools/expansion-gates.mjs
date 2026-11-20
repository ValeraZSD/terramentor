// tools/expansion-gates.mjs — which branches of a course's outline start open.
//
// Run:  node tools/expansion-gates.mjs
//
// Every branch used to start open, so a course of a thousand topics drew its
// whole tree and the learner's place was one card among dozens. The rule
// (`src/utils/defaultExpansion.ts`): from COLLAPSE_FROM_TOPICS study items up,
// a branch starts open only when it holds one in front of the learner now:
// the one "Next up" names, this week's on the plan, or one already under way.
// A learner's own open or close holds while the rule's answer for that branch
// is what it was when they chose.
//
// An opened card's list starts at its first unfinished row, so the work it
// was opened for is in view (`listStartRow`).
//
// Each case below is a way through a course the rule has to get right. The
// last sections run the real store in jsdom (opening a course, a learner's
// open and close, a later visit, a reveal, what storage holds) and read the
// board, so the rule is what the app actually uses and a closed card is only
// as tall as its header.
//
// Deterministic: fixtures built here, one fixed day, no database. The rule is
// bundled from the real .ts with esbuild. The store reads the device's date,
// so its cases use undated courses, whose answer no date changes.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleTs } from './lib/bundleTs.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'expansion-gates-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));

const rule = await bundleTs('src/utils/defaultExpansion.ts', scratch, {
    what: 'expansion rule', platform: 'node',
    needs: ['COLLAPSE_FROM_TOPICS', 'activeTopicIds', 'ruleExpansion', 'applyChoices', 'withChoice', 'choicesFromLegacy', 'choicesFromStorage', 'listStartRow'],
});
const tree = await bundleTs('src/utils/tree.ts', scratch, { what: 'expansion rule', platform: 'node', needs: ['buildTree'] });
if (!rule || !tree) process.exit(0);
const { COLLAPSE_FROM_TOPICS, ruleExpansion, applyChoices, withChoice, choicesFromLegacy, choicesFromStorage } = rule;

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const src = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

// ---- fixtures ----------------------------------------------------------------
// A course is a list of categories; a node is { title, kids } or a topic with
// its own fields. Ids are handed out depth-first, so creation order is
// outline order, as in a course written top to bottom.

const TODAY = '2026-11-19';
const day = (n) => {
    const d = new Date(`${TODAY}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
};

const build = (spec) => tree.buildTree(rowsOf(spec));
function rowsOf(spec) {
    let id = 0;
    const rows = [];
    const add = (n, parentId, position) => {
        n.id = n.fixedId ?? ++id;
        rows.push({
            id: n.id, project_id: 1, parent_id: parentId, title: n.title ?? `topic ${n.id}`, position,
            status: n.status ?? 'not_started', is_note: n.note ? 1 : 0, role: n.role ?? null,
            scheduled_start: n.start ?? null, scheduled_end: n.end ?? null,
            cards: n.cards ?? 0, seen: n.seen ?? 0, attempts: n.attempts ?? 0, completed_at: null,
        });
        (n.kids ?? []).forEach((k, i) => add(k, n.id, i));
    };
    spec.forEach((n, i) => add(n, null, i));
    return rows;
}
const topics = (n, fields = {}) => Array.from({ length: n }, () => ({ ...fields }));
const cat = (title, kids) => ({ title, kids });
/** Eight categories of twenty topics: 160, past the threshold. `shape(i)` dresses category i. */
const bigCourse = (shape = () => ({})) =>
    Array.from({ length: 8 }, (_, i) => cat(`C${i + 1}`, topics(20, shape(i))));
const openOf = (course, answer) => course.filter((c) => answer[c.id]).map((c) => c.title).join(',') || '(none)';
const expect = (label, course, answer, titles) => {
    const got = openOf(course, answer);
    check(label, got === titles, `open: ${got}, expected ${titles}`);
};

// ---- size --------------------------------------------------------------------
console.log('\nsize');
{
    const small = [cat('A', topics(20, { status: 'completed' })), cat('B', topics(20)), cat('Notes', topics(3, { note: true }))];
    expect('a small course opens every branch, finished ones too', small, ruleExpansion(build(small), TODAY), 'A,B,Notes');
}
{
    const course = (n) => [cat('Done', topics(10, { status: 'completed' })), cat('Rest', topics(n - 10))];
    const under = course(COLLAPSE_FROM_TOPICS - 1), at = course(COLLAPSE_FROM_TOPICS);
    expect(`${COLLAPSE_FROM_TOPICS - 1} topics: still opens everything`, under, ruleExpansion(build(under), TODAY), 'Done,Rest');
    expect(`${COLLAPSE_FROM_TOPICS} topics: the finished category starts closed`, at, ruleExpansion(build(at), TODAY), 'Rest');
    check('notes and empty card stages are not counted',
        Object.values(ruleExpansion(build([cat('N', topics(COLLAPSE_FROM_TOPICS, { note: true })), cat('P', topics(COLLAPSE_FROM_TOPICS, { role: 'pagination' }))]), TODAY)).every(Boolean));
    const stages = [cat('Met', topics(10, { role: 'pagination', cards: 40, seen: 40 })), cat('Rest', topics(COLLAPSE_FROM_TOPICS - 10, { role: 'pagination', cards: 40 }))];
    expect('stages an import cut out of card order count, as the rows they are', stages, ruleExpansion(build(stages), TODAY), 'Rest');
}
check('an empty course has nothing to open', Object.keys(ruleExpansion(build([]), TODAY)).length === 0);

// ---- where the learner is ------------------------------------------------------
console.log('\nwhere the learner is');
{
    const c = bigCourse();
    expect('nothing started, no dates: only the first category is open', c, ruleExpansion(build(c), TODAY), 'C1');
}
{
    // Categories 1-2 finished, the plan puts this week in category 3.
    const c = bigCourse((i) => (i < 2 ? { status: 'completed' } : {}));
    c[2].kids.forEach((t, j) => { t.start = day(j); t.end = day(j); });
    c.slice(3).forEach((k, i) => k.kids.forEach((t, j) => { t.start = day(20 + i * 20 + j); t.end = t.start; }));
    expect('finished categories close, the one paced for this week opens, later ones close', c, ruleExpansion(build(c), TODAY), 'C3');
}
{
    // The week runs over a category boundary: both open, the day after the week does not.
    const c = bigCourse((i) => (i < 2 ? { status: 'completed' } : {}));
    c[2].kids.forEach((t, j) => { t.start = day(j - 19); t.end = t.start; t.status = j < 19 ? 'completed' : 'not_started'; });
    c[3].kids.forEach((t, j) => { t.start = day(j + 6); t.end = t.start; });
    c[4].kids.forEach((t, j) => { t.start = day(j + 30); t.end = t.start; });
    expect('a week that spans two categories opens both', c, ruleExpansion(build(c), TODAY), 'C3,C4');
    c[3].kids.forEach((t, j) => { t.start = day(j + 7); t.end = t.start; });
    expect('a topic dated the day after the week does not open its category', c, ruleExpansion(build(c), TODAY), 'C3');
}
{
    // Behind the plan: two categories hold late topics. "Next up" names the
    // oldest one, so that category opens; the next one opens once the learner
    // gets there, not all of the backlog at once.
    const c = bigCourse();
    c[0].kids.forEach((t) => { t.status = 'completed'; });
    c[1].kids.forEach((t, j) => { t.start = day(-40 + j); t.end = t.start; });
    c[2].kids.forEach((t, j) => { t.start = day(-20 + j); t.end = t.start; });
    c.slice(3).forEach((k, i) => k.kids.forEach((t, j) => { t.start = day(30 + i * 20 + j); t.end = t.start; }));
    expect('behind the plan: the category of the oldest late topic opens', c, ruleExpansion(build(c), TODAY), 'C2');
}
{
    const c = bigCourse(() => ({ status: 'completed' }));
    expect('everything finished: every category closed', c, ruleExpansion(build(c), TODAY), '(none)');
    c[5].kids[0].status = 'skipped';
    c[6].kids.forEach((t) => { t.status = 'skipped'; });
    expect('skipped topics count as closed, a category of them too', c, ruleExpansion(build(c), TODAY), '(none)');
    c[7].kids[19].status = 'not_started';
    expect('the one open topic left opens only its category', c, ruleExpansion(build(c), TODAY), 'C8');
}
{
    // A learner who started something far ahead studies in two places at once.
    const c = bigCourse((i) => (i < 2 ? { status: 'completed' } : {}));
    c[6].kids[4].status = 'in_progress';
    c[4].kids[2].attempts = 3;
    expect('topics under way open their categories beside "Next up"', c, ruleExpansion(build(c), TODAY), 'C3,C5,C7');
}
{
    // Deep nesting: C5 > Part B > Section ii > the topic. The path opens, its
    // siblings do not.
    const c = bigCourse((i) => (i < 4 ? { status: 'completed' } : {}));
    c[4].kids = [
        cat('Part A', [cat('Section i', topics(5, { status: 'completed' }))]),
        cat('Part B', [cat('Section i', topics(5, { status: 'completed' })), cat('Section ii', topics(5)), cat('Section iii', topics(5))]),
    ];
    const answer = ruleExpansion(build(c), TODAY);
    const [partA, partB] = c[4].kids;
    expect('the deep topic opens its top category', c, answer, 'C5');
    check('…and every branch on the way down to it', answer[partB.id] && answer[partB.kids[1].id] === true);
    check('…and not the finished or later branches beside that path',
        !answer[partA.id] && !answer[partA.kids[0].id] && !answer[partB.kids[0].id] && !answer[partB.kids[2].id]);
}
{
    // A topic with notes under it is still a topic; open when it is the one.
    const c = bigCourse();
    c[0].kids[0].kids = [{ note: true }, { note: true }];
    const answer = ruleExpansion(build(c), TODAY);
    check('a topic holding notes opens when it is "Next up"', answer[c[0].kids[0].id] === true);
    // A category holding nothing but notes is a topic itself (the leaf rule,
    // src/utils/tree.ts): open while it is next, closed once finished, like
    // any other.
    const notes = [cat('Notes', topics(4, { note: true })), ...bigCourse()];
    expect('a category of notes only is a topic: open while it is next', notes, ruleExpansion(build(notes), TODAY), 'Notes');
    notes[0].status = 'completed';
    expect('…closed once finished', notes, ruleExpansion(build(notes), TODAY), 'C1');
    const bare = [{ title: 'Notes', note: true, kids: topics(4, { note: true }) }, ...bigCourse()];
    expect('a note with notes under it is no work and starts closed', bare, ruleExpansion(build(bare), TODAY), 'C1');
}
{
    // A deck: sections are topics whose content is cards. Met cards finish a
    // section and start one, as the progress counts do.
    const deck = Array.from({ length: 8 }, (_, i) => cat(`S${i + 1}`, topics(20, { cards: 30 })));
    deck[0].kids.forEach((t) => { t.seen = 30; });
    deck[1].kids.slice(0, 4).forEach((t) => { t.seen = 30; });
    deck[1].kids[4].seen = 12;
    expect('a deck: met cards finish a section, the section being met opens', deck, ruleExpansion(build(deck), TODAY), 'S2');
    // An imported deck cut into stages (no topic in it at all): it is studied stage by stage.
    const staged = Array.from({ length: 8 }, (_, i) => cat(`D${i + 1}`, topics(20, { role: 'pagination', cards: 50 })));
    expect('a deck of stages, nothing met: its first part opens', staged, ruleExpansion(build(staged), TODAY), 'D1');
    staged[0].kids.forEach((t) => { t.seen = 50; });
    staged[2].kids[7].seen = 9;
    expect('…a stage being met opens its part, beside the next unmet one', staged, ruleExpansion(build(staged), TODAY), 'D2,D3');
}
{
    // The order the feed serves in when nothing is due: dated topics first,
    // then undated ones in creation order. A topic added to C1 after the rest
    // of the course was written comes after them.
    const c = bigCourse((i) => (i === 0 ? { status: 'completed' } : {}));
    c[0].kids[0] = { fixedId: 9999 };
    expect('undated topics come in creation order, not outline order', c, ruleExpansion(build(c), TODAY), 'C2');
    c[5].kids[3].start = day(30); c[5].kids[3].end = day(30);
    expect('a dated topic comes before every undated one', c, ruleExpansion(build(c), TODAY), 'C6');
}
{
    // Two late topics due the same day: the server names the older one
    // (`scheduled_end, id`), wherever the outline put it.
    const c = bigCourse(() => ({ status: 'completed' }));
    c[1].kids[0] = { fixedId: 9001, start: day(-3), end: day(-3) };
    c[4].kids[0] = { fixedId: 9000, start: day(-3), end: day(-3) };
    expect('late topics due the same day: the older one is next, not the first in the outline', c, ruleExpansion(build(c), TODAY), 'C5');
}
{
    // A taught import that kept card stages beside its topics: "Next up" is a
    // topic, never a stage, however early the stage was made.
    const c = bigCourse((i) => (i === 0 ? { role: 'pagination', cards: 5 } : {}));
    expect('stages beside topics: "Next up" is the first topic, not a stage made earlier', c, ruleExpansion(build(c), TODAY), 'C2');
}
{
    // The server ranks a topic as dated by its start alone.
    const c = bigCourse((i) => (i === 0 ? { status: 'completed' } : {}));
    c[5].kids[2].start = day(20);
    expect('a topic with a start and no end is dated, ahead of the undated ones', c, ruleExpansion(build(c), TODAY), 'C6');
}

// ---- the learner's own choices -------------------------------------------------
console.log('\nthe learner\'s own choices');
{
    const c = bigCourse((i) => (i < 2 ? { status: 'completed' } : {}));
    const r1 = ruleExpansion(build(c), TODAY);
    const [c2, c3, c5] = [c[1].id, c[2].id, c[4].id];
    // The learner closes C3 (the one being studied) and opens C5 and C2 to look ahead and back.
    let choices = {};
    choices = withChoice(choices, c3, false, r1[c3]);
    choices = withChoice(choices, c5, true, r1[c5]);
    choices = withChoice(choices, c2, true, r1[c2]);
    const later = applyChoices(r1, choices);
    expect('a later visit keeps every open and close the learner made', c, later.expanded, 'C2,C5');
    check('…and keeps the choices themselves', Object.keys(later.choices).length === 3);
    check('opening what the rule opens anyway is no choice to keep',
        Object.keys(withChoice({}, c3, true, true)).length === 0 && Object.keys(withChoice(choices, c3, true, true)).length === 2);

    // C3 is finished: the rule moves on to C4, and the choices about C3 end.
    c[2].kids.forEach((t) => { t.status = 'completed'; });
    const r2 = ruleExpansion(build(c), TODAY);
    const moved = applyChoices(r2, choices);
    expect('when the course moves on, the category studied now opens', c, moved.expanded, 'C2,C4,C5');
    check('…the close of C3 ends with C3 (finished, closed by the rule now)', !(c3 in moved.choices) && moved.expanded[c3] === false);
    check('…the look back at C2 still holds (C2 is still finished)', moved.choices[c2]?.open === true);

    // C5 becomes the one being studied: the rule opens it, the old choice ends quietly.
    c[3].kids.forEach((t) => { t.status = 'completed'; });
    const r3 = ruleExpansion(build(c), TODAY);
    const reached = applyChoices(r3, moved.choices);
    check('a category opened early stays open once reached, and the choice ends',
        reached.expanded[c5] === true && !(c5 in reached.choices));

    const other = { 9001: { open: false, rule: true } };
    check('choices about another course are left alone', applyChoices(r1, { ...choices, ...other }).choices[9001] === other[9001]);
}
{
    // The old store kept every default as open, so only a closed entry was the learner's own.
    const legacy = JSON.stringify({ 3: true, 7: false, x: false, '-2': false });
    const choices = choicesFromLegacy(legacy);
    check('the old map turns into choices: closed entries only', JSON.stringify(choices) === JSON.stringify({ 7: { open: false, rule: true } }), JSON.stringify(choices));
    const c = bigCourse((i) => (i < 2 ? { status: 'completed' } : {}));
    const r = ruleExpansion(build(c), TODAY);
    const kept = applyChoices(r, choicesFromLegacy(JSON.stringify({ [c[2].id]: false, [c[0].id]: false })));
    check('an old close of the category being studied still holds', kept.expanded[c[2].id] === false && c[2].id in kept.choices);
    check('an old close of a finished category is closed by the rule now, and drops', kept.expanded[c[0].id] === false && !(c[0].id in kept.choices));
}
{
    // Storage is anyone's to write: a broken or foreign value is no choice.
    const junk = ['not json', 'null', '[1,2]', '"text"', JSON.stringify({ 5: { open: 'yes', rule: true }, 6: null, 7: { open: true }, x: { open: true, rule: false } })];
    check('broken or foreign storage reads as no choices, never a crash',
        junk.every((t) => Object.keys(choicesFromStorage(t)).length === 0 && Object.keys(choicesFromLegacy(t)).length === 0) && Object.keys(choicesFromStorage(null)).length === 0);
    const good = choicesFromStorage(JSON.stringify({ 4: { open: true, rule: false }, 8: { open: 1, rule: true } }));
    check('…while a well-formed choice beside a broken one is kept', JSON.stringify(good) === JSON.stringify({ 4: { open: true, rule: false } }), JSON.stringify(good));
}

// ---- the store ---------------------------------------------------------------
// The real store in jsdom. `fetch` answers the outline and leaves every other
// request pending; localStorage is the page's own, carried from one page to
// the next as a later visit.
console.log('\nthe store');
const require = createRequire(import.meta.url);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const { JSDOM } = require('jsdom');
const storeBundle = (await (await import('esbuild')).build({
    stdin: { contents: `import { useStore } from './src/store'; window.__gate = { useStore };`, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' }, loader: { '.css': 'empty', '.svg': 'dataurl' },
})).outputFiles[0].text;
const CHOICES = 'terramentor-expansion-choices', LEGACY = 'terramentor-expansion';

/** Open `rows` as course 1 on a fresh page whose storage holds `storage`. */
async function visit(rows, storage = {}, { failWrites = false } = {}) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false, addEventListener() { }, removeEventListener() { } });
    for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
    if (failWrites) w.Storage.prototype.setItem = () => { throw new w.DOMException('full', 'QuotaExceededError'); };
    w.fetch = (url) => /\/projects\/1\/nodes$/.test(String(url))
        ? Promise.resolve(new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } }))
        : new Promise(() => { });
    w.eval(storeBundle);
    const { useStore } = w.__gate;
    useStore.setState({ _navigate: () => { } });
    await useStore.getState().loadProjectData(1);
    const stored = () => Object.fromEntries(Object.keys(w.localStorage).map((k) => [k, w.localStorage.getItem(k)]));
    return { s: useStore.getState, stored, write: (k, v) => w.localStorage.setItem(k, v), close: () => w.close() };
}
const storedChoices = (page) => choicesFromStorage(page.stored()[CHOICES] ?? null);
{
    // Undated, so the device's date changes nothing: C1-C2 finished, C3 next.
    const c = bigCourse((i) => (i < 2 ? { status: 'completed' } : {}));
    const rows = rowsOf(c);
    const [c1, c3, c5, c7] = [c[0].id, c[2].id, c[4].id, c[6].id];

    const first = await visit(rows);
    expect('opening a big course opens only where the learner is', c, first.s().expanded, 'C3');
    first.s().toggleExpanded(c3);
    first.s().toggleExpanded(c5);
    expect("the learner's close and open show at once", c, first.s().expanded, 'C5');
    const kept = storedChoices(first);
    check('…and are kept as choices against the rule', kept[c3]?.open === false && kept[c3]?.rule === true && kept[c5]?.open === true && kept[c5]?.rule === false, JSON.stringify(kept));
    first.s().revealNode(c[6].kids[3].id);
    check('a reveal (a search hit, a link) opens the path for now', first.s().expanded[c7] === true);
    const keptAnywhere = (page, id) => id in storedChoices(page) || String(id) in JSON.parse(page.stored()[LEGACY] ?? '{}');
    check('…and is not kept', !keptAnywhere(first, c7), JSON.stringify(first.stored()));
    const storage = first.stored();
    first.close();

    const again = await visit(rows, storage);
    expect('a later visit shows the course as the learner left it, not the reveal', c, again.s().expanded, 'C5');
    again.s().collapseAll();
    const closed = await visit(rows, again.stored());
    expect('closing everything holds on the next visit', c, closed.s().expanded, '(none)');
    again.close(); closed.close();

    const legacy = await visit(rows, { [LEGACY]: JSON.stringify({ [c1]: true, [c3]: false, [c5]: true }) });
    expect('a close kept by the old store still holds', c, legacy.s().expanded, '(none)');
    check('…the old map is gone once its choices are kept', !(LEGACY in legacy.stored()) && storedChoices(legacy)[c3]?.open === false);
    legacy.close();

    const both = await visit(rows, { [CHOICES]: JSON.stringify({ [c5]: { open: true, rule: false } }), [LEGACY]: JSON.stringify({ [c3]: false }) });
    expect('with choices already kept, the old map is ignored', c, both.s().expanded, 'C3,C5');
    check('…and removed', !(LEGACY in both.stored()));
    both.close();

    const full = await visit(rows, { [LEGACY]: JSON.stringify({ [c3]: false }) }, { failWrites: true });
    expect('storage refusing writes: the old close still shows', c, full.s().expanded, '(none)');
    check('…and the old map stays until its choices are kept', LEGACY in full.stored());
    full.s().toggleExpanded(c5);
    expect('…and a choice made now lasts the visit', c, full.s().expanded, 'C5');
    full.s().toggleExpanded(c7);
    full.s().toggleExpanded(c5);
    full.s().toggleExpanded(c5);
    await full.s().loadProjectData(1);
    expect('…and so do several, the earlier ones too, through a reload', c, full.s().expanded, 'C5,C7');
    full.close();

    const quota = await visit(rows, { [CHOICES]: JSON.stringify({}) }, { failWrites: true });
    quota.s().toggleExpanded(c5);
    quota.s().toggleExpanded(c7);
    await quota.s().loadProjectData(1);
    expect('storage full: the visit keeps every choice made since, reloaded or not', c, quota.s().expanded, 'C3,C5,C7');
    quota.close();

    const moved = await visit(rows);
    const canOpenForNow = typeof moved.s().openForNow === 'function';
    if (canOpenForNow) moved.s().openForNow(c7);
    check('a row added or dropped into a closed branch opens it for now', canOpenForNow && moved.s().expanded[c7] === true);
    check('…and that open is not kept', canOpenForNow && !keptAnywhere(moved, c7), JSON.stringify(moved.stored()));
    moved.close();

    const broken = await visit(rows, { [CHOICES]: 'not json{' });
    expect('broken storage opens the course by the rule', c, broken.s().expanded, 'C3');
    broken.close();

    // Another tab (same storage) keeps a choice while this one is open; this
    // tab's next choice must not write back the copy it read when it opened.
    const tab = await visit(rows);
    tab.s().setExpanded(c5, true);
    tab.write(CHOICES, JSON.stringify({ ...storedChoices(tab), [c7]: { open: true, rule: false } }));
    tab.s().toggleExpanded(c3);
    const got = storedChoices(tab);
    check("a choice another tab kept meanwhile survives this tab's next one",
        got[c7]?.open === true && got[c5]?.open === true && got[c3]?.open === false, JSON.stringify(got));
    tab.close();
}

// ---- where an opened list starts ---------------------------------------------
console.log('\nwhere an opened list starts');
{
    const rowsFor = (spec) => {
        const flat = [];
        const walk = (n) => { flat.push(n); n.children.forEach(walk); };
        build(spec).forEach((c) => c.children.forEach(walk));
        return flat;
    };
    const at = (spec) => {
        const rows = rowsFor(spec);
        const id = rule.listStartRow(rows);
        return id == null ? null : rows.findIndex((n) => n.id === id);
    };
    check('eleven finished, four open: the list starts one row above the first open one',
        at([cat('C', [...topics(11, { status: 'completed' }), ...topics(4)])]) === 10);
    check('everything finished: the list stays at its top', at([cat('C', topics(15, { status: 'completed' }))]) === null);
    check('the first row is open: the list stays at its top', at([cat('C', topics(15))]) === null);
    check('the second row is open: already in view, the list stays at its top',
        at([cat('C', [...topics(1, { status: 'completed' }), ...topics(14)])]) === null);
    check('skipped topics count as finished',
        at([cat('C', [...topics(5, { status: 'skipped' }), ...topics(3)])]) === 4);
    check('a deck topic whose cards are all met is finished before anyone marks it',
        at([cat('C', [...topics(6, { cards: 4, seen: 4 }), ...topics(3, { cards: 4 })])]) === 5);
    check('notes are no work and never the place to start',
        at([cat('C', [...topics(4, { status: 'completed' }), { note: true }, { note: true }, ...topics(2)])]) === 5);
    const card = src('src/components/CategoryCard.tsx');
    check("the card scrolls its own list to that row, never the page, once per opening",
        /listStartRow\(/.test(card) && /scrollIntoViewWithin\([^)]*boundary:\s*list/.test(card)
            && /useLayoutEffect\([\s\S]*?\},\s*\[isExpanded\]\)/.test(card) && !/\.scrollIntoView\(/.test(card));
}

// ---- the board ---------------------------------------------------------------
console.log('\nthe board');
{
    const grid = src('src/components/NodeTree.tsx').match(/<div className="([^"]*)" data-card-grid/)?.[1] ?? '';
    check('the card grid does not stretch a closed card to its open neighbour', /\bitems-start\b/.test(grid), grid);
    const crumbs = src('src/components/Breadcrumbs.tsx').replace(/\/\/.*$/gm, '');
    check('a breadcrumb opens the path for this visit only, as a reveal', /revealNode\(/.test(crumbs) && !/setExpanded|toggleExpanded/.test(crumbs));
    // Adding a row and dropping one open the target for the learner to see it
    // land; neither is them choosing to keep that branch open.
    const noCode = (rel) => src(rel).replace(/\/\/.*$/gm, '');
    const places = {
        'src/components/CategoryCard.tsx': /openForNow\(node\.id\)/,
        'src/components/TreeItemRow.tsx': /openForNow\(node\.id\)/,
        'src/components/NodeTree.tsx': /openForNow\(placed\.parentId\)/,
        'src/components/Sidebar.tsx': /openForNow\(newParentId\)/,
    };
    for (const [rel, call] of Object.entries(places)) {
        const code = noCode(rel);
        check(`${rel.split('/').pop()}: an add or a drop opens its target for now, not as a choice`,
            call.test(code) && !/setExpanded\((node\.id|placed\.parentId|newParentId)\b/.test(code));
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

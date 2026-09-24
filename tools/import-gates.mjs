// tools/import-gates.mjs — the course-import boundary.
//
// Run:  node tools/import-gates.mjs
//
// Two things are asserted here, and they fail in different ways.
//
// 1. The normalizer both import paths share. A course file is something you were
//    GIVEN — by a cloud model, by a classmate, by a future marketplace — and its
//    resource URLs end up in an `href`. The two importers had drifted into
//    different opinions about the same file, and neither looked at a URL at all.
//
// 2. That the OUTLINE BRIEF the app hands out still describes the importer that
//    exists. That text is hand-maintained against a validator buried in a
//    3000-line file, and it promises "any field not listed here is discarded
//    silently" — a promise nothing was checking. Field drift is silent: a
//    documented field the importer ignores means a cloud model spends its output
//    budget writing something that is thrown away on import. It is the string
//    the app itself serves, so there is one copy to check — not a
//    PromptToGenerateProjectJSON.md duplicating the field tables.
//
// 3. The `questions` a node may carry. This field did not exist, and its
//    absence is why a real imported course shipped 4,315 practice items as
//    markdown prose with the key folded into a `<details>`: ungraded, invisible
//    to BKT, and chopped into "part 1/2/3" by the 10,000-character prose cap.
//    A question that arrives here becomes a REAL quiz, so everything that makes
//    one honest has to happen on the way in — and a bad question must cost its
//    own row, never the course around it.
//
// No model calls and no network. `questionDefects` and the answer-format
// registry reach `database.js`, so this sets a SCRATCH database first — the
// same thing `answer-format-gates.mjs` does, for the same reason: a gate must
// never be able to touch the real library.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'import-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

const B = new URL('../server/', import.meta.url).href;
const { sanitizeUrl, MAX_URL_LENGTH } = await import(B + 'urlSafety.js');
const {
    normalizeImportProject, normalizeImportTree, ImportError,
    normalizeMaterialPayload, matchMaterialToLeaves,
    MAX_MATERIAL_LEAVES, MAX_MATERIAL_PER_LEAF,
    MATERIAL_MIN_CHARS, leafHasMaterial,
    VALID_NODE_STATUSES, VALID_RESOURCE_TYPES,
    MAX_IMPORT_DEPTH, MAX_IMPORT_NODES, MAX_WARNINGS, LIMITS,
    MAX_QUESTIONS_PER_NODE, MAX_IMPORT_QUESTIONS,
    MAX_CARDS_PER_NODE, MAX_IMPORT_CARDS,
    READ_PROJECT_FIELDS, READ_NODE_FIELDS, READ_RESOURCE_FIELDS,
    isValidUuid,
} = await import(B + 'curriculumSchema.js');
const { normalizeQuestionFormat } = await import(B + 'answerFormats.js');
const { sanitizeQuestionMedia } = await import(B + 'agentic.js');
const { questionDefects } = await import(B + 'feedQuality.js');
const QUESTION_DEPS = { normalizeQuestionFormat, questionDefects, sanitizeQuestionMedia };

let pass = 0, fail = 0;
const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    ok ? pass++ : fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};
const throws = (name, fn, match) => {
    try { fn(); fail++; console.log(` FAIL  ${name}  (did not throw)`); }
    catch (e) {
        const ok = e instanceof ImportError && (!match || e.message.includes(match));
        ok ? pass++ : fail++;
        console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  (threw ${e.name}: ${e.message})`}`);
    }
};

// A minimal well-formed course, so each test varies exactly one thing.
const tree = (...nodes) => normalizeImportTree(nodes);
const leaf = (extra = {}) => ({ title: 'Snell\u2019s law', ...extra });
const deps = { isSupportedLanguage: (c) => ['en', 'nl', 'ja'].includes(c) };

console.log('\n--- a resource URL ends up in an href, so the scheme is checked ---');
for (const [name, url] of [
    ['javascript: (script execution in our own origin)', 'javascript:alert(document.cookie)'],
    ['javascript: with mixed case', 'JaVaScRiPt:alert(1)'],
    ['javascript: with leading whitespace', '   javascript:alert(1)'],
    ['data: scheme', 'data:text/html,<script>alert(1)</script>'],
    ['vbscript: scheme', 'vbscript:msgbox(1)'],
    ['file: scheme (reads off the learner\u2019s disk)', 'file:///C:/Windows/win.ini'],
    ['blob: scheme', 'blob:https://example.com/1234'],
    ['embedded credentials', 'https://evil.example@trusted.com/page'],
]) check(name + ' is rejected', sanitizeUrl(url).ok, false);

check('a plain https URL is kept', sanitizeUrl('https://example.com/a?b=c#d'),
    { ok: true, url: 'https://example.com/a?b=c#d' });
// Deliberately unlike validateUrlTemplate: real course material still lives on
// plain-http university pages, and dropping those loses more than it prevents.
check('plain http is KEPT (unlike a search-provider template)',
    sanitizeUrl('http://hyperphysics.phy-astr.gsu.edu/hbase/phyopt/huygen.html').ok, true);
check('an empty URL is valid (a resource may have no link)', sanitizeUrl(''), { ok: true, url: '' });
check('null is valid', sanitizeUrl(null), { ok: true, url: '' });
check('a bare hostname is normalized to https', sanitizeUrl('example.com/page'),
    { ok: true, url: 'https://example.com/page' });
check('an over-long URL is rejected', sanitizeUrl('https://e.com/' + 'a'.repeat(MAX_URL_LENGTH)).ok, false);
check('the https:// fallback cannot rescue javascript:',
    sanitizeUrl('javascript:alert(1)').reason.includes('javascript:'), true);

console.log('\n--- structural damage throws; nothing importable is past it ---');
throws('missing project', () => normalizeImportProject(undefined, deps), 'missing project');
throws('project without a name', () => normalizeImportProject({}, deps), 'must have a name');
throws('missing nodes', () => normalizeImportTree(undefined), 'missing nodes');
throws('nodes not an array', () => normalizeImportTree({}), 'must be an array');
throws('a node that is not an object', () => tree('hello'), 'must be an object');
throws('a node that is an array', () => tree([]), 'must be an object');
throws('a node without a title', () => tree({ description: 'x' }), 'must have a title');
throws('children not an array', () => tree(leaf({ children: 'x' })), 'children');
throws('resources not an array', () => tree(leaf({ resources: 'x' })), 'resources');
throws('a resource without a title', () => tree(leaf({ resources: [{ url: 'https://e.com' }] })), 'must have a title');

console.log('\n--- bounds (importNode recurses inside a transaction) ---');
let deep = leaf();
for (let i = 0; i < MAX_IMPORT_DEPTH + 2; i++) deep = { title: `L${i}`, children: [deep] };
throws('a tree deeper than the cap', () => tree(deep), 'deeper than');
check('a tree exactly at the cap is fine', (() => {
    let n = leaf();
    for (let i = 0; i < MAX_IMPORT_DEPTH - 1; i++) n = { title: `L${i}`, children: [n] };
    return tree(n).count;
})(), MAX_IMPORT_DEPTH);
throws('more nodes than the cap',
    () => tree(...Array.from({ length: MAX_IMPORT_NODES + 1 }, (_, i) => ({ title: `n${i}` }))), 'more than');

console.log('\n--- repairs warn, they do not reject (and they are never silent) ---');
const badStatus = tree(leaf({ status: 'nearly_done' }));
check('an unknown status becomes not_started', badStatus.nodes[0].status, 'not_started');
check('...and says so', badStatus.warnings.length, 1);
check('every valid status survives',
    VALID_NODE_STATUSES.map(s => tree(leaf({ status: s })).nodes[0].status), VALID_NODE_STATUSES);
check('an empty status is not a warning', tree(leaf({ status: '' })).warnings.length, 0);

const badType = tree(leaf({ resources: [{ title: 'R', type: 'podcast' }] }));
check('an unknown resource type becomes link', badType.nodes[0].resources[0].type, 'link');
check('...and says so', badType.warnings.length, 1);
check('every valid resource type survives',
    VALID_RESOURCE_TYPES.map(t => tree(leaf({ resources: [{ title: 'R', type: t }] })).nodes[0].resources[0].type),
    VALID_RESOURCE_TYPES);

const badUrl = tree(leaf({ resources: [{ title: 'Free marks', url: 'javascript:alert(1)' }] }));
check('an unsafe link is dropped', badUrl.nodes[0].resources[0].url, '');
check('...but the resource is kept, so its title still says what to look at',
    badUrl.nodes[0].resources[0].title, 'Free marks');
check('...and says so', badUrl.warnings.length, 1);

console.log('\n--- caps are applied where the DB expects them ---');
check('title is capped', tree(leaf({ title: 'a'.repeat(LIMITS.title + 50) })).nodes[0].title.length, LIMITS.title);
check('description is capped', tree(leaf({ description: 'a'.repeat(LIMITS.description + 50) })).nodes[0].description.length, LIMITS.description);
check('notes is capped', tree(leaf({ notes: 'a'.repeat(LIMITS.notes + 50) })).nodes[0].notes.length, LIMITS.notes);
check('is_note is coerced to 0/1', [tree(leaf()).nodes[0].is_note, tree(leaf({ is_note: true })).nodes[0].is_note], [0, 1]);
check('missing prose becomes empty strings, never undefined',
    [tree(leaf()).nodes[0].description, tree(leaf()).nodes[0].notes], ['', '']);

console.log('\n--- warnings are bounded (a hostile file must not balloon the response) ---');
const noisy = tree(...Array.from({ length: MAX_WARNINGS + 25 }, (_, i) => ({ title: `n${i}`, status: 'bogus' })));
check('the list is capped', noisy.warnings.length, MAX_WARNINGS + 1);
check('...with a tail saying how many were elided', noisy.warnings.at(-1).includes('more of the same kind'), true);

console.log('\n--- uuid: portable identity, validated before it is trusted ---');
check('a v4 uuid is accepted', isValidUuid('3f2504e0-4f89-41d3-9a0c-0305e82c3301'), true);
check('a v1 uuid is rejected', isValidUuid('3f2504e0-4f89-11d3-9a0c-0305e82c3301'), false);
check('a non-uuid is rejected', isValidUuid('../../etc/passwd'), false);
check('a valid node uuid is carried through',
    tree(leaf({ uuid: '3F2504E0-4F89-41D3-9A0C-0305E82C3301' })).nodes[0].uuid, '3f2504e0-4f89-41d3-9a0c-0305e82c3301');
check('an invalid one becomes null (the DB trigger mints a fresh one)',
    tree(leaf({ uuid: 'nope' })).nodes[0].uuid, null);
check('...and says so', tree(leaf({ uuid: 'nope' })).warnings.length, 1);
check('an absent uuid is not a warning', tree(leaf()).warnings.length, 0);

console.log('\n--- the project header ---');
const okProject = normalizeImportProject({ name: 'Wave Optics', content_language: 'nl', version: '1.2.0' }, deps);
check('a supported language is kept', okProject.project.content_language, 'nl');
check('version is kept as free text', okProject.project.version, '1.2.0');
check('defaults are filled', [okProject.project.color, okProject.project.icon], ['#3B82F6', 'folder']);
const badLang = normalizeImportProject({ name: 'X', content_language: 'zz' }, deps);
check('an unknown language falls back to "follow the material"', badLang.project.content_language, '');
// A silent fallback here is how a shared Dutch course ends up having every
// future lesson authored in whatever the local model guesses.
check('...and says so rather than falling back silently', badLang.warnings.length, 1);
check('no language at all is not a warning', normalizeImportProject({ name: 'X' }, deps).warnings.length, 0);

console.log('\n--- the authoring brief still describes the importer that exists ---');
const { OUTLINE_BRIEF, MATERIAL_BRIEF, buildOutlineBrief, buildMaterialBrief } = await import(B + 'authoringBrief.js');
const doc = OUTLINE_BRIEF;

const section = (heading) => {
    const start = doc.indexOf(heading);
    if (start < 0) return '';
    const next = doc.indexOf('\n## ', start + heading.length);
    return doc.slice(start, next < 0 ? doc.length : next);
};
const tableFields = (heading) => [...section(heading).matchAll(/^\|\s*`(\w+)`\s*\|/gm)].map(m => m[1]);
const jsonKeys = (block) => [...block.matchAll(/^\s*"(\w+)":/gm)].map(m => m[1]);

// The §1 output contract block, project object only.
const contract = section('## 1. Output contract');
const projectBlock = contract.slice(contract.indexOf('"project": {') + 12, contract.indexOf('"nodes"'));
const documentedProject = jsonKeys(projectBlock);
const documentedNode = tableFields('## 2. The Node object');
const documentedResource = tableFields('## 5. Resources');

const missing = (documented, read) => read.filter(f => !documented.includes(f)).sort();
const phantom = (documented, read) => documented.filter(f => !read.includes(f)).sort();

check('every project field the importer reads is documented', missing(documentedProject, READ_PROJECT_FIELDS), []);
check('...and every documented project field is read', phantom(documentedProject, READ_PROJECT_FIELDS), []);
check('every node field the importer reads is documented', missing(documentedNode, READ_NODE_FIELDS), []);
check('...and every documented node field is read', phantom(documentedNode, READ_NODE_FIELDS), []);
check('every resource field the importer reads is documented', missing(documentedResource, READ_RESOURCE_FIELDS), []);
check('...and every documented resource field is read', phantom(documentedResource, READ_RESOURCE_FIELDS), []);

// The doc used to advertise a top-level parser version. It was never read.
check('the brief no longer advertises a top-level parser version',
    /^\s*"version":/m.test(contract.slice(0, contract.indexOf('"project"'))), false);

// Pass one must FORBID material, not merely omit mentioning it: a model offered
// the choice between writing a tree and writing lessons always takes the tree,
// which is the measured failure this split exists to design out.
check('the outline brief forbids is_note outright', /No `is_note` field appears anywhere/.test(doc), true);

console.log('\n--- and the brief\u2019s worked example actually imports ---');
const example = section('## 9. Worked example');
const json = example.slice(example.indexOf('```json') + 7, example.lastIndexOf('```'));
let parsed = null;
try { parsed = JSON.parse(json); check('the worked example is strict-parseable JSON', true, true); }
catch (e) { fail++; console.log(` FAIL  the worked example is strict-parseable JSON  (${e.message})`); }

if (parsed) {
    const header = normalizeImportProject(parsed.project, { isSupportedLanguage: () => true });
    const body = normalizeImportTree(parsed.nodes);
    check('...and normalizes with no repairs needed', [...header.warnings, ...body.warnings], []);

    // Pass one's example must PRACTISE what section 4 forbids. The old
    // single-pass example showed its material bodies as parenthetical
    // placeholders — "*(600-2000 words: state it, ...)*" — and the measured
    // result was a model reproducing that exact shape in 78% of the material it
    // wrote. An example is copied harder than a rule, so it is checked here.
    const every = (list, fn) => list.every(n => fn(n) && every(n.children, fn));
    check('the outline example contains no material at all', every(body.nodes, n => n.is_note === 0), true);
    check('...and no placeholder-shaped description',
        every(body.nodes, n => !/\*\(\d{3}/.test(n.description)), true);

    const leafRes = [];
    const walkRes = (list) => list.forEach(n => {
        const isLeaf = n.children.filter(c => !c.is_note).length === 0;
        if (n.resources.length) leafRes.push(isLeaf);
        walkRes(n.children);
    });
    walkRes(body.nodes);
    check('...and puts resources only on leaf topics', leafRes.length > 0 && leafRes.every(Boolean), true);
}

console.log('\n--- pass two: the material brief and the merge it feeds ---');

const mSection = (heading) => {
    const start = MATERIAL_BRIEF.indexOf(heading);
    const next = MATERIAL_BRIEF.indexOf('\n## ', start + heading.length);
    return MATERIAL_BRIEF.slice(start, next < 0 ? MATERIAL_BRIEF.length : next);
};
const mExample = mSection('## 7. Worked example');
const mJson = mExample.slice(mExample.indexOf('```json') + 7, mExample.lastIndexOf('```'));
let mParsed = null;
try { mParsed = JSON.parse(mJson); check('the material example is strict-parseable JSON', true, true); }
catch (e) { fail++; console.log(` FAIL  the material example is strict-parseable JSON  (${e.message})`); }

if (mParsed) {
    const normalized = normalizeMaterialPayload(mParsed);
    check('...and normalizes with no repairs needed', normalized.warnings, []);
    // The reading is the leaf's Overview now — one lesson per topic, the shape
    // the app's own generator and the hand-built courses use — and the example
    // must show that shape, because an example is copied harder than a rule.
    check('...and the example writes the reading as the leaf\'s overview', typeof normalized.leaves[0].overview, 'string');
    check('...with no separate material entries', normalized.leaves[0].material, []);
    const body = normalized.leaves[0].overview;
    const wordCount = (body.match(/\S+/g) || []).length;
    // The number the whole split exists to protect. An example below the floor
    // teaches the model that the floor is decorative.
    check('...and its one worked reading clears the 600-word floor it asks for', wordCount >= 600, true);
    check('...and does not self-certify', /you (can|should) now|congratulations/i.test(body), false);
}

// The two hard rules pass two rests on, asserted against the text itself: an
// echoed title is what the merge matches on, and "stop cleanly" is what stops a
// model thinning twelve lessons into twelve summaries to fit them all in.
check('the material brief demands the title be echoed exactly', /[Ee]cho each title back exactly/.test(MATERIAL_BRIEF), true);
check('...and forbids thinning to fit',
    /Do not thin the material to/.test(MATERIAL_BRIEF)
    && /make it fit\./.test(MATERIAL_BRIEF), true);

console.log('\n--- pass two: what the merge accepts ---');

const mat = (title, ...bodies) => ({ title, material: bodies.map((d, i) => ({ title: `r${i}`, description: d })) });
const LONG = 'word '.repeat(700);

throws('a reply with no leaves array is refused', () => normalizeMaterialPayload({}), 'leaves');
throws('...and an empty one', () => normalizeMaterialPayload({ leaves: [] }), 'no topics');
throws('...and a leaf with no title', () => normalizeMaterialPayload({ leaves: [{ material: [] }] }), 'title');
throws('...and more leaves than the cap',
    () => normalizeMaterialPayload({ leaves: Array.from({ length: MAX_MATERIAL_LEAVES + 1 }, (_, i) => mat(`t${i}`, LONG)) }),
    'malformed');

const okPayload = normalizeMaterialPayload({ leaves: [mat('Snell’s law', LONG, LONG)] });
check('a well-formed reply normalizes clean', [okPayload.leaves.length, okPayload.leaves[0].material.length, okPayload.warnings], [1, 2, []]);

// An empty body is the stub the whole two-pass split exists to prevent. It is
// dropped rather than stored, so the topic stays visibly unwritten and can be
// asked for again — an empty reading would look done forever.
const withEmpty = normalizeMaterialPayload({ leaves: [{ title: 'A', material: [{ title: 'x', description: '   ' }, { title: 'y', description: LONG }] }] });
check('an empty reading is dropped, not stored', withEmpty.leaves[0].material.length, 1);
check('...and the drop is reported', withEmpty.warnings.length, 1);
throws('a reply that is ALL empty readings is refused', () => normalizeMaterialPayload({ leaves: [{ title: 'A', material: [{ description: '' }] }] }), 'No usable material');

const over = normalizeMaterialPayload({ leaves: [{ title: 'A', material: Array.from({ length: MAX_MATERIAL_PER_LEAF + 3 }, () => ({ description: LONG })) }] });
check('more readings than the per-leaf cap are trimmed', over.leaves[0].material.length, MAX_MATERIAL_PER_LEAF);
check('...and the trim is reported', over.warnings.length, 1);

// `is_note` is applied by the merge, never trusted from the reply: the shape the
// brief asks for cannot express anything else, which is the point of not reusing
// the node shape here.
check('the payload shape carries no is_note to trust', Object.keys(okPayload.leaves[0].material[0]).sort(), ['description', 'title']);

// The overview route: the common case now. A leaf may carry the reading in
// `overview`, the rare extra in `material`, or both; an entry with neither is
// skipped rather than stored blank, like an empty reading.
const withOverview = normalizeMaterialPayload({ leaves: [{ title: 'A', overview: LONG }, { title: 'B', overview: LONG, material: [{ title: 'table', description: LONG }] }, { title: 'C', overview: '   ' }] });
check('an overview alone is a usable entry', withOverview.leaves.map(l => [l.title, typeof l.overview, l.material.length]), [['A', 'string', 0], ['B', 'string', 1]]);
check('...a blank overview with no material is skipped with a reason', withOverview.warnings.some(w => /"C" had no usable material/.test(w)), true);
throws('a non-string overview is refused', () => normalizeMaterialPayload({ leaves: [{ title: 'A', overview: 42 }] }), 'overview');
check('the overview rides through to the match', matchMaterialToLeaves(withOverview.leaves, [{ id: 9, title: 'A' }]).matches[0].overview === LONG.trim(), true);

// "Already has material" has two routes and one rule, shared by the brief
// (which leaves to list) and the merge (which to skip): an attached reading,
// or an Overview longer than the signpost pass one writes.
check('a leaf with an attached reading has material', leafHasMaterial({ hasNotes: 1, descriptionLength: 0 }), true);
check('a leaf whose overview is a signpost does not', leafHasMaterial({ hasNotes: 0, descriptionLength: 400 }), false);
check('...but one whose overview is a reading does', leafHasMaterial({ hasNotes: 0, descriptionLength: MATERIAL_MIN_CHARS }), true);
check('the worked reading is well past the threshold', mParsed ? mParsed.leaves[0].overview.length > MATERIAL_MIN_CHARS * 2 : true, true);

console.log('\n--- pass two: what the merge matches against ---');

const course = [
    { id: 1, title: 'Huygens’ principle' },
    { id: 2, title: '3.2 Deriving Snell’s law' },
    { id: 3, title: 'Total internal reflection', hasMaterial: true },
    { id: 4, title: 'Introduction' },
    { id: 5, title: 'Introduction' },
];
const m = (titles, opts) => matchMaterialToLeaves(titles.map(t => mat(t, LONG)), course, opts);

check('an exact title matches', m(['Huygens’ principle']).matches.map(x => x.nodeId), [1]);
check('...case-insensitively', m(['huygens’ PRINCIPLE']).matches.map(x => x.nodeId), [1]);

// Adding or dropping curriculum numbering is the one thing a model reliably does
// to a title it was told to echo, so it is the one fallback the matcher has.
check('numbering the model dropped still matches', m(['Deriving Snell’s law']).matches.map(x => x.nodeId), [2]);

// Everything else is reported, never guessed.
check('an unknown title is reported, not guessed', m(['Fourier series']).unmatched, [{ title: 'Fourier series', reason: 'no topic with this title' }]);
check('an ambiguous title is reported, not guessed', m(['Introduction']).unmatched, [{ title: 'Introduction', reason: 'more than one topic has this title' }]);
check('...and nothing is written for it', m(['Introduction']).matches, []);

// Running the same file twice must do nothing the second time: this endpoint is
// meant to be used repeatedly against one project.
check('a topic that already has material is skipped', m(['Total internal reflection']).unmatched[0].reason, 'this topic already has material');
check('...unless replace was asked for', m(['Total internal reflection'], { replace: true }).matches.map(x => [x.nodeId, x.replacing]), [[3, true]]);

// One file listing the same topic twice must not stack two sets of readings on it.
const twice = m(['Huygens’ principle', 'huygens’ principle']);
check('the same topic twice in one file fills once', twice.matches.length, 1);
check('...and the duplicate says why', twice.unmatched[0].reason, 'already filled from this file');

console.log('\n--- a topic may carry GRADED questions, and a bad one costs only itself ---');

// The shape an authored course writes. Everything below varies one thing.
const MC = {
    question: 'Welk lidwoord hoort bij "krant"?',
    type: 'multiple_choice',
    options: ['de', 'het'],
    correct_answer: 'de',
    explanation: '"Krant" is een de-woord.',
};
const FILL = {
    question: 'Vul het juiste voorzetsel in: Wij komen ___ 9.45 uur.',
    type: 'fill_in',
    correct_answer: 'om',
    accept: ['omstreeks'],
    explanation: 'Een kloktijd krijgt "om".',
};
const withQuestions = (questions, extra = {}) =>
    normalizeImportTree([{ title: 'Lidwoorden', questions, ...extra }], QUESTION_DEPS);

const sound = withQuestions([MC, FILL]);
check('both questions survive the trip', sound.nodes[0].questions.length, 2);
check('...and are counted for the caller to report', sound.questionCount, 2);
check('...with nothing to warn about', sound.warnings, []);
check('a topic with no questions gets an empty array, never undefined', tree(leaf()).nodes[0].questions, []);
check('the key is still one of the options after the registry shuffles them',
    sound.nodes[0].questions[0].options.includes(sound.nodes[0].questions[0].correct_answer), true);
check('a typed answer keeps its declared variants', sound.nodes[0].questions[1].accept, ['omstreeks']);

// The doctrine of this file, applied where it matters most: a 4,000-question
// course with one broken question is still a course worth having.
const oneBad = withQuestions([MC, { ...MC, correct_answer: 'onzijdig' }, FILL]);
check('a question whose key matches no option is DROPPED', oneBad.nodes[0].questions.length, 2);
check('...and the drop says which question and why',
    /Dropped "Welk lidwoord.*no identifiable answer/.test(oneBad.warnings[0] || ''), true);
check('an unknown answer format is dropped the same way',
    withQuestions([MC, { ...MC, type: 'essay' }]).nodes[0].questions.length, 1);
check('...naming the format that was not understood',
    /"essay" is not an answer format/.test(withQuestions([MC, { ...MC, type: 'essay' }]).warnings[0] || ''), true);
check('a question with no text is dropped',
    withQuestions([{ ...MC, question: '   ' }]).warnings[0], 'Dropped a question at nodes[0].questions[0]: it has no question text.');
check('...and one that is not an object at all',
    withQuestions([null]).warnings[0], 'Dropped a question at nodes[0].questions[0]: it is not an object.');

// The SAME mechanical gate the feed and the quiz apply. A question with no
// explanation teaches nothing on a miss, which is the one outcome that must
// never be served — and an importer that skipped this check would be a second,
// laxer door into the same table.
const noExplanation = withQuestions([{ ...MC, explanation: '' }]);
check('a question that teaches nothing on a miss is dropped', noExplanation.nodes[0].questions.length, 0);
check('...by the same rule the feed uses, quoted',
    /no explanation/.test(noExplanation.warnings[0] || ''), true);
check('a typed key the stem gives away is dropped too',
    withQuestions([{ ...FILL, question: 'Het antwoord is omstreeks. Vul in: ___', correct_answer: 'omstreeks' }])
        .nodes[0].questions.length, 0);

// Work is a leaf, never a note: a note carries no weight and is never
// scheduled, so evidence recorded against one would be evidence for something
// the engine does not count.
const onNote = withQuestions([MC], { is_note: true });
check('questions on a reference note are ignored', onNote.nodes[0].questions, []);
check('...and the file is told, rather than half-imported in silence',
    /questions belong on the topic/.test(onNote.warnings[0] || ''), true);

// Nothing inside a question is truncated to fit. Half a key grades every right
// answer as wrong; half an ordering is not even parseable.
const longKey = 'x'.repeat(LIMITS.answer + 1);
check('an over-long answer drops the question rather than cutting the key',
    withQuestions([{ ...FILL, correct_answer: longKey }]).nodes[0].questions.length, 0);
check('...saying so', /answer is longer than/.test(withQuestions([{ ...FILL, correct_answer: longKey }]).warnings[0] || ''), true);
check('an over-long stem drops the question rather than cutting the question',
    withQuestions([{ ...MC, question: 'q'.repeat(LIMITS.questionStem + 1) }]).nodes[0].questions.length, 0);
check('an over-long explanation does the same',
    withQuestions([{ ...MC, explanation: 'e'.repeat(LIMITS.explanation + 1) }]).nodes[0].questions.length, 0);

// A picture question rebuilt key by key without `sanitizeQuestionMedia` is
// silently unanswerable: the stem asks about an image that no longer travels.
const HASH = 'b'.repeat(64);
const withMedia = withQuestions([{ ...MC, media: [{ hash: HASH, kind: 'image', alt: 'een krant' }] }]);
check('a photograph on a question survives the import', withMedia.nodes[0].questions[0].media, [{ hash: HASH, kind: 'image', alt: 'een krant' }]);
check('a media entry that is not a real blob reference is dropped, but the question is not',
    withQuestions([{ ...MC, media: [{ hash: 'not-a-hash', kind: 'image' }] }]).nodes[0].questions[0].media, undefined);

// Bounds. A file you were GIVEN must not be able to ask for unbounded work
// inside a transaction.
const many = withQuestions(Array.from({ length: MAX_QUESTIONS_PER_NODE + 5 }, (_, i) => ({ ...MC, question: `${MC.question} (${i})` })));
check('a topic is capped at the per-node limit', many.nodes[0].questions.length, MAX_QUESTIONS_PER_NODE);
check('...and the trim is reported', /only the first 200 were imported/.test(many.warnings.join(' ')), true);
throws('questions that are not an array are structural damage',
    () => withQuestions({ 0: MC }), 'must be an array');

// The whole-file budget fires in the MIDDLE of a tree, so the warning must be
// said once rather than once per node from there on.
const perNode = Array.from({ length: MAX_QUESTIONS_PER_NODE }, (_, i) => ({ ...MC, question: `${MC.question} (${i})` }));
const nodeCount = Math.ceil(MAX_IMPORT_QUESTIONS / MAX_QUESTIONS_PER_NODE) + 3;
const flood = normalizeImportTree(
    Array.from({ length: nodeCount }, (_, i) => ({ title: `Topic ${i}`, questions: perNode })),
    QUESTION_DEPS,
);
check('the file-wide question budget holds', flood.questionCount, MAX_IMPORT_QUESTIONS);
check('...and says so exactly once',
    flood.warnings.filter(w => /more than 50000 questions/.test(w)).length, 1);

console.log('\n--- a topic may carry FLASHCARDS, by the same doctrine ---');

// A language course's vocabulary and listening used to travel as a separate
// Anki deck that imported as a second project with no link to its topics.
// Now a node carries its cards, and the card is the row: front, back, the two
// supporting-line fields, and media BY NAME (the bundle resolves the name to
// a hash when it stores the bytes). Schedule state never travels.
const CARD = { front: 'de krant', back: 'газета', extra: 'мн. ч.: de kranten' };
const LISTEN = {
    front: '🎧 Послушай. Что сказал диктор?', back: 'Het boek, het adres.',
    extra: 'Dutch Grammar 1, урок 1',
    media: { front: [{ name: 'nl_9b8ab8622aef7747.mp3', kind: 'audio' }] },
};
const withCards = (flashcards, extra = {}) =>
    normalizeImportTree([{ title: 'Lidwoorden', flashcards, ...extra }], QUESTION_DEPS);

const cardsOk = withCards([CARD, LISTEN]);
check('both cards survive the trip', cardsOk.nodes[0].flashcards.length, 2);
check('...and are counted for the caller to report', cardsOk.cardCount, 2);
check('...with nothing to warn about', cardsOk.warnings, []);
check('a card is the row: the supporting lines keep their column names',
    Object.keys(cardsOk.nodes[0].flashcards[0]), ['front', 'back', 'extra', 'extra_front']);
check('an absent supporting line is null, never the empty string', cardsOk.nodes[0].flashcards[0].extra_front, null);
check('media travels by NAME, on the side it was written on',
    cardsOk.nodes[0].flashcards[1].media, { front: [{ name: 'nl_9b8ab8622aef7747.mp3', kind: 'audio' }] });
check('a topic with no cards gets an empty array, never undefined', tree(leaf()).nodes[0].flashcards, []);
check('a node with cards is not a leaf with more children — the cards are not nodes',
    tree(leaf({ flashcards: [CARD] })).count, 1);

check('a card with no back is dropped, and only that card',
    withCards([CARD, { front: 'het huis' }]).nodes[0].flashcards.length, 1);
check('...and the drop says which card and why',
    withCards([{ front: 'het huis' }]).warnings[0], 'Dropped a flashcard at nodes[0].flashcards[0]: it needs both a front and a back.');
check('a side over the cap drops the card rather than cutting the answer',
    withCards([{ ...CARD, back: 'x'.repeat(LIMITS.cardSide + 1) }]).nodes[0].flashcards.length, 0);
check('...saying so', /a side is longer than/.test(withCards([{ ...CARD, back: 'x'.repeat(LIMITS.cardSide + 1) }]).warnings[0] || ''), true);
check('one that is not an object at all',
    withCards([42]).warnings[0], 'Dropped a flashcard at nodes[0].flashcards[0]: it is not an object.');
check('schedule state in the file is ignored — every card starts new',
    Object.keys(withCards([{ ...CARD, next_review: '2020-01-01', stability: 40 }]).nodes[0].flashcards[0]).includes('next_review'), false);

// A media name is a plain file name: a bundle stores `media/<name>`, and a
// name that walks anywhere else is the zip-slip an importer is measured by.
const badName = withCards([{ ...LISTEN, media: { front: [{ name: '../../etc/passwd' }] } }]);
check('a media name that is a path is dropped, and the card survives', badName.nodes[0].flashcards.length, 1);
check('...without its media', badName.nodes[0].flashcards[0].media, undefined);
check('...and says so', /plain file name/.test(badName.warnings[0] || ''), true);
check('a media kind the app cannot play is dropped from the reference, the reference kept',
    withCards([{ ...LISTEN, media: { front: [{ name: 'a.mp3', kind: 'video' }] } }]).nodes[0].flashcards[0].media, { front: [{ name: 'a.mp3' }] });
check('a media side that is not a list is ignored with a warning',
    /must be a list/.test(withCards([{ ...LISTEN, media: { front: 'a.mp3' } }]).warnings[0] || ''), true);

check('cards on a reference note are ignored with a warning',
    tree(leaf({ is_note: true, flashcards: [CARD] })).nodes[0].flashcards, []);
check('...that says where they belong',
    /cards belong on the topic it explains/.test(tree(leaf({ is_note: true, flashcards: [CARD] })).warnings[0] || ''), true);
check('cards that are not an array are structural damage',
    (() => { try { withCards({}); return null; } catch (e) { return e instanceof ImportError; } })(), true);

const manyCards = withCards(Array.from({ length: MAX_CARDS_PER_NODE + 3 }, (_, i) => ({ ...CARD, front: `w${i}` })));
check('a topic is capped at the per-node card limit', manyCards.nodes[0].flashcards.length, MAX_CARDS_PER_NODE);
check('...and the trim is reported', /only the first/.test(manyCards.warnings[0] || ''), true);

const cardsPerNode = 400;
const cardNodes = Array.from({ length: Math.ceil(MAX_IMPORT_CARDS / cardsPerNode) + 1 }, (_, n) => ({
    title: `t${n}`, flashcards: Array.from({ length: cardsPerNode }, (_, i) => ({ ...CARD, front: `w${n}-${i}` })),
}));
const cardFlood = normalizeImportTree(cardNodes, QUESTION_DEPS);
check('the file-wide card budget holds', cardFlood.cardCount, MAX_IMPORT_CARDS);
check('...and says so exactly once', cardFlood.warnings.filter(w => /more than \d+ flashcards/.test(w)).length, 1);

console.log('\n--- a question and a card keep their identity across the trip ---');

// A later edition can only update a course in place if it can say WHICH
// question and WHICH card it means. Topics had a uuid; the two things a
// learner's progress actually hangs on did not (COURSE-UPDATES.md §1).
const Q_ID = '6f1c2a4e-9b3d-4c8e-a1f2-0d9e8b7c6a51';
const Q_ID2 = '0b8f7e6d-5c4b-4a39-8281-7f6e5d4c3b2a';
const C_ID = '2d4f6a8c-1e3b-4d5f-9a7c-8e0b2d4f6a8c';
const idQs = withQuestions([{ ...MC, uuid: Q_ID.toUpperCase() }, { ...FILL, uuid: Q_ID2 }]);
check('a question keeps the uuid it arrived with, lower-cased like every other uuid',
    idQs.nodes[0].questions.map(q => q.uuid), [Q_ID, Q_ID2]);
check('...with nothing to warn about', idQs.warnings, []);
check('a question that arrives without one has none yet — the database mints it',
    'uuid' in withQuestions([MC]).nodes[0].questions[0], false);
const badQId = withQuestions([{ ...MC, uuid: 'question-1' }]);
check('a uuid that is not a v4 uuid is dropped, never the question', [badQId.nodes[0].questions.length, 'uuid' in badQId.nodes[0].questions[0]], [1, false]);
check('...and says a new one will be minted', /not a valid v4 uuid/.test(badQId.warnings[0] || ''), true);
const dupQ = withQuestions([{ ...MC, uuid: Q_ID }, { ...FILL, uuid: Q_ID }]);
check('two questions on one topic claiming the same uuid: the first keeps it, the second gets a fresh one',
    dupQ.nodes[0].questions.map(q => q.uuid ?? null), [Q_ID, null]);
check('...and the file is told', /same uuid/.test(dupQ.warnings[0] || ''), true);

const idCards = withCards([{ ...CARD, uuid: C_ID }, LISTEN]);
check('a card keeps the uuid it arrived with', idCards.nodes[0].flashcards[0].uuid, C_ID);
check('a card without one carries no uuid key at all, so the row shape is unchanged',
    Object.keys(idCards.nodes[0].flashcards[1]), ['front', 'back', 'extra', 'extra_front', 'media']);
const badCId = withCards([{ ...CARD, uuid: 42 }]);
check('a card uuid that is not a v4 uuid is dropped, never the card', [badCId.nodes[0].flashcards.length, 'uuid' in badCId.nodes[0].flashcards[0]], [1, false]);
check('...and says so', /not a valid v4 uuid/.test(badCId.warnings[0] || ''), true);
const dupC = withCards([{ ...CARD, uuid: C_ID }, { ...CARD, front: 'het huis', uuid: C_ID }]);
check('two cards in one file claiming the same uuid: the second gets a fresh one',
    dupC.nodes[0].flashcards.map(c => c.uuid ?? null), [C_ID, null]);

console.log('\n--- the file says which model wrote an item, and the mark survives the trip ---');

// A shared course must not pass a model's questions off as its author's. The
// file names the model on each item one wrote; the importer keeps that claim
// rather than dropping it, so importing and exporting again cannot wash it out.
const byModel = withQuestions([{ ...MC, generated_by: '  z-ai/glm-5.3-flash ' }, FILL]);
check('a question keeps the model the file says wrote it, trimmed', byModel.nodes[0].questions[0].generated_by, 'z-ai/glm-5.3-flash');
check('...and one with no mark carries no key at all', 'generated_by' in byModel.nodes[0].questions[1], false);
const oddMark = withQuestions([{ ...MC, generated_by: { provider: 'x' } }]);
check('a mark that is not a model name is dropped, never the question', [oddMark.nodes[0].questions.length, 'generated_by' in oddMark.nodes[0].questions[0]], [1, false]);
check('...and says so', /generated_by/.test(oddMark.warnings[0] || ''), true);
check('an absurdly long mark is dropped the same way',
    'generated_by' in withQuestions([{ ...MC, generated_by: 'm'.repeat(LIMITS.modelName + 1) }]).nodes[0].questions[0], false);
const cardByModel = withCards([{ ...CARD, generated_by: 'qwen3.6-35b' }, LISTEN]);
check('a card keeps the model the file says wrote it', cardByModel.nodes[0].flashcards[0].generated_by, 'qwen3.6-35b');
check('...and a card with no mark keeps its old shape', Object.keys(cardByModel.nodes[0].flashcards[1]), ['front', 'back', 'extra', 'extra_front', 'media']);

// The project header may carry the author's new-cards-a-day dial.
check('new_per_day on the project is read as a whole number',
    normalizeImportProject({ name: 'x', new_per_day: 20 }, { isSupportedLanguage: () => true }).project.new_per_day, 20);
check('...absent, it is absent — the app keeps its own dial',
    normalizeImportProject({ name: 'x' }, { isSupportedLanguage: () => true }).project.new_per_day, undefined);
check('...and nonsense is ignored with a warning',
    /Ignored new_per_day/.test(normalizeImportProject({ name: 'x', new_per_day: 'many' }, { isSupportedLanguage: () => true }).warnings[0] || ''), true);

// A caller that forgot to inject the vetting would import unvetted questions in
// SILENCE, which is precisely the failure this field exists to end. That is a
// programming error, not a bad file, so it must not arrive as a 400.
let injectionError = null;
try { normalizeImportTree([{ title: 'x', questions: [MC] }]); } catch (e) { injectionError = e; }
check('importing questions without the vetting injected is a programming error, not an ImportError',
    [injectionError instanceof Error, injectionError instanceof ImportError], [true, false]);
check('...and it names what is missing', /normalizeQuestionFormat/.test(injectionError?.message || ''), true);

try { rmSync(scratch, { recursive: true, force: true }); } catch { /* the database handle is still open on Windows; swept by the OS */ }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// tools/question-media-gates.mjs — a graded question can carry a photograph,
// and every surface that asks one draws it.
//
// Run:  node tools/question-media-gates.mjs
//
// Why this gate exists at all. `QuestionStem` used to have one branch: a stem
// went through the markdown pipeline only if it carried a fenced VISUAL spec,
// and everything else took the KaTeX-only path. The consequence was that a
// graded question could not show a photograph — which read as a design
// decision and was not one. In a photo-based subject (a driving theory exam, a
// radiograph, a specimen) that forced every picture question to be demoted to a
// self-marked flashcard, the one surface that cannot clear the mastery gate.
//
// Media on a question is therefore structured data, exactly as it is on a card
// (`CardMedia.tsx` argues the three reasons), and it travels in the free JSON of
// `quizzes.questions`. Two failure modes follow, and both are SILENT:
//
//   1. a normalizer that rebuilds a question key by key drops `media`, and the
//      question arrives with its subject missing — not plainer, unanswerable;
//   2. a new question surface forgets to pass `media` to `QuestionStem`, and the
//      picture is simply absent there while it renders correctly elsewhere.
//
// Neither throws. So the scans below are the only thing that would notice.

import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const scratch = mkdtempSync(join(tmpdir(), 'question-media-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
// …and VAULT_ROOT, or the blob store resolves to the learner's real server/vault.
process.env.VAULT_ROOT = join(scratch, 'vault');

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const B = new URL('../server/', import.meta.url).href;
const { sanitizeQuestionMedia } = await import(B + 'agentic.js');
const { normalizeFeedQuestion } = await import(B + 'feed.js');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);

const HASH = 'a'.repeat(64);
const HASH2 = 'b3'.repeat(32);

// ---------------------------------------------------------------------------
section('sanitizeQuestionMedia: what an importer may attach');

check('a well-formed image survives',
    JSON.stringify(sanitizeQuestionMedia([{ hash: HASH, kind: 'image', name: 'x.jpg', alt: 'a roundabout' }]))
    === JSON.stringify([{ hash: HASH, kind: 'image', name: 'x.jpg', alt: 'a roundabout' }]));
check('audio survives too', sanitizeQuestionMedia([{ hash: HASH, kind: 'audio' }])?.[0].kind === 'audio');
check('several entries keep their order',
    sanitizeQuestionMedia([{ hash: HASH, kind: 'image' }, { hash: HASH2, kind: 'image' }])
        ?.map(m => m.hash).join(',') === `${HASH},${HASH2}`);

// The hash reaches `<img src="/api/media/…">`. Anything that is not a bare
// content address could only 404 — except a string carrying a path or a scheme,
// which is the one shape that would not.
check('a path traversal is dropped', sanitizeQuestionMedia([{ hash: '../../etc/passwd', kind: 'image' }]) === undefined);
check('an absolute URL is dropped', sanitizeQuestionMedia([{ hash: 'https://example.com/x.png', kind: 'image' }]) === undefined);
check('a short hash is dropped', sanitizeQuestionMedia([{ hash: 'abc123', kind: 'image' }]) === undefined);
check('an uppercase hash is dropped', sanitizeQuestionMedia([{ hash: 'A'.repeat(64), kind: 'image' }]) === undefined);
check('an unknown kind is dropped', sanitizeQuestionMedia([{ hash: HASH, kind: 'video' }]) === undefined);
check('a missing kind is dropped', sanitizeQuestionMedia([{ hash: HASH }]) === undefined);
check('one bad entry does not take the good one with it',
    sanitizeQuestionMedia([{ hash: 'nope', kind: 'image' }, { hash: HASH, kind: 'image' }])?.length === 1);

// Undefined rather than [] so a text question's stored JSON is byte-identical
// to what it was before this field existed.
check('nothing to attach returns undefined, not an empty array', sanitizeQuestionMedia([]) === undefined);
check('a non-array returns undefined', sanitizeQuestionMedia('a'.repeat(64)) === undefined);
check('absent returns undefined', sanitizeQuestionMedia(undefined) === undefined);
check('null entries do not throw', sanitizeQuestionMedia([null, undefined, 0]) === undefined);
// A `name` an importer read off a filesystem is display text, not a key.
check('an empty name is not carried', 'name' in (sanitizeQuestionMedia([{ hash: HASH, kind: 'image', name: '' }])[0]) === false);
check('a non-string alt is not carried', 'alt' in (sanitizeQuestionMedia([{ hash: HASH, kind: 'image', alt: 7 }])[0]) === false);

// ---------------------------------------------------------------------------
section('normalizeFeedQuestion: the one reducer that rebuilds a question');

const withPhoto = {
    question: 'Mag je hier inhalen?',
    type: 'multiple_choice',
    options: ['Ja', 'Nee'],
    correct_answer: 'Nee',
    explanation: 'Een doorgetrokken streep mag niet worden overschreden.',
    media: [{ hash: HASH, kind: 'image', name: 'q1.jpg', alt: 'doorgetrokken streep' }],
};
const normalized = normalizeFeedQuestion(withPhoto);
check('a question keeps its photograph', normalized?.media?.[0].hash === HASH);
check('…with its alt text, which is what a screen reader gets', normalized?.media?.[0].alt === 'doorgetrokken streep');
check('a forged hash is dropped rather than passed to the browser',
    normalizeFeedQuestion({ ...withPhoto, media: [{ hash: '../x', kind: 'image' }] })?.media === undefined);
check('a text question gains no media key',
    'media' in (normalizeFeedQuestion({ ...withPhoto, media: undefined }) || {}) === false);
check('the rest of the question still normalizes around it',
    normalized?.correct_answer === 'Nee' && normalized?.options?.length === 2);

// ---------------------------------------------------------------------------
section('parseMediaList (client) agrees with the server validator');

// Inside node_modules, not the OS temp dir: the UI packages are left external
// (the components here are never called — only the two pure parsers are) and a
// bundle anywhere else cannot resolve a bare `react` import at load time.
const cacheDir = join(repoRoot, 'node_modules', '.cache', 'question-media-gates');
mkdirSync(cacheDir, { recursive: true });
const bundled = join(cacheDir, 'cardmedia.mjs');
await esbuild.build({
    entryPoints: [join(repoRoot, 'src/components/CardMedia.tsx')],
    bundle: true, format: 'esm', platform: 'node', outfile: bundled, logLevel: 'silent',
    external: ['react', 'react/*', 'lucide-react', 'react-i18next'],
});
const { parseMediaList, parseCardMedia } = await import(pathToFileURL(bundled).href);

// The two validators are written in different languages against the same
// contract; a divergence is how a picture renders on the server's terms and
// then vanishes in the browser (or worse, the reverse).
const CASES = [
    [{ hash: HASH, kind: 'image' }],
    [{ hash: HASH, kind: 'audio' }],
    [{ hash: '../../etc/passwd', kind: 'image' }],
    [{ hash: 'https://example.com/x.png', kind: 'image' }],
    [{ hash: 'A'.repeat(64), kind: 'image' }],
    [{ hash: HASH, kind: 'video' }],
    [{ hash: HASH }],
    [null, { hash: HASH, kind: 'image' }],
    [],
];
for (const [i, input] of CASES.entries()) {
    const server = (sanitizeQuestionMedia(structuredClone(input)) || []).map(m => m.hash);
    const client = parseMediaList(structuredClone(input)).map(m => m.hash);
    check(`case ${i + 1}: both sides keep ${JSON.stringify(server)}`,
        JSON.stringify(server) === JSON.stringify(client), `server ${JSON.stringify(server)} vs client ${JSON.stringify(client)}`);
}
check('parseMediaList tolerates a JSON string, as the card column arrives',
    parseMediaList(JSON.stringify([{ hash: HASH, kind: 'image' }]))[0].hash === HASH);
check('malformed JSON is not a crash in a review session', parseMediaList('{{{').length === 0);
// Card media must keep working: parseCardMedia now routes through the same list
// validator, so the tightened hash check had better not reject real deck media.
check('parseCardMedia still splits the two sides',
    parseCardMedia({ front: [{ hash: HASH, kind: 'image' }], back: [{ hash: HASH2, kind: 'audio' }] }).back[0].kind === 'audio');

// ---------------------------------------------------------------------------
section('every question surface draws the picture');

// Source scan, because the failure is absence: a surface that forgets `media`
// renders a perfectly good question with its subject missing, and no test that
// looks at ONE surface would ever notice.
//
// A stem that can never have media says so here with its reason, the same
// bargain as control-gates' BESPOKE list.
const NO_MEDIA_BY_DESIGN = {
    'src/components/PlacementModal.tsx':
        'a placement probe is authored by a model against the project\'s own topics and is never stored, '
        + 'so there is no file for it to point at and no row to write one to',
};

const walk = (dir, out = []) => {
    for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.tsx$/.test(p)) out.push(p);
    }
    return out;
};

const offenders = [];
let stemCallSites = 0;
for (const file of walk(join(repoRoot, 'src'))) {
    const rel = relative(repoRoot, file).replace(/\\/g, '/');
    if (rel.endsWith('QuestionStem.tsx')) continue;
    const src = readFileSync(file, 'utf8');
    // `<QuestionStem …/>` possibly spanning lines. Self-closing in every use.
    for (const m of src.matchAll(/<QuestionStem\b[\s\S]*?\/>/g)) {
        stemCallSites++;
        if (/\bmedia=/.test(m[0])) continue;
        if (NO_MEDIA_BY_DESIGN[rel]) continue;
        offenders.push(`${rel}: ${m[0].replace(/\s+/g, ' ').slice(0, 90)}`);
    }
}
check('the scan actually found the call sites', stemCallSites >= 5, `found ${stemCallSites}`);
check('every QuestionStem is passed media, or is excused by name', offenders.length === 0, offenders.join(' | '));
// An excuse that no longer corresponds to a real file is a stale excuse, and a
// stale excuse is how a surface quietly re-enters the allowlist.
for (const [rel, reason] of Object.entries(NO_MEDIA_BY_DESIGN)) {
    check(`the excuse for ${rel} still names a real surface`,
        readFileSync(join(repoRoot, rel), 'utf8').includes('<QuestionStem'));
    check(`…and states why`, reason.length > 40);
}

// QuestionStem itself must actually draw them — the prop existing is not the
// feature.
const stemSrc = readFileSync(join(repoRoot, 'src/components/QuestionStem.tsx'), 'utf8');
check('QuestionStem renders CardMedia', /<CardMedia\b/.test(stemSrc));
check('…through the validator, not the raw prop', /parseMediaList\(\s*media\s*\)/.test(stemSrc));
check('…on both stem paths, not only the visual one',
    // One return for the no-media case and one wrapper carrying both; if the
    // picture were rendered inside the `hasVisual` branch only, a photo question
    // with plain text would silently lose it.
    /if \(!pictures\.length\) return words;/.test(stemSrc));

try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
try { rmSync(cacheDir, { recursive: true, force: true }); } catch { /* a build cache */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

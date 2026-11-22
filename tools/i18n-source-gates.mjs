#!/usr/bin/env node
/**
 * The half of i18n the locale files cannot see: a string that never reaches
 * i18next at all.
 *
 * `i18n-gates.mjs` compares en.json against every locale, so it can only judge
 * keys the source already declares. Every bug this file exists for was invisible
 * to it, because the English never became a key in the first place — coverage
 * read 99% while a Russian reader looked at a deck screen labelled "New / In
 * learning / Young / Mature" over "1 828 cards".
 *
 * Rules, each one earned:
 *
 *  1. A PLURAL KEY IS CALLED WITH `count`. `t("{{fmt}} cards", { fmt })` looks
 *     correct and is not: en.json holds that key as `_one`/`_other`, i18next
 *     cannot choose a form without `count`, and what renders is the raw key —
 *     the English text, in every language, with its placeholder filled in so it
 *     reads like a finished sentence. That is the worst failure mode available:
 *     it looks translated.
 *
 *  2. A `k()` TABLE IS READ THROUGH A TRANSLATOR. `k()` is identity at runtime;
 *     it marks a string so the extractor sees it, and the RENDER site owes a
 *     `t(row.label)`. `DeckBar` drew `{s.label}` and `{s.hint}` directly, so the
 *     four card states and their hints were English on every deck screen. The
 *     rule only looks at fields whose every value in that table is a `k()` call,
 *     which is what keeps a node's own `description` out of it.
 *
 *  3. A TOAST SAYS SOMETHING TRANSLATED. `addToast('error', 'Failed to load
 *     projects', e.message)` is the shape 48 of the store's 50 toasts had: a
 *     bare literal, never a key, never in en.json, never translated.
 *
 * Run: node tools/i18n-source-gates.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const srcDir = join(root, 'src');

let pass = 0;
let fail = 0;
const check = (label, offenders) => {
    if (offenders.length === 0) { pass++; console.log(`  ok   ${label}`); return; }
    fail++;
    console.log(`  FAIL ${label} — ${offenders.length}`);
    for (const o of offenders.slice(0, 12)) console.log(`         ${o}`);
    if (offenders.length > 12) console.log(`         … and ${offenders.length - 12} more`);
};

function walk(dir, out = []) {
    for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) { if (f !== 'locales') walk(p, out); }
        else if (/\.tsx?$/.test(f) && !/\.d\.ts$/.test(f)) out.push(p);
    }
    return out;
}

/** Comments blanked, byte offsets preserved so a line number stays honest. */
const decomment = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));

const files = walk(srcDir);
const read = new Map(files.map((f) => [f, decomment(readFileSync(f, 'utf8'))]));
const at = (file, src, index) => `${relative(root, file).replace(/\\/g, '/')}:${src.slice(0, index).split('\n').length}`;

console.log('--- strings that never reach i18next ---');

// 1. Plural keys called without `count`.
const en = JSON.parse(readFileSync(join(srcDir, 'locales/en.json'), 'utf8'));
const pluralKeys = new Set(
    Object.keys(en)
        .map((k) => k.match(/^(.*)_(zero|one|two|few|many|other)$/))
        .filter(Boolean)
        .map((m) => m[1]),
);
const countless = [];
for (const [file, src] of read) {
    const call = /\b(?:t|tr|i18n\.t|translate)\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*(,?)/g;
    let m;
    while ((m = call.exec(src))) {
        let key;
        try { key = m[1][0] === '"' ? JSON.parse(m[1]) : JSON.parse(`"${m[1].slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`); }
        catch { continue; }
        if (!pluralKeys.has(key)) continue;
        // The options object that follows, brace-balanced.
        let opts = '';
        if (m[2]) {
            let depth = 0, started = false;
            for (let i = call.lastIndex; i < src.length; i++) {
                const c = src[i];
                if (c === '{') { depth++; started = true; }
                if (c === '}') depth--;
                opts += c;
                if (started && depth === 0) break;
                if (!started && c === ')') break;
            }
        }
        if (!/(^|[\s{,])count\s*[:,}]/.test(opts)) countless.push(`${at(file, src, m.index)}  ${JSON.stringify(key)}`);
    }
}
check('every plural key is called with a count (without one, i18next renders the raw key)', countless);

// 2. A field whose every value in a table is `k()` must be read through a translator.
//    Collect field names per FILE, so `label` being a key table in one module does
//    not make every `.label` in the app suspect.
const untranslatedReads = [];
for (const [file, src] of read) {
    const fields = new Map(); // name -> { marked, total }
    for (const m of src.matchAll(/(\w[\w$]*)\s*:\s*(k\(|[^,\n}]+)/g)) {
        const name = m[1];
        const marked = m[2].startsWith('k(');
        const seen = fields.get(name) || { marked: 0, total: 0 };
        seen.marked += marked ? 1 : 0;
        seen.total += 1;
        fields.set(name, seen);
    }
    const keyFields = [...fields].filter(([, v]) => v.marked > 0 && v.marked === v.total).map(([n]) => n);
    if (keyFields.length === 0) continue;
    for (const field of keyFields) {
        // `{row.label}` or `` `${row.label}` `` with no translator in front of it.
        const re = new RegExp(`([\\w$]+)\\.${field}\\b`, 'g');
        let m;
        while ((m = re.exec(src))) {
            const before = src.slice(Math.max(0, m.index - 90), m.index);
            if (/\b(?:t|tr|i18n\.t|translate)\(\s*$/.test(before)) continue;   // t(row.label)
            if (/\b(?:t|tr|i18n\.t|translate)\(\s*[^()]*$/.test(before)) continue; // t("x", { a: row.label })
            const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index));
            if (/\bk\(/.test(line)) continue;                 // the definition itself
            if (/key=|\bkey:\s/.test(line)) continue;         // a React key is not shown
            // A presence test is not a render: `provider.description && (…)` and
            // `row.label ? a : b` decide whether to draw, they draw nothing.
            if (/^\s*(?:\?|&&|\|\||\))/.test(src.slice(m.index + m[0].length))) continue;
            untranslatedReads.push(`${at(file, src, m.index)}  .${field}`);
        }
    }
}
check('every k()-marked field is rendered through a translator', untranslatedReads);

// 3. A toast message is a key, not a literal.
const bareToasts = [];
const LEVELS = new Set(['error', 'success', 'info', 'warning']);
for (const [file, src] of read) {
    let i = 0;
    while (true) {
        const start = src.indexOf('addToast(', i);
        if (start === -1) break;
        const open = start + 'addToast('.length;
        let depth = 1, j = open, str = null;
        for (; j < src.length; j++) {
            const c = src[j];
            if (str) { if (c === '\\') { j++; continue; } if (c === str) str = null; continue; }
            if (c === "'" || c === '"' || c === '`') { str = c; continue; }
            if ('([{'.includes(c)) depth++;
            else if (')]}'.includes(c)) { depth--; if (depth === 0) break; }
        }
        const args = src.slice(open, j);
        const masked = args.replace(/`(?:\\.|[^`\\])*`/g, (m) => '\0'.repeat(m.length));
        for (const m of masked.matchAll(/(['"])((?:\\.|(?!\1)[^\\])*)\1/g)) {
            const body = args.slice(m.index + 1, m.index + m[0].length - 1);
            if (LEVELS.has(body) || !/[A-Za-z]/.test(body)) continue;
            // An acronym is the same word in every language: OCR, PDF, API, SSE.
            if (/^[A-Z0-9+.\- ]{1,8}$/.test(body)) continue;
            const before = args.slice(Math.max(0, m.index - 30), m.index);
            if (/\b(?:t|tr|i18n\.t|translate)\(\s*$/.test(before)) continue;
            // A literal being COMPARED is not a message: `mode === 'ask' ? … : …`
            // picks which translated sentence to show, it is not one itself.
            if (/[=!]==?\s*$/.test(before)) continue;
            const after = masked.slice(m.index + m[0].length, m.index + m[0].length + 8);
            if (/^\s*[?:]/.test(after) && !/^\s*:\s*['"`]/.test(after)) continue;
            bareToasts.push(`${at(file, src, open + m.index)}  ${JSON.stringify(body).slice(0, 60)}`);
        }
        i = j;
    }
}
check('every toast message is a translation key, not a bare literal', bareToasts);

// --- 4. one sentence is one key ----------------------------------------------
// "Must use" + `https` + "and contain" + `{query}` + ". See" is five keys and
// one English sentence. Five locales conjugated the middle piece as if it stood
// alone ("y contienen" after "must use"), and no translator could have done
// better: the word order is English and the pieces are nailed down in JSX. Same
// fault, same day, in "Question" + n + "of {{length}}" on three surfaces.
//
// Judging the key TEXT does not work — "In progress", "Zoom in" and "Use" are
// good labels — so this reads the shape: two t() calls in one run of JSX with
// nothing between them but a space, a <code>, or a short expression.
const CALL = String.raw`\{\s*t\(\s*"(?:[^"\\]|\\.)*"[\s\S]{0,200}?\}`;
const GLUE = String.raw`(?:\s|\{' '\}|\{" "\}|<code[^>]*>[\s\S]{0,60}?</code>|<span[^>]*>[\s\S]{0,40}?</span>|\{[A-Za-z0-9_.?\[\]' ()-]{1,60}\}|<strong>|</strong>|<b>|</b>)*`;
const GLUED = new RegExp(`${CALL}${GLUE}${CALL}`, 'g');

/**
 * Pairs that are two LABELS side by side, not one sentence — a row of chips, a
 * pair of radio options, a heading next to a status. Each was read before it was
 * listed. Anything not here is a sentence somebody has to translate in pieces.
 */
const ADJACENT_LABELS = new Set([
    'BulkGenerateModal.tsx:{{count}} topics',        // two chips in a row
    'BulkGenerateModal.tsx:mastery check',              // two option labels
    'BulkGenerateModal.tsx:stopped — everything finished is saved',
    'DeckDashboard.tsx:· {{fmt}} sections',          // a row of facts
    'ProjectsGrid.tsx:Activity log',                 // a heading beside a status
    'ProjectQuizzesList.tsx:{{length}} questions',   // two facts on one line
    'AnkiImportModal.tsx:{{cards}} cards',           // "N cards" · "from M decks"
    'GlobalFlashcardReview.tsx:{{min}} of {{length}} cards', // a row of facts: position · skipped · deleted
]);
/**
 * Split sentences that are known and not yet rewritten. They
 * are listed one by one so a NEW one fails; shortening this list is the work.
 */
const KNOWN_SPLIT = new Set([
    'AnkiImportModal.tsx:new cards arrive a few a day rather than all at once',
    'DeckForecast.tsx:reviews due in the next {{length}} days',
    'EmojiPicker.tsx:Use',
    'EmojiPicker.tsx:— use it as a custom icon above',
]);

const split = [];
for (const file of files) {
    if (!file.endsWith('.tsx')) continue;
    const src = readFileSync(file, 'utf8');
    const name = file.split(/[\\/]/).pop();
    for (const m of src.matchAll(GLUED)) {
        const keys = [...m[0].matchAll(/t\(\s*"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
        if (keys.length < 2) continue;
        const id = `${name}:${keys[0]}`;
        if (ADJACENT_LABELS.has(id) || KNOWN_SPLIT.has(id)) continue;
        split.push(`${at(file, src, m.index)}  ${keys.map((k) => JSON.stringify(k.slice(0, 40))).join(' + ')}`);
    }
}
check('no sentence is built out of more than one key', split);

// --- 5. a literal-label tuple is not translated ------------------------------
// The Create-Project modal's tabs were `['ai', 'With AI']` — a table of bare
// English labels rendered as {label}. One step removed from a JSX text node,
// so neither the extractor nor a text scan saw it, and all three tabs were
// English in eleven languages. Same shape in BulkGenerateModal's
// preset chips. The table itself is fine; the LABEL may not be a bare literal.
// Two words minimum: a single-word second member is too often real data
// (`surfaces: ['topic', 'missed_answer']`).
const tupleLabels = [];
for (const [file, src] of read) {
    for (const m of src.matchAll(/\[\s*'([A-Za-z][\w-]*)'\s*,\s*'([A-Za-z][^']*\s[A-Za-z][^']*)'\s*\]/g)) {
        tupleLabels.push(`${at(file, src, m.index)}  ${JSON.stringify(m[2]).slice(0, 60)}`);
    }
}
check('every tuple label table is translated, not a bare literal', tupleLabels);

// --- 6. a status sentence picked by a ternary is not translated ---------------
// ActiveTaskBanner picked the banner's primary sentence through an
// `isComplete ? 'Project fully created!' : isCancelled ? '…' : …` chain — four
// English sentences that never reached i18next in any of the twelve languages,
// drawn directly under the spinner. Same class as rule 5 but one conditional
// deep: the branch a ternary can render may not be prose-shaped either.
// Sentence-shaped, so class lists ('flex sm:hidden'), routes ('/settings') and
// enum values don't trip it: 8+ chars, a space, an uppercase first letter and
// at least one lowercase one.
const isProseLiteral = (body) =>
    body.length >= 8 &&
    /\s/.test(body) &&
    /^\p{Lu}/u.test(body) &&
    /\p{Ll}/u.test(body);
/** Sentence-shaped literals sitting in a ternary arm. An arm is identified by
 * what PRECEDES the literal: `?` for the true one; for the false one a colon
 * whose own run-up still contains a `?` — an object entry (`label: 'Two
 * words'`, or one keyed by a quoted string) has no `?` before its colon and is
 * rule 5's territory, not a conditional arm. */
const scanTernaryProse = (src) => {
    const out = [];
    for (const m of src.matchAll(/(['"])((?:(?!\1)[^\\]|\\.)*)\1/g)) {
        const body = m[2];
        if (!isProseLiteral(body)) continue;
        const before = src.slice(Math.max(0, m.index - 6), m.index);
        // A literal being COMPARED is not a message (`mode === 'auto' ? … : …`
        // picks between keys; the pick is the UI, the literal is not drawn).
        if (/[=!<>]=\s*$/.test(before)) continue;
        if (/\bt\(\s*$/.test(src.slice(Math.max(0, m.index - 24), m.index))) continue;
        if (/\?\s*$/.test(before)) { out.push({ index: m.index, body }); continue; }
        if (/:\s*$/.test(before) && /\?/.test(src.slice(Math.max(0, m.index - 40), m.index).replace(/:\s*$/, ''))) {
            out.push({ index: m.index, body });
        }
    }
    return out;
};
const ternaryProse = [];
for (const [file, src] of read) {
    if (!file.endsWith('.tsx')) continue;
    for (const hit of scanTernaryProse(src)) {
        ternaryProse.push(`${at(file, src, hit.index)}  ${JSON.stringify(hit.body).slice(0, 70)}`);
    }
}
check('every sentence a ternary can render is a translation key, not a literal', ternaryProse);

// --- 7. every messageKey the server sends is a key in en.json ------------------
// The server's creation frames carry `messageKey` and the client renders
// t(aiProgress.messageKey) — dynamic at both ends, so no extractor call site
// ever names them. A key the server sends but en.json has dropped still
// RENDERS (i18next falls back to the key text, which is the English) but its
// translation is gone in eleven languages. The keys with no client call site
// are marked with k() (SERVER_CREATION_MESSAGE_KEYS in ProjectsGrid.tsx); this
// is the net for the one somebody adds server-side and forgets to mark.
// Every server file is read: the frames moved out of server/index.js into
// routes/createProject.js and creationStages.js, and a scan of index.js alone
// read nothing and passed. A plural key lives in en.json as `_one`/`_other`.
const scanServerMessageKeys = (src) => {
    const out = [];
    for (const m of src.matchAll(/\bmessageKey:\s*('((?:[^'\\]|\\.)*)'|`([^`]*)`)/g)) {
        const raw = m[2] !== undefined ? m[2] : m[3];
        let key;
        try { key = JSON.parse(`"${raw.replace(/"/g, '\\"')}"`); }
        catch { key = raw; }
        out.push(key);
    }
    return out;
};
function walkServer(dir, out = []) {
    for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) { if (f !== 'node_modules') walkServer(p, out); }
        else if (f.endsWith('.js')) out.push(p);
    }
    return out;
}
const serverFiles = new Map(walkServer(join(root, 'server')).map((f) => [f, decomment(readFileSync(f, 'utf8'))]));
const inEn = (key) => key in en || `${key}_other` in en;
const missingServerKeys = [];
let messageKeysSeen = 0;
for (const [file, src] of serverFiles) {
    const keys = scanServerMessageKeys(src);
    messageKeysSeen += keys.length;
    for (const key of keys) if (!inEn(key)) missingServerKeys.push(`${relative(root, file).replace(/\\/g, '/')}  ${JSON.stringify(key)}`);
}
check(`every messageKey the server sends is a key in en.json (${messageKeysSeen} read)`,
    messageKeysSeen === 0 ? ['no messageKey literal found under server/: the scan reads nothing'] : missingServerKeys);

// --- 7b. an error body a route sends goes through a helper -----------------------
// `res.json({ error: 'Topic not found' })` reaches the learner in English under
// every interface language: the app has no key to translate it from. A route
// answers a refusal with `keyed(key, params)` (the learner's), `apiError(text)`
// (a request only a program gets wrong), `errorFields(refusal)` or
// `errorBody(err)`; each says which it is, and the first carries the key.
const scanBareErrorBodies = (src) => [...src.matchAll(/\.(?:json|send)\(\s*\{\s*(?:ok:\s*false\s*,\s*)?error\b/g)];
const bareErrorBodies = [];
for (const [file, src] of serverFiles) {
    for (const m of scanBareErrorBodies(src)) bareErrorBodies.push(at(file, src, m.index));
}
check('every error body a server route sends is built by keyed/apiError/errorFields/errorBody', bareErrorBodies);

// --- 8. every task labelKey the server sends is a key in en.json -------------
// Same shape as 7, for the background-task dock: `tasks.createTask({ label,
// labelKey })` and the chip renders t(task.labelKey). A key missing from
// en.json still renders (as the English) but loses its eleven translations.
// Every string literal on a `labelKey:` line counts (bulkGen picks one of two).
// A plural key lives in en.json as its `_one`/`_other` pair.
const scanServerLabelKeys = (src) => {
    const out = [];
    for (const line of src.matchAll(/\blabelKey:([^\n]*)/g)) {
        for (const lit of line[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)) out.push(lit[1]);
    }
    return out;
};
const serverDir = join(root, 'server');
const missingLabelKeys = [];
let labelKeysSeen = 0;
for (const f of readdirSync(serverDir).filter((f) => f.endsWith('.js'))) {
    const keys = scanServerLabelKeys(decomment(readFileSync(join(serverDir, f), 'utf8')));
    labelKeysSeen += keys.length;
    for (const key of keys) if (!inEn(key)) missingLabelKeys.push(`server/${f}  ${JSON.stringify(key)}`);
}
check(`every task labelKey the server sends is a key in en.json (${labelKeysSeen} read)`,
    labelKeysSeen === 0 ? ['no labelKey found in server/*.js: the scan reads nothing'] : missingLabelKeys);

// --- 9. a label built into an object outside a component ---------------------
// `drillFromFlashcards` built the card drill as `{ title: `Practice: ${nodeTitle}`,
// promptLabel: 'What is this?' }` in a plain module, far from any t(). The
// launcher drew `spec.title` as content, so every topic with cards showed
// "Practice: <a Russian topic name>" in a Russian interface. Rule 6 sees only
// ternary arms; this sees a display field given a sentence-shaped literal, or
// a template literal that wraps a capitalised word around an interpolation.
const DISPLAY_FIELD = /\b(title|label|promptLabel|answerLabel|subtitle|heading|placeholder|hint|caption|tooltip|ariaLabel|emptyText|message)\s*:\s*(`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/g;
/**
 * Display fields that are English on purpose, each read before it was listed:
 * the GitHub issue form's own labels (the parity gate compares them to the
 * .yml to the letter, and the dialog never shows them) and a product's name.
 */
const ENGLISH_BY_DESIGN = new Set([
    'report.ts:Version and environment',
    'report.ts:Which part of the app?',
    'report.ts:How often?',
    'report.ts:Where did you see it?',
    'report.ts:Before you post',
    'ConnectModel.tsx:Google Gemini',
]);
const scanDisplayFields = (src) => {
    const out = [];
    for (const m of src.matchAll(DISPLAY_FIELD)) {
        const lit = m[2];
        const body = lit.slice(1, -1);
        const shown = lit[0] === '`'
            ? /\$\{/.test(body) && /\p{Lu}\p{Ll}{2,}/u.test(body.replace(/\$\{[^}]*\}/g, ' '))
            : isProseLiteral(body);
        if (shown) out.push({ index: m.index, field: m[1], body });
    }
    return out;
};
const builtLabels = [];
for (const [file, src] of read) {
    const name = file.split(/[\\/]/).pop();
    for (const hit of scanDisplayFields(src)) {
        if (ENGLISH_BY_DESIGN.has(`${name}:${hit.body}`)) continue;
        builtLabels.push(`${at(file, src, hit.index)}  ${hit.field}: ${JSON.stringify(hit.body).slice(0, 60)}`);
    }
}
check('every label built into an object is a translation key, not a literal', builtLabels);

// --- 10. a translated suffix keeps its space --------------------------------
// The vault's "· math recovered" badge adds "(OCR)" and "(partial)" after the
// word. Written as `{tr("· math recovered")}{… ? tr("(OCR)") : ''}` the three
// pieces print as "· math recovered(OCR)(partial)": JSX drops the whitespace
// between expressions, so each suffix has to carry its own leading space.
const SUFFIX_AFTER_BADGE = /tr\("· math recovered"\)\}([^<]*)<\/span>/;
const glueSuffixes = (src) => {
    // No badge found is a failure, not a clean pass: the rule has stopped
    // matching the source it guards.
    const badge = SUFFIX_AFTER_BADGE.exec(src);
    if (!badge) return ['the "· math recovered" badge was not found'];
    const run = badge[1];
    // A suffix is spaced when it sits in a template that opens with a space, or
    // after a `{' '}`.
    return [...run.matchAll(/(.{0,6})tr\("(\([^"]*\))"\)/g)]
        .filter((m) => !/(`\s\$\{|\{' '\})$/.test(m[1]))
        .map((m) => m[2]);
};
check('each suffix on the math-recovered badge has a space before it',
    glueSuffixes(readFileSync(join(srcDir, 'components', 'VaultPanel.tsx'), 'utf8')));

// The rules are only worth having if they FIRE. Each is re-run against the exact
// source shape it was written for, so a rule that silently stopped matching is a
// failure here rather than a clean run that checks nothing.
console.log('\n--- the rules catch what they were written for ---');
const PRE_FIX = [
    ['a plural key with no count',
        'DeckDashboard.tsx', `{t("{{fmt}} cards", { fmt: fmt(deck.totals.cards) })}`,
        (s) => /\bt\(\s*"\{\{fmt\}\} cards"\s*,\s*\{(?![^}]*\bcount\b)/.test(s)],
    ['a k() legend drawn straight',
        'DeckBar.tsx', `<span className="truncate">{s.label}</span>`,
        (s) => /(?<!\(\s*)\bs\.label\b/.test(s) && !/t\(s\.label\)/.test(s)],
    ['a bare toast literal',
        'store.ts', `get().addToast('error', 'Failed to load projects', e.message);`,
        (s) => /addToast\(\s*'error'\s*,\s*'[A-Za-z]/.test(s)],
    ['a sentence split across two keys',
        'QuizView.tsx', `{t("Question")}{' '}{currentIndex + 1} {t("of {{totalQuestions}}", { totalQuestions })}`,
        (s) => GLUED.test(s)],
    ['a tuple label table left bare',
        'ProjectsGrid.tsx', `['ai', 'With AI'],`,
        (s) => /\[\s*'ai'\s*,\s*'With AI'\s*\]/.test(s)],
    ['a status sentence picked by a ternary',
        'ProjectsGrid.tsx', `const primaryMessage = isComplete ? 'Project fully created!' : isCancelled ? 'Creation cancelled — partial content saved' : isError ? 'An error occurred' : aiProgress?.message || 'Initializing...';`,
        (s) => scanTernaryProse(s).length >= 3],
    ['a server messageKey en.json has dropped',
        'server/routes/createProject.js', `messageKey: 'Model "{{model}}" is ready.'`,
        (s) => scanServerMessageKeys(s).includes('Model "{{model}}" is ready.')],
    ['a route answering in bare English',
        'server/routes/decks.js', `if (!data) return res.status(404).json({ error: 'Project not found' });
        if (check.wrong) { res.status(401).json({ error }); return true; }
        return res.status(404).json(keyed('Project not found'));
        res.json({ recorded: recordBuildFailure({ hash, error: new Error(message) }) });`,
        (s) => scanBareErrorBodies(s).length === 2],
    ['a task labelKey en.json does not hold',
        'server/bulkGen.js', `labelKey: project?.name ? 'Study material · {{project}}' : 'Not a key anywhere',`,
        (s) => scanServerLabelKeys(s).filter((key) => !inEn(key)).join() === 'Not a key anywhere'],
    ['a badge suffix glued to its word',
        'VaultPanel.tsx', `{tr("· math recovered")}{method === 'ocr' ? tr("(OCR)") : ''}{cancelled ? tr("(partial)") : ''}</span>`,
        (s) => glueSuffixes(s).join() === '(OCR),(partial)'
            && glueSuffixes(`{tr("· math recovered")}{method === 'ocr' ? \` \${tr("(OCR)")}\` : ''}</span>`).length === 0
            && glueSuffixes('<span>nothing here</span>').length === 1],
    ['a drill title and prompt built in English',
        'parseDrill.ts', "title: `Practice: ${nodeTitle}`,\n        promptLabel: 'What is this?',",
        (s) => scanDisplayFields(s).map((h) => h.field).join() === 'title,promptLabel'],
];
for (const [name, where, sample, fires] of PRE_FIX) {
    check(`${name} (${where}) is still detected`, fires(sample) ? [] : [`the rule no longer matches: ${sample}`]);
}

// --- 8. words round a value, and an error a screen prints as it is -----------
console.log('--- words that stay English round a value ---');
{
    // The About row is "ab12cd3 · desktop · Node 22": identifiers. A template
    // literal that glues an English word on ("commit …", "… install") is English
    // under every interface language.
    const about = readFileSync(join(srcDir, 'components/settings/AboutSection.tsx'), 'utf8');
    // A template literal, or a quoted word joined to the value with `+`.
    const GLUED = /`[^`\n]*\$\{appVersion\.(?:commitShort|deployment)\}[^`\n]*`|(?:'[^'\n]*[A-Za-z][^'\n]*'|"[^"\n]*[A-Za-z][^"\n]*")\s*\+\s*appVersion\.(?:commitShort|deployment)\b|appVersion\.(?:commitShort|deployment)\s*\+\s*(?:'[^'\n]*[A-Za-z][^'\n]*'|"[^"\n]*[A-Za-z][^"\n]*")/g;
    const gluedIn = (src) => [...decomment(src).matchAll(GLUED)].map((m) => m[0]);
    check('the glue rule sees a template literal, and a word joined with +, on either side',
        ['`commit ${appVersion.commitShort}`', '`${appVersion.deployment} install`', "'commit ' + appVersion.commitShort", 'appVersion.deployment + " install"']
            .filter((sample) => gluedIn(sample).length !== 1));
    check('...and passes the bare identifiers', gluedIn('[appVersion.commitShort, appVersion.deployment, `Node ${appVersion.node}`]'));
    const glued = gluedIn(about);
    check('the About version row glues no English word onto the commit or the install kind', glued);

    // `PracticeCard` prints a scan error's message as the problem text, so the
    // message must come out of i18n at call time. Run the real throw with a
    // translator that marks what passes through it.
    const { createRequire } = await import('node:module');
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { pathToFileURL } = await import('node:url');
    const require = createRequire(import.meta.url);
    const esbuild = require('esbuild');
    const scratch = mkdtempSync(join(tmpdir(), 'i18n-source-gates-'));
    try {
        const outfile = join(scratch, 'warp.mjs');
        await esbuild.build({
            entryPoints: [join(srcDir, 'utils/scan/warp.ts')],
            bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
            plugins: [{
                name: 'i18n-stub',
                setup(b) {
                    b.onResolve({ filter: /(^|\/)i18n$/ }, () => ({ path: 'i18n', namespace: 'stub' }));
                    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: "export default { t: (key) => '<<' + key + '>>' };", loader: 'js' }));
                },
            }],
        });
        const { warpQuad } = await import(pathToFileURL(outfile).href);
        const line = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 20 }, { x: 30, y: 30 }];
        let message = null;
        try { warpQuad({ width: 40, height: 40, data: new Uint8ClampedArray(40 * 40 * 4) }, line, { width: 20, height: 20 }); }
        catch (e) { message = e.message; }
        check('a scan whose corners form no page says so through i18n, not in bare English',
            message === '<<Drag the four corners onto the corners of your page.>>' ? [] : [`got ${JSON.stringify(message)}`]);
        check('…and that key exists in en.json',
            en['Drag the four corners onto the corners of your page.'] ? [] : ['missing']);
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
/**
 * Move the interface's English into `t()` calls — a codemod over src/**\/*.tsx.
 *
 *   node tools/i18n-extract.mjs [--dry] [--report] [files…]
 *
 * What it rewrites, and how:
 *   JSX text          <p>Mark done anyway</p>          → <p>{t("Mark done anyway")}</p>
 *   text + expression <p>{n} cards due</p>             → <p>{t("{{n}} cards due", { n })}</p>
 *                     (only when every expression in the run is simple — an
 *                     identifier, a property chain, a call with no JSX in it)
 *   attributes        title="Copy details"             → title={t("Copy details")}
 *                     placeholder={`Search ${x}`}      → placeholder={t("Search {{x}}", { x })}
 *   expressions       {done ? 'Copied' : 'Copy'}       → {done ? t("Copied") : t("Copy")}
 *   calls             addToast('Project created')      → addToast(t("Project created"))
 *                     showConfirm({ title: 'Delete?' }) → showConfirm({ title: t("Delete?") })
 *
 * and inserts `const { t } = useTranslation();` at the top of the enclosing
 * component or hook (or uses `i18n.t` outside one), plus the imports.
 *
 * What it refuses, and reports instead (--report):
 *   text inside <code>, <pre>, <kbd>, <samp>       — it is code, not copy
 *   runs mixing text with a non-simple expression  — needs <Trans> or a hand split
 *   module-level label tables ({ label: '…' })     — the RENDER site needs t(), not the table
 *   text with no letters, or a lone symbol         — nothing to translate
 *   strings that look like code, paths or URLs
 *
 * The key is the English text with whitespace collapsed and HTML entities
 * decoded, so `en.json` (written here, merged with what is already in it) is a
 * list of sentences a translator can read top to bottom.
 *
 * Idempotent: a file that already imports useTranslation is still scanned, but
 * text already inside t() is not text any more, so a second run changes nothing.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectKeys, englishEntries, pluralCategories } from './lib/i18nKeys.mjs';
import {
    parseTsx, forEachChild, isStringish, isTemplate, stringText, templateParts, isLogical, isBinaryLike,
    isCall, isPropertyAccess, isElementAccess, isPropertyAssignment, propertyNameText, isJsxElement, jsxExpressionOf,
} from './lib/tsxAst.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const srcDir = join(repoRoot, 'src');
const localeFile = join(srcDir, 'locales', 'en.json');

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const wantReport = argv.includes('--report');
const explicit = argv.filter((a) => !a.startsWith('--'));

/** Attributes whose string value is read by a person. */
const TEXT_ATTRS = new Set([
    'title', 'placeholder', 'aria-label', 'aria-description', 'aria-roledescription', 'alt', 'label', 'hint', 'description',
    'confirmLabel', 'cancelLabel', 'message', 'emptyLabel', 'helpText', 'tooltip', 'caption', 'heading', 'subtitle',
    'summary', 'okLabel', 'submitLabel', 'emptyText', 'buttonLabel', 'legend', 'prompt',
    'actionLabel', 'secondaryLabel', 'primaryLabel',
]);
/** Object-literal properties of dialog/toast calls that carry copy. */
const CALL_PROPS = new Set(['title', 'message', 'confirmLabel', 'cancelLabel', 'label', 'description', 'hint', 'body', 'detail']);
/** Functions whose first string argument is shown to the person. */
const TOAST_FNS = new Set(['addToast', 'showToast', 'toast', 'notify', 'showConfirm']);
/** Elements whose text is code. */
const CODE_TAGS = new Set(['code', 'pre', 'kbd', 'samp', 'var', 'tt']);
/** Files that are not UI. */
const SKIP_FILES = [/[\\/]i18n[\\/]/, /[\\/]locales[\\/]/, /sw-register\.ts$/, /\.d\.ts$/, /vite-env/, /[\\/]utils[\\/]/, /[\\/]hooks[\\/]/];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rarr: '→', larr: '←', hellip: '…', mdash: '—', ndash: '–', times: '×', middot: '·', bull: '•', copy: '©', deg: '°', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', check: '✓', uarr: '↑', darr: '↓', para: '¶', sect: '§', plusmn: '±' };
const decodeEntities = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
});

const hasLetters = (s) => /\p{L}{2,}/u.test(s);
const looksLikeCode = (s) => /^[\w./:@-]+$/.test(s) && (s.includes('/') || /\w\.\w/.test(s) || s.includes('_'))
    || /^https?:\/\//.test(s) || /^(npm|node|git|docker|npx)\s/.test(s) || /^\/api\//.test(s) || /\{\{|\}\}/.test(s) || /^[A-Z0-9_]+$/.test(s) && s.length > 1 && !/^[A-Z]+$/.test(s);
const normalize = (s) => decodeEntities(s).replace(/\s+/g, ' ').trim();
const q = (s) => JSON.stringify(s);

// --- collect files ------------------------------------------------------------
function walk(dir, out = []) {
    for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.tsx$/.test(f) || (/\.ts$/.test(f) && dir.includes(`${sep}components`))) out.push(p);
    }
    return out;
}
const files = (explicit.length ? explicit.map((f) => resolve(repoRoot, f)) : walk(srcDir))
    .filter((f) => !SKIP_FILES.some((re) => re.test(f)));

// --- the work ------------------------------------------------------------------
const allKeys = new Map();   // key → first file
const report = [];           // { file, line, kind, text }
let filesChanged = 0, sitesRewritten = 0;

for (const file of files) {
    const before = readFileSync(file, 'utf8');
    let result;
    try {
        result = transform(before, file);
    } catch (err) {
        // A file the parser cannot read is left as it is, and said so.
        report.push({ file: relative(repoRoot, file), line: err.loc?.line ?? 1, kind: 'unparsed', text: err.message });
        process.stdout.write(`skipped    ${relative(repoRoot, file)}: ${err.message}\n`);
        continue;
    }
    if (!result) continue;
    const { text, sites, skipped } = result;
    for (const s of skipped) report.push({ file: relative(repoRoot, file), ...s });
    if (sites === 0 || text === before) continue;
    sitesRewritten += sites;
    filesChanged += 1;
    if (!dry) writeFileSync(file, text);
    process.stdout.write(`${dry ? 'would rewrite' : 'rewrote'}  ${relative(repoRoot, file).padEnd(60)} ${String(sites).padStart(4)} sites\n`);
}

// --- en.json: the source list ----------------------------------------------------
// Rebuilt from the SOURCE (every t()/k() call now in it), not from this run's
// rewrites — the second run rewrites nothing and must still produce the list.
// Existing entries win, so a hand-edited plural form survives a re-run; entries
// no key uses any more are dropped.
if (!dry) {
    const keys = collectKeys(srcDir);
    const n = writeEnglishLocale(localeFile, keys);
    process.stdout.write(`en.json: ${n} entries\n`);
    // A reworded or renamed English key orphans its translations. They are
    // dropped here rather than left in the file: the gate would otherwise refuse
    // the locale, and a translation of a sentence the app no longer says is not
    // worth keeping. The coverage table (i18n-gates) is where the loss shows.
    for (const f of readdirSync(join(srcDir, 'locales'))) {
        if (!f.endsWith('.json') || f === 'en.json') continue;
        const code = f.replace(/\.json$/, '');
        const file = join(srcDir, 'locales', f);
        const data = JSON.parse(readFileSync(file, 'utf8'));
        const allowed = new Set(Object.keys(JSON.parse(readFileSync(localeFile, 'utf8'))));
        for (const [key, { plural }] of keys) if (plural) for (const c of pluralCategories(code)) allowed.add(`${key}_${c}`);
        const stale = Object.keys(data).filter((k) => !allowed.has(k));
        if (!stale.length) continue;
        for (const k of stale) delete data[k];
        writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
        process.stdout.write(`${code}.json: dropped ${stale.length} stale ${stale.length === 1 ? 'key' : 'keys'}\n`);
    }
}

process.stdout.write(`\n${filesChanged} files, ${sitesRewritten} sites, ${allKeys.size} distinct keys${dry ? ' (dry run)' : ''}\n`);
if (wantReport && report.length) {
    process.stdout.write(`\n${report.length} sites left for hand work:\n`);
    for (const r of report) process.stdout.write(`  ${r.file}:${r.line}  [${r.kind}]  ${r.text.slice(0, 90)}\n`);
}

// ==============================================================================

function transform(source, file) {
    const { program, startOf, lineOf: line, textOf } = parseTsx(source);
    const edits = [];          // { start, end, text }
    const skipped = [];
    const needsHook = new Set();   // function nodes that need `const { t } = useTranslation()`
    let needsGlobal = false;       // some site is outside any component → i18n.t
    let needsMarker = false;       // a module-level table was tagged with k()
    let sites = 0;

    // A file that already binds `t` to something else gets `tr` everywhere.
    const declaresT = /\b(?:const|let|var)\s+t\s*=|\(\s*t\s*[,)]|\bt\s*=>|function\s+t\b/.test(source) && !/const \{ t \} = useTranslation/.test(source);
    const T = declaresT ? 'tr' : 't';

    const isComponentName = (n) => /^[A-Z]/.test(n) || /^use[A-Z]/.test(n);

    /** The enclosing function whose `t` this site can use, or null. */
    function owner(node) {
        let cur = node.parent;
        while (cur) {
            if (cur.type === 'FunctionDeclaration' && cur.id && isComponentName(cur.id.name)) return cur;
            if (cur.type === 'ArrowFunctionExpression' || cur.type === 'FunctionExpression') {
                const p = cur.parent;
                if (p.type === 'VariableDeclarator' && p.id.type === 'Identifier' && isComponentName(p.id.name)) return cur;
                if (isCall(p) && /^(forwardRef|memo|React\.forwardRef|React\.memo|observer)$/.test(textOf(p.callee))) return cur;
                if (cur.type === 'FunctionExpression' && cur.id && isComponentName(cur.id.name)) return cur;
                if (p.type === 'ExportDefaultDeclaration') return cur;
            }
            cur = cur.parent;
        }
        return null;
    }

    function callName(node) {
        const fn = owner(node);
        if (fn) { needsHook.add(fn); return T; }
        needsGlobal = true;
        return 'i18n.t';
    }

    function insideCode(node) {
        let cur = node.parent;
        while (cur) {
            if (isJsxElement(cur)) {
                const tag = textOf(cur.openingElement.name);
                if (CODE_TAGS.has(tag)) return true;
            }
            cur = cur.parent;
        }
        return false;
    }

    /** `a.b`'s `b`, as written (`#b` for a private name). */
    const memberName = (e) => (e.property.type === 'PrivateName' ? `#${e.property.id.name}` : e.property.name);

    /** Whether an expression may become a `{{placeholder}}`. */
    function simpleExpr(e) {
        if (e.type === 'ParenthesizedExpression') return simpleExpr(e.expression);
        if (e.type === 'Identifier' || e.type === 'NumericLiteral' || isStringish(e)) return true;
        if (isPropertyAccess(e) || isElementAccess(e)) return simpleExpr(e.object);
        if (e.type === 'TSNonNullExpression') return simpleExpr(e.expression);
        if (isCall(e)) return !/<|=>/.test(textOf(e)) && textOf(e).length < 80 && !/\bt\(/.test(textOf(e));
        return false;
    }
    function placeholderName(e, used) {
        let base = 'value';
        if (e.type === 'Identifier') base = e.name;
        else if (isPropertyAccess(e)) base = memberName(e);
        else if (e.type === 'TSNonNullExpression' || e.type === 'ParenthesizedExpression') return placeholderName(e.expression, used);
        else if (isCall(e)) {
            const ex = e.callee;
            // `stats.mapped.toLocaleString()` is named after `mapped`, not after the
            // formatter: the placeholder should say what the number IS.
            if (isPropertyAccess(ex) && /^(toLocaleString|toFixed|toString|toUpperCase|toLowerCase|trim|join|toLocaleDateString)$/.test(memberName(ex))) {
                return placeholderName(ex.object, used);
            }
            base = isPropertyAccess(ex) ? memberName(ex) : ex.type === 'Identifier' ? ex.name : 'value';
            base = base.replace(/^(get|format|render|compute|to)(?=[A-Z])/, '');
            base = base.charAt(0).toLowerCase() + base.slice(1);
        }
        base = base.replace(/[^A-Za-z0-9_]/g, '') || 'value';
        let name = base, i = 2;
        while (used.has(name)) name = `${base}${i++}`;
        used.add(name);
        return name;
    }

    /** Build `t("… {{x}} …", { x: expr })` from parts. */
    function buildCall(node, parts) {
        // parts: [{ text }] | [{ expr }]
        const used = new Set();
        const vars = [];
        let key = '';
        for (const p of parts) {
            if (p.text !== undefined) key += p.text;
            else {
                const name = placeholderName(p.expr, used);
                vars.push([name, textOf(p.expr)]);
                key += `{{${name}}}`;
            }
        }
        key = key.replace(/\s+/g, ' ').trim();
        if (!hasLetters(key.replace(/\{\{[^}]+\}\}/g, ''))) return null;
        const fn = callName(node);
        allKeys.set(key, file);
        if (!vars.length) return `${fn}(${q(key)})`;
        const obj = vars.map(([n, ex]) => (n === ex ? n : `${n}: ${ex}`)).join(', ');
        return `${fn}(${q(key)}, { ${obj} })`;
    }

    // ---- 1. JSX children runs ---------------------------------------------------------------
    function visitJsxChildren(children) {
        // Group consecutive text / simple-expression children into runs separated
        // by elements. A run with any real text becomes one t() call.
        let run = [];
        const flush = () => {
            if (run.length) handleRun(run);
            run = [];
        };
        for (const c of children) {
            if (c.type === 'JSXText') { run.push(c); continue; }
            if (c.type === 'JSXExpressionContainer' && jsxExpressionOf(c)) {
                const e = c.expression;
                if (isStringish(e)) { run.push(c); continue; }
                if (simpleExpr(e)) { run.push(c); continue; }
                // A non-simple expression breaks the run: the run before it and
                // the run after it are translated separately (if they contain text).
                flush();
                continue;
            }
            flush();
        }
        flush();
    }

    /** A JSX text as written: whitespace and entities kept, as the compiler's `.text` was. */
    const jsxText = (c) => source.slice(c.start, c.end);
    /** A run member that is a `{'string'}` child. */
    const isStringChild = (c) => c.type === 'JSXExpressionContainer' && isStringish(c.expression);

    function handleRun(run) {
        const texts = run.filter((c) => c.type === 'JSXText' || isStringChild(c));
        const joined = texts.map((c) => c.type === 'JSXText' ? jsxText(c) : stringText(c.expression)).join('');
        const norm = normalize(joined);
        if (!hasLetters(norm)) return;
        const first = run[0], last = run[run.length - 1];
        if (insideCode(first)) { skipped.push({ line: line(first), kind: 'code', text: norm }); return; }
        if (looksLikeCode(norm)) { skipped.push({ line: line(first), kind: 'code-like', text: norm }); return; }
        // Expressions in the run must all be simple (they are, by construction of the run).
        const parts = [];
        for (const c of run) {
            if (c.type === 'JSXText') parts.push({ text: decodeEntities(jsxText(c)) });
            else if (isStringChild(c)) parts.push({ text: stringText(c.expression) });
            else parts.push({ expr: c.expression });
        }
        // Whitespace at the run's edges is layout, not copy: keep it outside.
        // A `{' '}` at either edge IS layout too — the one way JSX keeps a space
        // next to an element — so it is re-emitted, not folded into the key.
        const isSpacer = (c) => isStringChild(c) && /^\s+$/.test(stringText(c.expression));
        const spacerLead = isSpacer(first) ? "{' '}" : '';
        const spacerTrail = run.length > 1 && isSpacer(last) ? "{' '}" : '';
        const rawStart = startOf(first), rawEnd = last.end;
        const raw = source.slice(rawStart, rawEnd);
        const lead = spacerLead || /^\s*/.exec(raw)[0], trail = spacerTrail || /\s*$/.exec(raw)[0];
        // Trim the parts' edge whitespace to match.
        if (parts[0].text !== undefined) parts[0].text = parts[0].text.replace(/^\s+/, '');
        if (parts[parts.length - 1].text !== undefined) parts[parts.length - 1].text = parts[parts.length - 1].text.replace(/\s+$/, '');
        // A leading/trailing space WITHOUT a newline is significant in JSX.
        const leadSig = lead.length && !lead.includes('\n') ? "{' '}" : lead;
        const trailSig = trail.length && !trail.includes('\n') ? "{' '}" : trail;
        const call = buildCall(first, parts);
        if (!call) return;
        edits.push({ start: rawStart, end: rawEnd, text: `${leadSig}{${call}}${trailSig}` });
        sites += 1;
    }

    // ---- 2. attributes -----------------------------------------------------------------------------
    function visitAttribute(attr) {
        if (!attr.value) return;
        const name = textOf(attr.name);
        if (!TEXT_ATTRS.has(name)) return;
        const init = attr.value;
        if (init.type === 'StringLiteral') {
            const text = stringText(init);
            const norm = normalize(text);
            if (!hasLetters(norm) || looksLikeCode(norm)) return;
            const call = buildCall(init, [{ text }]);
            if (!call) return;
            edits.push({ start: init.start, end: init.end, text: `{${call}}` });
            sites += 1;
        } else if (init.type === 'JSXExpressionContainer' && jsxExpressionOf(init)) {
            visitExpressionTree(init.expression);
        }
    }

    // ---- 3. expressions: string literals and templates at "display" positions --------------------
    function visitExpressionTree(e) {
        if (!e) return;
        if (isStringish(e)) { literal(e); return; }
        if (isTemplate(e)) { template(e); return; }
        if (e.type === 'ParenthesizedExpression') { visitExpressionTree(e.expression); return; }
        if (e.type === 'ConditionalExpression') { visitExpressionTree(e.consequent); visitExpressionTree(e.alternate); return; }
        if (isLogical(e)) { visitExpressionTree(e.left); visitExpressionTree(e.right); return; }
        if (e.type === 'TSAsExpression' || e.type === 'TSNonNullExpression') { visitExpressionTree(e.expression); return; }
    }
    function literal(e) {
        const text = stringText(e);
        const norm = normalize(text);
        if (!hasLetters(norm) || looksLikeCode(norm)) return;
        // A string used as a comparison operand or a key is not copy.
        const p = e.parent;
        if (p.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(p.operator)) return;
        if (isPropertyAssignment(p) && p.key === e) return;
        if (isElementAccess(p) && p.property === e) return;
        const call = buildCall(e, [{ text }]);
        if (!call) return;
        edits.push({ start: e.start, end: e.end, text: call });
        sites += 1;
    }
    function template(e) {
        const { head, spans } = templateParts(e);
        const parts = [{ text: head }];
        for (const span of spans) {
            if (!simpleExpr(span.expression)) { skipped.push({ line: line(e), kind: 'template', text: normalize(textOf(e)) }); return; }
            parts.push({ expr: span.expression });
            parts.push({ text: span.literal });
        }
        const norm = normalize(parts.filter((p) => p.text !== undefined).map((p) => p.text).join(' '));
        if (!hasLetters(norm) || looksLikeCode(norm)) return;
        const call = buildCall(e, parts);
        if (!call) return;
        edits.push({ start: e.start, end: e.end, text: call });
        sites += 1;
    }

    // ---- 4. calls: toasts, confirms, and copy-carrying object props -------------------------------------
    function visitCall(node) {
        const callee = node.callee;
        const nm = callee.type === 'Identifier' ? callee.name : isPropertyAccess(callee) ? memberName(callee) : '';
        if (!TOAST_FNS.has(nm)) return;
        for (const arg of node.arguments) {
            if (isStringish(arg) || isTemplate(arg) || arg.type === 'ConditionalExpression' || isBinaryLike(arg)) {
                // addToast(type, message, details): the FIRST argument is a kind, not copy.
                if (nm === 'addToast' && arg === node.arguments[0]) continue;
                visitExpressionTree(arg);
            } else if (arg.type === 'ObjectExpression') {
                for (const prop of arg.properties) {
                    if (isPropertyAssignment(prop) && CALL_PROPS.has(propertyNameText(prop, textOf))) visitExpressionTree(prop.value);
                }
            }
        }
    }

    // ---- 5. object-literal copy properties ---------------------------------------------------------------
    // `{ label: 'Again' }`, `{ hint: '…' }`, `{ desc: '…' }`: a table of options. Inside a
    // component the value becomes t('…') (the table is rebuilt per render, so the
    // language follows); at module level it becomes k('…') — the English stays the
    // KEY and the render site must t() it, which the report lists for hand work.
    const COPY_PROPS = new Set(['label', 'hint', 'desc', 'description', 'stage', 'title', 'message', 'emptyLabel', 'subtitle', 'caption', 'tooltip', 'helper', 'summary', 'placeholder', 'hardware', 'experience']);
    function visitObjectProperty(prop) {
        if (!isPropertyAssignment(prop)) return;
        const key = prop.key;
        const name = prop.computed ? '' : key.type === 'Identifier' ? key.name : key.type === 'StringLiteral' ? key.value : '';
        if (!COPY_PROPS.has(name)) return;
        const v = prop.value;
        if (!isStringish(v)) return;
        const norm = normalize(stringText(v));
        if (!hasLetters(norm) || looksLikeCode(norm)) return;
        // Tailwind-looking values (`text: 'text-blue-700 …'`) never reach COPY_PROPS by
        // name, but a `title` can be a class string in a config: refuse class-shaped text.
        if (/^(?:[a-z-]+:)?(?:bg|text|border|ring|hover|dark)-[\w/[\]-]+(?:\s|$)/.test(norm)) return;
        const fn = owner(v);
        if (fn) {
            needsHook.add(fn);
            allKeys.set(norm, file);
            edits.push({ start: v.start, end: v.end, text: `${T}(${q(norm)})` });
        } else {
            needsMarker = true;
            allKeys.set(norm, file);
            edits.push({ start: v.start, end: v.end, text: `k(${q(norm)})` });
            skipped.push({ line: line(v), kind: 'k-table', text: `${name}: ${norm}` });
        }
        sites += 1;
    }

    // ---- walk ------------------------------------------------------------------------------------------
    function visit(node) {
        if (isPropertyAssignment(node)) visitObjectProperty(node);
        if (isJsxElement(node)) visitJsxChildren(node.children);
        else if (node.type === 'JSXFragment') visitJsxChildren(node.children);
        else if (node.type === 'JSXAttribute') visitAttribute(node);
        else if (node.type === 'JSXExpressionContainer' && jsxExpressionOf(node) && (node.parent.type === 'JSXElement' || node.parent.type === 'JSXFragment')) {
            // A lone expression child that is not part of a text run (a ternary of
            // strings, a template): translate its literals in place.
            const e = node.expression;
            if (e.type === 'ConditionalExpression' || isTemplate(e) || (isBinaryLike(e) && !simpleExpr(e))) visitExpressionTree(e);
        }
        else if (isCall(node)) visitCall(node);
        forEachChild(node, visit);
    }
    visit(program);

    if (!edits.length) return { text: source, sites: 0, skipped };

    // ---- hook insertion ------------------------------------------------------------------------
    for (const fn of needsHook) {
        if (!fn.body) continue;
        const bodyText = textOf(fn.body);
        if (/\buseTranslation\s*\(/.test(bodyText) && new RegExp(`\\{\\s*t(?::\\s*${T})?\\s*\\}\\s*=\\s*useTranslation`).test(bodyText)) continue;
        const decl = T === 't' ? 'const { t } = useTranslation();' : `const { t: ${T} } = useTranslation();`;
        if (fn.body.type === 'BlockStatement') {
            const open = fn.body.start + 1;
            // Match the body's indentation.
            const nextLine = source.slice(open).match(/\n([ \t]*)\S/);
            const indent = nextLine ? nextLine[1] : '    ';
            edits.push({ start: open, end: open, text: `\n${indent}${decl}` });
        } else {
            // Expression body: wrap into a block.
            edits.push({ start: fn.body.start, end: fn.body.start, text: `{ ${decl} return ` });
            edits.push({ start: fn.body.end, end: fn.body.end, text: `; }` });
        }
    }

    // ---- imports --------------------------------------------------------------------------------
    const importLines = [];
    if (needsHook.size && !/from ['"]react-i18next['"]/.test(source)) importLines.push(`import { useTranslation } from 'react-i18next';`);
    let rel = relative(dirname(file), join(srcDir, 'i18n')).split(sep).join('/');
    if (!rel.startsWith('.')) rel = `./${rel}`;
    if (needsGlobal && !/import i18n(?:, \{[^}]*\})? from ['"][^'"]*i18n['"]/.test(source)) importLines.push(`import i18n from '${rel}';`);
    if (needsMarker && !/import (?:\{[^}]*\bk\b[^}]*\}|i18n, \{[^}]*\bk\b[^}]*\}) from ['"][^'"]*i18n['"]/.test(source)) importLines.push(`import { k } from '${rel}';`);
    if (importLines.length) {
        // After the last import statement.
        let at = 0;
        for (const st of program.body) if (st.type === 'ImportDeclaration') at = st.end;
        edits.push({ start: at, end: at, text: `${at ? '\n' : ''}${importLines.join('\n')}${at ? '' : '\n'}` });
    }

    // ---- apply, from the end ---------------------------------------------------------------------
    // Two rules can claim one node (a `title:` inside a showConfirm({…}) is both a
    // copy property and a call property); the first edit on a range wins and an
    // overlapping one is dropped, or the text is spliced twice.
    edits.sort((a, b) => b.start - a.start || b.end - a.end);
    let out = source;
    let lastStart = Infinity;
    for (const e of edits) {
        if (e.end > lastStart && e.start !== e.end) continue;
        out = out.slice(0, e.start) + e.text + out.slice(e.end);
        if (e.start !== e.end) lastStart = e.start;
    }
    return { text: out, sites, skipped };
}

/** Write en.json: one entry per key (plural keys get _one/_other), existing values kept. */
function writeEnglishLocale(file, keys) {
    const existing = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    const next = {};
    for (const [key, { plural }] of keys) {
        for (const [k, v] of Object.entries(englishEntries(key, plural))) next[k] = k in existing ? existing[k] : v;
    }
    const sorted = Object.fromEntries(Object.keys(next).sort((a, b) => a.localeCompare(b, 'en')).map((k) => [k, next[k]]));
    writeFileSync(file, `${JSON.stringify(sorted, null, 2)}\n`);
    return Object.keys(sorted).length;
}

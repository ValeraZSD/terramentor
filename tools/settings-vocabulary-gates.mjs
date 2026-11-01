#!/usr/bin/env node
/**
 * settings-vocabulary-gates.mjs — what a SETTING looks like, as a rule.
 *
 * `control-gates.mjs` settled what a CONTROL looks like and the page obeys it.
 * What it cannot see is everything AROUND the control, and that is where the
 * page comes apart. What goes wrong:
 *
 *   * Labels in `text-transform: uppercase`, including topic names and a
 *     project's own words. In Russian, capitals strip the ascenders and
 *     descenders that give a word its silhouette, so an upper-cased label is
 *     a grey brick. It is also a loud tell of machine-written interface copy.
 *   * Several different disclosures, hand-written copies of each other with
 *     one detail different apiece (a tint, a border, a missing webkit marker
 *     reset, the chevron on the other side).
 *   * Disclosures called "More", which names nothing: two of them close
 *     together, one inside the other's section, each with a long sentence
 *     behind it.
 *
 * Each rule below is re-run against the exact pre-fix shape it was written for
 * (PRE_FIX at the bottom). A rule that does not fire on the code that caused it
 * is not a rule, it is a comment — and the rules here are cheap string checks,
 * which is exactly the kind that silently stops matching after a refactor.
 *
 *   node tools/settings-vocabulary-gates.mjs
 *   node tools/settings-vocabulary-gates.mjs --json
 */
import { readFileSync, globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const rel = (abs) => path.relative(ROOT, abs).replace(/\\/g, '/');

/** Every surface held to the setting vocabulary. */
const SETTINGS_SCOPE = [
    'src/components/Settings.tsx',
    'src/components/settings/*.tsx',
    'src/components/SearchProvidersPanel.tsx',
    'src/components/SecuritySettings.tsx',
    'src/components/ui/SettingRow.tsx',
];

/** The whole interface, for the casing rule — a shouted label is shouted
 *  wherever it is drawn, and the worst of them were on feed cards. */
const UI_SCOPE = ['src/**/*.tsx', 'src/**/*.ts'];

const files = (globs) => globs
    .flatMap((g) => globSync(g, { cwd: ROOT }))
    .map((f) => rel(path.join(ROOT, f)))
    .filter((f, i, all) => all.indexOf(f) === i)
    .sort();

const findings = [];
let checked = 0;
const fail = (rule, file, line, detail, fix) => findings.push({ rule, file, line, detail, fix });
const lineOf = (src, index) => src.slice(0, index).split('\n').length;

/** Comments, blanked character for character so line numbers do not move. */
const blindComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*\/\/.*$/gm, (c) => ' '.repeat(c.length));

/** Lines that are only talking ABOUT the rule. */
const isComment = (line) => /^\s*(\*|\/\/|\/\*)/.test(line);

/* ── 1. nothing shouts ──────────────────────────────────────────────────── */
//
// The class, not the rendered text: a translated string is capitalised by the
// language, and `text-transform` is the app overruling it.
function noShouting(src, file) {
    src.split('\n').forEach((line, i) => {
        if (isComment(line)) return;
        if (/\buppercase\b/.test(line)) {
            fail('caps', file, i + 1, 'text-transform: uppercase',
                'sentence case — see GROUP_CAPTION in ui/SettingRow.tsx');
        }
        // The same thing done in JS, which no class scan would ever see. A file
        // extension or a currency code is not prose and is allowed by name.
        const up = /(\w[\w.]*)\.toUpperCase\(\)/.exec(line);
        if (up && !/file_type|extension|\bext\b|charAt|hex|code/i.test(line)) {
            fail('caps', file, i + 1, `${up[1]}.toUpperCase() on displayed text`,
                'draw the string as it was written');
        }
    });
}

/* ── 1b. and taking the shouting out left no stumps ─────────────────────── */
//
// The pass that removed `uppercase tracking-wider` did it by pattern and cut
// through the neighbouring class: `font-semibold uppercase tracking-wider`
// became `font-semiboldr`, `text-xs uppercase tracking-wider` became
// `text-xsr`, and `text-[10px] uppercase tracking-widest` became
// `text-[11px]st` — seventeen labels that silently lost their weight or their
// size, because Tailwind drops a class it does not know without a word and tsc
// cannot see inside a string. A size or weight fused to trailing letters is
// never a real class.
const FUSED_TYPE = /(?:^|[\s"'`:{])((?:text-(?:xs|sm|base|lg|[2-9]?xl|\[[\d.]+(?:px|rem|em)\])|font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black))[a-z]+)(?![\w-])/g;
// Only on a line that is building classes, so prose ("any text-based file")
// is not read as one.
const CLASS_LINE = /(?:^|[\s"'`])(?:bg|border|rounded|flex|grid|gap|items|justify|[pm][xytblr]?|[wh]|text-(?:slate|gray|accent|red|amber|white))-/;
function noClassStumps(src, file) {
    src.split('\n').forEach((line, i) => {
        if (isComment(line) || !CLASS_LINE.test(line)) return;
        for (const m of line.matchAll(FUSED_TYPE)) {
            fail('stump', file, i + 1, `\`${m[1]}\` is not a class — a size or weight with letters fused on`,
                'restore the class it was cut from (font-semibold, text-xs, …)');
        }
    });
}

/* ── 2. one disclosure vocabulary ───────────────────────────────────────── */
//
// A `<details>` in the settings scope means someone has hand-written an eighth
// shape. `Explain` is prose behind a name, `ExpandableSection` is controls
// behind a name, and there is deliberately no third.
function oneDisclosure(raw, file) {
    // Blind the comments: the note left where each hand-written copy was
    // removed names the tag it replaced, and so does this file's own
    // explanation of the rule. Blanking them keeps every line number intact.
    const src = blindComments(raw);
    for (const m of src.matchAll(/<details\b/g)) {
        fail('shape', file, lineOf(src, m.index), 'hand-written <details>',
            'use <Explain> (prose) or <ExpandableSection> (controls) from ui/Disclosure');
    }
    for (const m of src.matchAll(/<summary\b/g)) {
        fail('shape', file, lineOf(src, m.index), 'hand-written <summary>',
            'use <Explain> or <ExpandableSection> from ui/Disclosure');
    }
}

/* ── 3. no disclosure is called "More" ──────────────────────────────────── */
//
// A door with no sign on it. The rule is enforced on the KEY rather than on the
// component, because the next unnamed one will be spelt "Details" or "Show" —
// so it also fails a summary that is one of the generic words.
const EMPTY_NAMES = /^(more|details?|show|info|learn more|read more)$/i;
function namedDisclosures(src, file) {
    for (const m of src.matchAll(/<Explain\b[\s\S]{0,200}?summary=\{(?:tr|t|k)\("([^"]*)"\)\}/g)) {
        if (EMPTY_NAMES.test(m[1].trim())) {
            fail('unnamed', file, lineOf(src, m.index), `summary is "${m[1]}"`,
                'name what is inside it — "Where your data goes", not "More"');
        }
    }
}

/* ── 4. the control is on the right, on one line ────────────────────────── */
//
// A switch that wraps onto its own line lands at the LEFT edge — the one corner
// of a phone a thumb cannot reach, which is why every phone OS puts a switch on
// the right. This checks the one row every setting is built from.
function rowNeverWraps(src, file) {
    if (!file.endsWith('ui/SettingRow.tsx')) return;
    // The row itself: a flex line whose first child is the name column.
    const row = /<div [^>]*className=\{`flex[^`]*`\}>\s*\n\s*<div className="min-w-0 flex-1">/.exec(src);
    if (!row) {
        fail('row', file, 1, 'the setting row is no longer a flex line with a `min-w-0 flex-1` name column',
            'name left, control right — see the comment above it');
        return;
    }
    if (/flex-wrap/.test(row[0])) {
        fail('row', file, lineOf(src, row.index), 'the setting row wraps',
            'a wrapped control lands at the LEFT edge; let the name wrap, or stack deliberately');
    }
    // The only other place a control may go is UNDER the whole name, which is
    // what `block` and the measured stack share. If that branch disappears, a
    // three-line name beside a wide control is back.
    if (!/\{under && control/.test(src)) {
        fail('row', file, lineOf(src, row.index), 'there is no stacked branch for a control that cannot fit',
            'a control that cannot sit beside its name goes UNDER it, never half-way');
    }
}

/* ── 5. a disclosure looks open only when IT is open ────────────────────── */
//
// `group-open:` matches ANY open ancestor that carries `group`, and disclosures
// nest (an `Explain` inside an `ExpandableSection` row; a lesson's own
// `<details>` step inside the opened "Show part 1 again"). Inside an opened row
// the shut "Why a small model is better" drew its chevron turned down, as if
// open over an empty body (2026-11-01). Every open-state class anywhere in the
// interface names its own `<details>`: `[details[open]>summary>&]:` for a
// chevron in the summary, `[details[open]>summary_&]:` for words inside it.
function ownOpenState(raw, file) {
    const src = blindComments(raw);
    for (const m of src.matchAll(/\bgroup-open:/g)) {
        fail('nested', file, lineOf(src, m.index), '`group-open:` also fires for an open parent disclosure',
            'key the open state to the element\'s own <details>: `[details[open]>summary>&]:` or `[details[open]>&]:`');
    }
}

/* ── 6. an on/off setting is a switch on the right ──────────────────────── */
//
// Six on/off settings (four feed dials, resource hunting, "Offer simulations
// and widgets to any model") were ticks on the LEFT, a few rows from switches
// and steppers on the right, so one kind of setting read as two (outside
// review, 2026-11-01). A tick belongs only where several things are picked
// from a list; each such list is named here with how many it may hold.
const CHECKLISTS = {
    'src/components/settings/ServingEndpointsPicker.tsx': 1, // endpoints picked from a table, in order
    'src/components/settings/VisualKindsPanel.tsx': 1,       // the gallery: a card's picture is its switch
};
function switchesNotTicks(raw, file) {
    const src = blindComments(raw);
    const ticks = [...src.matchAll(/<Checkbox\b/g)];
    for (const m of ticks.slice(CHECKLISTS[file] ?? 0)) {
        fail('switch', file, lineOf(src, m.index), 'an on/off setting drawn as a tick on the left',
            'use ui/Switch to the right of the name; a tick only picks several things from a list (CHECKLISTS)');
    }
}

/* ── 7. a switch whose save failed goes back ────────────────────────────── */
//
// A switch flips the moment it is pressed and the write follows. When the
// write fails, the switch must go back to what is stored: four of them
// (the feed dials, resource hunting, "Offer simulations and widgets to any
// model", "Use AI features") stayed in the new position over an error toast,
// or over nothing but a console line, saying a setting was on that was off.
// The rule: a handler that sets the state the switch SHOWS (`checked={x…}` →
// `setX`) before its write sets that same state again on the failure path (a
// `catch` or `finally` block, or a `.catch(` callback); `src/utils/switchSaver.ts`
// does both for you. Every `<Switch>` in the interface is judged, and one
// whose handler cannot be found is a finding, not a pass.
/** The bracketed span that starts at `open` (an index of `{` or `(`), counted. */
const spanAt = (src, open) => {
    const [o, c] = src[open] === '(' ? ['(', ')'] : ['{', '}'];
    let depth = 0;
    for (let i = open; i >= 0 && i < src.length; i++) {
        if (src[i] === o) depth++;
        else if (src[i] === c && --depth === 0) return src.slice(open, i + 1);
    }
    return '';
};
const STORE_ACTION = Symbol('store action');
/** The body of what `name` names in this file, STORE_ACTION, or null when it cannot be found. */
function handlerNamed(src, name) {
    if (new RegExp(`const ${name} = useStore\\(`).test(src)) return STORE_ACTION; // judged where it lives
    const arrow = new RegExp(`const ${name} = (?:useCallback\\(\\s*)?(?:async\\s+)?(?:\\([^)]*\\)|\\w+)(?:\\s*:\\s*[\\w<>\\[\\]|]+)?\\s*=>\\s*`).exec(src);
    if (arrow) {
        const at = arrow.index + arrow[0].length;
        return src[at] === '{' ? spanAt(src, at) : src.slice(at, src.indexOf('\n', at));
    }
    const fn = new RegExp(`(?:async\\s+)?function ${name}\\s*\\(`).exec(src);
    if (fn) {
        const params = spanAt(src, fn.index + fn[0].length - 1);
        const open = src.indexOf('{', fn.index + fn[0].length - 1 + params.length);
        return spanAt(src, open);
    }
    return null;
}
/** The code a `<Switch … />`'s onChange runs, STORE_ACTION, or null. */
function handlerOf(src, el) {
    const inline = /\bonChange=\{\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>\s*\{/.exec(el);
    if (inline) return spanAt(el, inline.index + inline[0].length - 1);
    const call = /\bonChange=\{\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>\s*(?:void\s+)?(\w+)\(/.exec(el);
    const bare = /\bonChange=\{\s*(\w+)\s*\}/.exec(el);
    const name = call?.[1] ?? bare?.[1];
    return name ? handlerNamed(src, name) : null;
}
function switchRevertsOnFailure(raw, file) {
    const src = blindComments(raw);
    // One `<Switch … />` at a time: a handler is never looked for past its own element.
    for (const el of src.matchAll(/<Switch\b(?:(?!\/>)[\s\S])*\/>/g)) {
        const shown = /\bchecked=\{\s*!*\s*(\w+)/.exec(el[0]);
        if (!shown) continue; // shows nothing it could leave wrong
        const setter = new RegExp(`\\bset${shown[1][0].toUpperCase()}${shown[1].slice(1)}\\(`);
        const body = handlerOf(src, el[0]);
        if (body === STORE_ACTION) continue;
        if (body === null) {
            fail('revert', file, lineOf(src, el.index), `cannot find what this switch's \`onChange\` runs, so cannot tell whether a failed save leaves it wrong`,
                'write the handler as a `const` (or a function) in this file, or inline');
            continue;
        }
        // A call to a saver made by `switchSaver()` is the write (and owns the revert).
        const savers = [...src.matchAll(/(\w+)\s*=\s*(?:useRef\(\s*)?switchSaver\(\)/g)].map((m) => m[1]);
        const write = body.search(new RegExp(`\\bawait\\b|\\.then\\(|\\btry\\s*\\{|writeSetting\\(|api\\.${savers.map((s) => `|\\b${s}\\(`).join('')}`));
        const before = write < 0 ? '' : body.slice(0, write);
        if (!setter.test(before)) continue; // not optimistic: shows what the server answered
        const failurePaths = [
            ...[...body.matchAll(/\b(?:catch\s*(?:\([^)]*\))?|finally)\s*\{/g)].map((m) => spanAt(body, m.index + m[0].length - 1)),
            ...[...body.matchAll(/\.catch\(/g)].map((m) => spanAt(body, m.index + m[0].length - 1)),
        ];
        if (!failurePaths.some((p) => setter.test(p))) {
            fail('revert', file, lineOf(src, el.index), `this switch moves (\`${setter.source.slice(2, -2)}\`) before saving and stays there when the save fails`,
                'save it through `switchSaver` (src/utils/switchSaver.ts), or set the same state back on the failure path');
        }
    }
}

/* ── run ────────────────────────────────────────────────────────────────── */
for (const file of files(UI_SCOPE)) {
    checked++;
    const src = read(file);
    noShouting(src, file);
    noClassStumps(src, file);
    ownOpenState(src, file);
    // A switch that says ON over a failed save is wrong wherever it is drawn.
    if (/<Switch\b/.test(src)) switchRevertsOnFailure(src, file);
}
for (const file of files(SETTINGS_SCOPE)) {
    const src = read(file);
    checked++;
    oneDisclosure(src, file);
    namedDisclosures(src, file);
    rowNeverWraps(src, file);
    switchesNotTicks(src, file);
}

/* ── the rules are re-run against the shapes that caused them ───────────── */
//
// Every one of these is a verbatim line from the tree before this pass, or
// (marked) the nearest shape that would let the bug through a weaker rule.
const PRE_FIX = [
    {
        why: 'a failed save that clears some OTHER state and leaves the switch moved (shape)',
        run: switchRevertsOnFailure,
        file: 'src/components/settings/FeedSettingsPanel.tsx',
        src: `const saveBool = async (key: BoolKey, value: boolean) => {
        setBools(prev => ({ ...prev, [key]: value }));
        try {
            await api.setSetting(key, value ? 'true' : 'false');
        } catch (e: any) {
            setSaving(false);
            addToast('error', tr("Failed to save"), e.message);
        }
    };
<Switch id={id} label={label} checked={bools[key]} onChange={v => void saveBool(key, v)} />`,
    },
    {
        why: 'an inline handler that moves the switch and never puts it back (shape)',
        run: switchRevertsOnFailure,
        file: 'src/components/settings/ThisComputerSection.tsx',
        src: `<Switch checked={keepRunning} label="Keep the server running" onChange={async next => {
            setKeepRunning(next);
            try { await desktopApi.keepRunning(next); }
            catch { addToast('error', tr("Could not change the setting")); }
        }} />`,
    },
    {
        why: 'a switch whose handler is not in the file (shape)',
        run: switchRevertsOnFailure,
        file: 'src/components/settings/VisualKindsPanel.tsx',
        src: `export function Row({ onToggle }) { return <Switch checked={anyModel} onChange={onToggle} label="x" />; }`,
    },
    {
        why: 'the group caption that started it',
        run: noShouting,
        src: '            <h2 className="mb-2 px-1 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">',
    },
    {
        why: 'a topic name shouted on a feed card',
        run: noShouting,
        src: '                        <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500 truncate">',
    },
    {
        why: 'the poster, which does it in JS where no class scan would see it',
        run: noShouting,
        src: '    centred(ctx, content.eyebrow.toUpperCase(), layout.width / 2, layout.eyebrowY);',
    },
    {
        why: 'the weight the caps removal cut into `font-semiboldr`',
        run: noClassStumps,
        src: '                                <h3 className="text-xs font-semiboldr text-slate-500 dark:text-slate-400">',
    },
    {
        why: 'the size it cut into `text-[11px]st`',
        run: noClassStumps,
        src: '        <span className={`text-[11px]st font-semibold px-2 py-1 rounded-md ${CHIP_TONE[tone]}`}>',
    },
    {
        why: 'the eighth disclosure shape, hand-written in the AI tab',
        run: oneDisclosure,
        src: '<details className="group rounded-lg border border-slate-200 bg-slate-50">\n<summary className="flex items-center gap-2 px-3 h-10">',
    },
    {
        why: 'the unnamed "More" this pass removed fourteen of',
        run: namedDisclosures,
        src: '<Explain summary={tr("More")}>x</Explain>',
    },
    {
        why: 'the wrapping row that put a switch under the reader’s left thumb',
        run: rowNeverWraps,
        file: 'src/components/ui/SettingRow.tsx',
        src: '            <div ref={row} className={`flex flex-wrap items-center justify-between gap-x-6`}>\n                <div className="min-w-0 flex-1">\n{under && control}',
    },
    {
        why: 'the chevron that turned for its parent row',
        run: ownOpenState,
        file: 'src/components/ui/Disclosure.tsx',
        src: "    'transition-transform duration-200 ease-out motion-reduce:transition-none group-open:rotate-90';",
    },
    {
        why: 'the feed dial ticked on the left under steppers on the right',
        run: switchesNotTicks,
        file: 'src/components/settings/FeedSettingsPanel.tsx',
        src: '        <label className="flex items-start gap-3 px-4 py-3 cursor-pointer">\n            <Checkbox\n                checked={bools[key]}',
    },
    {
        why: 'the lesson step whose chevron turned for the opened Explain around it',
        run: ownOpenState,
        file: 'src/components/Markdown.tsx',
        src: '                className="mt-1 shrink-0 text-slate-500 transition-transform duration-200 group-open:rotate-90 dark:text-slate-400',
    },
    {
        why: 'the feed dial left switched on over "Failed to save"',
        run: switchRevertsOnFailure,
        file: 'src/components/settings/FeedSettingsPanel.tsx',
        src: `const saveBool = async (key: BoolKey, value: boolean) => {
        setBools(prev => ({ ...prev, [key]: value }));
        try {
            await api.setSetting(key, value ? 'true' : 'false');
        } catch (e: any) {
            addToast('error', tr("Failed to save"), e.message);
        }
    };
<Switch id={id} label={label} checked={bools[key]} onChange={v => void saveBool(key, v)} />`,
    },
    {
        why: '"Use AI features" left flipped over a console line',
        run: switchRevertsOnFailure,
        file: 'src/components/settings/AISettings.tsx',
        src: `const handleToggleAI = () => {
        const next = !aiEnabledRef.current;
        aiEnabledRef.current = next;
        setAiEnabled(next);
        writeSetting('ai_enabled', String(next))
            .then(() => announceAI())
            .catch(e => console.error('Saving ai_enabled failed:', e));
    };
<Switch checked={aiEnabled} onChange={handleToggleAI} label={tr("Use AI features")} />`,
    },
    {
        why: 'a second tick slipped into the visuals gallery file',
        run: switchesNotTicks,
        file: 'src/components/settings/VisualKindsPanel.tsx',
        src: '<Checkbox id={`visual-kind-${spec.id}`} />\n<Checkbox id="visual-any-model" checked={anyModel} />',
    },
];

const blind = [];
for (const c of PRE_FIX) {
    const before = findings.length;
    c.run(c.src, c.file || 'PRE_FIX');
    const fired = findings.splice(before).length;
    if (!fired) blind.push(c.why);
}

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', c: '\x1b[36m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ checked, findings, blind }, null, 2));
} else {
    console.log(`\n${C.b}Setting vocabulary${C.x} ${C.d}(${checked} files scanned)${C.x}\n`);
    for (const why of blind) {
        console.log(`  ${C.y}blind${C.x} a rule no longer fires on ${why}`);
    }
    for (const f of findings) {
        console.log(`  ${C.r}${f.rule}${C.x} ${f.detail}`);
        console.log(`        ${C.d}${f.file}:${f.line}${C.x}`);
        console.log(`        ${C.d}→ ${f.fix}${C.x}`);
    }
    // run-gates.mjs reads this line: a suite that prints no count is a suite
    // that might be asserting nothing.
    const asserts = checked + PRE_FIX.length;
    if (!findings.length && !blind.length) {
        console.log(`  ${C.g}${asserts} passed, 0 failed${C.x} ${C.d}· nothing shouts, one disclosure shape, every disclosure named, the control on the right${C.x}`);
        console.log(`  ${C.d}· ${PRE_FIX.length} pre-fix shapes still caught${C.x}`);
    } else {
        console.log(`  ${asserts - findings.length - blind.length} passed, ${findings.length + blind.length} failed`);
    }
    console.log('');
}

process.exit(findings.length || blind.length ? 1 : 0);

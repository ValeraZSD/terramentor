#!/usr/bin/env node
// control-gates.mjs — the control vocabulary is a rule, not a paragraph.
//
// The app had a colour system and no SIZE system, so every control was sized at
// its call site: 186 buttons in 50 distinct shapes, five different heights on
// the Settings page alone (28 / 32 / 40 / 44 / 48px). Every existing gate
// checks one element in isolation — is it legible, is it reachable, is its
// colour a token — and a page of fifty different buttons passes all of them.
// This one checks SAMENESS, which is the thing no other check can see.
//
// The invariant, in the files listed in SCOPE:
//
//   a raw <button> / <a> may not size itself.
//
// Height, horizontal padding, radius and type size come from `ui/Button`,
// `ui/Field`, `ui/SegmentedControl`, `ui/Stepper`, `ui/Switch` or `ui/Slider`
// — so changing the app's control height is one edit, not 186.
//
// A genuine widget (a tab in a rail, a list row, an answer tile, a drag
// handle) is not a button in this sense: it carries a `data-` marker naming
// its kind, and MARKERS argues each kind once. The file is read as TSX and the
// gate tests itself on fixtures before it reads the app.
//
//   node tools/control-gates.mjs             # human report
//   node tools/control-gates.mjs --json
//   node tools/control-gates.mjs --root DIR  # another checkout (the pre-fix tree)

import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

// `new URL(import.meta.url).pathname` leaves the drive letter behind a slash and
// the spaces in "3 - work" percent-encoded, so the glob silently matched nothing
// and the gate reported a clean run over zero files.
// `--root DIR` reads another checkout (the pre-fix tree, to show the gate fails there).
const rootArg = process.argv.indexOf('--root');
if (rootArg > 0 && !process.argv[rootArg + 1]) { console.error('--root needs a directory'); process.exit(2); }
const ROOT = rootArg > 0
    ? path.resolve(process.argv[rootArg + 1])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Files held to the vocabulary. Grows as the rest of the app is converted. */
const SCOPE = [
    'src/components/ui/**/*.tsx',
    'src/components/ModelPicker.tsx',
    'src/components/Settings.tsx',
    'src/components/settings/*.tsx',
    // The project dialog: the third place a control shape was invented (a
    // panel radius on a field, `focus:ring` instead of the focus ring), and the
    // reason the colour picker drifted into two versions of itself unseen.
    'src/components/ProjectFormFields.tsx',
    'src/components/IconPicker.tsx',
    'src/components/ExternalAuthoring.tsx',
    // Capture: converted when the attach control was found to be a line of
    // text with a paperclip in front of it, which nobody read as pressable.
    'src/components/CaptureModal.tsx',
    // New code, so there is no conversion debt to grandfather: the
    // finished-project screen is built out of the vocabulary from the start.
    'src/components/completion/*.tsx',
    // Same argument for the atlas's chrome, written with the second surface:
    // the floating card's Open button had invented a fourth height (36px) three
    // days after the ladder shipped.
    'src/components/atlas/*.tsx',
    // The assistant's prepared controls (a check, a card, a note): new code,
    // built from the vocabulary from the start.
    'src/components/AssistantProposals.tsx',
    // Report a problem: converted when it became a form (2026-09-28); its
    // Close, Copy and Continue buttons had each sized themselves by hand.
    'src/components/ReportProblemDialog.tsx',
    // The head-start banner replaced TransferBanner (2026-09-28), whose two
    // buttons had sized themselves by hand (`px-3 py-2 min-h-11`).
    'src/components/feed/HeadStartBanner.tsx',
    // An AI creation's own screen (2026-09-30), split out of the projects grid
    // when several runs could be live at once: built from the vocabulary.
    'src/components/creation/*.tsx',
    // The study clock's readings (2026-10-04): new code, from the vocabulary.
    'src/components/studyTime/*.tsx',
    // Files in the assistant chat (2026-10-07): new code, from the vocabulary.
    'src/components/attachments/*.tsx',
    'src/components/update/*.tsx',
    // Saved AI connections and the Connect dialog (2026-10-12): new code.
    'src/components/settings/connections/*.tsx',
    // THE WHOLE APP (2026-10-13). Converted file by file above, then in one
    // pass after the lock screens put a full-width 44px button with an icon
    // over a small outlined one without, and the same pass found 313 buttons
    // in 86 files still sizing themselves: four heights for a primary action,
    // two radii, two fills. Every file is held now; a real widget is argued
    // into MARKERS below, and a file is never left out instead.
    'src/**/*.tsx',
];

/**
 * Files not yet held, each with the reason and the condition that ends it.
 * Empty is the goal; a line here is debt with a name on it.
 */
const PENDING = [];

/**
 * Widgets, not buttons. Every exemption is read off the element's ATTRIBUTES by
 * the parser, never as a substring of the tag's text: as a substring, an old
 * entry written for one atlas row (`aria-expanded={open}`) exempted any sized
 * button anywhere in the app that happened to carry the same attribute.
 *
 * MARKERS: a `data-` attribute that says which KIND of widget the element is.
 * The reason is argued here once per kind. Where `files` is given, the kind is
 * honoured in those files only — a `data-dock` outside the task dock exempts
 * nothing. A marked element may not be painted as a primary action (a solid
 * accent fill with white text): a marker on that is a button in disguise —
 * unless the kind is `selectable`, where the fill is the CHOSEN state of a
 * value (a playing sound, the picked engine, the tab you are on).
 */
const MARKERS = [
    { attr: 'data-row', why: 'a row of a list, or a card\'s title that opens it — its height is the text inside it (a conversation, a deck section, a day\'s activity, a topic, a phase)' },
    { attr: 'data-tab', selectable: true, why: 'a tab in a navigation rail — sized with the rail; its active state is a fill, not a button' },
    { attr: 'data-chip', selectable: true, why: 'a filter or type chip in a strip of them — one line of 10-12px text; the strip owns the height' },
    { attr: 'data-disclosure', why: 'a disclosure heading that spans its panel — a row that opens, not a button beside others' },
    { attr: 'data-answer-option', selectable: true, why: 'an answer tile — sized by the answer it holds, laid out by how much it paints (ChoiceInput)' },
    { attr: 'data-row-fold', why: 'the fold chevron inside a tree or lane row — the row owns the height' },
    { attr: 'data-drag-handle', why: 'a drag handle — a grip glyph the row\'s height carries, pressed and held, never clicked' },
    { attr: 'data-link', why: 'an inline text link inside a sentence — the sentence\'s type, not a control size' },
    { attr: 'data-tile', why: 'a choice tile with a mark, a title and lines of text — its height is its content' },
    { attr: 'data-dock', files: ['src/components/TaskDock.tsx'], why: 'the background-task bar: a 40px floating strip whose chips and controls tools/dock-harness measures' },
    { attr: 'data-strip', files: ['src/components/schedule/ScheduleBoard.tsx'], why: 'the schedule card\'s date strip: the dates ARE the control, and pressing them swaps in an editor of the same height' },
    { attr: 'data-rating', files: ['src/components/flashcards/RatingButton.tsx'], why: 'one of the four rating tiles — icon, word and interval stacked' },
    { attr: 'data-handle', files: ['src/components/feed/PracticeCard.tsx'], why: 'a corner handle dragged over a photograph' },
    { attr: 'data-media-control', selectable: true, files: ['src/components/CardMedia.tsx'], why: 'play/stop on a sound inside a card — a round media control sized with the card text it sits in' },
    { attr: 'data-toast-body', files: ['src/components/Toast.tsx'], why: 'a toast\'s own text, pressable for its details — the toast owns the shape' },
    { attr: 'data-day-toggle', selectable: true, files: ['src/components/ScheduleModal.tsx'], why: 'a study day in a week of seven toggles — a 40px square per weekday; the week owns the layout' },
    { attr: 'data-bar', files: ['src/components/studyTime/StudyTime.tsx'], why: 'a day in a bar chart — the bar is the value, the chart owns the height' },
    // The ✕ on a 64px thumbnail is a 24px circle on its corner — the shape all
    // five big chat apps use — with a 44px hit area from an inset pseudo-element;
    // a sent file is a link sized by what it shows (a picture's height, a card).
    { attr: 'data-chip-remove', files: ['src/components/attachments/AttachmentChips.tsx'], why: 'the ✕ on a thumbnail chip — a 24px circle whose hit area is widened past what it paints' },
    { attr: 'data-attachment-link', files: ['src/components/attachments/AttachmentFigure.tsx', 'src/components/attachments/MessageAttachments.tsx'], why: 'a sent file as its picture or its card — sized by the file it shows' },
    // SegmentedControl's segments, ColorField's swatches, IconPicker's tiles: the
    // group owns the shape and the tile IS the value, so there is no label to size.
    { attr: 'role', value: 'radio', selectable: true, why: 'a radio inside a radiogroup — the group owns the height' },
];

/**
 * Exemptions written before the markers, each pinned to the one file it was
 * argued for and identified by one attribute's source text there. Each must
 * still match something, or the gate fails: an exemption that matches nothing
 * is one nobody can see.
 */
const LEGACY = [
    { file: 'src/components/Settings.tsx', attr: 'onClick', has: 'selectTab(t.id)', why: 'the settings tab rail — a nav item, sized with the rail' },
    { file: 'src/components/settings/AppearanceControls.tsx', attr: 'onClick', has: 'setTheme(id)', why: 'a theme preview card — the swatch IS the control' },
    // The New course dialog's drop zone and the vault's: a dashed target two
    // lines tall that takes a drag as well as a press.
    { file: 'src/components/creation/SourceFiles.tsx', attr: 'onClick', has: 'chooseFiles', why: 'the course-material drop row — a dashed drop target sized by its line of text' },
    { file: 'src/components/VaultPanel.tsx', attr: 'onDragOver', has: 'setDragOver(true)', why: 'a file drop target — a dashed panel sized by its two lines of text' },
    // The atlas's lists and its control cluster: a row's height is the title in
    // it, and the map's cluster is one hairline-divided panel of 44px cells.
    { file: 'src/components/atlas/RegionList.tsx', attr: 'aria-expanded', has: 'open', why: 'a region row that expands — its height is its own title and bar' },
    { file: 'src/components/atlas/RegionList.tsx', attr: 'onClick', has: 'openProjectNode(t.projectId, t.id)', why: 'a topic row inside a region — sized by the list' },
    { file: 'src/components/atlas/BridgeList.tsx', attr: 'className', has: 'min-w-0 text-left rounded-lg px-2 py-2 min-h-11', why: 'a bridge row: two titles side by side, each sized by its own text' },
    { file: 'src/components/atlas/MapControls.tsx', attr: 'aria-pressed', has: 'active === undefined ? undefined : active', why: 'a cell in the map control cluster — the divided panel owns the shape' },
    { file: 'src/components/creation/CreationRunParts.tsx', attr: 'onClick', has: 'toggleCollapse(node.key)', why: 'the fold chevron inside a live-structure tree row — the row owns the height' },
];

/** Utilities that SIZE a control, behind any variant prefix and an optional `!`. */
const SIZING = /^(?:[\w-]+:)*!?(?:h-(?!full$|auto$)[\w.[\]/-]+|min-h-[\w.[\]/-]+|size-[\w.[\]/-]+|px-[\w.[\]/-]+|py-[\w.[\]/-]+|p-[\w.[\]/-]+|text-(?:3xs|2xs|xs|sm|base|lg|xl|[2-9]xl)|rounded(?:-[\w.[\]/-]+)?)$/;
/** A solid accent fill: the primary action's paint. */
const PRIMARY_PAINT = (classes) => classes.includes('bg-accent') && classes.includes('text-white');

const RAW = new Set(['button', 'a']);
const PRIMITIVES = new Set(['Button', 'ButtonLink', 'IconButton', 'IconLink', 'Chip', 'TextInput', 'Select', 'SegmentedControl', 'Switch', 'Stepper', 'Slider']);

/**
 * Check one file. Returns its findings, the number of controls checked and the
 * LEGACY entries it used. Class names are read through the parser: a literal, a
 * template, both sides of a ternary, a cx() argument, a local string constant
 * (followed through its own templates and ternaries), and a `className` handed
 * in by a spread of a local object (`{...SESSION_TOOL}`).
 */
export function checkSource(src, rel) {
    const found = [];
    let count = 0;
    const usedLegacy = new Set();
    const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const strings = new Map(), objects = new Map();
    const unwrap = (e) => { while (e && (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression?.(e))) e = e.expression; return e; };
    const collectDecls = (n) => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
            const init = unwrap(n.initializer);
            if (ts.isObjectLiteralExpression(init)) objects.set(n.name.text, init);
            else strings.set(n.name.text, init);
        }
        ts.forEachChild(n, collectDecls);
    };
    collectDecls(sf);
    const classNamesOf = (expr, seen = new Set()) => {
        const out = [];
        const take = (n) => {
            if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
            else if (ts.isTemplateExpression(n)) { out.push(n.head.text); n.templateSpans.forEach(s => out.push(s.literal.text)); }
            else if (ts.isIdentifier(n) && strings.has(n.text) && !seen.has(n.text)
                && !(n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n)) {
                seen.add(n.text);
                out.push(...classNamesOf(strings.get(n.text), seen));
                return;
            }
            ts.forEachChild(n, take);
        };
        take(expr);
        return out.join(' ').split(/\s+/).filter(c => c && /^[!a-z[]/.test(c));
    };
    // The strings a `type` attribute can END UP as: the branches of a ternary and
    // the operands of ||/??/&&, never a string it is merely compared with
    // (`mode === 'password' ? 'text' : 'email'` is never a password field).
    const typeValues = (e) => {
        if (!e) return [];
        if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
        if (ts.isJsxExpression(e) || ts.isParenthesizedExpression(e)) return typeValues(e.expression);
        if (ts.isConditionalExpression(e)) return [...typeValues(e.whenTrue), ...typeValues(e.whenFalse)];
        if (ts.isBinaryExpression(e) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
            ts.SyntaxKind.AmpersandAmpersandToken].includes(e.operatorToken.kind)) {
            return [...typeValues(e.left), ...typeValues(e.right)];
        }
        return [];
    };
    const visit = (n) => {
        if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
            const tag = n.tagName.getText();
            // A secret field is `ui/PasswordInput` and nothing else: Edge draws its own
            // eye inside every type="password", so a field that adds a toggle beside it
            // showed TWO (the Connect dialog, 2026-10-17), and one that adds none shows
            // an eye on Edge and nothing on Chrome. One component, one eye, everywhere.
            // It reads the LITERAL form (type="password" / {'password'}); a type held in a
            // variable or spread in through props is not seen.
            if ((tag === 'input' || tag === 'TextInput') && n.attributes.properties.some(a =>
                ts.isJsxAttribute(a) && a.name.getText() === 'type' && a.initializer
                && typeValues(a.initializer).includes('password'))) {
                count++;
                found.push({ file: rel, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, tag, missing: 'ui/PasswordInput: a hand-made password field (Edge adds its own eye beside any toggle of ours)' });
            }
            const raw = RAW.has(tag);
            if (raw || PRIMITIVES.has(tag)) {
                const attrs = n.attributes.properties;
                const named = (name) => attrs.find(a => ts.isJsxAttribute(a) && a.name.getText() === name);
                const textOf = (a) => !a?.initializer ? '' : ts.isStringLiteral(a.initializer) ? a.initializer.text : a.initializer.getText();
                // className, from the attribute or from a spread of a local object.
                const sources = [];
                const cn = named('className');
                if (cn?.initializer) sources.push(cn.initializer);
                for (const a of attrs) {
                    if (!ts.isJsxSpreadAttribute(a) || !ts.isIdentifier(a.expression) || !objects.has(a.expression.text)) continue;
                    for (const p of objects.get(a.expression.text).properties)
                        if (ts.isPropertyAssignment(p) && p.name.getText() === 'className') sources.push(p.initializer);
                }
                const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
                let exempt = false;
                if (raw) {
                    const marker = MARKERS.find(m => {
                        const a = named(m.attr);
                        if (!a || (m.value && textOf(a) !== m.value)) return false;
                        return !m.files || m.files.includes(rel);
                    });
                    const strayMarker = !marker && MARKERS.find(m => m.files && named(m.attr) && !m.files.includes(rel));
                    if (strayMarker) found.push({ file: rel, line, tag, missing: `a reason: ${strayMarker.attr} is honoured in ${strayMarker.files.join(', ')} only` });
                    const legacy = LEGACY.find(l => l.file === rel && textOf(named(l.attr)).includes(l.has));
                    if (legacy) usedLegacy.add(legacy);
                    exempt = !!(marker || legacy);
                    if (exempt && !marker?.selectable && sources.length && PRIMARY_PAINT(sources.flatMap(s => classNamesOf(s)))) {
                        found.push({ file: rel, line, tag, missing: 'a real control: it is marked as a widget but painted as a primary action (bg-accent + text-white)' });
                    }
                }
                if (sources.length && !exempt) {
                    count++;
                    const sizing = sources.flatMap(s => classNamesOf(s))
                        .filter(c => SIZING.test(c))
                        // A primitive may still be told how to FLOW (w-full, flex-1,
                        // self-start, shrink-0) — that is layout, not shape.
                        .filter(c => raw || !/^rounded(-full)?$/.test(c));
                    if (sizing.length) found.push({ file: rel, line, tag, sizing });
                }
            }
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return { found, count, usedLegacy };
}

// --- The gate checks itself first: each case must fail or pass as stated.
const SELF = [
    { fails: true, why: 'a raw button that sizes itself', src: '<button className="px-4 py-2 rounded-lg">Go</button>' },
    { fails: true, why: '…with JSX inside an attribute (what the old regex skipped)', src: '<button title={<b>x</b>} className="h-10 px-3">Go</button>' },
    { fails: true, why: '…with an arrow function in an attribute', src: '<button onClick={() => go()} className="py-1 text-xs">Go</button>' },
    { fails: true, why: 'a primitive re-sized through className', src: '<Button icon={<Plus />} className="px-6 py-3">New</Button>' },
    { fails: true, why: 'a primitive re-sized through a spread', src: "const S = { size: 'sm', className: 'h-16 px-8' } as const;\nconst x = <Button {...S}>Go</Button>;" },
    { fails: true, why: 'a class constant on a primitive', src: "const WIDE = 'px-8 h-12';\nconst x = <Button className={WIDE}>Go</Button>;" },
    { fails: true, why: 'a constant built from another, inside a template', src: "const A = 'px-4 py-2';\nconst B = `${A} bg-accent`;\nconst x = <button className={B}>Go</button>;" },
    { fails: true, why: 'a ternary constant', src: "const C = big ? 'px-4' : 'px-3';\nconst x = <button className={C}>Go</button>;" },
    { fails: true, why: 'a 10px type size', src: '<button className="text-3xs">Go</button>' },
    { fails: true, why: 'an important or size- utility', src: '<button className="!px-4 size-10">Go</button>' },
    { fails: true, why: 'a file-bound marker outside its file', src: '<button data-dock className="h-8">x</button>' },
    { fails: true, why: 'a widget marker on a primary-painted button', src: '<button data-row="x" className="bg-accent text-white px-4">Go</button>' },
    { fails: true, why: 'a hand-made password field', src: '<TextInput type="password" value={v} />' },
    { fails: true, why: '…a raw one, or one whose type is an expression', src: '<input type={shown ? "text" : "password"} />' },
    { fails: true, why: '…or a fallback', src: '<input type={kind ?? `password`} />' },
    { fails: false, why: 'a text field', src: '<TextInput type="text" value={v} />' },
    { fails: false, why: 'a type only COMPARED with "password"', src: '<input type={mode === \'password\' ? \'text\' : \'email\'} />' },
    { fails: false, why: 'a marked row', src: '<button data-row="title" className="px-1 rounded">Title</button>' },
    { fails: false, why: 'a primitive told how to flow', src: '<Button className="w-full shrink-0 mt-4">Go</Button>' },
    { fails: false, why: 'a raw button with no shape of its own', src: '<button className="flex-1 text-left">Go</button>' },
];
const selfFailures = [];
for (const c of SELF) {
    const failed = checkSource(c.src, 'fixture.tsx').found.length > 0;
    if (failed !== c.fails) selfFailures.push(`${c.fails ? 'missed' : 'flagged'} ${c.why}`);
}

const files = [...new Set(SCOPE.flatMap(p => globSync(p, { cwd: ROOT })).map(f => path.join(ROOT, f)))];
const findings = selfFailures.map(s => ({ file: 'tools/control-gates.mjs', line: 1, tag: 'self-test', missing: s }));
/** Controls inspected — one assertion each, so `run-gates.mjs` can count them. */
let checked = SELF.length;
const usedLegacy = new Set();

for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    // `ui/` defines the vocabulary, so it is the one place allowed to spell it.
    if (rel.startsWith('src/components/ui/')) continue;
    const r = checkSource(src, rel);
    r.usedLegacy.forEach(l => usedLegacy.add(l));
    const pending = PENDING.find(p => p.file === rel);
    if (pending) {
        // A PENDING file is skipped, but not silently forever: once it no longer
        // needs the exemption, the exemption is the defect.
        checked++;
        if (!r.found.length) findings.push({ file: rel, line: 1, tag: 'PENDING', missing: `a reason to stay in PENDING: it now passes, so drop its line (${pending.why})` });
        continue;
    }
    checked += r.count;
    findings.push(...r.found);
}
// An exemption that matches nothing is one nobody can see.
// So is one naming a file the scope no longer holds (renamed, moved, deleted).
const inScope = new Set(files.map(f => path.relative(ROOT, f).replace(/\\/g, '/')));
for (const p of PENDING) {
    if (!inScope.has(p.file)) findings.push({ file: p.file, line: 1, tag: 'PENDING', missing: `a file in scope: none at this path, so drop its line (${p.why})` });
}
for (const l of LEGACY) {
    checked++;
    if (!inScope.has(l.file)) findings.push({ file: l.file, line: 1, tag: 'LEGACY', missing: 'a file in scope: none at this path, so drop the entry' });
    else if (!usedLegacy.has(l))
        findings.push({ file: l.file, line: 1, tag: 'LEGACY', missing: `the element its exemption names (${l.attr} containing "${l.has}"); drop the entry` });
}
// A run over nothing is not a pass: a wrong --root or a broken glob reads as green.
if (files.length < 50 || checked < 100) {
    findings.push({ file: ROOT, line: 1, tag: 'scope', missing: `a tree to check: ${files.length} files, ${checked} controls (is --root right?)` });
}

// The other half of the vocabulary's promise: a finger gets 44px where a mouse gets 32
// or 40 (`touch:min-h-11`, a media query and never a width). The app's own header is the
// one place that never came through `ui/` — its tab rail, back arrow and three icons
// were `px-2.5 py-1.5` and `p-1.5` — so it is held to the floor by name (UX-05/12).
// A padded square (no horizontal padding of its own) is an icon button and gets the width too.
const TOUCH_FLOOR = [
    { file: 'src/components/Layout.tsx', from: '<header', to: '</header>' },
    { file: 'src/components/SearchBar.tsx', from: 'export default function SearchBar', to: 'isOpen && createPortal' },
];
for (const { file, from, to } of TOUCH_FLOOR) {
    const whole = readFileSync(path.join(ROOT, file), 'utf8').replace(/=>/g, '=»');
    const start = whole.indexOf(from);
    const end = whole.indexOf(to, start);
    if (start < 0 || end < 0) { findings.push({ file, line: 1, tag: 'header', missing: `a "${from}" … "${to}" region to check` }); continue; }
    const re = /<button\b([\s\S]*?)>/g;
    const region = whole.slice(start, end);
    let bm;
    while ((bm = re.exec(region))) {
        const cn = /className=(?:"([^"]*)"|\{`([\s\S]*?)`\}|\{([^}]*)\})/.exec(bm[1]);
        const classes = cn ? (cn[1] || cn[2] || cn[3] || '') : '';
        checked++;
        const need = ['touch:min-h-11'];
        if (!/\bsm:px-|\bpx-/.test(classes)) need.push('touch:min-w-11');
        const missing = need.filter(n => !classes.includes(n));
        if (!missing.length) continue;
        const line = whole.slice(0, start + bm.index).split('\n').length;
        findings.push({ file, line, tag: 'button', missing: missing.join(' ') });
    }
}

// The Create dialog's submit row (UX-09). At 1440x707 the form pushed Create Empty /
// Create with AI below the fold of a dialog that scrolled as a whole; the first fix
// made the row sticky inside that scroll. Since 2026-10-02 the dialog is a column
// (`<Modal … fill>`): ONE scroll region for the form and the row AFTER it, outside it,
// so no length of form can carry the buttons away and there is no scrollbar in a
// scrollbar. Checked on the source's structure: the row holding "Create with AI" is a
// `shrink-0` sibling that starts once the `overflow-y-auto` region has closed.
{
    const dialog = readFileSync(path.join(ROOT, 'src/components/NewProjectModal.tsx'), 'utf8');
    const rel = 'src/components/NewProjectModal.tsx';
    const fail = (missing) => findings.push({ file: rel, line: 1, tag: 'div', missing });
    checked++;
    if (!/<Modal\b[^>]*\bfill\b/.test(dialog)) fail('`fill` on the dialog\'s Modal (the form lays itself out: one scroll region, a fixed foot)');
    // The region is the shared `ScrollShade` (a shade says there is more) or a plain
    // `overflow-y-auto` div; either way it must have CLOSED before the buttons.
    const shade = dialog.search(/<ScrollShade\b/);
    const scroll = shade >= 0 ? shade : dialog.search(/<div\b[^>]*className="[^"]*\boverflow-y-auto\b/);
    const create = dialog.search(/\{t\("Create with AI"\)\}/);
    checked++;
    if (scroll < 0 || create < 0) {
        fail('a scroll region (`ScrollShade` or `overflow-y-auto`) and the "Create with AI" button');
    } else {
        let closedAt = -1;
        if (shade >= 0) {
            const end = dialog.indexOf('</ScrollShade>', shade);
            if (end >= 0 && end < create) closedAt = end;
        } else {
            // Walk the divs from the region's opening tag to the button: the region
            // has to have closed (depth back to 0) before the button's row opens.
            let depth = 0;
            const tags = /<div\b[^>]*?(\/?)>|<\/div>/g;
            tags.lastIndex = scroll;
            for (let m; (m = tags.exec(dialog)) && m.index < create;) {
                if (m[0].startsWith('</')) depth--;
                else if (m[1] !== '/') depth++;
                if (depth === 0) { closedAt = m.index; break; }
            }
        }
        if (closedAt < 0) fail('the Create buttons OUTSIDE the scroll region (they are inside it, so a long form scrolls them away)');
        const rowOpen = dialog.slice(0, create).lastIndexOf('className={cx(');
        const rowCls = rowOpen >= 0 ? dialog.slice(rowOpen, dialog.indexOf(')}', rowOpen)) : '';
        checked++;
        if (!/\bshrink-0\b/.test(rowCls)) fail('shrink-0 on the Create dialog\'s action row (a fixed foot the scroll region cannot squeeze)');
    }
}

const json = process.argv.includes('--json');
if (json) {
    console.log(JSON.stringify({ scanned: files.length, findings }, null, 2));
} else {
    const C = { r: '\x1b[31m', g: '\x1b[32m', c: '\x1b[36m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
    console.log(`\n${C.b}Control vocabulary${C.x} ${C.d}(${files.length} files in scope)${C.x}\n`);
    if (!findings.length) {
        console.log(`  ${C.g}${checked} passed, 0 failed${C.x} ${C.d}· every control in scope takes its shape from src/components/ui/${C.x}\n`);
    } else {
        console.log(`  ${checked - findings.length} passed, ${findings.length} failed ${C.d}· a control in scope may not size itself${C.x}\n`);
        for (const f of findings) {
            if (f.missing) {
                console.log(`  ${C.r}missing${C.x} ${C.c}<${f.tag}>${C.x} has no ${f.missing}`);
                console.log(`        ${C.d}${f.file}:${f.line}${C.x}`);
                continue;
            }
            console.log(`  ${C.r}shape${C.x} ${C.c}<${f.tag}>${C.x} sets its own ${f.sizing.join(' ')}`);
            console.log(`        ${C.d}${f.file}:${f.line}${C.x}`);
            console.log(`        ${C.d}→ use <Button>/<IconButton>/<TextInput>/<Select>, or give it a kind in MARKERS${C.x}`);
        }
        console.log('');
    }
}

process.exit(findings.length ? 1 : 0);

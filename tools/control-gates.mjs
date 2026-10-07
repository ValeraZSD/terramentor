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
// A genuine widget (the settings tab rail, a theme preview card, an accent
// swatch, a listbox row) is not a button in this sense and is listed in
// BESPOKE with the reason. That list is the point: it is short, it is
// argued, and a sixth entry should be an argument, not a habit.
//
//   node tools/control-gates.mjs           # human report
//   node tools/control-gates.mjs --json
//
// Not committed (see .gitignore `tools/`).

import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// `new URL(import.meta.url).pathname` leaves the drive letter behind a slash and
// the spaces in "3 - work" percent-encoded, so the glob silently matched nothing
// and the gate reported a clean run over zero files.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
];

/**
 * Elements that are widgets rather than buttons, with the reason. Matched on a
 * distinctive substring of the opening tag.
 */
const BESPOKE = [
    { match: 'onClick={() => selectTab(t.id)}', why: 'the settings tab rail — a nav item, sized with the rail' },
    { match: 'onClick={() => setTheme(id)}', why: 'a theme preview card — the swatch IS the control' },
    { match: 'role="option"', why: 'a listbox row — sized by its list' },
    { match: 'data-row="phase"', why: 'a selectable row in a list — its height is its title, not the button scale' },
    // Covers SegmentedControl's segments, ColorField's swatches and IconPicker's
    // tiles: in all three the group owns the shape and the tile IS the value, so
    // there is no label to size. (The old 'aria-label={tr("{{label}} accent"'
    // entry matched nothing once the swatches moved out of Settings.tsx — a
    // BESPOKE line that matches nothing is an exemption nobody can see.)
    { match: 'role="radio"', why: 'a radio inside a radiogroup — the group owns the height' },
    // The New course dialog's drop zone: a dashed target two lines tall (what to
    // add, then the formats) that takes a drag as well as a press. No button size
    // is that shape, and it is the dialog's first step, not one control among many.
    { match: 'onClick={chooseFiles}', why: 'the course-material drop row — a dashed drop target sized by its line of text' },
    // The atlas's lists and its control cluster. Both are the documented shape of
    // exemption: a row's height is the title inside it, and the map's cluster is
    // one hairline-divided panel of 44px cells where the panel owns the shape and
    // a rounded control inside it would break the division.
    { match: 'aria-expanded={open}', why: 'a region row that expands — its height is its own title and bar' },
    { match: 'openProjectNode(t.projectId, t.id)', why: 'a topic row inside a region — sized by the list' },
    { match: 'min-w-0 text-left rounded-lg px-2 py-2 min-h-11', why: 'a bridge row: two titles side by side, each sized by its own text' },
    { match: 'aria-pressed={active === undefined ? undefined : active}', why: 'a cell in the map control cluster — the divided panel owns the shape' },
    { match: 'onClick={() => toggleCollapse(node.key)}', why: 'the fold chevron inside a live-structure tree row — the row owns the height' },
    // The New project dialog's file target (creation/SourceFiles.tsx): a dashed
    // panel holding two lines of text, a place to drop files on more than a
    // button, so its height is its text and its radius a panel's.
    { match: 'onDragOver={e => { e.preventDefault(); setDragOver(true); }}', why: 'a file drop target — a dashed panel sized by its two lines of text' },
    // The study-time readings: a day's bar IS its value (its height is the
    // time), and a topic's row is a line of a list, sized by its own text.
    { match: 'data-bar="study-day"', why: 'a day in a bar chart — the bar is the value, the chart owns the height' },
    { match: 'data-row="study-time"', why: 'a topic row in a list of times — its height is its title' },
    // The assistant's attachments (components/attachments/): the ✕ on a 64px
    // thumbnail is a 24px circle on its corner — the shape all five big chat
    // apps use — with a 44px hit area from an inset pseudo-element; and a sent
    // file is a link sized by what it shows (a picture's height, a file card).
    { match: 'data-chip-remove', why: 'the ✕ on a thumbnail chip — a 24px circle whose hit area is widened past what it paints' },
    { match: 'data-attachment-link', why: 'a sent file as its picture or its card — sized by the file it shows' },
];

/** Utilities that SIZE a control. A raw button in scope may carry none of them. */
const SIZING = /^(?:can-hover:|touch:|sm:|md:|lg:|dark:|group-hover:|focus-visible:|active:|disabled:)*(?:h-(?!full|auto)[\w.[\]/-]+|min-h-[\w.[\]/-]+|px-[\w.[\]/-]+|py-[\w.[\]/-]+|p-[\w.[\]/-]+|text-(?:xs|sm|base|lg|xl)|rounded(?:-[\w.[\]/-]+)?)$/;

const files = SCOPE.flatMap(p => globSync(p, { cwd: ROOT })).map(f => path.join(ROOT, f));
const findings = [];
/** Controls inspected — one assertion each, so `run-gates.mjs` can count them. */
let checked = 0;

for (const file of [...new Set(files)]) {
    // An arrow function inside an attribute (`onChange={e => …}`) ends a naive
    // "up to the first >" tag match, so the scan saw a headless tag with no
    // className and skipped it — which made the gate silently check a fraction
    // of what it claimed. Blind the arrows first; offsets are unchanged, so the
    // reported line numbers stay right.
    const src = readFileSync(file, 'utf8').replace(/=>/g, '=»');
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    // `ui/` defines the vocabulary, so it is the one place allowed to spell it.
    if (rel.startsWith('src/components/ui/')) continue;

    const re = /<(button|a)\b([\s\S]*?)>/g;
    let m;
    while ((m = re.exec(src))) {
        const [, tag, attrs] = m;
        if (attrs.includes('<')) continue;                  // ran past the tag
        if (tag === 'a' && !/className=/.test(attrs)) continue;
        // `attrs` has had its arrows blinded, so blind the needles too.
        if (BESPOKE.some(b => attrs.includes(b.match.replace(/=>/g, '=»')))) continue;

        const cn = /className=(?:"([^"]*)"|\{`([\s\S]*?)`\}|\{([^}]*)\})/.exec(attrs);
        if (!cn) continue;
        checked++;
        const classes = (cn[1] || cn[2] || cn[3] || '')
            .split(/[\s'"`]+/)
            .filter(c => c && /^[a-z[]/.test(c));
        const sizing = classes.filter(c => SIZING.test(c));
        if (!sizing.length) continue;

        const line = src.slice(0, m.index).split('\n').length;
        findings.push({ file: rel, line, tag, sizing });
    }

    // The other half of the drift: a primitive is used, but the call site
    // over-rides its shape through `className`. `<Button className="h-8 px-2">`
    // is the same defect as a raw button, one layer further in.
    const PRIMITIVE = /<(Button|ButtonLink|IconButton|TextInput|Select|SegmentedControl|Switch|Stepper|Slider)\b([\s\S]*?)\/?>/g;
    let pm;
    while ((pm = PRIMITIVE.exec(src))) {
        const [, tag, attrs] = pm;
        if (attrs.includes('<')) continue;
        const cn = /className=(?:"([^"]*)"|\{`([\s\S]*?)`\}|\{([^}]*)\})/.exec(attrs);
        if (!cn) continue;
        checked++;
        const sizing = (cn[1] || cn[2] || cn[3] || '')
            .split(/[\s'"`]+/)
            .filter(c => c && /^[a-z[]/.test(c))
            // A primitive may still be told how to FLOW (w-full, flex-1, self-start,
            // shrink-0) — that is layout, not shape.
            .filter(c => SIZING.test(c) && !/^rounded(-full)?$/.test(c));
        if (!sizing.length) continue;
        const line = src.slice(0, pm.index).split('\n').length;
        findings.push({ file: rel, line, tag, sizing });
    }
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
            console.log(`        ${C.d}→ use <Button>/<IconButton>/<TextInput>/<Select>, or argue it into BESPOKE${C.x}`);
        }
        console.log('');
    }
}

process.exit(findings.length ? 1 : 0);

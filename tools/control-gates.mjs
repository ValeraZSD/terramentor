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
    // The atlas's lists and its control cluster. Both are the documented shape of
    // exemption: a row's height is the title inside it, and the map's cluster is
    // one hairline-divided panel of 44px cells where the panel owns the shape and
    // a rounded control inside it would break the division.
    { match: 'aria-expanded={open}', why: 'a region row that expands — its height is its own title and bar' },
    { match: 'openProjectNode(t.projectId, t.id)', why: 'a topic row inside a region — sized by the list' },
    { match: 'min-w-0 text-left rounded-lg px-2 py-2 min-h-11', why: 'a bridge row: two titles side by side, each sized by its own text' },
    { match: 'aria-pressed={active === undefined ? undefined : active}', why: 'a cell in the map control cluster — the divided panel owns the shape' },
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
            console.log(`  ${C.r}shape${C.x} ${C.c}<${f.tag}>${C.x} sets its own ${f.sizing.join(' ')}`);
            console.log(`        ${C.d}${f.file}:${f.line}${C.x}`);
            console.log(`        ${C.d}→ use <Button>/<IconButton>/<TextInput>/<Select>, or argue it into BESPOKE${C.x}`);
        }
        console.log('');
    }
}

process.exit(findings.length ? 1 : 0);

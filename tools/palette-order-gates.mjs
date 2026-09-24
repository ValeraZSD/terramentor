#!/usr/bin/env node
// palette-order-gates.mjs — three colour rows on one card, and they are the
// same sixteen colours read at three rungs.
//
// Settings → Appearance asks three colour questions in a column: what colour
// the PAGE is, what the ACCENT is, and what the app ICON's tile is. Each had
// its own list, written at its own time, in its own order — so a reader moving
// down the card found amber in the eleventh slot, then the twelfth, then not at
// all, and three grids that plainly were not the same family.
//
// The fix is not a shared constant (they are genuinely different colours: a
// tint is a pastel, an accent carries white label text at 700, a tile is read
// at 16px and is 900). It is a shared ORDER and shared NAMES, which is exactly
// the kind of sameness no per-list check can see. Hence this file, like
// `control-gates.mjs` and the sameness half of `color-gates.mjs`.
//
// The names are read off the comment beside each hex, which is also what makes
// them maintainable: the comment is the assertion.
//
//   node tools/palette-order-gates.mjs
//   node tools/palette-order-gates.mjs --json

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const findings = [];
let checked = 0;
const ok = (name, cond, detail) => { checked++; if (!cond) findings.push({ name, detail }); };

/** Every `'#rrggbb', // Name` line inside one array literal, in order. */
function palette(src, name) {
    const body = new RegExp(`(?:export )?const ${name} = \\[([\\s\\S]*?)\\n\\];`).exec(src)?.[1];
    if (!body) return null;
    return [...body.matchAll(/'(#[0-9a-f]{6})',\s*\/\/\s*([A-Za-z]+)/g)]
        .map((m) => ({ hex: m[1], name: m[2] }));
}

const FIELD = read('src/components/ui/ColorField.tsx');
const ICON = read('src/components/settings/AppIconPanel.tsx');

const LISTS = [
    ['THEME_TINTS', palette(FIELD, 'THEME_TINTS')],
    ['ACCENT_COLORS', palette(FIELD, 'ACCENT_COLORS')],
    ['ICON_BACKGROUNDS', palette(ICON, 'ICON_BACKGROUNDS')],
];

for (const [name, list] of LISTS) {
    ok(`${name} is readable, with a name beside every swatch`,
        !!list && list.length === 16,
        list ? `found ${list.length} named swatches, expected 16` : 'array literal not found');
}

if (LISTS.every(([, l]) => l && l.length === 16)) {
    const [tints, accents, tiles] = LISTS.map(([, l]) => l);
    const names = (l) => l.map((x) => x.name).join(' · ');

    ok('the accent row and the tint row are the same sixteen names, in order',
        names(tints) === names(accents),
        `tints:   ${names(tints)}\n        accents: ${names(accents)}`);
    ok('the icon row is too',
        names(tints) === names(tiles),
        `tints: ${names(tints)}\n        tiles: ${names(tiles)}`);

    // The last two slots are the achromatic pair, in both senses: they are what
    // a reader reaches for when they want NO colour, and they are the only two
    // that differ in kind between the lists (an accent cannot be white — see
    // `color-gates.mjs` — so its pale end is the lightest grey that still
    // carries white text).
    ok('the achromatic pair is last, and in the same two places in all three',
        tints.slice(14).map((x) => x.name).join() === 'Ink,Paper'
        && accents.slice(14).map((x) => x.name).join() === 'Ink,Paper'
        && tiles.slice(14).map((x) => x.name).join() === 'Ink,Paper',
        `${tints.slice(14).map(x => x.name)} / ${accents.slice(14).map(x => x.name)} / ${tiles.slice(14).map(x => x.name)}`);

    for (const [name, list] of LISTS) {
        ok(`${name} holds no duplicate`,
            new Set(list.map((x) => x.hex)).size === 16,
            'two identical chips are two ways to pick one colour');
        ok(`${name} is lowercase hex`,
            list.every((x) => x.hex === x.hex.toLowerCase()),
            list.filter((x) => x.hex !== x.hex.toLowerCase()).map((x) => x.hex).join(' '));
    }

    // …and the three are drawn at DIFFERENT rungs, which is the other half of
    // the design: if two lists ever converge on the same values, one of them has
    // stopped doing its job.
    const same = tints.filter((t, i) => t.hex === accents[i].hex && t.name !== 'Ink' && t.name !== 'Paper');
    ok('a tint and an accent of the same name are not the same colour',
        same.length === 0,
        `${same.map((x) => x.name).join(' ')} are identical in both lists — a page is not a button`);
}

// ONE COMPONENT DRAWS ALL THREE. The rule this file is about only holds if the
// rows are also the same SHAPE, and that is `ColorField`'s job, not a
// coincidence of three call sites.
ok('all three rows are the one ColorField',
    /THEME_TINTS/.test(read('src/components/Settings.tsx'))
    && /ACCENT_COLORS/.test(read('src/components/Settings.tsx'))
    && /<ColorField/.test(ICON),
    'a hand-written swatch grid beside two ColorFields is how one of them becomes the bad one');

// ---------------------------------------------------------------------------
// AND THE WORDS FOR THEM. The assistant can be asked for an accent by name, and
// the model is handed that list of names in its prompt. Both are mirrors of
// `ACCENT_COLORS` and both had drifted away from it: the validator held fourteen
// entries including `cyan` and `slate`, which the picker has no swatch for, and
// neither it nor the prompt knew `sky` or `fuchsia`, which it does. Asking for a
// sky accent returned null — no chip, no change — straight after a model told to
// say what it had changed.
//
// The names come off the comment beside each hex, which `palette()` already
// reads, so there is nothing to keep in step by hand.
{
    const accents = palette(FIELD, 'ACCENT_COLORS');
    const table = read('src/utils/assistantSettings.ts');
    const body = /const ACCENT_NAMES: Record<string, string> = \{([\s\S]*?)\n\};/.exec(table)?.[1] || '';
    const named = new Map([...body.matchAll(/(\w+):\s*'(#[0-9a-fA-F]{6})'/g)]
        .map((m) => [m[1].toLowerCase(), m[2].toLowerCase()]));
    ok('the assistant names every accent the picker draws, and no others',
        accents && named.size === accents.length
        && accents.every((a) => named.get(a.name.toLowerCase()) === a.hex.toLowerCase()),
        `picker: ${accents?.map((a) => a.name.toLowerCase()).join(' · ')} | assistant: ${[...named.keys()].join(' · ')}`);

    // The prompt is the model's whole view of what it may ask for. A name the
    // validator accepts but the prompt never mentions is a setting the learner
    // can only reach by guessing; one the prompt offers and the validator
    // refuses is the silence above.
    const prompt = read('server/ai.js');
    const line = /- accent_color — a colour name \(([^)]*)\)/.exec(prompt)?.[1] || '';
    const offered = line.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    ok('the prompt offers exactly the names the validator accepts',
        offered.length === named.size && offered.every((n) => named.has(n)),
        `prompt: ${offered.join(' · ')}`);
}

// ---------------------------------------------------------------------------
const json = process.argv.includes('--json');
if (json) {
    console.log(JSON.stringify({ checked, findings }, null, 2));
} else {
    const C = { r: '\x1b[31m', g: '\x1b[32m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
    console.log(`\n${C.b}The three palettes${C.x} ${C.d}(one order, three rungs)${C.x}\n`);
    if (!findings.length) {
        console.log(`  ${C.g}${checked} passed, 0 failed${C.x}\n`);
    } else {
        console.log(`  ${checked - findings.length} passed, ${C.r}${findings.length} failed${C.x}\n`);
        for (const f of findings) console.log(`  ${C.r}fail${C.x} ${f.name}\n        ${C.d}${f.detail}${C.x}`);
        console.log('');
    }
}
process.exit(findings.length ? 1 : 0);

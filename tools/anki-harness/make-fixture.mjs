// Builds a small but REAL .apkg (schema 18, zstd, protobuf media index) so the
// redesigned import preview can be driven end to end in a browser. Same shape
// as a real vocabulary deck: a term/reading/meaning/sentence
// note type carrying a picture and two clips per note.
//
// Usage: node temp/anki-harness/make-fixture.mjs <out.apkg>

import { createRequire } from 'node:module';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zstdCompressSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const JSZip = require('jszip');

const out = process.argv[2] || 'fixture.apkg';
const SEP = '\x1f';
const scratch = mkdtempSync(join(tmpdir(), 'anki-fixture-'));
const dbPath = join(scratch, 'c18.sqlite');

const c = new Database(dbPath);
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
`);
c.prepare("INSERT INTO col (id, ver, models, decks, conf, dconf, tags) VALUES (1, 18, '', '', '{}', '{}', '{}')").run();
c.prepare('INSERT INTO notetypes (id, name, config) VALUES (?,?,?)').run(200, 'Japanese vocab', Buffer.from([0x08, 0x00]));
const FIELDS = ['Word', 'Word Reading', 'Word Meaning', 'Sentence', 'Sentence Meaning', 'Word Audio', 'Sentence Audio', 'Picture'];
const insF = c.prepare('INSERT INTO fields (ntid, ord, name, config) VALUES (?,?,?,?)');
FIELDS.forEach((f, i) => insF.run(200, i, f, Buffer.from([])));
c.prepare('INSERT INTO decks (id, name, common, kind) VALUES (?,?,?,?)').run(5, 'Core 2k', Buffer.from([]), Buffer.from([]));

const NOTES = [
    ['早い', 'はやい', 'early', '今朝、5時に起きました。', 'I woke up at 5 A.M. this morning.'],
    ['振る', 'ふる', 'wave, shake', '犬がしっぽを振っている。', 'The dog is wagging its tail.'],
    ['解く', 'とく', 'to solve', 'この問題を解けますか。', 'Can you solve this problem?'],
];
const ins = c.prepare('INSERT INTO notes (id, guid, mid, tags, flds, sfld) VALUES (?,?,?,?,?,?)');
const insC = c.prepare('INSERT INTO cards (id, nid, did, ord, ivl, factor, reps, lapses, due, type, queue) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
NOTES.forEach((n, i) => {
    const flds = [...n, `[sound:word${i}.mp3]`, `[sound:sentence${i}.mp3]`, `<img src="pic${i}.png">`].join(SEP);
    ins.run(i + 1, `g${i}`, 200, '', flds, n[0]);
    insC.run(i + 1, i + 1, 5, 0, 0, 0, 0, 0, i + 3, 0, 0);
});
c.close();

// A 1x1 PNG and a tiny (silent, technically truncated) MP3 — enough for the
// importer to sniff a type and for the page to draw a control.
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c6360000002000100ffff03000006000557bfabd4' +
    '0000000049454e44ae426082', 'hex');
const MP3 = Buffer.concat([Buffer.from('fffb90640000000000000000', 'hex'), Buffer.alloc(256)]);

// The current media index: MediaEntries{ repeated MediaEntry{ name=1 } }, zstd.
function varint(n) { const b = []; while (n > 127) { b.push((n & 127) | 128); n >>>= 7; } b.push(n); return Buffer.from(b); }
function entry(name) {
    const nm = Buffer.from(name, 'utf8');
    const body = Buffer.concat([Buffer.from([0x0a]), varint(nm.length), nm]);
    return Buffer.concat([Buffer.from([0x0a]), varint(body.length), body]);
}
const names = [];
for (let i = 0; i < NOTES.length; i++) names.push(`pic${i}.png`, `word${i}.mp3`, `sentence${i}.mp3`);
const index = zstdCompressSync(Buffer.concat(names.map(entry)));

const zip = new JSZip();
zip.file('collection.anki21b', zstdCompressSync(readFileSync(dbPath)));
zip.file('media', index);
names.forEach((n, i) => zip.file(String(i), zstdCompressSync(n.endsWith('.png') ? PNG : MP3)));
const buf = await zip.generateAsync({ type: 'nodebuffer' });
writeFileSync(out, buf);
console.log(`wrote ${out} (${buf.length} bytes, ${NOTES.length} notes, ${names.length} media files)`);

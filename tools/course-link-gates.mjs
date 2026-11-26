// tools/course-link-gates.mjs — checks a course survives the trip through a link.
//
// Run:  node tools/course-link-gates.mjs
//
// A course link (`src/utils/courseLink.ts`) carries a whole course file after
// `#course=`, packed with the browser's deflate. What is asserted here:
//
//   1. a course comes back from its link exactly as it went in;
//   2. the packing is plain deflate-raw and base64url, checked against Node's
//      own zlib in BOTH directions, so a link made here opens anywhere that
//      speaks the format and nothing private to this module leaks into it;
//   3. the link is found inside what people actually paste: a whole address,
//      the part after `#`, a link a messaging app broke over lines;
//   4. a damaged, cut-short, foreign or newer link is refused with its reason,
//      never half-read;
//   5. a small link that would unpack to gigabytes stops at the cap.
//
// Bundles the real TypeScript module with esbuild, like `srs-gates.mjs`, so
// this tests the shipped code rather than a copy of it.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const scratch = mkdtempSync(join(tmpdir(), 'course-link-gates-'));
const out = join(scratch, 'courseLink.mjs');
await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/utils/courseLink.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    logLevel: 'silent',
});
const link = await import(pathToFileURL(out).href);
const { packCourse, unpackCourse, packedCourseIn, courseFromText, courseLinkFor, CourseLinkError, MAX_COURSE_BYTES } = link;

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
/** The `problem` an unpack is refused with, or 'ok' when it was read. */
const refusalOf = async (packed) => {
    try { await unpackCourse(packed); return 'ok'; }
    catch (e) { return e instanceof CourseLinkError ? e.problem : `threw ${e?.name}: ${e?.message}`; }
};
const b64url = (buf) => Buffer.from(buf).toString('base64url');

// A word course the size of a real one: seven phases of three topics, eight
// cards and ten questions each, with accents and right-to-left text in it so
// the UTF-8 round trip is exercised.
const word = (p, t, i) => `woord-${p}-${t}-${i} één ü مرحبا`;
const course = {
    project: { name: 'Zakelijke woorden (B1)', description: 'Woorden voor een plan.', color: '#1F4E79', icon: 'briefcase', content_language: 'nl', version: '2026-11', new_per_day: 20 },
    nodes: Array.from({ length: 7 }, (_, p) => ({
        title: `Fase ${p + 1}`,
        children: Array.from({ length: 3 }, (_, t) => ({
            title: `Onderwerp ${p + 1}.${t + 1}`,
            description: 'Lees de woorden en de voorbeeldzin.',
            flashcards: Array.from({ length: 8 }, (_, i) => ({ front: word(p, t, i), back: `Betekenis ${i}`, extra: `Voorbeeld: Ik gebruik ${word(p, t, i)}.` })),
            questions: Array.from({ length: 10 }, (_, i) => i % 2
                ? { type: 'fill_in', question: `Vul in: Ik heb ___ (${i}).`, correct_answer: word(p, t, i), explanation: 'Zie de kaart.' }
                : { type: 'multiple_choice', question: `Welk woord past (${i})?`, options: [word(p, t, i), 'a', 'b', 'c'], correct_answer: word(p, t, i), explanation: '' }),
        })),
    })),
};
const json = JSON.stringify(course);

console.log('1. round trip');
const packed = await packCourse(course);
check('packs to the 1. format', packed.startsWith('1.'), packed.slice(0, 10));
// A gate must not crash on the code it is testing: a throw is a FAIL, not an exit.
const back = await unpackCourse(packed).catch(e => e);
check('the course comes back unchanged', isDeepStrictEqual(back, course), back instanceof Error ? back.message : '');
check('the link is much smaller than the file', packed.length < json.length / 3, `${packed.length} chars for ${json.length} bytes`);

console.log('2. plain deflate-raw + base64url, both directions');
const ours = Buffer.from(packed.slice(2), 'base64url');
let zlibRead = null;
try { zlibRead = JSON.parse(inflateRawSync(ours).toString('utf8')); } catch (e) { zlibRead = e; }
check("Node's zlib reads our link", isDeepStrictEqual(zlibRead, course));
const theirs = '1.' + b64url(deflateRawSync(Buffer.from(json, 'utf8'), { level: 9 }));
check("our reader opens a link Node's zlib made", isDeepStrictEqual(await unpackCourse(theirs), course));
check('no padding or URL-unsafe characters in the data', /^[A-Za-z0-9_-]+$/.test(packed.slice(2)));

console.log('3. finding the link in what is pasted');
const full = courseLinkFor('https://example.test/study/#old', String(packed));
check('courseLinkFor replaces an old # part', full.startsWith('https://example.test/study/#course=1.') && !full.includes('#old'));
check('found in a whole link', packedCourseIn(full) === packed);
check('found in the part after #', packedCourseIn(`#course=${packed}`) === packed);
check('found among other # fields', packedCourseIn(`https://x.test/#lang=nl&course=${packed}&v=2`) === packed);
const wrapped = full.replace(/(.{70})/g, '$1\n ');
check('found in a link broken over lines with spaces', packedCourseIn(wrapped) === packed);
check('a device-pairing link is not a course', packedCourseIn('https://x.test/#pair=abcdefghijklmnopqrstu') === null);
check('plain text is not a course', packedCourseIn('see you tomorrow') === null);
check('"discourse=" is not "course="', packedCourseIn('https://x.test/#discourse=1.abc') === null);

console.log('4. refusals, each with its reason');
check('cut short by a messaging app → damaged', await refusalOf(packed.slice(0, Math.floor(packed.length * 0.6))) === 'damaged');
check('a character outside base64url → damaged', await refusalOf(packed.slice(0, 40) + '%' + packed.slice(41)) === 'damaged');
check('random bytes → damaged', await refusalOf('1.' + b64url(Buffer.from('not deflate at all, just text'))) === 'damaged');
check('a later format → newer-format', await refusalOf('2.' + packed.slice(2)) === 'newer-format');
check('no format → not-a-link', await refusalOf(packed.slice(2)) === 'not-a-link');
check('JSON that is no course → not-a-course', await refusalOf('1.' + b64url(deflateRawSync(Buffer.from('{"a":1}')))) === 'not-a-course');
check('a course with no name → not-a-course', await refusalOf('1.' + b64url(deflateRawSync(Buffer.from('{"project":{"name":" "},"nodes":[]}')))) === 'not-a-course');
// A course whose name holds a byte that is not UTF-8: read leniently it would
// import as "a�b", a name nobody wrote.
const badUtf8 = Buffer.concat([Buffer.from('{"project":{"name":"a'), Buffer.from([0xff]), Buffer.from('b"},"nodes":[]}')]);
check('a course that is not UTF-8 → damaged', await refusalOf('1.' + b64url(deflateRawSync(badUtf8))) === 'damaged');
let packRefusal = 'packed';
try { await packCourse({ nodes: [] }); } catch (e) { packRefusal = e?.problem; }
check('packing something that is no course is refused', packRefusal === 'not-a-course');

console.log('5. a link that unpacks to gigabytes stops at the cap');
// 64 MB of one repeated byte packs to ~64 KB: eight times the cap once unpacked.
const bomb = '1.' + b64url(deflateRawSync(Buffer.alloc(64 * 1024 * 1024, 0x20), { level: 9 }));
const started = Date.now();
check('refused as too-large', await refusalOf(bomb) === 'too-large');
// Generous: gates run side by side, and unpacking all 64 MB would still take far longer.
check('refused without unpacking it all (under 10 s)', Date.now() - started < 10000, `${Date.now() - started} ms`);
// The edge of the cap, with a real course on both sides of it.
const courseOfSize = (bytes) => {
    const shell = JSON.stringify({ project: { name: 'Big', description: '' }, nodes: [] });
    return JSON.stringify({ project: { name: 'Big', description: 'x'.repeat(bytes - shell.length) }, nodes: [] });
};
const packOf = (text) => '1.' + b64url(deflateRawSync(Buffer.from(text, 'utf8'), { level: 9 }));
check('a course 1 KB under the cap is read', await refusalOf(packOf(courseOfSize(MAX_COURSE_BYTES - 1024))) === 'ok');
check('a course 1 KB over the cap → too-large', await refusalOf(packOf(courseOfSize(MAX_COURSE_BYTES + 1024))) === 'too-large');

console.log('6. a link with other text around it');
/** The course name read from pasted text, or the refusal. */
const fromText = async (text) => {
    try { return (await courseFromText(text)).project.name; }
    catch (e) { return e instanceof CourseLinkError ? e.problem : `threw ${e?.name}: ${e?.message}`; }
};
const name = course.project.name;
check('text on the next line after the link', await fromText(`Here it is:\n${full}\nthanks!`) === name);
check('a word after the link on the same line', await fromText(`${full} thanks`) === name);
check('a sentence that ends on the link', await fromText(`Open ${full}.`) === name);
check('a link in angle brackets', await fromText(`<${full}>`) === name);
check('a link wrapped over lines, then a word', await fromText(`${wrapped}\nbye`) === name);
check('an escaped "=" after course (%3D)', await fromText(full.replace('#course=', '#course%3D')) === name);
check('base64 padding at the end', await fromText(`${full}==`) === name);
check('cut short is still damaged with text after it', await fromText(`${full.slice(0, Math.floor(full.length * 0.6))}\nthanks`) === 'damaged');
check('no link in the text → not-a-link', await fromText('see you tomorrow') === 'not-a-link');

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

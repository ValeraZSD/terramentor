// tools/lean-start-gates.mjs — what a start loads, and what a package ships.
//
// Run:  node tools/lean-start-gates.mjs
//
// Two halves of one question: how much the app costs before anyone uses it.
//
// 1. A start loads no document parser. mammoth and ExcelJS run only in the
//    office child process, and pdf-parse only when a PDF is added; imported at
//    the top, the three cost about 0.5 s of CPU and 50 MB of memory on every
//    launch, for a file nobody had added. Checked by loading the app's module
//    graph in a child process with a resolve hook that records every module,
//    then by reading a PDF, a docx and an xlsx through the server's functions.
//
// 2. The desktop package leaves out what nothing runs: source maps, type
//    declarations, readmes and better-sqlite3's C sources (about 68 MB of the
//    1.6.0 nightly's 210 MB node_modules), and keeps every licence. The rule is
//    tools/lib/packageStrip.mjs; the build imports every package the code names
//    from the stripped copy, since a plain start does not reach the parsers.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { strippable } from './lib/packageStrip.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
    if (ok) { passed++; console.log(`  ok    ${name}`); }
    else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const PARSERS = ['mammoth', 'exceljs', 'pdf-parse'];
const loadedIn = (urls, pkg) => urls.some((u) => u.includes(`/node_modules/${pkg}/`));

console.log('\n[a start loads no document parser]');
{
    // The module graph of the server (app.js, as the gates link-test it) and of
    // the module that holds the parsers, with every resolved URL recorded.
    const script = `
import { registerHooks } from 'node:module';
const seen = [];
registerHooks({ resolve(spec, ctx, next) { const r = next(spec, ctx); seen.push(r.url); return r; } });
await import(process.argv[1]);
console.log(JSON.stringify(seen));`;
    const scratch = mkdtempSync(join(tmpdir(), 'lean-start-'));
    for (const entry of ['server/app.js', 'server/extract.js']) {
        const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, pathToFileURL(join(root, entry)).href], {
            cwd: root, encoding: 'utf8', timeout: 120_000,
            env: {
                ...process.env,
                DB_PATH: join(scratch, 'terramentor.db'),
                VAULT_ROOT: join(scratch, 'vault'),
                SECRETS_PATH: join(scratch, 'terramentor.secrets.json'),
            },
        });
        let urls = [];
        try { urls = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { /* reported below */ }
        check(`${entry} loads (${urls.length} modules)`, r.status === 0 && urls.length > 0, (r.stderr || '').slice(0, 300));
        for (const p of PARSERS) check(`  ...without ${p}`, urls.length > 0 && !loadedIn(urls, p));
    }
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

console.log('\n[the parsers still read on first use]');
{
    const { extractText, parseOffice } = await import('../server/extract.js');

    // A one-page PDF with real text, written by hand with correct offsets.
    const objs = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        null,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    const stream = 'BT /F1 18 Tf 20 80 Td (Photosynthesis needs light) Tj ET';
    objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    let pdf = '%PDF-1.4\n';
    const offsets = [];
    objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const read = await extractText(Buffer.from(pdf, 'latin1'), 'notes.pdf').then((r) => r, (e) => ({ text: `error: ${e.message}` }));
    check('a PDF is read (pdf-parse loaded on first use)', /Photosynthesis needs light/.test(read.text), read.text.slice(0, 120));
    check('...with its page count', read.meta?.pageCount === 1, JSON.stringify(read.meta));

    const JSZip = require('jszip');
    const docx = new JSZip();
    docx.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    docx.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    docx.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Cells divide by mitosis</w:t></w:r></w:p></w:body></w:document>');
    const docxText = await parseOffice('docx', await docx.generateAsync({ type: 'nodebuffer' })).then((r) => r.text, (e) => `error: ${e.message}`);
    check('a docx is read (mammoth loaded on first use)', /Cells divide by mitosis/.test(docxText), docxText.slice(0, 120));

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Terms').addRow(['osmosis', 'water across a membrane']);
    const xlsx = await parseOffice('xlsx', Buffer.from(await wb.xlsx.writeBuffer())).then((r) => r, (e) => ({ text: `error: ${e.message}` }));
    check('an xlsx is read (ExcelJS loaded on first use)', /osmosis \| water across a membrane/.test(xlsx.text), xlsx.text.slice(0, 120));
    check('...with its sheet names', JSON.stringify(xlsx.meta?.sheetNames) === '["Terms"]', JSON.stringify(xlsx.meta));
}

console.log('\n[what the desktop package leaves out]');
{
    const out = [
        'pdfjs-dist/legacy/build/pdf.mjs.map',
        'exceljs/dist/exceljs.min.js.map',
        'zod/v4/core/schemas.d.ts',
        '@modelcontextprotocol/server/dist/index.d.mts',
        '@modelcontextprotocol/core/dist/index.d.cts',
        'undici/README.md',
        'exceljs/CHANGELOG.MD',
        'better-sqlite3/deps/sqlite3/sqlite3.c',
        'better-sqlite3/deps/sqlite3.gyp',
        'better-sqlite3/src/better_sqlite3.cpp',
    ];
    const kept = [
        'better-sqlite3/build/Release/better_sqlite3.node',
        'better-sqlite3/lib/index.js',
        'better-sqlite3/package.json',
        'better-sqlite3/LICENSE',
        'pdfjs-dist/legacy/build/pdf.mjs',
        'pdfjs-dist/cmaps/Adobe-Japan1-UCS2.bcmap',
        'pdfjs-dist/standard_fonts/FoxitSans.pfb',
        'tesseract.js-core/tesseract-core.wasm',
        '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
        'some-pkg/LICENSE.md',
        'some-pkg/license.markdown',
        'some-pkg/NOTICE.md',
        'some-pkg/COPYING.md',
        'some-pkg/AUTHORS.md',
        'typescript-ish/lib/types.ts',
        'pkg/index.mts',
        'pkg/maps.js',
        'pkg/sourcemap/index.js',
    ];
    for (const p of out) check(`drops ${p}`, strippable(p) === true);
    for (const p of kept) check(`keeps ${p}`, strippable(p) === false);

    const build = readFileSync(join(root, 'tools', 'build-desktop.mjs'), 'utf8');
    const pruneAt = build.indexOf("run('npm', ['prune'");
    const stripAt = build.indexOf('stripNodeModules(join(appDir');
    const listAt = build.indexOf("writeFileSync(join(appDir, 'files.json')");
    check('the build strips after the prune and before the file list', pruneAt > 0 && stripAt > pruneAt && listAt > stripAt);
    const importAt = build.indexOf('await import(s)');
    const checkAt = build.indexOf("'desktop/launcher.js', '--check'");
    check('the build imports every package the code names from the stripped copy',
        importAt > stripAt && /serverSpecifiers/.test(build.slice(importAt - 600, importAt)) && /cwd: appDir/.test(build.slice(importAt, importAt + 500)) && checkAt > 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

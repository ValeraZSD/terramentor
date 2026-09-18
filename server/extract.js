// Turn an uploaded file's bytes into the plain text/tables that feed RAG.
//
// Philosophy: we don't keep a narrow allowlist of "blessed" file types. A
// self-directed learner's reference material is anything — a .sql schema, a
// PowerShell/.bat script for a cybersecurity course, a .py source file, a
// config, a log. So the policy is permissive-but-verified:
//
//   - Known STRUCTURED formats (PDF / DOCX / XLSX / PPTX) get a dedicated
//     parser, gated on magic-byte sniffing so the bytes must match the name.
//   - EVERYTHING ELSE is attempted as plain text: if it decodes cleanly and
//     doesn't look binary, we accept it as text (so .ps1/.bat/.sql/.py/.json/
//     .yaml/.html/.c/… all "just work"). If it looks binary, we decline it
//     with a clear reason the user sees in the UI.
//
// Security posture (this runs on user-supplied bytes, and will eventually run
// on a public server):
//   - Structured parsers are gated on magic bytes — never trust the extension.
//   - multer enforces a hard per-file byte cap upstream; we additionally cap
//     the amount of extracted text so a degenerate file can't blow up RAM/DB.
//   - Every parser runs inside the caller's try/catch; a failure is recorded
//     as a per-document status, never a server crash.
//
// Returns { text, kind, meta }. Throws on undecodable/binary input or parse
// failure — the caller turns the thrown message into a per-file "declined".

import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { PDFParse } from 'pdf-parse';
import JSZip from 'jszip';

export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB per file
const MAX_TEXT_CHARS = 4_000_000;               // ~4 MB of extracted text

// Zip-bomb guard for any ZIP-based input (Office files here; bundle import in
// index.js reuses it). JSZip reads the central directory without decompressing,
// so we can reject a file by its *declared* expansion before any bytes are
// inflated. Office docs are XML and compress well, so the cap is generous;
// 25 MB compressed in can never legitimately need hundreds of MB out.
const OFFICE_ZIP_LIMITS = { maxEntries: 4096, maxTotalBytes: 300 * 1024 * 1024 };

// Throws if a loaded JSZip declares more entries or more total uncompressed
// bytes than allowed. Caller passes a zip it already loaded (no double-parse).
export function assertZipSafe(zip, limits = OFFICE_ZIP_LIMITS) {
    const names = Object.keys(zip.files);
    if (names.length > limits.maxEntries) {
        throw new Error(`Archive has too many entries (${names.length} > ${limits.maxEntries}); refusing as a possible zip bomb.`);
    }
    let total = 0;
    for (const name of names) {
        total += zip.files[name]?._data?.uncompressedSize || 0;
        if (total > limits.maxTotalBytes) {
            throw new Error(`Archive expands too large (> ${Math.round(limits.maxTotalBytes / 1024 / 1024)} MB uncompressed); refusing as a possible zip bomb.`);
        }
    }
}

// Extensions that map to a dedicated structured parser. Anything NOT here is
// still accepted as long as it decodes as text (see extractText).
const STRUCTURED = {
    pdf: 'pdf',
    docx: 'docx',
    xlsx: 'xlsx',
    pptx: 'pptx',
};

function extOf(filename) {
    const m = /\.([a-z0-9]+)$/i.exec(filename || '');
    return m ? m[1].toLowerCase() : '';
}

// Looks like a ZIP container (docx/xlsx/pptx are zip archives): "PK\x03\x04".
// (Also matches empty/spanned-archive markers PK\x05\x06 / PK\x07\x08.)
function isZip(buf) {
    return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b
        && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
}

// "%PDF" magic.
function isPdf(buf) {
    return buf.length >= 5 && buf.toString('latin1', 0, 5) === '%PDF-';
}

// Image magic bytes — used by Capture's photo path (server/capture.js), which
// needs the original bytes stored and vision-readable, not "extracted" as
// text. These never collide with isPdf/isZip, so the check can sit anywhere
// before the binary-rejection branch.
function isJpeg(buf) {
    return buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
}
function isPng(buf) {
    return buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47
        && buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A;
}
function isWebp(buf) {
    return buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP';
}

// Decide whether a buffer is plain text or binary. We sample the head and:
//   - reject on a NUL byte (the classic git/grep heuristic), and
//   - reject if too many bytes are non-text control chars (catches binaries
//     that happen to have no NUL early on, e.g. some images/executables).
// UTF-8 BOM and ordinary whitespace/printable ranges are fine.
function looksBinary(buf) {
    const n = Math.min(buf.length, 8000);
    if (n === 0) return false;
    let suspicious = 0;
    for (let i = 0; i < n; i++) {
        const b = buf[i];
        if (b === 0) return true;
        // Control chars other than tab(9) line-feed(10) carriage-return(13)
        // form-feed(12) and escape(27, common in ANSI-colored logs).
        if (b < 9 || (b > 13 && b < 27) || (b > 27 && b < 32)) suspicious++;
    }
    return suspicious / n > 0.1;
}

function clamp(text) {
    if (text.length > MAX_TEXT_CHARS) {
        return text.slice(0, MAX_TEXT_CHARS) + '\n\n[...truncated: file exceeded extraction limit]';
    }
    return text;
}

// Render a single ExcelJS cell value to a string (cells can be rich text,
// formula results, hyperlinks, dates, etc.).
function cellToString(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') {
        if (v.text !== undefined) return String(v.text);                 // hyperlink / rich
        if (v.result !== undefined) return String(v.result);             // formula result
        if (Array.isArray(v.richText)) return v.richText.map(r => r.text).join('');
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        return '';
    }
    return String(v);
}

async function extractXlsx(buffer) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const parts = [];
    const sheetNames = [];
    wb.eachSheet((sheet) => {
        sheetNames.push(sheet.name);
        parts.push(`## Sheet: ${sheet.name}`);
        sheet.eachRow((row) => {
            const values = Array.isArray(row.values) ? row.values.slice(1) : [];
            const cells = values.map(cellToString);
            if (cells.some((c) => c.trim() !== '')) parts.push(cells.join(' | '));
        });
        parts.push('');
    });
    return { text: parts.join('\n'), meta: { sheetNames } };
}

async function extractPdf(buffer) {
    const parser = new PDFParse({ data: buffer });
    try {
        const result = await parser.getText();
        return { text: result.text || '', meta: { pageCount: result.total ?? null } };
    } finally {
        await parser.destroy();
    }
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(s) {
    return s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (_, e) => {
        if (e[0] === '#') {
            const code = e[1] === 'x' || e[1] === 'X'
                ? parseInt(e.slice(2), 16)
                : parseInt(e.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : _;
        }
        return XML_ENTITIES[e.toLowerCase()] ?? _;
    });
}

// PowerPoint has no maintained pure-JS text extractor we want to depend on, but
// a .pptx is just a zip of XML — slide text lives in <a:t> runs. We unzip with
// JSZip (already a dependency) and pull the runs slide-by-slide, plus speaker
// notes, which are often where the real explanation lives.
async function extractPptx(zip) {
    const slideNo = (name) => {
        const m = /(\d+)\.xml$/.exec(name);
        return m ? Number(m[1]) : 0;
    };
    const runsFrom = (xml) =>
        [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
            .map((m) => decodeXml(m[1]))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();

    const slideFiles = Object.keys(zip.files)
        .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort((a, b) => slideNo(a) - slideNo(b));

    const parts = [];
    for (const name of slideFiles) {
        const n = slideNo(name);
        const body = runsFrom(await zip.files[name].async('string'));

        const notesName = `ppt/notesSlides/notesSlide${n}.xml`;
        const notes = zip.files[notesName]
            ? runsFrom(await zip.files[notesName].async('string'))
            : '';

        parts.push(`## Slide ${n}`);
        if (body) parts.push(body);
        if (notes) parts.push(`Notes: ${notes}`);
        parts.push('');
    }
    // Reuse page_count to surface the slide count in the UI.
    return { text: parts.join('\n'), meta: { pageCount: slideFiles.length } };
}

// Main entry. `buffer` is the raw file; `filename` carries the extension used
// to pick a structured parser. `kind` describes how we read it: one of
// 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'text'.
export async function extractText(buffer, filename) {
    const ext = extOf(filename);
    const structured = STRUCTURED[ext];

    let text = '';
    let kind = 'text';
    let meta = {};

    if (structured === 'pdf' || (!structured && isPdf(buffer))) {
        if (!isPdf(buffer)) throw new Error('File does not look like a valid PDF.');
        kind = 'pdf';
        ({ text, meta } = await extractPdf(buffer));
    } else if (!structured && (isJpeg(buffer) || isPng(buffer) || isWebp(buffer))) {
        // A photo has no "text" to extract — it's stored as an original for
        // Capture's vision path (server/capture.js) to read directly. Return
        // early: the `!text` check below would otherwise reject every image.
        return { text: '', kind: isJpeg(buffer) ? 'jpg' : isPng(buffer) ? 'png' : 'webp', meta: {} };
    } else if (structured) {
        // docx / xlsx / pptx — must actually be a ZIP-based Office document.
        if (!isZip(buffer)) {
            throw new Error(`File does not look like a valid ${ext.toUpperCase()} (expected a ZIP-based Office document).`);
        }
        // Inspect the central directory and reject zip bombs before any parser
        // inflates the bytes. extractPptx reuses this same loaded zip.
        const zip = await JSZip.loadAsync(buffer);
        assertZipSafe(zip);
        kind = structured;
        if (structured === 'docx') {
            const res = await mammoth.extractRawText({ buffer });
            text = res.value || '';
        } else if (structured === 'xlsx') {
            ({ text, meta } = await extractXlsx(buffer));
        } else if (structured === 'pptx') {
            ({ text, meta } = await extractPptx(zip));
        }
    } else {
        // Unknown extension: accept it iff it reads as text. A ZIP/archive or
        // any other binary is declined with a reason the user can see.
        if (isZip(buffer)) {
            throw new Error('Looks like a binary archive (ZIP/Office/jar). Only text-based files and PDF/DOCX/XLSX/PPTX are supported.');
        }
        if (looksBinary(buffer)) {
            throw new Error('File looks binary, not text — it can\'t be read as study material.');
        }
        kind = 'text';
        text = buffer.toString('utf8');
    }

    text = clamp(text.trim());
    if (!text) throw new Error('No extractable text found in file.');
    return { text, kind, meta };
}

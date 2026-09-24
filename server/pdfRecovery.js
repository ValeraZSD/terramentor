// server/pdfRecovery.js — recover math/formulas that a PDF's text layer drops.
//
// Why this exists: Word/LaTeX-exported PDFs (e.g. a maths exam bank)
// embed every equation in a subsetted font (ABCDEE+Cambria/Calibri) that carries
// NO ToUnicode CMap and uses a custom glyph encoding. pdf.js decodes the standard
// parentheses/digits but emits an EMPTY STRING for each math glyph, so
// "x(t) = 1 − t²" comes out of the vault as "( )". Nothing at the text layer can
// recover it (verified: supplying pdf.js the standard fonts + cmaps changes
// nothing — the mapping simply isn't in the file). The glyphs exist only as
// *shapes*, so the only way back to text is to re-read the RENDERED page.
//
// Strategy (chosen by the user): vision-model transcription is primary (produces
// clean Markdown + LaTeX the app already renders via KaTeX), tesseract OCR is the
// offline fallback (recovers structure, mangles some notation), and the original
// text layer is kept as the last resort. Detection is cheap and runs at upload
// (dropped-glyph-width ratio per page); the expensive re-read runs in the
// background on its OWN serial chain — like embeddings.js / feedGen.js, NEVER
// through the tasks FIFO — and yields to interactive model work before each call.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import db from './database.js';
import * as tasks from './tasks.js';
import vaultStorage from './vaultStorage.js';
import { chunkText } from './ai.js';
import { dataPaths } from './paths.js';
import { indexDocument, removeChunkVectors } from './embeddings.js';
import { transcribeImageToText, visionAvailability, getAISettings } from './ai.js';

const require = createRequire(import.meta.url);

// Lazy pdf.js handle — the legacy build runs on the main thread in Node.
let _pdfjs = null;
async function getPdfjs() {
    if (!_pdfjs) _pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    return _pdfjs;
}

// Standard-font data ships with pdfjs-dist; pointing render at it improves
// fidelity for the substituted body font (and silences the console warning).
function pdfjsAssetDir(sub) {
    try {
        const pkg = require.resolve('pdfjs-dist/package.json');
        // pdf.js validates these as URLs and requires a trailing slash — a raw
        // Windows path (backslashes) is rejected, so hand it a file:// URL.
        return pathToFileURL(path.join(path.dirname(pkg), sub) + path.sep).href;
    } catch { return undefined; }
}

// ---- detection + per-page text extraction -----------------------------------

// A page is "degraded" when this fraction of its positive-width glyph runs
// produced no character. Clean prose scores ~0; the affected exam pages score
// 0.13–0.57. 0.12 catches the math pages without tripping on ordinary text.
const DEGRADE_RATIO = 0.12;

// Assemble one page's text from its items, matching how the whole-doc extractor
// lays out lines (append run strings, break on hasEOL).
function pageItemsToText(items) {
    let out = '';
    for (const it of items) {
        out += it.str;
        if (it.hasEOL) out += '\n';
    }
    return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Parse a PDF once and report, per page, the text-layer text plus a degradation
// score. Returns { numPages, pages:[{page,text,emptyRatio,chars,degraded}],
// degradedPages:[1-based…], degraded }. Never throws for a readable PDF; a parse
// failure is surfaced so the caller can decline recovery (keeping the text layer).
export async function analyzePdfPages(buffer) {
    const pdfjs = await getPdfjs();
    const doc = await pdfjs.getDocument({
        data: new Uint8Array(buffer),
        verbosity: 0,
        standardFontDataUrl: pdfjsAssetDir('standard_fonts'),
        cMapUrl: pdfjsAssetDir('cmaps'),
        cMapPacked: true,
    }).promise;

    // Capture numPages BEFORE the loop — it's read again in the return below,
    // which executes after the `finally` has destroyed the proxy (reading a
    // destroyed pdf.js document is undefined behaviour).
    const numPages = doc.numPages;
    const pages = [];
    try {
        for (let p = 1; p <= numPages; p++) {
            const page = await doc.getPage(p);
            const tc = await page.getTextContent();
            let widthAll = 0, widthEmpty = 0, chars = 0;
            for (const it of tc.items) {
                if (it.width > 0) {
                    widthAll += it.width;
                    if (it.str.trim() === '') widthEmpty += it.width;
                }
                chars += it.str.replace(/\s/g, '').length;
            }
            const emptyRatio = widthAll > 0 ? widthEmpty / widthAll : 0;
            const degraded = widthAll > 0 && emptyRatio >= DEGRADE_RATIO;
            pages.push({
                page: p,
                text: pageItemsToText(tc.items),
                emptyRatio: Math.round(emptyRatio * 100) / 100,
                chars,
                degraded,
            });
            page.cleanup();
        }
    } finally {
        await doc.destroy();
    }

    const degradedPages = pages.filter(p => p.degraded).map(p => p.page);
    return { numPages, pages, degradedPages, degraded: degradedPages.length > 0 };
}

// ---- page rendering ---------------------------------------------------------

let _canvas = null;
async function getCanvasFactory() {
    if (!_canvas) _canvas = await import('@napi-rs/canvas');
    return _canvas;
}

// Render one page to PNG bytes. scale 3 ≈ 216 DPI — enough for crisp small
// superscripts without ballooning the image the model/OCR has to read.
async function renderPageToPng(doc, pageNum, scale = 3) {
    const { createCanvas } = await getCanvasFactory();
    const page = await doc.getPage(pageNum);
    try {
        const viewport = page.getViewport({ scale });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        return canvas.toBuffer('image/png');
    } finally {
        page.cleanup();
    }
}

// ---- tesseract OCR fallback -------------------------------------------------

// One shared worker, created on first use and torn down when recovery goes idle
// (loading the eng model costs ~1s off the local copy described below).
//
// The decompressed model is cached where `server/paths.js` says the vault is,
// never beside the source: built from `__dirname` it ignored DATA_DIR *and*
// VAULT_ROOT, so a packaged install wrote into the application folder — the
// unwritable-directory case paths.js exists to prevent — and every process on
// one machine shared one cache directory.
let _ocrWorker = null;
let _ocrIdleTimer = null;
const OCR_DATA_DIR = path.join(dataPaths().vaultRoot, 'ocr-data');

/** Where the OCR model cache went, so `tenancy-gates.mjs` can read the value
 *  this module actually uses rather than recompute one that would agree with
 *  paths.js however this line was written. */
export const ocrDataDir = () => OCR_DATA_DIR;

/**
 * The English model, INSIDE the install (`@tesseract.js-data/eng`).
 *
 * Left unset, `langPath` defaults to `cdn.jsdelivr.net` and tesseract.js
 * downloads `eng.traineddata.gz` on the first OCR — an outbound connection
 * SECURITY.md does not list, made by the one recovery mode whose own label in
 * Settings says "Fully offline", and made by tesseract's own fetch rather than
 * through `netSafety.js`. It is also the mode a reader picks *because* the
 * machine has no network. Shipping the file is what makes that label true.
 *
 * There is deliberately NO CDN fallback: a fallback is the outbound connection,
 * and it would fire exactly where it is least wanted. A missing model is a
 * broken install and says so.
 *
 * The folder name is tesseract.js's own: `createWorker('eng', 1, …)` is
 * OEM.LSTM_ONLY, for which it reads the `4.0.0_best_int` build (2.9 MB) rather
 * than the legacy-carrying `4.0.0` (10.9 MB). Keep the two in step if the oem
 * argument ever changes.
 */
function ocrLangPath() {
    let pkgDir;
    try {
        pkgDir = path.dirname(require.resolve('@tesseract.js-data/eng/package.json'));
    } catch {
        throw new Error('OCR model package @tesseract.js-data/eng is not installed — run `npm install`.');
    }
    const dir = path.join(pkgDir, '4.0.0_best_int');
    if (!fs.existsSync(path.join(dir, 'eng.traineddata.gz'))) {
        throw new Error(`OCR model missing at ${dir} — run \`npm install\`. This app never downloads it.`);
    }
    return dir;
}

async function getOcrWorker() {
    if (_ocrWorker) return _ocrWorker;
    fs.mkdirSync(OCR_DATA_DIR, { recursive: true });
    const { createWorker } = await import('tesseract.js');
    _ocrWorker = await createWorker('eng', 1, {
        langPath: ocrLangPath(),
        cachePath: OCR_DATA_DIR,
        logger: () => {},
    });
    return _ocrWorker;
}

function scheduleOcrTeardown() {
    clearTimeout(_ocrIdleTimer);
    _ocrIdleTimer = setTimeout(async () => {
        const w = _ocrWorker;
        _ocrWorker = null;
        try { await w?.terminate(); } catch { /* ignore */ }
    }, 60000);
}

async function ocrPage(png) {
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(png);
    return (data?.text || '').trim();
}

// ---- background orchestration ----------------------------------------------

const RECOVERY_MODE_SETTING = 'pdf_math_recovery'; // 'auto' (default) | 'off'
function recoveryEnabled() {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(RECOVERY_MODE_SETTING);
    return (row?.value ?? 'auto') !== 'off';
}

// Whether to use a vision model for recovery. The danger case is an OpenAI-
// compatible endpoint (llama-swap/llama.cpp): there's no capability probe, and a
// TEXT-only model there often doesn't reject an image — it silently ignores it
// and hallucinates a "transcription", which would be worse than OCR and get
// mislabelled 'vision'. So 'auto' (default) only trusts vision when we can VERIFY
// it (Ollama's capability list); on an OpenAI endpoint it falls back to OCR
// unless the user explicitly sets 'always' (they know their endpoint serves a
// vision model). 'never' = OCR only.
//   returns the effective flag for transcribeImageToText: 'yes' | 'no'
const VISION_MODE_SETTING = 'pdf_recovery_vision'; // 'auto' (default) | 'always' | 'never'
// A dedicated vision model for recovery, so chat can stay on a text-only model
// (e.g. minimax) while pages are transcribed by a vision model on the SAME
// provider (e.g. gemma…-cloud). Empty = use the chat model.
const VISION_MODEL_SETTING = 'pdf_recovery_vision_model';
function getRecoveryVisionModel() {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(VISION_MODEL_SETTING);
    const configured = (row?.value || '').trim();
    return configured || getAISettings().model;
}

// Returns { use: 'yes'|'no', model } — the effective vision decision AND which
// model to transcribe with. Capability is probed on the VISION model (not chat),
// so 'auto' can enable vision purely because the recovery model supports images.
async function decideVision() {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(VISION_MODE_SETTING);
    const mode = row?.value ?? 'auto';
    const model = getRecoveryVisionModel();
    if (!model || mode === 'never') return { use: 'no', model };
    // 'always' = the user takes responsibility (they know their endpoint/model
    // serves images) — force it, don't second-guess the probe.
    if (mode === 'always') return { use: 'yes', model };
    // 'auto' = only when we can VERIFY the model handles images (Ollama's
    // capability list). An OpenAI-compatible 'maybe' is unknowable, and a
    // text-only model there would hallucinate, so it falls back to OCR.
    const cap = await visionAvailability(model); // 'yes' | 'no' | 'maybe'
    return { use: cap === 'yes' ? 'yes' : 'no', model };
}

// Any non-recovery model task running or queued? Then the GPU/model belongs to
// the user's interactive work — wait before spending it on a background page.
function interactiveModelBusy() {
    try {
        return tasks.listTasks().some(t =>
            (t.status === 'running' || t.status === 'queued') && t.kind !== 'recover');
    } catch { return false; }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Yield to interactive work before a vision call: poll until the model is free
// (recovery isn't latency-sensitive), capped so a continuously-busy session can't
// stall a document forever.
async function waitForModelIdle(maxWaitMs = 5 * 60000) {
    const start = Date.now();
    while (interactiveModelBusy() && Date.now() - start < maxWaitMs) {
        await sleep(2000);
    }
}

let recoveryChain = Promise.resolve();

// Public: queue a document for background math recovery. Idempotent-ish — the
// serial chain runs one document at a time. `force` bypasses the settings gate
// and the "already recovered" guard (used by the manual re-run endpoint).
export function queueRecovery(documentId, { force = false } = {}) {
    if (!force && !recoveryEnabled()) return;
    recoveryChain = recoveryChain.then(() => runRecovery(documentId, { force })).catch(() => {});
}

// The recovery queue lives in memory, so a restart (e.g. after a rebuild) orphans
// any doc left mid-flight: its DB `recovery_status` stays 'running'/'pending' but
// nothing drives it — the badge spins forever. Called once at startup to resume:
// interrupted 'running' rows are reset to 'pending' and everything pending is
// re-queued. If recovery is switched off, the orphaned badges are just cleared so
// they don't sit stuck. Mirrors feedGen.startupKick / the embeddings resume.
export function resumePendingRecovery() {
    let rows;
    try {
        rows = db.prepare("SELECT id FROM documents WHERE recovery_status IN ('pending', 'running')").all();
    } catch { return; }
    if (!rows.length) return;

    if (!recoveryEnabled()) {
        db.prepare("UPDATE documents SET recovery_status = NULL WHERE recovery_status IN ('pending', 'running')").run();
        return;
    }
    // An interrupted 'running' is just an un-started 'pending' now.
    db.prepare("UPDATE documents SET recovery_status = 'pending' WHERE recovery_status = 'running'").run();
    console.log(`[recover] resuming ${rows.length} interrupted document(s) after restart`);
    for (const r of rows) queueRecovery(r.id);
}

async function runRecovery(documentId, { force }) {
    const doc = db.prepare(
        'SELECT id, title, file_type, file_hash, project_id, node_id, recovery_status FROM documents WHERE id = ?'
    ).get(documentId);
    if (!doc || doc.file_type !== 'pdf' || !doc.file_hash) return;
    if (!force && doc.recovery_status && doc.recovery_status !== 'pending') return;
    if (!force && !recoveryEnabled()) return;

    let buffer;
    try { buffer = vaultStorage.readBuffer(doc.file_hash); }
    catch { return; } // original blob gone — nothing to re-read

    // Analyse BEFORE touching status/TaskDock so a clean PDF (the common case)
    // recovers no math, spawns no visible task, and quietly records 'skipped'.
    let analysis;
    try {
        analysis = await analyzePdfPages(buffer);
    } catch (err) {
        db.prepare('UPDATE documents SET recovery_status = ? WHERE id = ?').run('failed', documentId);
        console.warn(`[recover] analysis failed for "${doc.title}": ${err.message}`);
        return;
    }
    if (!analysis.degraded) {
        db.prepare('UPDATE documents SET recovery_status = ? WHERE id = ?').run('skipped', documentId);
        return;
    }

    db.prepare('UPDATE documents SET recovery_status = ? WHERE id = ?').run('running', documentId);

    // The TaskDock cancel button invokes this hook (tasks.cancelTask on an
    // external task); the page loop checks the flag between pages, so a long
    // vision recovery stops within one page.
    let cancelRequested = false;
    // The project's NAME and COLOUR, not only its id: the dock draws the colour,
    // and it is the only thing on a chip that says which course the work is for.
    const owner = doc.project_id
        ? db.prepare('SELECT name, color FROM projects WHERE id = ?').get(doc.project_id)
        : null;
    const handle = tasks.registerExternal({
        kind: 'recover',
        label: `Recovering math in "${doc.title}"`,
        projectId: doc.project_id ?? null,
        projectName: owner?.name ?? null,
        projectColor: owner?.color ?? null,
        cancel: () => { cancelRequested = true; },
    });

    try {
        const pdfjs = await getPdfjs();
        const renderDoc = await pdfjs.getDocument({
            data: new Uint8Array(buffer),
            verbosity: 0,
            standardFontDataUrl: pdfjsAssetDir('standard_fonts'),
            cMapUrl: pdfjsAssetDir('cmaps'),
            cMapPacked: true,
        }).promise;

        // Decide vision use once (verified via Ollama capability probe on the
        // dedicated recovery model; on an OpenAI-compatible endpoint only when the
        // user opted in — see decideVision).
        const { use: visionUse, model: visionModel } = await decideVision();
        let vision = visionUse; // 'yes' | 'no'

        const degradedSet = new Set(analysis.degradedPages);
        const perPageMethod = {};
        let recoveredCount = 0;
        const total = analysis.degradedPages.length;
        let done = 0;

        let cancelled = false;
        try {
            for (const p of analysis.pages) {
                // cancelRequested is set by the TaskDock cancel hook. (The task's
                // status never reads 'cancelled' here — with a cancel hook,
                // cancelTask leaves settling to the owner, i.e. this function.)
                if (cancelRequested) { cancelled = true; break; }
                if (!degradedSet.has(p.page)) continue;

                done++;
                handle.update({ phase: 'recover', message: `Page ${p.page} of ${analysis.numPages}`, percent: Math.round((done / total) * 100) });

                let recovered = '';
                let method = '';
                const png = await renderPageToPng(renderDoc, p.page);

                if (vision === 'yes') {
                    await waitForModelIdle();
                    try {
                        recovered = await transcribeImageToText(png, { model: visionModel });
                        if (recovered) method = 'vision';
                    } catch (err) {
                        // Per-page failure (e.g. a transient model error) — fall through
                        // to OCR for this page; a capable model stays enabled for the rest.
                        console.warn(`[recover] vision failed on "${doc.title}" p${p.page}: ${err.message}`);
                    }
                }

                if (!recovered) {
                    try {
                        recovered = await ocrPage(png);
                        if (recovered) method = 'ocr';
                    } catch (err) {
                        console.warn(`[recover] OCR failed on "${doc.title}" p${p.page}: ${err.message}`);
                    }
                }

                // Only substitute when the re-read beat the (near-empty) text layer.
                if (recovered && recovered.replace(/\s/g, '').length > p.chars) {
                    p.text = recovered;
                    perPageMethod[p.page] = method;
                    recoveredCount++;
                }
            }
        } finally {
            await renderDoc.destroy();
            scheduleOcrTeardown();
        }

        if (cancelled && recoveredCount === 0) {
            // Cancelled before anything was gained — leave the document exactly as
            // it was (status cleared, not 'failed': the user stopped it, recovery
            // didn't fail) so a later re-run starts fresh.
            db.prepare('UPDATE documents SET recovery_status = NULL, recovery_meta = NULL WHERE id = ?').run(documentId);
            handle.cancelled();
            console.log(`[recover] "${doc.title}": cancelled before any page was recovered`);
            return;
        }

        if (recoveredCount === 0) {
            db.prepare('UPDATE documents SET recovery_status = ?, recovery_meta = ? WHERE id = ?')
                .run('failed', JSON.stringify({
                    degradedPages: analysis.degradedPages,
                    recovered: 0,
                    reason: vision === 'no' ? 'no-vision-or-ocr' : 'no-gain',
                }), documentId);
            handle.finish();
            return;
        }

        // Rebuild the full document text from the (now partly recovered) pages and
        // re-chunk + re-index so RAG sees the formulas.
        const methods = [...new Set(Object.values(perPageMethod))];
        const method = methods.length > 1 ? 'mixed' : (methods[0] || 'none');
        const fullText = analysis.pages.map(p => p.text).filter(Boolean).join('\n\n').trim();

        const persist = db.transaction(() => {
            // Keep the real gains even on a cancelled run (the vision/OCR work is
            // done and the recovered pages are strictly better than the dropped-
            // glyph text layer), but record `cancelled` so the badge/meta don't
            // claim a clean full pass — some degraded pages may be un-re-read.
            db.prepare('UPDATE documents SET content = ?, recovery_status = ?, recovery_meta = ? WHERE id = ?')
                .run(fullText, 'recovered', JSON.stringify({
                    method, recovered: recoveredCount, degradedPages: analysis.degradedPages, perPage: perPageMethod,
                    ...(cancelled ? { cancelled: true } : {}),
                    ...(methods.includes('vision') ? { visionModel } : {}),
                }), documentId);
            db.prepare('DELETE FROM document_chunks WHERE document_id = ?').run(documentId);
            const insertChunk = db.prepare('INSERT INTO document_chunks (document_id, chunk_index, content) VALUES (?, ?, ?)');
            chunkText(fullText).forEach((c, i) => insertChunk.run(documentId, i, c));
        });
        // Re-chunking gives the new rows fresh ids, so the OLD chunks' vectors in
        // vec_chunks (rowid-keyed, not a real FK) would be orphaned — capture the
        // ids before the delete and sweep them, mirroring the document-delete path.
        // Safe even if SQLite reuses a rowid: the new chunk has no vector until
        // indexDocument (queued after) embeds it.
        const oldChunkIds = db.prepare('SELECT id FROM document_chunks WHERE document_id = ?')
            .all(documentId).map(r => r.id);
        persist();
        removeChunkVectors(oldChunkIds);
        indexDocument(documentId); // re-embed the recovered text (no-op if embeddings off)

        if (cancelled) handle.cancelled(); else handle.finish();
        console.log(`[recover] "${doc.title}": recovered ${recoveredCount}/${total} page(s) via ${method}${cancelled ? ' (cancelled mid-run, partial)' : ''}`);
    } catch (err) {
        db.prepare('UPDATE documents SET recovery_status = ? WHERE id = ?').run('failed', documentId);
        try { handle.fail(err.message); } catch { /* ignore */ }
        console.warn(`[recover] "${doc.title}" failed: ${err.message}`);
    }
}

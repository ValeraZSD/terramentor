import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { dataPaths } from './paths.js';

/**
 * What the learner said was wrong with a drawing, and what came back after.
 *
 * WHY THIS IS A FILE AND NOT A TABLE. Every other record this app keeps is
 * about the learner's own knowledge and never leaves the machine; this one is
 * the opposite — it exists SO THAT it can leave, deliberately, when the learner
 * decides to send it. A JSONL file is the shape that makes that a decision
 * rather than an export feature: it is one line per event, readable in any
 * editor, greppable, appendable, and it can be attached to an issue as it
 * stands. Putting it in SQLite would mean writing an exporter to get it out
 * again, and would bury it inside the file that holds their private notes.
 *
 * It lives under VAULT_ROOT beside the other two blob stores, so the Docker
 * backup story is unchanged: back up the volume and you have backed this up too.
 *
 * WHAT A RECORD IS FOR. A visual that renders and is WRONG throws nothing. The
 * repair loop cannot see it, the coherence gate cannot see it, and the only
 * detector is a person who knows what they were supposed to be looking at. So
 * the record has to carry all three parts or it teaches nobody anything: the
 * spec that was drawn, what the person said about it, and what the model
 * produced when it was told. Two of those alone is an anecdote.
 *
 * Nothing here is sent anywhere. The app only writes the file and hands it back
 * when asked for.
 */

// Where the vault is — `server/paths.js` is the ONE answer (DB_PATH/VAULT_ROOT,
// then DATA_DIR, then the historical `server/vault`). Reading VAULT_ROOT here
// and stopping honoured a scratch server but not the desktop launcher, which
// sets DATA_DIR: a packaged install wrote this file into the application folder
// instead of the learner's data directory, where an update would take it.
const ROOT = dataPaths().vaultRoot;
const DIR = path.join(ROOT, 'feedback');
const FILE = path.join(DIR, 'visual-feedback.jsonl');

/**
 * Caps, all of them for the same reason the task-failure record has them: this
 * file grows without an upper bound and a single p5 sketch or compiled widget
 * can be tens of kilobytes. A spec longer than the cap is truncated with a
 * marker rather than dropped — a clipped spec still shows what KIND of thing
 * went wrong, and an absent one shows nothing.
 */
const MAX_SPEC = 20000;
const MAX_FEEDBACK = 2000;
/** Beyond this the file is refusing to be read by anything; the writer stops. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

const clip = (value, max) => {
    const text = typeof value === 'string' ? value : '';
    return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text;
};

function ensureDir() {
    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

/** Where the file is, so the UI can tell the learner what to attach. */
export function visualFeedbackPath() {
    return FILE;
}

function append(record) {
    ensureDir();
    try {
        if (fs.existsSync(FILE) && fs.statSync(FILE).size > MAX_FILE_BYTES) return false;
    } catch { /* a stat failure is not a reason to lose the record */ }
    fs.appendFileSync(FILE, `${JSON.stringify(record)}\n`, 'utf8');
    return true;
}

/**
 * Record that a drawing was reported. Returns the id, which the client hands
 * back once the rebuild lands so the two halves end up on one record.
 */
export function recordVisualFeedback({
    kind, language, spec, feedback, surface, nodeId, messageId, theme, provider, model, appVersion,
}) {
    const id = `vf_${crypto.randomBytes(8).toString('hex')}`;
    const record = {
        id,
        at: new Date().toISOString(),
        kind: String(kind || '').slice(0, 40),
        language: String(language || '').slice(0, 40) || undefined,
        surface: String(surface || 'unknown').slice(0, 40),
        nodeId: Number.isFinite(Number(nodeId)) ? Number(nodeId) : undefined,
        messageId: Number.isFinite(Number(messageId)) ? Number(messageId) : undefined,
        theme: theme ? String(theme).slice(0, 20) : undefined,
        provider: provider ? String(provider).slice(0, 60) : undefined,
        model: model ? String(model).slice(0, 120) : undefined,
        appVersion: appVersion ? String(appVersion).slice(0, 40) : undefined,
        feedback: clip(feedback, MAX_FEEDBACK),
        spec: clip(spec, MAX_SPEC),
    };
    for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key];
    append(record);
    return id;
}

/**
 * Attach what the rebuild produced.
 *
 * Written as its OWN line rather than by rewriting the first: an append-only
 * file cannot be corrupted by a crash halfway through, and the pair is joined
 * by `id` when the file is read. `outcome` is what a maintainer actually needs
 * — "the learner said the axes do not move and here is what the model did about
 * it" is a bug report; either half alone is not.
 */
export function recordVisualOutcome(id, { revisedSpec, revisedDrawing, error, accepted }) {
    if (!id || typeof id !== 'string' || !/^vf_[0-9a-f]{16}$/.test(id)) return false;
    return append({
        id,
        at: new Date().toISOString(),
        outcome: {
            accepted: accepted === undefined ? undefined : !!accepted,
            error: error ? String(error).slice(0, 500) : undefined,
            revisedSpec: revisedSpec ? clip(revisedSpec, MAX_SPEC) : undefined,
            // For a brief-backed visual the block holds WORDS and the drawing
            // lives in the cache; both are revised, and a record holding only
            // the words could not say what the reader was then shown.
            revisedDrawing: revisedDrawing ? clip(revisedDrawing, MAX_SPEC) : undefined,
        },
    });
}

/**
 * A summary for the Settings panel: how much is in the file and how big it is.
 * Deliberately not the contents — the panel's job is to say the file exists and
 * offer it, not to render somebody's own bug reports back at them.
 */
export function visualFeedbackSummary() {
    try {
        if (!fs.existsSync(FILE)) return { count: 0, bytes: 0, path: FILE, lastAt: null };
        const raw = fs.readFileSync(FILE, 'utf8');
        const lines = raw.split('\n').filter(Boolean);
        let count = 0;
        let lastAt = null;
        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                if (entry.outcome) continue;   // the second half of a pair, not a new report
                count++;
                if (entry.at) lastAt = entry.at;
            } catch { /* a half-written line is skipped, never fatal */ }
        }
        return { count, bytes: Buffer.byteLength(raw, 'utf8'), path: FILE, lastAt };
    } catch {
        return { count: 0, bytes: 0, path: FILE, lastAt: null };
    }
}

/** The whole file, for the download. Empty string when nothing has been reported. */
export function readVisualFeedback() {
    try {
        return fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : '';
    } catch {
        return '';
    }
}

/** Delete every report. The learner's file, the learner's call. */
export function clearVisualFeedback() {
    try {
        if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
        return true;
    } catch {
        return false;
    }
}

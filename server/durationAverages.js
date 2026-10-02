/**
 * How long one kind of model call has been taking on THIS machine, kept as a
 * rolling average in the settings table.
 *
 * Two long jobs time themselves this way — bulk study material
 * (`bulk_avg_ms_*`) and AI project creation (`creation_avg_ms_*`) — and both
 * use it for the same thing only: the SEED of a live "~x left" while the run in
 * progress has not yet timed a call of its own. Nothing prints it before a run
 * starts: a job that pauses for the tutor cannot be held to a duration.
 *
 * Weighted toward recent runs (0.7 old, 0.3 new), because the model or the box
 * may have changed since.
 */
import db from './database.js';

/** A single call longer than this is a stall or a sleep, not a timing. */
const MAX_SAMPLE_MS = 30 * 60 * 1000;

function readSetting(key) {
    try {
        return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
    } catch { return null; }
}

/** The stored average in ms, or null when this kind was never timed here. */
export function readAverageMs(key) {
    const raw = Number(readSetting(key));
    return raw > 0 ? Math.round(raw) : null;
}

/** Fold one measured call into the stored average. Never throws: a timing hint is never worth failing a run over. */
export function recordAverageMs(key, ms) {
    if (!(ms > 0) || ms > MAX_SAMPLE_MS) return;
    const prev = Number(readSetting(key));
    const next = prev > 0 ? prev * 0.7 + ms * 0.3 : ms;
    try {
        db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(Math.round(next)));
    } catch { /* see above */ }
}

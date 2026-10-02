// Settings rows read and written by the routes and the startup jobs.
import db from './database.js';
import { masteryCheckSize } from './questionLog.js';

/** Read a single setting value with a fallback. */
function getSetting(key, fallback) {
    try {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
        return row && row.value != null ? row.value : fallback;
    } catch {
        return fallback;
    }
}

/** Resolved configuration for the mastery / completion gate. */
function getGateConfig() {
    const mode = getSetting('mastery_gate_mode', 'enforced');
    return {
        mode: ['off', 'advisory', 'enforced'].includes(mode) ? mode : 'enforced',
        threshold: parseFloat(getSetting('mastery_threshold', '0.85')) || 0.85,
        checkPass: parseFloat(getSetting('mastery_check_pass', '0.8')) || 0.8,
        checkSize: masteryCheckSize(getSetting),
        decayDays: parseInt(getSetting('decay_days', '14'), 10) || 14,
    };
}

const setSettingValue = (key, value) =>
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);

export { getGateConfig, getSetting, setSettingValue };

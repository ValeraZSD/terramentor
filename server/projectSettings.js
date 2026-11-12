// A setting that belongs to one project lives in `settings` under
// `<prefix><project uuid>` (settingsSchema.js PROJECT_SETTING_PREFIXES). The
// uuid, not the integer id: the id names a different project in another copy
// of the library. database.js moves rows written under the id to the uuid.

import db from './database.js';

const projectUuid = (projectId) =>
    db.prepare('SELECT uuid FROM projects WHERE id = ?').pluck().get(projectId) ?? null;

/** The settings key for `projectId`'s row of `prefix`, or null when there is no such project. */
export function projectSettingKey(prefix, projectId) {
    const uuid = projectUuid(projectId);
    return uuid ? prefix + uuid : null;
}

/** The stored value, or null when unset or the project does not exist. */
export function readProjectSetting(prefix, projectId) {
    const key = projectSettingKey(prefix, projectId);
    if (!key) return null;
    return db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) ?? null;
}

/** Store `value`; false when the project does not exist (nothing written). */
export function writeProjectSetting(prefix, projectId, value) {
    const key = projectSettingKey(prefix, projectId);
    if (!key) return false;
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, String(value));
    return true;
}

/** Remove the row; a no-op when unset or the project does not exist. */
export function clearProjectSetting(prefix, projectId) {
    const key = projectSettingKey(prefix, projectId);
    if (key) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

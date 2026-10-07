/**
 * Changes the assistant PREPARES and the learner APPLIES, through one door.
 *
 * The assistant drafts a change as a fenced block (src/utils/assistantWrites.ts):
 * a course's name, icon, colour, description, status or daily new cards
 * (```project), a topic's title (```topic), a page saved on a topic (```link).
 * The drawer shows it as before → after with an Apply button, and Apply is the
 * only thing that reaches this module. Nothing here runs on the model's say-so.
 *
 * Every applied change is a ROW (`assistant_edits`) holding what each field
 * was and what it became, so Undo is a restore from the row — and it survives a
 * reload, because the preview finds its row again by `source` (the stored
 * message id and the block's place in it).
 *
 * Two compare-and-sets keep it honest about time:
 *   - Apply replaces only what the learner SAW: every field it changes must
 *     still hold the value the preview showed (`expect`), or nothing is written
 *     and the preview redraws from what is there now. A description someone
 *     edited after the preview was drawn is not overwritten unseen.
 *   - Undo restores only a field that still holds what Apply wrote. A name the
 *     learner changed again since is theirs, and is reported as kept.
 *
 * Every value is judged by a rule here, never by the model's word: an icon is
 * one of the app's drawings, a colour is one the app can paint, a status is one
 * of three. The client runs the same rules to draw the preview
 * (`server/projectFields.js` is shared), but this is the door.
 */
import db from './database.js';
import { addProvenanceFields } from './projectIdentity.js';
import {
    newPerDay, oneLine, projectColour, projectDescription, projectIconName, projectName, projectStatus, topicTitle,
} from './projectFields.js';
import { getNewPerDay } from './decks.js';
import { sanitizeUrl } from './urlSafety.js';
import { scheduleNodeSync } from './nodeEmbeddings.js';
import { logActivity } from './activityLog.js';

/** What a saved link's title is cut to. */
export const LINK_TITLE_MAX = 200;

const nowIso = () => new Date().toISOString();

/** An error the route turns into a status: 400 a value no rule accepts, 404 a
 *  target that does not exist, 409 a preview that is out of date. */
export class EditError extends Error {
    constructor(status, message, extra = {}) {
        super(message);
        this.status = status;
        Object.assign(this, extra);
    }
}

/** Whether a project has any cards: a daily allowance of new cards means nothing without them. */
const hasCards = (projectId) => !!db.prepare(
    'SELECT 1 FROM flashcards f JOIN nodes n ON n.id = f.node_id WHERE n.project_id = ? LIMIT 1',
).get(projectId);

const settingStmt = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
const newPerDayKey = (projectId) => `deck_new_per_day_${projectId}`;

/**
 * Each kind: how to read its target, and per field how a value is judged
 * (`normalize` → the value to write, or null), read (`get`, what the preview
 * showed and what is compared), written, and — where a field's stored form is
 * not the value shown — snapshotted and restored.
 */
const KINDS = {
    project: {
        label: 'course',
        read: (id) => db.prepare('SELECT id, name, description, color, icon, status, generated_by FROM projects WHERE id = ?').get(id) || null,
        fields: {
            name: {
                words: true,
                normalize: projectName,
                get: (row) => row.name ?? '',
                write: (id, v) => db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(v, id),
            },
            description: {
                words: true,
                normalize: projectDescription,
                get: (row) => row.description ?? '',
                write: (id, v) => db.prepare('UPDATE projects SET description = ? WHERE id = ?').run(v, id),
            },
            icon: {
                normalize: projectIconName,
                get: (row) => row.icon ?? '',
                write: (id, v) => db.prepare('UPDATE projects SET icon = ? WHERE id = ?').run(v, id),
            },
            color: {
                normalize: projectColour,
                // Compared as the colour it is: `#3B82F6` and `#3b82f6` are one.
                get: (row) => (projectColour(row.color ?? '') ?? String(row.color ?? '')),
                write: (id, v) => db.prepare('UPDATE projects SET color = ? WHERE id = ?').run(v, id),
                snapshot: (_id, row) => row.color ?? null,
            },
            status: {
                normalize: projectStatus,
                get: (row) => row.status || 'active',
                write: (id, v) => db.prepare('UPDATE projects SET status = ? WHERE id = ?').run(v, id),
            },
            new_per_day: {
                normalize: (raw, row) => {
                    const n = newPerDay(raw);
                    // A number of new cards a day for a course with none to
                    // introduce would be a setting nobody can see work.
                    if (n !== null && !hasCards(row.id)) throw new EditError(400, 'This course has no cards, so it has no daily allowance of new ones.', { fields: ['new_per_day'] });
                    return n;
                },
                get: (row) => getNewPerDay(row.id),
                write: (id, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
                    .run(newPerDayKey(id), String(v)),
                // The stored row itself: absent means "follow the default",
                // and Undo puts the absence back, not today's default as a number.
                snapshot: (id) => settingStmt(newPerDayKey(id)),
                restore: (id, snap) => (snap == null
                    ? db.prepare('DELETE FROM settings WHERE key = ?').run(newPerDayKey(id))
                    : db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(newPerDayKey(id), snap)),
            },
        },
        afterWrite: () => {},
    },
    topic: {
        label: 'topic',
        read: (id) => db.prepare('SELECT id, project_id, title FROM nodes WHERE id = ?').get(id) || null,
        fields: {
            title: {
                normalize: topicTitle,
                get: (row) => row.title ?? '',
                write: (id, v) => db.prepare('UPDATE nodes SET title = ? WHERE id = ?').run(v, id),
            },
        },
        // A topic's vector is built from its title (curriculumLabel.js).
        afterWrite: () => scheduleNodeSync(),
    },
};

const sameValue = (a, b) => String(a ?? '') === String(b ?? '');

/** What a kind's target looks like to a preview: every field's shown value. */
function viewOf(k, row) {
    const view = {};
    for (const [f, spec] of Object.entries(k.fields)) {
        try { view[f] = spec.get(row); } catch { view[f] = null; }
    }
    return view;
}

function readTarget(kind, targetId) {
    const k = KINDS[kind];
    if (!k) throw new EditError(400, 'Unknown kind of change.');
    const id = Number(targetId);
    if (!Number.isInteger(id) || id <= 0) throw new EditError(400, 'A change needs the id of what it changes.');
    const row = k.read(id);
    if (!row) throw new EditError(404, `That ${k.label} does not exist.`);
    return { k, id, row };
}

/** The current values of a target, as a preview shows them. */
export function currentValues(kind, targetId) {
    const { k, row } = readTarget(kind, targetId);
    return viewOf(k, row);
}

/**
 * Apply a change. `changes` are the proposed values by field; `expect` the
 * values the preview SHOWED for those fields. `projectId`, when given for a
 * topic, must be the topic's own project (the block names both).
 *
 * Returns `{ id, before, after, current }`, or `{ unchanged: true, current }`
 * when every proposed value is already in place. Throws `EditError`.
 */
export function applyAssistantEdit({ kind, targetId, projectId = null, changes, expect = {}, source = null }) {
    const { k, id, row } = readTarget(kind, targetId);
    if (kind === 'topic' && projectId != null && Number(projectId) !== row.project_id) {
        throw new EditError(404, 'That topic is not in that course.');
    }
    if (!changes || typeof changes !== 'object') throw new EditError(400, 'Nothing to change.');
    const next = {};
    const invalid = [];
    for (const [field, raw] of Object.entries(changes)) {
        const spec = k.fields[field];
        if (!spec) { invalid.push(field); continue; }
        const v = spec.normalize(raw, row);
        if (v === null || v === undefined) invalid.push(field);
        else next[field] = v;
    }
    if (invalid.length) throw new EditError(400, `Not a value the app accepts: ${invalid.join(', ')}.`, { fields: invalid });
    if (!Object.keys(next).length) throw new EditError(400, 'Nothing to change.');

    const shown = viewOf(k, row);
    const changed = Object.keys(next).filter(f => !sameValue(shown[f], next[f]));
    if (!changed.length) return { unchanged: true, current: shown };
    const stale = changed.filter(f => !expect || !(f in expect) || !sameValue(expect[f], shown[f]));
    if (stale.length) {
        throw new EditError(409, 'This changed since the preview was drawn.', { stale, current: shown });
    }

    const before = {};
    const after = {};
    let editId = null;
    db.transaction(() => {
        for (const f of changed) {
            const spec = k.fields[f];
            before[f] = spec.snapshot ? spec.snapshot(id, row) : shown[f];
            after[f] = next[f];
            spec.write(id, next[f]);
        }
        // Words a model wrote say so (`generated_by`), as at creation; the
        // learner pressed Apply, but the sentence is still the model's.
        const words = changed.filter(f => k.fields[f].words);
        if (kind === 'project' && words.length) {
            const stamped = addProvenanceFields(row.generated_by, words);
            if (stamped) {
                before.generated_by = row.generated_by ?? null;
                after.generated_by = stamped;
                db.prepare('UPDATE projects SET generated_by = ? WHERE id = ?').run(stamped, id);
            }
        }
        editId = Number(db.prepare(`
            INSERT INTO assistant_edits (kind, target_id, source, before, after, applied_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(kind, id, typeof source === 'string' ? source.slice(0, 80) : null,
            JSON.stringify(before), JSON.stringify(after), nowIso()).lastInsertRowid);
    })();
    k.afterWrite();
    logActivity({ area: 'assistant', event: `assistant.${kind}.applied`, projectId: kind === 'project' ? id : row.project_id, nodeId: kind === 'topic' ? id : null });
    return { id: editId, before: publicSide(before), after: publicSide(after), current: viewOf(k, k.read(id)) };
}

/** A side of an edit as the client sees it: the provenance stamp is bookkeeping. */
function publicSide(side) {
    const { generated_by, ...rest } = side;
    return rest;
}

/**
 * Undo an applied change: every field that still holds what Apply wrote goes
 * back; one changed since is KEPT and named. Returns `{ restored, kept, current }`,
 * `{ alreadyUndone: true }`, or `{ gone: true }` when the target was deleted.
 */
export function undoAssistantEdit(editId) {
    const rec = db.prepare('SELECT * FROM assistant_edits WHERE id = ?').get(Number(editId));
    if (!rec) throw new EditError(404, 'That change is not on record.');
    if (rec.undone_at) return { alreadyUndone: true };
    if (rec.kind === 'link') return undoLink(rec);
    const k = KINDS[rec.kind];
    const row = k?.read(rec.target_id);
    if (!row) return { gone: true };
    const before = JSON.parse(rec.before);
    const after = JSON.parse(rec.after);
    const shown = viewOf(k, row);
    const restored = [];
    const kept = [];
    db.transaction(() => {
        for (const f of Object.keys(after)) {
            if (f === 'generated_by') continue;
            const spec = k.fields[f];
            if (!spec) continue;
            if (!sameValue(shown[f], after[f])) { kept.push(f); continue; }
            if (spec.restore) spec.restore(rec.target_id, before[f]);
            else spec.write(rec.target_id, before[f]);
            restored.push(f);
        }
        // The stamp goes back with the words it was about — unless something
        // stamped the row again since.
        if ('generated_by' in after && restored.some(f => k.fields[f]?.words) && sameValue(row.generated_by, after.generated_by)) {
            db.prepare('UPDATE projects SET generated_by = ? WHERE id = ?').run(before.generated_by ?? null, rec.target_id);
        }
        db.prepare('UPDATE assistant_edits SET undone_at = ? WHERE id = ?').run(nowIso(), rec.id);
    })();
    if (restored.length) k.afterWrite();
    logActivity({ area: 'assistant', event: `assistant.${rec.kind}.undone`, projectId: rec.kind === 'project' ? rec.target_id : row.project_id, nodeId: rec.kind === 'topic' ? rec.target_id : null });
    return { restored, kept, current: viewOf(k, k.read(rec.target_id)) };
}

/**
 * Save a page on a topic: a resource row like the topic's own Saved links.
 * The URL goes through the same scheme check as every other write path
 * (urlSafety.js); the title is the page's own when the link check read one.
 * The same page on the same topic twice is one row (`existed`).
 */
export function saveAssistantLink({ projectId = null, nodeId, url, title = '', source = null }) {
    const node = db.prepare('SELECT id, project_id, is_note FROM nodes WHERE id = ?').get(Number(nodeId));
    if (!node) throw new EditError(404, 'That topic does not exist.');
    if (projectId != null && Number(projectId) !== node.project_id) throw new EditError(404, 'That topic is not in that course.');
    const checked = sanitizeUrl(url);
    if (!checked.ok) throw new EditError(400, `Not a link the app can open: ${checked.reason}.`, { fields: ['url'] });
    const same = db.prepare('SELECT id FROM resources WHERE node_id = ? AND url = ?').get(node.id, checked.url);
    if (same) return { existed: true, resourceId: same.id };
    const name = oneLine(String(title || ''), LINK_TITLE_MAX) ?? checked.url.slice(0, LINK_TITLE_MAX);
    let editId = null;
    let resourceId = null;
    db.transaction(() => {
        const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM resources WHERE node_id = ?').get(node.id).pos;
        resourceId = Number(db.prepare('INSERT INTO resources (node_id, title, url, type, position) VALUES (?, ?, ?, ?, ?)')
            .run(node.id, name, checked.url, 'article', pos).lastInsertRowid);
        editId = Number(db.prepare(`
            INSERT INTO assistant_edits (kind, target_id, source, before, after, applied_at)
            VALUES ('link', ?, ?, '{}', ?, ?)
        `).run(node.id, typeof source === 'string' ? source.slice(0, 80) : null,
            JSON.stringify({ resourceId, url: checked.url, title: name }), nowIso()).lastInsertRowid);
    })();
    logActivity({ area: 'assistant', event: 'assistant.link.applied', projectId: node.project_id, nodeId: node.id });
    return { id: editId, resourceId, url: checked.url, title: name };
}

/** A saved link's Undo removes the row it added, if it is still that link. */
function undoLink(rec) {
    const after = JSON.parse(rec.after);
    const res = db.prepare('SELECT id, url FROM resources WHERE id = ?').get(after.resourceId);
    db.transaction(() => {
        if (res && res.url === after.url) db.prepare('DELETE FROM resources WHERE id = ?').run(res.id);
        db.prepare('UPDATE assistant_edits SET undone_at = ? WHERE id = ?').run(nowIso(), rec.id);
    })();
    logActivity({ area: 'assistant', event: 'assistant.link.undone', nodeId: rec.target_id });
    if (!res) return { gone: true };
    if (res.url !== after.url) return { restored: [], kept: ['url'] };
    return { restored: ['link'], kept: [] };
}

/** The newest change applied from one block of one message, for a preview
 *  redrawn after a reload: `{ id, kind, targetId, before, after, undone }`. */
export function editBySource(source) {
    if (typeof source !== 'string' || !source) return null;
    const rec = db.prepare('SELECT * FROM assistant_edits WHERE source = ? ORDER BY id DESC LIMIT 1').get(source.slice(0, 80));
    if (!rec) return null;
    return {
        id: rec.id, kind: rec.kind, targetId: rec.target_id,
        before: publicSide(JSON.parse(rec.before)), after: publicSide(JSON.parse(rec.after)),
        undone: !!rec.undone_at,
    };
}

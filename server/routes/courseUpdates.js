// Updating an installed course from a newer file of the same course.
//
// The import doors (routes/importExport.js, routes/bundle.js) always make a NEW
// project. These routes instead bring a newer edition INTO the course already
// in the library, updating its rows in place so every id survives and the
// learner's mastery, evidence and card schedule follow without being moved:
//
//   POST /api/course-updates/inspect    what the file would change (nothing written)
//   POST /api/course-updates/commit     apply it, with the learner's choice per conflict
//   GET  /api/course-updates/:id/undo   whether the last update can be taken back
//   POST /api/course-updates/:id/undo   take it back
//
// The decisions are courseMerge.js (pure, no database); the reading and writing
// is courseUpdate.js.
import multer from 'multer';
import JSZip from 'jszip';
import db from '../database.js';
import { isSupportedLanguage } from '../language.js';
import { logActivity } from '../activityLog.js';
import { scheduleNodeSync } from '../nodeEmbeddings.js';
import { scheduleSearchWords } from '../searchWords.js';
import { invalidateProjectLanguage } from '../language.js';
import { assertZipSafe } from '../extract.js';
import { rejectOversizedBody } from '../uploadGuard.js';
import { ImportError, normalizeImportProject, normalizeImportTree } from '../curriculumSchema.js';
import { IMPORT_QUESTION_DEPS } from '../courseFiles.js';
import { BUNDLE_ZIP_LIMITS, BundleRefusal, readBundleCourse, restoreCardMedia, underlying } from '../bundleCourse.js';
import { planCourseUpdate } from '../courseMerge.js';
import {
    applyCourseUpdate, readBase, readFileCourse, readInstalledCourse, undoAvailable, undoLastUpdate,
} from '../courseUpdate.js';
import { KeyedError, errorBody, k, keyed } from '../clientError.js';
import { wrap } from './request.js';
import { routeTable } from './routeTable.js';

const app = routeTable('courseUpdates');

/** A lone bundle's ceiling, the same as the bundle import door's. */
const MAX_UPDATE_UPLOAD_BYTES = 200 * 1024 * 1024;
const updateUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPDATE_UPLOAD_BYTES } });

/** A file this door cannot read; the message is the answer, the status 400. */
class UpdateRefusal extends KeyedError {}

const isZip = (buf) => buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;

/**
 * The uploaded file, normalized by the same code as the import doors.
 * `withMedia` restores a bundle's card media to disk (commit only: inspect
 * writes nothing, and compares media by name).
 */
async function readUpload(file, { withMedia = false } = {}) {
    if (!file) throw new UpdateRefusal('No file uploaded');
    if (isZip(file.buffer)) {
        let zip;
        try {
            zip = await JSZip.loadAsync(file.buffer);
            assertZipSafe(zip, BUNDLE_ZIP_LIMITS);
        } catch (e) {
            throw new BundleRefusal(`Invalid bundle: ${underlying(e)}`);
        }
        const { manifest, project, nodes, warnings } = await readBundleCourse(zip);
        // The import door reads a bundle with no tree as an empty course; here it
        // would read as every topic removed.
        if (!Array.isArray(manifest.nodes)) throw new UpdateRefusal('Invalid bundle: manifest.json has no course tree ("nodes").');
        let mediaByName = null;
        if (withMedia) {
            let spent = 0;
            const limit = BUNDLE_ZIP_LIMITS.maxTotalBytes;
            const charge = (n) => {
                spent += n;
                if (spent > limit) throw new Error(`this bundle expands to more than ${Math.round(limit / 1024 / 1024)} MB and is being refused as a compression bomb`);
            };
            mediaByName = await restoreCardMedia(zip, nodes, charge, warnings);
        }
        return { project, nodes, exportedAt: manifest.exported_at, bundle: true, mediaByName, warnings };
    }
    let body;
    try {
        body = JSON.parse(file.buffer.toString('utf8'));
    } catch {
        throw new UpdateRefusal('This file is not a course file: it is neither a course export nor a .studyvault bundle.');
    }
    try {
        const header = normalizeImportProject(body?.project, { isSupportedLanguage });
        const tree = normalizeImportTree(body?.nodes, IMPORT_QUESTION_DEPS);
        return { project: header.project, nodes: tree.nodes, exportedAt: body?.exported_at, bundle: false, mediaByName: null, warnings: [...header.warnings, ...tree.warnings] };
    } catch (err) {
        if (err instanceof ImportError) throw new UpdateRefusal(err.message);
        throw err;
    }
}

/** The installed course this file is a newer edition of, by the course's id. */
const twinOf = (project) => (project.uuid ? db.prepare('SELECT id, name, version FROM live_projects projects WHERE uuid = ?').get(project.uuid) : null) || null;

/** Plan the update of `twin` from the read file. */
function plan(twin, read, choices = {}) {
    const local = readInstalledCourse(twin.id);
    const upstream = readFileCourse(read.project, read.nodes, { exportedAt: read.exportedAt, withMedia: read.bundle });
    const base = readBase(twin.id);
    return { local, upstream, base, plan: planCourseUpdate({ upstream, local, base, choices }) };
}

const SHOWN_FIRST = ['question', 'options', 'items', 'tokens', 'correct_answer', 'explanation'];
const asText = (v) => (Array.isArray(v) ? v.map(asText).join(' · ') : v && typeof v === 'object' ? JSON.stringify(v) : String(v ?? ''));
/**
 * A question as lines a learner can compare: what it asks, its choices, its
 * answer (marked ✓), its explanation, then anything else it carries. Two
 * questions that differ only in their answer read differently.
 */
function questionText(q) {
    if (!q || typeof q !== 'object') return asText(q);
    const lines = [];
    for (const f of SHOWN_FIRST) {
        if (q[f] == null || q[f] === '') continue;
        lines.push(f === 'correct_answer' ? `✓ ${asText(q[f])}` : asText(q[f]));
    }
    for (const f of Object.keys(q).sort()) {
        if (SHOWN_FIRST.includes(f) || f === 'type' || q[f] == null || q[f] === '') continue;
        lines.push(asText(q[f]));
    }
    return lines.join('\n');
}

/**
 * A value as the preview shows it: text as it is, a question as its lines,
 * a parent as its topic's title, a card's media as its file names.
 */
function display(field, value, titleOf) {
    if (value == null) return null;
    if (field === 'parent') return titleOf(value);
    if (field === 'is_note') return value ? 'note' : 'topic';
    if (field === 'media') {
        const names = [...(value.front || []), ...(value.back || [])]
            .map(m => (typeof m === 'string' ? m : m?.name ?? '')).filter(Boolean);
        return names.length ? names.join(', ') : null;
    }
    if (field === 'content') return questionText(value);
    if (field === 'deleted') return null;
    if (typeof value === 'object') return JSON.stringify(value).slice(0, 400);
    return String(value);
}

const PREVIEW_TEXT_MAX = 1200;
const PREVIEW_DIFFS = 200;
/** Cut at a whole character, never inside a surrogate pair. */
const clip = (s) => {
    if (s == null) return null;
    const chars = Array.from(s);
    return chars.length > PREVIEW_TEXT_MAX ? `${chars.slice(0, PREVIEW_TEXT_MAX).join('')}…` : s;
};

function preview(twin, read, p) {
    const titles = new Map();
    for (const e of p.local.entities) if (e.kind === 'node') titles.set(e.uuid, e.label);
    for (const e of p.upstream.entities) if (e.kind === 'node' && e.uuid && !titles.has(e.uuid)) titles.set(e.uuid, e.label);
    // A topic the update adds has no uuid yet: the plan names it `new:<ref>`, and its label is the file's title.
    const newTitles = new Map();
    for (const e of p.upstream.entities) if (e.kind === 'node') newTitles.set(`new:${e.ref}`, e.label);
    const titleOf = (u) => (u == null ? null : titles.get(u) ?? newTitles.get(u) ?? null);
    const r = p.plan;
    return {
        match: { projectId: twin.id, name: twin.name, version: twin.version ?? null, fileVersion: read.project.version ?? null },
        refused: r.refused,
        message: r.refused === 'older'
            ? 'This file is an older edition than the course you have, so it was not applied.'
            : null,
        installedAt: p.base.exportedAt,
        fileAt: p.upstream.exportedAt,
        summary: r.summary ?? null,
        items: r.items ? {
            ...r.items,
            // Before and after as the learner reads them, long text cut to what a preview shows.
            // Only the first PREVIEW_DIFFS carry their texts, so a big edition stays a small answer.
            changed: r.items.changed.map((it, i) => {
                const { diff, ...rest } = it;
                if (i >= PREVIEW_DIFFS) return rest;
                return {
                    ...rest,
                    diff: (diff || [])
                        .map(d => ({ field: d.field, from: clip(display(d.field, d.from, titleOf)), to: clip(display(d.field, d.to, titleOf)) }))
                        // Two values that read the same (cut at the same place, say) show no change.
                        .filter(d => d.from !== d.to),
                };
            }),
            // Where it goes: null is the top of the course; a place that cannot be named is left out.
            moved: r.items.moved.map(it => {
                const { to, ...rest } = it;
                const named = !to ? undefined
                    : 'title' in to ? to.title ?? undefined
                        : to.uuid == null ? null : titleOf(to.uuid) ?? undefined;
                return named === undefined ? rest : { ...rest, to: named };
            }),
        } : null,
        conflicts: (r.conflicts || []).map(c => ({
            key: c.key, kind: c.kind, field: c.field, label: c.label ?? null, where: c.where ?? null,
            mine: clip(display(c.field, c.mine, titleOf)),
            file: c.field === 'deleted' ? null : clip(display(c.field, c.file, titleOf)),
            unknownBase: !!c.unknownBase,
        })),
        warnings: read.warnings,
    };
}

const parseChoices = (raw) => {
    if (raw == null || raw === '') return {};
    let v;
    try { v = JSON.parse(raw); } catch { throw new UpdateRefusal('Invalid choices'); }
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new UpdateRefusal('Invalid choices');
    const out = {};
    for (const [k, c] of Object.entries(v)) if (c === 'file' || c === 'mine') out[String(k).slice(0, 200)] = c;
    return out;
};

const answerRefusal = (res, err) => {
    if (err instanceof UpdateRefusal || err instanceof BundleRefusal) {
        res.status(400).json(errorBody(err, 400));
        return true;
    }
    return false;
};

const UPLOAD_GUARD = rejectOversizedBody(MAX_UPDATE_UPLOAD_BYTES + 8 * 1024 * 1024);

app.post('/api/course-updates/inspect', UPLOAD_GUARD, updateUpload.single('file'), wrap(async (req, res) => {
    try {
        const read = await readUpload(req.file);
        const twin = twinOf(read.project);
        // Not a course in this library: the import door's job, a new project.
        if (!twin) return res.json({ match: null, refused: null, summary: null });
        return res.json(preview(twin, read, plan(twin, read)));
    } catch (err) {
        if (answerRefusal(res, err)) return;
        throw err;
    }
}));

app.post('/api/course-updates/commit', UPLOAD_GUARD, updateUpload.single('file'), wrap(async (req, res) => {
    try {
        const projectId = Number(req.body?.projectId);
        if (!Number.isInteger(projectId) || projectId <= 0) throw new UpdateRefusal('projectId is required');
        const choices = parseChoices(req.body?.choices);
        const read = await readUpload(req.file, { withMedia: true });
        const twin = twinOf(read.project);
        // The preview was of THIS course; a file of another one is refused
        // rather than written over the wrong course.
        if (!twin || twin.id !== projectId) {
            return res.status(409).json(keyed('This file is not an edition of that course.'));
        }
        const p = plan(twin, read, choices);
        if (p.plan.refused) return res.status(409).json(preview(twin, read, p));
        // A file that changes nothing writes nothing, so the last real update keeps its undo.
        if (p.plan.summary.nothing) return res.json({ projectId: twin.id, summary: p.plan.summary, undo: undoAvailable(twin.id) });
        const started = Date.now();
        const { touchedNodes } = applyCourseUpdate(twin.id, p.plan, { mediaByName: read.mediaByName });
        invalidateProjectLanguage(twin.id);
        scheduleNodeSync();
        scheduleSearchWords();
        const s = p.plan.summary;
        // Counts only, never the thing counted (activity-log-gates.mjs).
        logActivity({
            area: 'project',
            event: 'project.updated_from_file',
            projectId: twin.id,
            ms: Date.now() - started,
            level: s.conflicts ? 'warn' : 'info',
            detail: `${s.changed} changed · ${s.added} added · ${s.removed} removed · ${s.keptRemoved} kept · ${s.conflicts} conflict(s) · ${touchedNodes.length} topic(s) touched`,
        });
        return res.json({ projectId: twin.id, summary: s, undo: undoAvailable(twin.id) });
    } catch (err) {
        if (answerRefusal(res, err)) return;
        throw err;
    }
}));

const projectParam = (req, res) => {
    const id = Number(req.params.projectId);
    if (!Number.isInteger(id) || id <= 0 || !db.prepare('SELECT 1 FROM live_projects projects WHERE id = ?').get(id)) {
        res.status(404).json(keyed('Project not found'));
        return null;
    }
    return id;
};

app.get('/api/course-updates/:projectId/undo', (req, res) => {
    const id = projectParam(req, res);
    if (id == null) return;
    res.json(undoAvailable(id));
});

app.post('/api/course-updates/:projectId/undo', (req, res) => {
    const id = projectParam(req, res);
    if (id == null) return;
    const done = undoLastUpdate(id);
    if (!done.ok) return res.status(409).json(keyed(done.reason ?? k('There is no update of this course to undo.')));
    invalidateProjectLanguage(id);
    scheduleNodeSync();
    scheduleSearchWords();
    logActivity({ area: 'project', event: 'project.update_undone', projectId: id });
    res.json({ ok: true, undo: undoAvailable(id) });
});

export const routes = app.takeRoutes();

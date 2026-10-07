// /api/export/:projectId and /api/import: the plain JSON course file.
import db from '../database.js';
import { isSupportedLanguage } from '../language.js';
import { logActivity } from '../activityLog.js';
import { scheduleNodeSync } from '../nodeEmbeddings.js';
import { projectTeaches, setProjectTeaches } from '../nodeRole.js';
import { ImportError, normalizeImportProject, normalizeImportTree } from '../curriculumSchema.js';
import {
    applyImportedCardDial, claimUuid, exportedFlashcards, exportedQuestions, IMPORT_QUESTION_DEPS,
    insertImportedTree, newPerDaySetting,
} from '../courseFiles.js';
import { nextProjectPosition } from './projectRows.js';
import { routeTable } from './routeTable.js';

const app = routeTable('importExport');

app.get('/api/export/:projectId', (req, res) => {
    const { includeNotes, includeResources, includeProgress } = req.query;
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const allNodes = db.prepare('SELECT * FROM nodes WHERE project_id = ? ORDER BY position').all(req.params.projectId);
    const buildExportTree = (parentId) => {
        return allNodes
            .filter(n => n.parent_id === parentId)
            .map(n => {
                const node = {
                    title: n.title,
                    uuid: n.uuid || undefined,
                    description: n.description || undefined,
                    notes: includeNotes === 'true' && n.notes ? n.notes : undefined,
                    status: includeProgress === 'true' ? n.status : undefined,
                    is_note: n.is_note ? true : undefined,
                    // Only when it is not a topic: a re-imported deck's stage
                    // must not come back as something to teach.
                    role: n.role && n.role !== 'topic' ? n.role : undefined,
                    questions: exportedQuestions(n.id),
                    flashcards: exportedFlashcards(n.id),
                };
                if (includeResources === 'true') {
                    const resources = db.prepare('SELECT uuid, title, url, type, completed FROM resources WHERE node_id = ? ORDER BY position').all(n.id);
                    if (resources.length > 0) {
                        node.resources = resources.map(r => {
                            const resource = { title: r.title };
                            if (r.uuid) resource.uuid = r.uuid;
                            if (r.url) resource.url = r.url;
                            if (r.type && r.type !== 'link') resource.type = r.type;
                            if (includeProgress === 'true' && r.completed) resource.completed = true;
                            return resource;
                        });
                    }
                }
                const children = buildExportTree(n.id);
                if (children.length > 0) node.children = children;
                Object.keys(node).forEach(key => { if (node[key] === undefined) delete node[key]; });
                return node;
            });
    };
    // No top-level `version`. It read "2.0" for years, nothing ever parsed it,
    // and there was never a v1 to branch on — a format version that no reader
    // consults is decoration that invites people to bump it. If the container
    // ever does change incompatibly, the *absence* of a marker is the signal
    // that a file is one of these, and a marker can be added then, by a reader
    // that actually exists.
    res.json({
        exported_at: new Date().toISOString(),
        // uuid and content_language travel with the curriculum. The language,
        // because a shared Dutch course that imports as "follow the material"
        // has its lessons authored in whatever the importer's model guesses from
        // the titles. The uuid, because it is the only thing that makes "is this
        // the course I already have, or a different one?" answerable at all —
        // and `version` is the author's answer to "which edition?".
        project: {
            name: project.name,
            uuid: project.uuid || undefined,
            version: project.version || undefined,
            description: project.description || undefined,
            color: project.color,
            icon: project.icon,
            content_language: project.content_language || undefined,
            // The language the course teaches, when it is not the one it is
            // explained in: a copy without it would translate the Dutch away.
            learning_language: project.learning_language || undefined,
            // The same author's dial the bundle carries, or a deck that goes
            // out and back as JSON studies at the importer's default pace.
            new_per_day: newPerDaySetting(project.id),
            // The EFFECTIVE switch, so a copy teaches exactly when this one
            // does, whatever the importing machine would have defaulted to.
            teaches: projectTeaches(project.id),
        },
        nodes: buildExportTree(null)
    });
});

app.post('/api/import', (req, res) => {
    let normalized;
    try {
        const header = normalizeImportProject(req.body?.project, { isSupportedLanguage });
        const tree = normalizeImportTree(req.body?.nodes, IMPORT_QUESTION_DEPS);
        normalized = {
            project: header.project, nodes: tree.nodes, questionCount: tree.questionCount, cardCount: tree.cardCount,
            warnings: [...header.warnings, ...tree.warnings],
        };
    } catch (err) {
        if (err instanceof ImportError) return res.status(400).json({ error: err.message });
        throw err;
    }

    const { project, nodes, questionCount, cardCount, warnings } = normalized;
    // The plain JSON door carries no bytes, so a card's media can only ever be
    // a name here. Said once, up front, rather than silently importing a
    // listening course as text cards.
    let namedMedia = 0;
    const countMedia = (list) => list.forEach(n => {
        for (const c of n.flashcards) if (c.media) namedMedia += (c.media.front?.length || 0) + (c.media.back?.length || 0);
        countMedia(n.children);
    });
    countMedia(nodes);
    if (namedMedia) warnings.push(`${namedMedia} card media file(s) were named but a plain JSON file carries no media — import the course as a .studyvault bundle to bring them.`);

    // Importing always creates a NEW project — merging an updated edition into a
    // curriculum the learner has already made progress against is a different
    // feature, and doing it implicitly would be the wrong default. But staying
    // silent about it means quietly ending up with two copies of the same
    // course, so it is reported.
    const twin = project.uuid ? db.prepare('SELECT id, name, version FROM projects WHERE uuid = ?').get(project.uuid) : null;
    if (twin) {
        const editions = project.version && twin.version && project.version !== twin.version
            ? ` (you have ${twin.version}, this file is ${project.version})`
            : '';
        warnings.push(`You already have this course as "${twin.name}"${editions} — it was imported as a separate copy.`);
    }

    const transaction = db.transaction(() => {
        const projectResult = db.prepare(`
            INSERT INTO projects (name, description, color, icon, position, content_language, learning_language, version, uuid)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(project.name, project.description, project.color, project.icon, nextProjectPosition(),
            project.content_language, project.learning_language, project.version, claimUuid('projects', project.uuid));
        const newProjectId = projectResult.lastInsertRowid;
        insertImportedTree(newProjectId, nodes);
        applyImportedCardDial(newProjectId, project, cardCount);
        if (typeof project.teaches === 'boolean') setProjectTeaches(newProjectId, project.teaches);
        return newProjectId;
    });

    try {
        const newProjectId = transaction();
        const newProject = db.prepare('SELECT * FROM projects WHERE id = ?').get(newProjectId);
        console.log(`Successfully imported project "${newProject.name}" with id ${newProjectId}${questionCount ? ` (${questionCount} question(s))` : ''}${cardCount ? ` (${cardCount} card(s))` : ''}${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
        scheduleNodeSync();   // map the imported curriculum into the topic space
        // Counts only, never the thing counted: `activity-log-gates.mjs` scans
        // every call site below for the vocabulary a learner's own words would
        // arrive in, and it is right to — this log is meant to be handable to a
        // stranger.
        logActivity({
            area: 'project',
            event: 'project.imported',
            projectId: newProjectId,
            level: warnings.length ? 'warn' : 'info',
            detail: `curriculum · ${questionCount} graded item(s) · ${cardCount} card(s) · ${warnings.length} warning(s)`,
        });
        res.json({ ...newProject, questionCount, cardCount, warnings });
    } catch (err) {
        console.error('Import error:', err);
        res.status(400).json({ error: `Database error: ${err.message}` });
    }
});

export const routes = app.takeRoutes();

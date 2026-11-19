// Project row helpers shared by the route files.
import db from '../database.js';

// DB helpers

// A new project goes to the end of the list. Prepared once: the import doors
// run it inside a transaction, so re-preparing it there recompiled the same SQL
// on every imported course.
const nextProjectPositionStmt = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 as pos FROM projects');
const nextProjectPosition = () => nextProjectPositionStmt.get().pos;

// The project lookup every :projectId route opens with. Returns the row, or
// sends the 404 and returns null so the caller can `if (!project) return;`.
const projectByIdStmt = db.prepare('SELECT id FROM projects WHERE id = ?');
function requireProject(req, res) {
    const id = req.params.projectId ?? req.params.id;
    const project = projectByIdStmt.get(id);
    if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return null;
    }
    return project;
}

// The fields a create or an edit stores as sent. SQLite's column types stop
// none of it: `name: null` reached the NOT NULL constraint as a 500, `""` and
// `"   "` were saved as a nameless course, and a 2 MB colour or icon came back
// inside every GET /api/projects. A colour is a CSS colour and an icon a name
// from the picker, so 64 characters is room for any real one. Every door that
// takes these fields from a request asks this: the plain create, the edit, the
// AI create (routes/createProject.js) and the Anki import (routes/anki.js).
// A course file's fields are bounded by its reader instead (curriculumSchema.js
// `token`), and a short course maps them to the palette (projectFields.js).
// Returns the refusal, or null.
const PROJECT_TOKEN_MAX = 64;
function projectFieldError({ name, description, color, icon, position }) {
    if (name !== undefined && (typeof name !== 'string' || !name.trim())) return 'A project needs a name';
    if (description !== undefined && description !== null && typeof description !== 'string') return 'description must be text';
    // Not null or blank either: every reader of a project expects a colour and
    // an icon, and a PUT stored `null` as sent.
    for (const [label, v] of [['color', color], ['icon', icon]]) {
        if (v !== undefined && (typeof v !== 'string' || !v.trim() || v.length > PROJECT_TOKEN_MAX)) {
            return `${label} must be text of at most ${PROJECT_TOKEN_MAX} characters`;
        }
    }
    if (position !== undefined && !(Number.isSafeInteger(position) && position >= 0)) return 'position must be a whole number, 0 or more';
    return null;
}

export { nextProjectPosition, projectFieldError, requireProject };

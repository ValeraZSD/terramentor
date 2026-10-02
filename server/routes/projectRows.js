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

export { nextProjectPosition, requireProject };

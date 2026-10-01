// Server-sent-event plumbing for background tasks, and the origin a task records.
import db from '../database.js';
import * as tasks from '../tasks.js';

// BACKGROUND AI TASKS (see server/tasks.js)
//
// Every AI generation runs as a background task; the SSE responses below are
// mere subscriptions. These endpoints expose the registry to the UI: the
// global task dock follows /api/tasks/stream, a reopened panel reattaches via
// /api/tasks/:id/stream, and cancel/dismiss are explicit actions — a dropped
// connection never cancels anything.

// Shared SSE plumbing for task subscriptions: disable socket timeouts (a
// thinking model can be silent for minutes), keepalive comments, and a write
// that no-ops once the socket is gone. Mirrors startAiStream, minus the
// abort-on-disconnect semantics (detaching must not cancel the task).
function startSseResponse(req, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    req.setTimeout(0);
    res.setTimeout(0);
    if (res.socket) res.socket.setTimeout(0);

    let keepAlive = setInterval(() => {
        if (!res.writableEnded) res.write(': keepalive\n\n');
    }, 15000);
    const stopKeepAlive = () => {
        if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
    };
    const write = (obj) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    const end = () => {
        stopKeepAlive();
        if (!res.writableEnded) { try { res.end(); } catch { } }
    };
    return { write, end, stopKeepAlive };
}

// Attach an HTTP response to a task's event stream. Replays accumulated
// output first (so a reattach shows everything generated so far), then
// follows live until the terminal done/error/cancelled frame.
function attachTaskStream(req, res, taskId) {
    const { write, end, stopKeepAlive } = startSseResponse(req, res);
    const unsub = tasks.subscribe(taskId, (evt) => {
        write(evt);
        if (evt.done || evt.error || evt.cancelled) end();
    });
    if (!unsub) {
        write({ error: 'Task not found — it may have already finished and expired.' });
        return end();
    }
    // Client went away: detach only. The task keeps running; the dock keeps
    // tracking it; a later subscriber replays from the accumulators.
    res.on('close', () => { stopKeepAlive(); unsub(); });
}

// Project display fields for a node-scoped task chip (dock shows the
// project's colour + name next to the label).
function nodeTaskInfo(nodeId) {
    return db.prepare(`
        SELECT n.id, n.title, n.project_id as projectId, p.name as projectName, p.color as projectColor
        FROM nodes n JOIN projects p ON p.id = n.project_id
        WHERE n.id = ?
    `).get(nodeId);
}

/**
 * Where a request says it came from, else where this endpoint's own screen is.
 * The client knows the surface (the assistant, a feed card, a topic's Overview)
 * and the server knows the endpoint; `normalizeOrigin` in tasks.js keeps only a
 * closed vocabulary and integer ids, so a request cannot put text on a record.
 */
function requestOrigin(req, fallback = null) {
    return tasks.normalizeOrigin(req.body?.origin) || fallback;
}

/**
 * A visual build's origin plus the task fields its topic supplies. A drawing
 * repaired under a topic's Overview belongs to that topic's course, and the
 * chip's dot is the only thing that says which; one built under an assistant
 * answer belongs to no course and names none. The project is read from the
 * node rather than trusted from the request.
 */
function visualTaskOrigin(req) {
    const origin = requestOrigin(req);
    if (!origin?.nodeId) return { origin, fields: {} };
    const info = nodeTaskInfo(origin.nodeId);
    if (!info) {
        delete origin.nodeId;
        delete origin.projectId;
        return { origin, fields: {} };
    }
    origin.projectId = info.projectId;
    return {
        origin,
        fields: { nodeId: info.id, projectId: info.projectId, projectName: info.projectName, projectColor: info.projectColor },
    };
}

export { attachTaskStream, nodeTaskInfo, requestOrigin, startSseResponse, visualTaskOrigin };

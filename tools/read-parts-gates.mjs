#!/usr/bin/env node
/**
 * tools/read-parts-gates.mjs — a topic picked up again shows where it starts.
 *
 * Run:  node tools/read-parts-gates.mjs
 *
 * Two faults an outside review found on 1 Oct 2026, on a copy of the real
 * library:
 *
 * 1. The stream serves only UNREAD parts, so a topic left after part 2 came
 *    back as "Part 3 of 3", a part that says "the wavefront picture from
 *    Part 1 still holds" with nothing on the screen leading to Part 1. The
 *    first unread part now carries `readBefore` (titles and dates of the parts
 *    read earlier) and `/api/feed/nodes/:id/read-parts` hands their text over
 *    when the learner opens them. And the 30-day sweep no longer deletes a
 *    read part of an OPEN topic: a missing part is one `nextMissing` writes
 *    again and serves as new.
 *
 * 2. "Next up" on the course dashboard walked the course by `position`, which
 *    is a place among SIBLINGS, so the first topic of every section came
 *    before the rest. It named a topic due 14 Aug while Start Studying opened
 *    the stream on one due 8 Aug. The hero is now the stream's first topic.
 *
 * Deterministic: a scratch database, no model, no network. The sweep is a
 * startup step, so it is proved by booting a SECOND process against the file.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'read-parts-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const eq = (label, actual, expected) =>
    check(label, JSON.stringify(actual) === JSON.stringify(expected),
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const db = (await import('../server/database.js')).default;
const { ROLE_TOPIC } = await import('../server/nodeRole.js');
const { composeFeed, readLessonParts, getFocusNodes } = await import('../server/feed.js');
const { feedRoutes } = await import('../server/routes/feed.js');
const { routes: dashboardRoutes } = await import('../server/routes/studyDashboard.js');

if (db.name !== process.env.DB_PATH) {
    console.log(`refusing to run: the database is ${db.name}, not the scratch file`);
    process.exit(1);
}
db.prepare("INSERT INTO settings (key, value) VALUES ('ai_enabled', 'false') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().split('T')[0];
const mkProject = (name) => Number(db.prepare(
    'INSERT INTO projects (name, position) VALUES (?, 0)').run(name).lastInsertRowid);
const mkNode = (projectId, parentId, title, position, extra = {}) => Number(db.prepare(`
    INSERT INTO nodes (project_id, parent_id, title, position, role, scheduled_start, scheduled_end, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run(projectId, parentId, title, position, ROLE_TOPIC,
    extra.start ?? null, extra.end ?? null, extra.description ?? '').lastInsertRowid);
const PARTS = ['Waves in a medium', 'The moving source', 'Light has no medium'];
const mkPlan = (nodeId) => db.prepare(`
    INSERT INTO feed_items (node_id, kind, seq, content, status) VALUES (?, 'plan', 0, ?, 'ready')
`).run(nodeId, JSON.stringify({ parts: PARTS.map(title => ({ title })) }));
const mkLesson = (nodeId, part, status, consumedAt = null) => Number(db.prepare(`
    INSERT INTO feed_items (node_id, kind, seq, content, status, meta, consumed_at) VALUES (?, 'lesson', ?, ?, ?, ?, ?)
`).run(nodeId, part * 2 - 1, `## ${PARTS[part - 1]}\n\nText of part ${part}.`, status,
    JSON.stringify({ partIndex: part, partCount: PARTS.length, partTitle: PARTS[part - 1] }), consumedAt).lastInsertRowid);
const lessons = (items, nodeId) => items.filter(c => c.kind === 'lesson' && c.nodeId === nodeId);

console.log('\n--- a topic picked up at part 3 offers parts 1 and 2 ---');
const course = mkProject('Physics');
const section = mkNode(course, null, 'Waves', 0);
const doppler = mkNode(course, section, 'Doppler', 0);
mkPlan(doppler);
const read1 = new Date(Date.now() - 5 * 86400000).toISOString();
const read2 = new Date(Date.now() - 4 * 86400000).toISOString();
mkLesson(doppler, 1, 'consumed', read1);
mkLesson(doppler, 2, 'consumed', read2);
const part3 = mkLesson(doppler, 3, 'ready');
{
    const { items } = composeFeed({ nodeId: doppler });
    const [first] = lessons(items, doppler);
    eq('the stream opens on part 3', first?.partIndex, 3);
    eq('…and names the parts read before it, in order',
        first?.readBefore?.map(p => [p.partIndex, p.partTitle]), [[1, PARTS[0]], [2, PARTS[1]]]);
    eq('…with when each was read', first?.readBefore?.map(p => p.readAt), [read1, read2]);
    check('…but not their text, which is fetched on demand',
        (first?.readBefore ?? []).every(p => !('markdown' in p)));
    const texts = readLessonParts(doppler, 3);
    eq('the read parts come back with their text, in order',
        texts.map(p => p.markdown), [`## ${PARTS[0]}\n\nText of part 1.`, `## ${PARTS[1]}\n\nText of part 2.`]);
    eq('…and only those before the part asked about', readLessonParts(doppler, 2).map(p => p.partIndex), [1]);

    // The route: what LessonCard actually calls.
    const get = feedRoutes.calls.find(c => c.method === 'get' && c.args[0] === '/api/feed/nodes/:nodeId/read-parts');
    const call = (nodeId, before) => {
        let status = 200, body = null;
        const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
        get.args.at(-1)({ params: { nodeId: String(nodeId) }, query: { before: String(before) } }, res);
        return { status, body };
    };
    check('the read-parts route is registered', !!get);
    if (get) {
        const ok = call(doppler, 3);
        eq('…answers with the two parts', ok.body?.parts?.map(p => p.partIndex), [1, 2]);
        eq('…refuses a part with nothing before it', call(doppler, 1).status, 400);
        eq('…and a non-numeric id', call('x', 3).status, 400);
    }

    const page = composeFeed({ nodeId: doppler, excludeKeys: new Set([`fi-${part3}`]) });
    check('a part the client already holds is not offered twice',
        lessons(page.items, doppler).every(c => !c.readBefore));
}

console.log('\n--- …and nothing is offered where nothing was skipped ---');
{
    const fresh = mkNode(course, section, 'Beats', 1);
    mkPlan(fresh);
    mkLesson(fresh, 1, 'ready');
    mkLesson(fresh, 2, 'ready');
    const ls = lessons(composeFeed({ nodeId: fresh }).items, fresh);
    eq('a topic that starts at part 1 serves parts 1 and 2', ls.map(c => c.partIndex), [1, 2]);
    check('…and neither carries an offer (part 2 follows part 1 on screen)', ls.every(c => !c.readBefore));

    const resumed = mkNode(course, section, 'Lenses', 4);
    mkPlan(resumed);
    mkLesson(resumed, 1, 'consumed', read1);
    mkLesson(resumed, 2, 'ready');
    mkLesson(resumed, 3, 'ready');
    const rs = lessons(composeFeed({ nodeId: resumed }).items, resumed);
    eq('picked up at part 2: part 2 offers part 1', rs.map(c => c.readBefore?.map(p => p.partIndex) ?? null), [[1], null]);
}

console.log('\n--- "Next up" is where Start Studying begins ---');
{
    // Two sections. The first topic of section 2 is overdue by a few days; a
    // topic further down section 1 has been overdue longer. A walk by
    // `position` meets section 2's head (position 0) before section 1's third
    // topic (position 2) — the fixture must discriminate, or it proves nothing.
    const p = mkProject('Ordering');
    const s1 = mkNode(p, null, 'Section 1', 0);
    const s2 = mkNode(p, null, 'Section 2', 1);
    mkNode(p, s1, 'S1 done', 0, { start: day(-30), end: day(-20) });
    mkNode(p, s1, 'S1 later', 1, { start: day(5), end: day(6) });
    const longOverdue = mkNode(p, s1, 'S1 overdue since long', 2, { start: day(-12), end: day(-10) });
    const recentOverdue = mkNode(p, s2, 'S2 overdue lately', 0, { start: day(-6), end: day(-5) });
    db.prepare("UPDATE nodes SET status = 'completed' WHERE title = 'S1 done'").run();
    db.prepare('UPDATE projects SET start_date = ?, deadline = ? WHERE id = ?').run(day(-40), day(40), p);

    const byPosition = db.prepare(`
        SELECT id FROM nodes WHERE project_id = ? AND is_note = 0 AND status <> 'completed'
          AND scheduled_end < ? AND parent_id IS NOT NULL ORDER BY position
    `).all(p, day(0)).map(r => r.id);
    eq('control: the pre-fix walk by position meets the recent one first', byPosition[0], recentOverdue);

    const get = dashboardRoutes.calls.find(c => c.method === 'get' && c.args[0] === '/api/projects/:projectId/study-dashboard');
    let body = null;
    get.args.at(-1)({ params: { projectId: String(p) } }, { status() { return this; }, json(b) { body = b; return this; } });
    const streamFirst = getFocusNodes({ projectId: p }).focus[0]?.nodeId;
    eq('the course stream starts on the longest-overdue topic', streamFirst, longOverdue);
    eq('…and "Next up" names that same topic', body?.heroTask?.id, streamFirst);
}

console.log('\n--- a read part of an open topic outlives the 30-day sweep ---');
{
    const old = new Date(Date.now() - 40 * 86400000).toISOString();
    const keep = mkNode(course, section, 'Left for a month', 2);
    const keptLesson = mkLesson(keep, 1, 'consumed', old);
    const sweptQuestion = Number(db.prepare(`
        INSERT INTO feed_items (node_id, kind, seq, content, status, consumed_at) VALUES (?, 'question', 2, '{}', 'consumed', ?)
    `).run(keep, old).lastInsertRowid);
    const closed = mkNode(course, section, 'Finished', 3);
    const closedLesson = mkLesson(closed, 1, 'consumed', old);
    db.prepare("UPDATE nodes SET status = 'completed' WHERE id = ?").run(closed);
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    check('control: the read part is past the sweep\'s cutoff', old < cutoff);

    const boot = `await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'server', 'database.js')).href)}); process.exit(0);`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', boot], {
        cwd: repoRoot, encoding: 'utf8', timeout: 60_000, env: { ...process.env },
    });
    check('a second process boots against the same library', run.status === 0, (run.stderr || '').slice(0, 300));
    const exists = (id) => !!db.prepare('SELECT 1 FROM feed_items WHERE id = ?').get(id);
    check('the open topic\'s read lesson part is kept', exists(keptLesson));
    check('…its answered question is still swept (the comparison is live)', !exists(sweptQuestion));
    check('…and a finished topic\'s whole cache still goes', !exists(closedLesson));
}

try { db.close(); } catch { /* already closed */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a leftover temp dir is not a failure */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

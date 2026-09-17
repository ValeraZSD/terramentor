/**
 * Re-author cached feed lessons for chosen topics.
 *
 * feed_items is a CACHE, so anything already in it was written by whatever
 * prompts and validators existed at the time. After a change to either, the old
 * rows do not improve on their own — the generator only ever fills gaps. This
 * purges a topic's cached sequence and rebuilds it through the current pipeline.
 *
 * Usage (server must NOT be running — it writes to the same SQLite file):
 *   node tools/feed-regen.mjs --list
 *   node tools/feed-regen.mjs 11313 11314 12565
 *   node tools/feed-regen.mjs --all            # every node that has a cached plan
 *   node tools/feed-regen.mjs --dry-run 11313  # show what would be purged
 *   node tools/feed-regen.mjs --restore 11314  # put back what a killed run purged
 *
 * A rebuild is atomic from the learner's side: the old rows are held (and
 * mirrored to a temp file) until the new ones land, and a failure puts them
 * back. Only a hard kill needs --restore.
 *
 * Mastery evidence lives in mastery_evidence, not here, so re-authoring a topic
 * never touches what the learner has proved.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import db from '../server/database.js';
import { generateForNode } from '../server/feedGen.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const all = args.includes('--all');
const list = args.includes('--list');
const restoreOnly = args.includes('--restore');
const ids = args.filter(a => /^\d+$/.test(a)).map(Number);

function plannedNodes() {
    return db.prepare(`
        SELECT DISTINCT fi.node_id AS id, n.title, p.name AS project
        FROM feed_items fi
        JOIN nodes n ON n.id = fi.node_id
        JOIN projects p ON p.id = n.project_id
        ORDER BY p.id, fi.node_id
    `).all();
}

function summarise(nodeId) {
    return db.prepare(`
        SELECT kind, COUNT(*) AS c FROM feed_items WHERE node_id = ? GROUP BY kind
    `).all(nodeId).map(r => `${r.c} ${r.kind}`).join(', ') || 'nothing cached';
}

if (list) {
    for (const n of plannedNodes()) {
        console.log(`${String(n.id).padStart(6)}  ${n.project} :: ${n.title}  [${summarise(n.id)}]`);
    }
    process.exit(0);
}

const targets = all ? plannedNodes().map(n => n.id) : ids;
if (targets.length === 0) {
    console.error('Name at least one node id, or pass --all. Use --list to see them.');
    process.exit(1);
}

/**
 * Put a purged sequence back, exactly as it was — original ids included, since a
 * lesson's repaired visual is written back by row id (PUT /api/feed/items/:id)
 * and a renumbered row would orphan that write. Column list comes from the rows
 * themselves, so a future migration needs no change here.
 */
function restore(nodeId, rows) {
    if (!rows.length) return;
    const cols = Object.keys(rows[0]);
    const stmt = db.prepare(
        `INSERT OR REPLACE INTO feed_items (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
    );
    const tx = db.transaction(() => {
        db.prepare('DELETE FROM feed_items WHERE node_id = ?').run(nodeId);
        for (const r of rows) stmt.run(cols.map(c => r[c]));
    });
    tx();
    console.error(`    restored ${rows.length} previous item(s) — the topic is unchanged.`);
}

/**
 * Crash insurance. The in-memory backup above covers a failed generation; it
 * does nothing for Ctrl-C or a killed process, which is a real way to lose a
 * topic's whole sequence. So the rows also go to a file before the delete, and
 * the file is removed once the rebuild lands.
 */
const backupPath = (nodeId) => path.join(os.tmpdir(), `feed-regen-${nodeId}.json`);

if (restoreOnly) {
    let restored = 0;
    for (const nodeId of targets) {
        const file = backupPath(nodeId);
        if (!fs.existsSync(file)) { console.error(`  !! ${nodeId}: no backup at ${file}`); continue; }
        restore(nodeId, JSON.parse(fs.readFileSync(file, 'utf8')));
        fs.rmSync(file, { force: true });
        restored++;
    }
    console.log(`${restored} topic(s) restored.`);
    process.exit(0);
}

const started = Date.now();
let ok = 0;
let failed = 0;

for (const nodeId of targets) {
    const node = db.prepare('SELECT title FROM nodes WHERE id = ?').get(nodeId);
    if (!node) { console.error(`  !! ${nodeId}: no such node`); failed++; continue; }

    console.log(`\n=== ${nodeId} — ${node.title}`);
    console.log(`    purging: ${summarise(nodeId)}`);
    if (dryRun) continue;

    // Purge and re-author are ONE operation. Generation is a dozen model calls
    // deep and any of them can fail on transport alone; deleting first and
    // hoping leaves the topic emptier than it started — the old rows were
    // servable, and re-authoring is an improvement, not a rescue. So keep them
    // in hand and put them back if the rebuild doesn't land.
    const backup = db.prepare('SELECT * FROM feed_items WHERE node_id = ?').all(nodeId);
    if (backup.length) fs.writeFileSync(backupPath(nodeId), JSON.stringify(backup));
    db.prepare('DELETE FROM feed_items WHERE node_id = ?').run(nodeId);
    try {
        const t0 = Date.now();
        const made = await generateForNode(nodeId, {
            onStep: (label) => process.stdout.write(`    · ${label}\n`),
        });
        console.log(`    done: ${made} items in ${Math.round((Date.now() - t0) / 1000)}s — ${summarise(nodeId)}`);
        try { fs.rmSync(backupPath(nodeId), { force: true }); } catch { /* best effort */ }
        ok++;
    } catch (err) {
        console.error(`    FAILED: ${err.message}`);
        restore(nodeId, backup);
        try { fs.rmSync(backupPath(nodeId), { force: true }); } catch { /* best effort */ }
        failed++;
    }
}

console.log(`\n${ok} topic(s) rebuilt, ${failed} failed, ${Math.round((Date.now() - started) / 1000)}s total.`);
process.exit(failed > 0 ? 1 : 0);

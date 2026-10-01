#!/usr/bin/env node
/**
 * Leaf-count invariant check.
 *
 *   node tools/leaf-invariant.mjs            # check the live DB
 *   node tools/leaf-invariant.mjs --api      # also cross-check a running server
 *
 * Guards the one rule every progress number in this app depends on:
 *
 *   A leaf is a non-note node with no non-note children.
 *   Notes are material attached to a topic, not units of work.
 *
 * node_count / completed_count on GET /api/projects must always equal a live
 * recount of leaves. They drifted once already: the aggregate counted every
 * non-note row, so section headers ("00 — Setup & Logistics") — containers
 * nobody ever completes — were counted as unfinished work and pinned every
 * project below its true progress (one read 22.0% instead of 28.1%).
 *
 * This is a script rather than a suite because the repo has no test runner;
 * it needs no deps and exits non-zero on failure, so CI or a pre-commit hook
 * can call it directly.
 */

import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs';

function resolveDbPath() {
    return path.join(__dirname, '..', 'server', 'terramentor.db');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolveDbPath();
const API = process.env.API_URL || 'http://localhost:3001';

const db = new Database(DB_PATH, { readonly: true });

// Hard failures are things that make the numbers *wrong*. Advisories are
// content smells that don't corrupt any count — they're reported but never
// break the build, or the check would be red on day one and get ignored.
const failures = [];
const advisories = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };
const advise = (ok, msg) => { if (!ok) advisories.push(msg); };

// The reference implementation, deliberately written differently from the
// server's SQL: "id never appears as a non-note row's parent_id". If it agreed
// by construction it would not be a check.
const leafRows = db.prepare(`
    SELECT n.project_id, n.id, n.status, n.role
    FROM nodes n
    WHERE n.is_note = 0
      AND n.id NOT IN (SELECT parent_id FROM nodes WHERE parent_id IS NOT NULL AND is_note = 0)
`).all();

const blank = () => ({ node_count: 0, completed_count: 0, topic_count: 0, completed_topic_count: 0 });
const expected = new Map();
for (const r of leafRows) {
    const e = expected.get(r.project_id) || blank();
    const closed = r.status === 'completed' || r.status === 'skipped';
    e.node_count++;
    if (closed) e.completed_count++;
    // The second pair: leaves that are units of WORK. A stage cut out of an
    // imported deck's card order is a leaf but not work, and every progress
    // percentage the learner sees is counted over this pair — so it needs the
    // same independent recount as the structural one.
    if (r.role !== 'pagination') {
        e.topic_count++;
        if (closed) e.completed_topic_count++;
    }
    expected.set(r.project_id, e);
}

const projects = db.prepare('SELECT id, name FROM projects ORDER BY id').all();

// --- Advisory: note-shape smells ------------------------------------------
// Notes are meant to be terminal material hanging off a leaf topic. These
// don't corrupt the counts (a note is excluded either way) but they mean the
// tree is modelling something the design has no answer for.
const notesWithRealChildren = db.prepare(`
    SELECT n.id, n.project_id, n.title FROM nodes n
    WHERE n.is_note = 1
      AND EXISTS (SELECT 1 FROM nodes k WHERE k.parent_id = n.id AND k.is_note = 0)
`).all();
advise(notesWithRealChildren.length === 0,
    `${notesWithRealChildren.length} note(s) contain real work — notes are terminal material, not containers: `
    + notesWithRealChildren.map(n => `#${n.id} "${n.title}" (project ${n.project_id})`).join(', '));

const scheduledNotes = db.prepare(`
    SELECT COUNT(*) c FROM nodes
    WHERE is_note = 1 AND (scheduled_start IS NOT NULL OR scheduled_end IS NOT NULL)
`).get().c;
advise(scheduledNotes === 0,
    `${scheduledNotes} note(s) carry a schedule — notes are never work (database.js sweeps these on boot)`);

// --- The in-memory mirror of the same rule ---------------------------------
// The dashboard's segmented progress bar walks a built tree rather than SQL,
// and it is the fifth site of this convention: it tested `children.length`, so
// a topic whose only children are notes HAS children, was recursed into, and
// never produced a segment — fewer segments than the leaf count printed next
// to them. The rule now lives once in server/today.js; this drives that exact
// function over a tree shaped to contain the case.
//
// today.js imports database.js, which opens a DB and migrates at import time,
// so DB_PATH and VAULT_ROOT are pointed at scratch IN-PROCESS first: this tool
// is read-only about the real library and must stay that way.
async function checkTreeRule() {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'leaf-invariant-'));
    process.env.DB_PATH = path.join(scratch, 'scratch.db');
    process.env.VAULT_ROOT = path.join(scratch, 'vault');
    let structuralChildren;
    try {
        ({ structuralChildren } = await import('../server/today.js'));
    } catch (err) {
        failures.push(`could not load the leaf rule from server/today.js: ${err.message}`);
        return;
    }

    // A phase with three topics: one plain leaf, one carrying only notes (the
    // case), one real parent of two leaves. Four leaves, so four segments.
    const tree = {
        id: 1, title: 'Phase', is_note: 0, status: 'not_started', children: [
            { id: 2, title: 'Plain leaf', is_note: 0, status: 'completed', children: [] },
            {
                id: 3, title: 'Topic with only notes', is_note: 0, status: 'not_started', children: [
                    { id: 4, title: 'Reading A', is_note: 1, status: 'not_started', children: [] },
                    { id: 5, title: 'Reading B', is_note: 1, status: 'not_started', children: [] },
                ],
            },
            {
                id: 6, title: 'Section', is_note: 0, status: 'not_started', children: [
                    { id: 7, title: 'Sub leaf 1', is_note: 0, status: 'skipped', children: [] },
                    { id: 8, title: 'Sub leaf 2', is_note: 0, status: 'not_started', children: [] },
                ],
            },
        ],
    };

    // The server's collector, driven through the shared rule.
    const segments = [];
    const collect = (node) => {
        if (node.is_note) return;
        const structural = structuralChildren(node);
        if (structural.length === 0) segments.push(node.id);
        else structural.forEach(collect);
    };
    collect(tree);

    // Independent recount, written differently on purpose (same reason as the
    // SQL above): flatten every row, then keep the non-note ones that are no
    // non-note row's parent.
    const flat = [];
    (function walk(n, parent) { flat.push({ ...n, parent_id: parent }); (n.children || []).forEach(c => walk(c, n.id)); })(tree, null);
    const realParents = new Set(flat.filter(n => !n.is_note && n.parent_id != null).map(n => n.parent_id));
    const expectedLeaves = flat.filter(n => !n.is_note && !realParents.has(n.id)).map(n => n.id);

    check(segments.length === expectedLeaves.length,
        `tree rule: ${segments.length} segment(s) != ${expectedLeaves.length} leaf/leaves `
        + `(segments ${segments.join(',')} vs leaves ${expectedLeaves.join(',')})`);
    check(segments.includes(3),
        'tree rule: a topic whose only children are notes produced no segment — it is still a leaf');
    check(!segments.includes(4) && !segments.includes(5),
        'tree rule: a note was collected as a segment — notes are material, never units of work');

    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* tmp, best effort */ }
}

// --- The counts themselves -------------------------------------------------
async function main() {
    const useApi = process.argv.includes('--api');
    let apiProjects = null;

    if (useApi) {
        try {
            const res = await fetch(`${API}/api/projects`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            apiProjects = new Map((await res.json()).map(p => [p.id, p]));
        } catch (err) {
            console.error(`Could not reach ${API}: ${err.message}`);
            console.error('Start the server (npm run server) or drop --api to check the DB only.');
            process.exit(2);
        }
    }

    for (const p of projects) {
        const want = expected.get(p.id) || blank();
        const label = `#${p.id} ${(p.name || '').slice(0, 40)}`;

        check(want.completed_count <= want.node_count,
            `${label}: completed_count ${want.completed_count} exceeds node_count ${want.node_count}`);
        check(want.topic_count <= want.node_count,
            `${label}: topic_count ${want.topic_count} exceeds node_count ${want.node_count}`);
        check(want.completed_topic_count <= want.topic_count,
            `${label}: completed_topic_count ${want.completed_topic_count} exceeds topic_count ${want.topic_count}`);

        if (apiProjects) {
            const got = apiProjects.get(p.id);
            if (!got) { failures.push(`${label}: missing from GET /api/projects`); continue; }
            check(got.node_count === want.node_count,
                `${label}: API node_count ${got.node_count} != live leaf count ${want.node_count}`);
            check(got.completed_count === want.completed_count,
                `${label}: API completed_count ${got.completed_count} != live completed leaves ${want.completed_count}`);
            check(got.topic_count === want.topic_count,
                `${label}: API topic_count ${got.topic_count} != live topic leaves ${want.topic_count}`);
            check(got.completed_topic_count === want.completed_topic_count,
                `${label}: API completed_topic_count ${got.completed_topic_count} != live completed topics ${want.completed_topic_count}`);
        }
    }

    await checkTreeRule();

    const scope = apiProjects ? 'DB + API' : 'DB';

    for (const a of advisories) console.warn(`  advisory: ${a}`);

    if (failures.length > 0) {
        console.error(`FAIL (${scope}) — ${failures.length} invariant violation(s):`);
        for (const f of failures) console.error(`  - ${f}`);
        process.exit(1);
    }
    console.log(`OK (${scope}) — ${projects.length} projects, ${leafRows.length} leaves, all counts agree.`
        + (advisories.length ? ` (${advisories.length} advisory)` : ''));
}

main().finally(() => db.close());

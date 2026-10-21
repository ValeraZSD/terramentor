#!/usr/bin/env node
// tools/onboarding-gates.mjs — "Read a lesson" stays ticked once a lesson was read.
//
// Run:  node tools/onboarding-gates.mjs
//       node tools/onboarding-gates.mjs --server <dir>   (another copy of server/,
//                                                       e.g. HEAD's, to watch it fail)
//
// WHY. The first-run checklist on the home feed decided "Read a lesson" from
// `feed_items`, and that table is a CACHE: startup deletes every row of a
// finished topic, and a topic's own Overview served as a reading card (no AI,
// or nothing generated yet) never had a row. So a learner who read lessons on a
// course's Study page and then finished the topic opened the home feed to
// "Read a lesson here" unticked, with "Answer a question" and "Complete a
// topic" ticked under it (reported 21 Oct 2026, a Frisian course in Russian).
// The fact is now kept apart from the cache (`first_lesson_read_at`). The
// study clock's reading time is NOT used: an idle tab with a lesson on screen
// logs it, and the checklist must not credit what was not done.
//
// Held here, on a scratch library through the REAL /api/onboarding:
//   - nothing read → unticked; a written but unread lesson → still unticked;
//   - Continue on a lesson (any scope: the stream is one) → ticked;
//   - Continue on an Overview reading card, which has no row → ticked;
//   - a library read BEFORE this fix, whose topic was then finished: a SECOND
//     BOOT sweeps the topic's rows and the step stays ticked;
//   - reading time on the study clock alone (a lesson left on screen) → not.
// No model, no network beyond loopback.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const at = argv.indexOf('--server');
const serverDir = at >= 0 ? resolve(argv[at + 1]) : fileURLToPath(new URL('../server/', import.meta.url));
const B = pathToFileURL(serverDir + '/').href;

// A second boot is this file again, told only which library to open: the env
// is set in-process, never as a shell prefix.
const boot = argv.indexOf('--boot');
if (boot >= 0) {
    const dir = argv[boot + 1];
    process.env.DB_PATH = join(dir, 'test.db');
    process.env.VAULT_ROOT = join(dir, 'vault');
    await import(B + 'database.js');
    process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), 'onboarding-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

const { default: db } = await import(B + 'database.js');
if (!process.env.DB_PATH.startsWith(scratch)) throw new Error('refusing: not the scratch library');
const { consumeFeedItem } = await import(B + 'feed.js');
const { createApp } = await import(B + 'app.js');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

const appServer = createServer(createApp());
const port = await new Promise(ok => appServer.listen(0, '127.0.0.1', () => ok(appServer.address().port)));
const lessonStep = async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/onboarding`);
    const body = await r.json();
    return body.steps?.lesson === true;
};
const reset = () => {
    db.prepare(`DELETE FROM settings WHERE key = 'first_lesson_read_at'`).run();
    db.prepare(`DELETE FROM feed_items`).run();
    db.prepare(`DELETE FROM study_time`).run();
};
const secondBoot = () => execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--server', serverDir, '--boot', scratch], { stdio: 'pipe' });

const pid = Number(db.prepare(`INSERT INTO projects (name) VALUES ('Fixture: Frisian')`).run().lastInsertRowid);
const topic = (title) => Number(db.prepare(`INSERT INTO nodes (project_id, title, description) VALUES (?, ?, 'The alphabet has 26 letters.')`).run(pid, title).lastInsertRowid);
const lesson = (nodeId, seq = 1, status = 'ready', consumedAt = null) => Number(db.prepare(
    `INSERT INTO feed_items (node_id, kind, seq, content, status, consumed_at) VALUES (?, 'lesson', ?, '{"markdown":"# Part"}', ?, ?)`,
).run(nodeId, seq, status, consumedAt).lastInsertRowid);
let attempt = 0;
const nextAttempt = () => `onboarding-gate-${++attempt}`;

try {
    section('nothing read yet');
    {
        reset();
        check('an empty library: unticked', !(await lessonStep()));
        lesson(topic('Alphabet'));
        check('a lesson written but not read: unticked', !(await lessonStep()));
    }

    section('Continue on a lesson ticks it, from any scope');
    {
        reset();
        const n = topic('Vowels');
        const id = lesson(n);
        consumeFeedItem({ key: `lesson-${id}`, kind: 'lesson', feedItemId: id, nodeId: n, result: { read: true }, attemptId: nextAttempt() });
        check('the read lesson ticks the step', await lessonStep());
        check('the fact is kept apart from the cache row',
            !!db.prepare(`SELECT value FROM settings WHERE key = 'first_lesson_read_at'`).get()?.value);
    }

    section("a topic's Overview read as a card has no row, and still counts");
    {
        reset();
        const n = topic('Consonants');
        consumeFeedItem({ key: `read-${n}`, kind: 'lesson', feedItemId: null, nodeId: n, result: { read: true }, attemptId: nextAttempt() });
        check('Continue on the reading card ticks the step', await lessonStep());
    }

    section('read before this build, then the topic was finished: the sweep must not untick it');
    {
        reset();
        const n = topic('Diphthongs');
        lesson(n, 1, 'consumed', '2026-10-10T09:00:00.000Z');
        lesson(n, 2, 'ready');
        db.prepare(`UPDATE nodes SET status = 'completed' WHERE id = ?`).run(n);
        check('before the restart (the row is still there): ticked', await lessonStep());
        secondBoot();
        check("the restart swept the finished topic's rows (the condition being tested)",
            db.prepare(`SELECT COUNT(*) c FROM feed_items WHERE node_id = ?`).get(n).c === 0);
        check('after the restart: still ticked', await lessonStep());
        check('the kept date is when it was read', db.prepare(`SELECT value FROM settings WHERE key = 'first_lesson_read_at'`).get()?.value === '2026-10-10T09:00:00.000Z');
    }

    section('a finished topic with only UNREAD lessons gives no tick on restart');
    {
        reset();
        const n = topic('Stress');
        lesson(n, 1, 'ready');
        db.prepare(`UPDATE nodes SET status = 'completed' WHERE id = ?`).run(n);
        secondBoot();
        check('still unticked', !(await lessonStep()));
    }

    section('a lesson left on screen is not a lesson read');
    {
        // Measured 21 Oct 2026: a home feed open in an idle tab logged 22 s of
        // `reading` with no press at all. Only Continue says it was read.
        reset();
        const n = topic('Spelling');
        lesson(n);
        db.prepare(`INSERT INTO study_time (node_id, hour, activity, active_ms) VALUES (?, '2026-10-21T08', 'reading', 22209)`).run(n);
        check('reading time with no Continue: unticked', !(await lessonStep()));
    }
} finally {
    await new Promise(ok => appServer.close(ok));
    db.close();
    rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

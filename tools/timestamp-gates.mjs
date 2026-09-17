#!/usr/bin/env node
/**
 * One shape for a stored timestamp, and the comparison that reads it.
 *
 * SQLite renders `datetime('now')` and `CURRENT_TIMESTAMP` as
 * `2026-09-03 11:19:30`. Every JS writer in this app stores
 * `Date.toISOString()` — `2026-09-03T10:00:00.000Z`. The column has no type to
 * settle it, so the comparison is a plain string compare, and `'T'` (0x54)
 * sorts after `' '` (0x20). Two consequences, both silent:
 *
 *   1. A COMPARISON across the two shapes is wrong for the rest of the day and
 *      right again at UTC midnight. `next_review <= datetime('now')` hid every
 *      card due earlier today — invisible while every interval was a whole day,
 *      fatal to a ten-minute relearning step. `NOW_ISO` (database.js) is the
 *      fix, and it keeps `idx_flashcards_next_review` usable, which wrapping
 *      the column in `datetime(...)` would not.
 *   2. A column written in BOTH shapes cannot be SORTED at all: every ISO row
 *      orders after every legacy row whatever the dates say. `feed_items.
 *      consumed_at` was the one column in that state — `consumeFeedItem` wrote
 *      `datetime('now')` while `recentMisses` (index.js) and
 *      `buildTodayActivity` (today.js) both `ORDER BY consumed_at DESC`. No
 *      answer was wrong, because nothing compared it against an ISO stamp; it
 *      was one migration away from being wrong on every row.
 *
 * `CURRENT_TIMESTAMP` as a column DEFAULT is NOT a fault and is not flagged:
 * those columns are SQLite's to write, and `AS_ISO` in today.js is the reader
 * contract that normalises them on the way out. What is a fault is comparing
 * one against a stored stamp, and stamping a JS-written column with it.
 *
 * `fsrs-gates.mjs` proves the RUNTIME half for flashcards (a card due ten
 * minutes ago is due). This suite is the SOURCE scan the rule never had, plus
 * the `consumed_at` migration end to end.
 *
 *   node tools/timestamp-gates.mjs
 */
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const serverDir = join(repoRoot, 'server');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
    cond ? pass++ : fail++;
    console.log(`${cond ? '  ok   ' : ' FAIL  '}${label}${cond || !detail ? '' : ` — ${detail}`}`);
};

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

/** Comments blanked, byte offsets preserved so a line number stays honest. */
const decomment = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));

/**
 * The string literals in a JS source, so a hit can be scoped to the statement
 * it sits in rather than to 800 characters of whatever came before.
 *
 * Deliberately naive about `${}` inside a template: a nested `'NULL'` is left
 * as part of the template's own text, which is what lets `mastery.js` build a
 * SET clause out of a ternary and still be read as one statement.
 */
function literals(src) {
    const out = [];
    for (let i = 0; i < src.length; i++) {
        const q = src[i];
        if (q !== "'" && q !== '"' && q !== '`') continue;
        let j = i + 1;
        while (j < src.length) {
            if (src[j] === '\\') { j += 2; continue; }
            if (src[j] === q) break;
            if (src[j] === '\n' && q !== '`') break;   // an unterminated quote is not a literal
            j++;
        }
        out.push({ start: i, end: j });
        i = j;
    }
    return out;
}

/** `datetime('now'…)` and `CURRENT_TIMESTAMP` — the two SQLite-shaped `now`s. */
const NOW_EXPR = /\bdatetime\s*\(\s*'now'|\bCURRENT_TIMESTAMP\b/gi;

const CMP_BEFORE = /(<=|>=|<>|!=|<|>)\s*$/;
const CMP_AFTER = /^\s*(<=|>=|<>|!=|<|>)(?!=)/;
const ASSIGN_BEFORE = /=\s*$/;
const ASSIGN_AFTER = /^\s*=(?!=)/;

/**
 * Where a `now` expression sits: `'comparison'` (the fault), `'write'` (a
 * DEFAULT, a VALUES entry, a SET assignment, a bare projection) or
 * `'unclassified'`.
 *
 * Unclassified FAILS. The shapes this repo actually writes are all covered, so
 * an unclassified hit means a shape nobody has thought about, and the gate
 * would rather ask than wave it through — the same bargain as the visual
 * coherence gates, which decline what they cannot fully evaluate.
 */
function classify(scope, after) {
    // The statement, not the whole `db.exec` of a dozen of them.
    const head = scope.slice(scope.lastIndexOf(';') + 1);

    if (/\bDEFAULT\s*$/i.test(head)) return 'write';
    if (CMP_BEFORE.test(head) || CMP_AFTER.test(after)) return 'comparison';
    if (/\bBETWEEN\b[^;]*$/i.test(head)) return 'comparison';

    // `=` is the ambiguous one: an assignment in a SET clause, a comparison in
    // a WHERE. Whichever keyword is NEAREST decides. A fragment with neither
    // (`updates.push('updated_at = CURRENT_TIMESTAMP')`) is a SET clause built
    // piecewise — a timestamp compared for exact equality with the clock is not
    // a thing anyone means.
    const nearest = (re) => { let last = -1, m; const r = new RegExp(re, 'gi'); while ((m = r.exec(head))) last = m.index; return last; };
    const write = Math.max(nearest(/\bSET\b/), nearest(/\bVALUES\b/), nearest(/\bDEFAULT\b/));
    const read = Math.max(nearest(/\bWHERE\b/), nearest(/\bHAVING\b/), nearest(/\bON\s+(?!DELETE|UPDATE|CONFLICT)/));

    if (ASSIGN_BEFORE.test(head) || ASSIGN_AFTER.test(after)) return read > write ? 'comparison' : 'write';
    if (read > write && read >= 0) return 'comparison';
    if (write >= 0) return 'write';
    if (nearest(/\bSELECT\b/) >= 0) return 'write';        // `SELECT datetime('now') AS v`
    return 'unclassified';
}

/** Every SQLite-shaped `now` in a source, classified. */
function scan(src) {
    const text = decomment(src);
    const lits = literals(text);
    const hits = [];
    NOW_EXPR.lastIndex = 0;
    let m;
    while ((m = NOW_EXPR.exec(text))) {
        const lit = lits.find((l) => m.index > l.start && m.index < l.end);
        if (!lit) continue;                                 // not in a string: not SQL
        hits.push({
            index: m.index,
            line: text.slice(0, m.index).split('\n').length,
            text: m[0],
            where: classify(text.slice(lit.start + 1, m.index), text.slice(m.index + m[0].length, lit.end)),
        });
    }
    return hits;
}

// ---------------------------------------------------------------------------
console.log('--- the scanner catches the shape it was written for ---');
{
    // Rule one is only worth having if it FIRES, and the bug it exists for is
    // eight months old — the source it was written against is long gone. So it
    // is re-run here against that exact shape, and against the neighbours it
    // must NOT flag, which is the half that decides whether anyone leaves the
    // gate switched on.
    const CASES = [
        // [name, source, expected classification of the single hit]
        ['the pre-fix due query',
            "db.prepare(`SELECT id FROM flashcards WHERE next_review IS NOT NULL AND next_review <= datetime('now')`)", 'comparison'],
        ['the pre-fix due query, reversed',
            "db.prepare(`SELECT id FROM flashcards WHERE datetime('now') >= next_review`)", 'comparison'],
        ['the pre-fix sweep, with a modifier',
            "db.prepare(`DELETE FROM feed_items WHERE status = 'consumed' AND consumed_at < datetime('now', '-30 days')`)", 'comparison'],
        ['a CURRENT_TIMESTAMP comparison',
            "db.prepare(`SELECT * FROM nodes WHERE updated_at > CURRENT_TIMESTAMP`)", 'comparison'],
        ['an equality in a WHERE',
            "db.prepare(`SELECT * FROM n WHERE completed_at = datetime('now')`)", 'comparison'],
        ['a BETWEEN',
            "db.prepare(`SELECT * FROM n WHERE due BETWEEN datetime('now') AND ?`)", 'comparison'],
        // …and the safe neighbours. Each of these is a shape the repo really
        // writes; flagging one would be the false positive that gets the rule
        // deleted rather than obeyed.
        ['a column DEFAULT in DDL',
            'db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`)', 'write'],
        ['a SET assignment',
            "db.prepare(`UPDATE projects SET ai_generating = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)", 'write'],
        ['a SET assignment after another column, with a WHERE behind it',
            "db.prepare(`UPDATE feed_items SET status = 'consumed', consumed_at = datetime('now'), result = ? WHERE id = ?`)", 'write'],
        ['a VALUES entry',
            'db.prepare(`INSERT INTO node_embeddings (node_id, hash, model, dim, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`)', 'write'],
        ['an upsert DO UPDATE SET',
            'db.prepare(`INSERT INTO widget_builds (hash, html) VALUES (?, ?) ON CONFLICT(hash) DO UPDATE SET html = excluded.html, created_at = CURRENT_TIMESTAMP`)', 'write'],
        ['a SET fragment built piecewise',
            "updates.push('updated_at = CURRENT_TIMESTAMP');", 'write'],
        ['a bare projection',
            'db.prepare(`SELECT datetime(\'now\') AS v`)', 'write'],
        ['a DDL default beside an ON DELETE CASCADE',
            'db.exec(`CREATE TABLE t (node_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE)`)', 'write'],
        ['a mention in a comment is not code',
            "// next_review <= datetime('now') was the bug\nconst x = 1;", null],
    ];
    for (const [name, src, want] of CASES) {
        const hits = scan(src);
        if (want === null) { ok(`${name}: nothing to classify`, hits.length === 0, JSON.stringify(hits)); continue; }
        ok(`${name}: read as a ${want}`,
            hits.length === 1 && hits[0].where === want,
            hits.length === 1 ? `read as a ${hits[0].where}` : `${hits.length} hits`);
    }
}

// ---------------------------------------------------------------------------
console.log('\n--- no stored timestamp is compared against SQLite\'s own `now` ---');
{
    // A deliberate one goes here with its reason, the `BESPOKE` convention from
    // control-gates.mjs and the `EXEMPT` map from tenancy-gates.mjs. It would
    // have to be a column SQLite alone ever writes AND nothing sorts — write
    // down which, or the next reader has to rediscover the whole story.
    const EXEMPT = new Map(/** @type {[string, string][]} */ ([]));

    const files = readdirSync(serverDir).filter((f) => f.endsWith('.js'));
    for (const f of files) {
        const hits = scan(readFileSync(join(serverDir, f), 'utf8'));
        const bad = hits.filter((h) => h.where !== 'write');
        const key = `server/${f}`;
        if (EXEMPT.has(key)) { ok(`${key} is exempt: ${EXEMPT.get(key)}`, true); continue; }
        if (!bad.length) continue;                          // silent when clean: 72 modules
        ok(`${key} compares nothing against a SQLite-rendered now`, false,
            bad.map((h) => `line ${h.line}: ${h.text} (${h.where})`).join('; '));
    }
    ok('every server module scanned', files.length > 0, String(files.length));
}

// ---------------------------------------------------------------------------
console.log('\n--- nothing STORES a SQLite-rendered now into a JS-written column ---');
{
    // The other half, and the one rule one could never have caught: the fault
    // in `consumeFeedItem` was on the WRITE side, so there was no comparison to
    // find. A JS writer that wants a stamp has `NOW_ISO`; a relative cutoff is
    // computed in JS and bound (`database.js`'s 30-day sweep). That leaves no
    // reason for `datetime('now')` to appear in server SQL at all, so it may
    // not — which is a rule with one grep in it rather than a judgement.
    //
    // `CURRENT_TIMESTAMP` is deliberately NOT banned: it is how the columns
    // SQLite owns are declared, and `AS_ISO` in today.js is what reads them.
    const EXEMPT = new Map(/** @type {[string, string][]} */ ([]));

    for (const f of readdirSync(serverDir).filter((x) => x.endsWith('.js'))) {
        const text = decomment(readFileSync(join(serverDir, f), 'utf8'));
        const lits = literals(text);
        const hits = [];
        const re = /\bdatetime\s*\(\s*'now'/gi;
        let m;
        while ((m = re.exec(text))) {
            if (!lits.some((l) => m.index > l.start && m.index < l.end)) continue;
            hits.push(text.slice(0, m.index).split('\n').length);
        }
        const key = `server/${f}`;
        if (EXEMPT.has(key)) { ok(`${key} is exempt: ${EXEMPT.get(key)}`, true); continue; }
        if (!hits.length) continue;
        ok(`${key} writes no datetime('now')`, false, `line ${hits.join(', ')} — use NOW_ISO, or bind a JS-computed cutoff`);
    }
    ok("no server module reaches for datetime('now')", true);
}

// ---------------------------------------------------------------------------
// The runtime half. A scratch library, never the learner's.
// ---------------------------------------------------------------------------
const scratch = mkdtempSync(join(tmpdir(), 'timestamp-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
// VAULT_ROOT travels with DB_PATH, always — a run pointed at a scratch database
// and the DEFAULT blob store is one import away from sweeping a real library.
process.env.VAULT_ROOT = join(scratch, 'vault');

const db = (await import('../server/database.js')).default;
const { NOW_ISO } = await import('../server/database.js');
const { consumeFeedItem } = await import('../server/feed.js');

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

console.log('\n--- the two renderings, on fixed strings ---');
{
    // On FIXED strings, never the live clock: read against `now` this pair is
    // right for ten minutes a day by accident (before 00:10 UTC the date halves
    // settle the comparison before the separator can), which is how the same
    // assertion in fsrs-gates.mjs once failed at 00:10 and passed at 00:15 on a
    // tree where nothing had been touched.
    const sqlNow = db.prepare("SELECT datetime('now') AS v").get().v;
    ok("datetime('now') renders a space where an ISO stamp has a T", !sqlNow.includes('T'), sqlNow);
    ok('…so a stamp from earlier today reads as LATER than the clock',
        !('2026-09-03T10:00:00.000Z' <= '2026-09-03 11:19:30'));
    ok('NOW_ISO renders exactly what Date.toISOString() does',
        ISO.test(db.prepare(`SELECT ${NOW_ISO} AS v`).get().v));
    ok('…and the two agree to the second',
        db.prepare(`SELECT ${NOW_ISO} AS v`).get().v.slice(0, 19) === new Date().toISOString().slice(0, 19));
}

console.log('\n--- feed_items.consumed_at: one shape, on the way in ---');
const projectId = Number(db.prepare(`INSERT INTO projects (name) VALUES ('gate')`).run().lastInsertRowid);
const nodeId = Number(db.prepare(`INSERT INTO nodes (project_id, parent_id, title, position) VALUES (?, NULL, 'n', 0)`).run(projectId).lastInsertRowid);
const mkItem = (seq) => Number(db.prepare(
    `INSERT INTO feed_items (node_id, kind, seq, content, status) VALUES (?, 'lesson', ?, '{}', 'ready')`
).run(nodeId, seq).lastInsertRowid);
const stampOf = (id) => db.prepare('SELECT consumed_at FROM feed_items WHERE id = ?').get(id)?.consumed_at;

{
    const id = mkItem(1);
    consumeFeedItem({ key: 'k1', kind: 'lesson', feedItemId: id });
    ok('the writer stamps an ISO timestamp', ISO.test(String(stampOf(id))), String(stampOf(id)));

    // The reason it has to be ONE shape: both readers of this column sort on it
    // raw (`recentMisses`, `buildTodayActivity`). The separator only decides
    // once the DATE halves are equal — which is why a mixed column is not
    // uniformly wrong but wrong WITHIN a day, the hardest kind to see. Two rows
    // on the same date, fifteen hours apart, and the earlier one sorts first.
    const morning = mkItem(2), evening = mkItem(3);
    const setStamp = db.prepare("UPDATE feed_items SET status = 'consumed', consumed_at = ? WHERE id = ?");
    setStamp.run('2026-09-17T08:00:00.000Z', morning);
    setStamp.run('2026-09-17 23:00:00', evening);
    const order = db.prepare(
        `SELECT id FROM feed_items WHERE id IN (?, ?) ORDER BY consumed_at DESC`
    ).all(morning, evening).map((r) => r.id);
    ok('mixed shapes sort by the separator, not the clock: 08:00 above 23:00',
        order[0] === morning, `order ${JSON.stringify(order)}`);
    for (const x of [morning, evening]) db.prepare('DELETE FROM feed_items WHERE id = ?').run(x);
}

console.log('\n--- …and the rows written before it, migrated once ---');
{
    // The migration is a startup step in database.js, so it is proved by
    // STARTING a second process against the same file — not by re-running a
    // copy of the statement here, which would assert nothing about what ships.
    const stale = mkItem(5);
    const legacyStamp = new Date(Date.now() - 2 * 86400_000).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare("UPDATE feed_items SET status = 'consumed', consumed_at = ? WHERE id = ?").run(legacyStamp, stale);
    ok('a pre-fix row is seeded in SQLite\'s shape', stampOf(stale) === legacyStamp, String(stampOf(stale)));

    const boot = `await import(${JSON.stringify(pathToFileURL(join(serverDir, 'database.js')).href)}); process.exit(0);`;
    const restart = () => spawnSync(process.execPath, ['--input-type=module', '-e', boot], {
        cwd: repoRoot, encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });

    const first = restart();
    ok('a second process boots against the same library', first.status === 0, (first.stderr || '').slice(0, 300));
    const after = stampOf(stale);
    ok('startup rewrote the pre-fix row to ISO', ISO.test(String(after)), String(after));
    ok('…keeping the instant it recorded', String(after).slice(0, 19) === legacyStamp.replace(' ', 'T'), String(after));

    restart();
    ok('a second startup changes nothing (idempotent)', stampOf(stale) === after, String(stampOf(stale)));

    // The sweep the migration has to survive: it deletes consumed rows older
    // than 30 days, and its cutoff is now an ISO stamp too. A row two days old
    // is not old enough, and a row 40 days old is — proving the comparison is
    // still live and did not silently start matching nothing.
    const old = mkItem(6);
    db.prepare("UPDATE feed_items SET status = 'consumed', consumed_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 40 * 86400_000).toISOString(), old);
    restart();
    ok('the 30-day sweep keeps a two-day-old card', stampOf(stale) !== undefined);
    ok('…and takes a forty-day-old one', stampOf(old) === undefined, String(stampOf(old)));
}

try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a leftover temp dir is not a failure */ }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

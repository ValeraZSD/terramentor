/**
 * One model's half of tools/model-bench/run.mjs (forked, one per model).
 *
 * Opens a fresh scratch library, points the app at OpenRouter through the env
 * overrides getAISettings() reads (never a settings row), seeds each case
 * family's fixture rows, then runs every case through the app's own code and
 * appends one JSON line per case to BENCH_FILE. A case already on disk is
 * skipped, so a stopped run continues where it stopped.
 */
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { startLibrary, endLibrary, installFetch, loadApp, runOnce, muteAppLogs } from './harness.mjs';

const MODEL = process.env.BENCH_MODEL;
const FILE = process.env.BENCH_FILE;
const VISION = process.env.BENCH_VISION === '1';
const ONLY = (process.env.BENCH_CASES || '').split(',').filter(Boolean);
const RETRY_ERRORS = process.env.BENCH_RETRY_ERRORS === '1';
const REV = process.env.BENCH_REV || null;

const scratch = startLibrary(MODEL, process.env.OPENROUTER_API_KEY);
const LOG = FILE.replace(/\.jsonl$/, '.app.log');
const print = muteAppLogs((line) => appendFileSync(LOG, `${line}\n`));

// A stray rejection inside the app (an aborted body nobody awaits) is logged,
// not fatal: the case it belongs to still records its own outcome.
process.on('unhandledRejection', (e) => appendFileSync(LOG, `[unhandled] ${String(e?.stack || e).slice(0, 600)}\n`));
// The parent is gone: nobody will grant another slot.
process.on('disconnect', () => process.exit(0));

let seq = 0;
const waiting = new Map();
process.on('message', (m) => {
    if (m?.type === 'slot' && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
});
installFetch({
    slot: () => new Promise((resolve) => { const id = ++seq; waiting.set(id, resolve); process.send({ type: 'slot', id }); }),
    onDailyLimit: () => process.send({ type: 'stop', why: 'free daily request limit reached' }),
});

const app = await loadApp(MODEL);
const { loadCases } = await import('./cases/index.mjs');
const cases = await loadCases(app);

const done = new Map();
if (existsSync(FILE)) {
    for (const line of readFileSync(FILE, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { const r = JSON.parse(line); done.set(r.case, r); } catch { /* a torn last line */ }
    }
}

let exitCode = 0;
for (const c of cases) {
    if (ONLY.length && !ONLY.includes(c.id)) continue;
    const prev = done.get(c.id);
    if (prev && !(RETRY_ERRORS && prev.transient)) continue;
    if (c.vision && !VISION) {
        appendFileSync(FILE, JSON.stringify({ case: c.id, category: c.category, model: MODEL, na: true, why: 'text-only model', rev: REV }) + '\n');
        continue;
    }
    let row = null, stop = '';
    // What every attempt spent, not only the last one's.
    const spent = { calls: 0, cost: 0, promptTokens: 0, completionTokens: 0 };
    // A refusal upstream (429, overloaded, a dropped stream) is retried twice
    // with a pause; the row records how many attempts it took.
    for (let attempt = 0; attempt < 3; attempt++) {
        const r = await runOnce(c, app);
        if (r.outOfSlots) { stop = 'out of request slots; the rest runs next time'; break; }
        if (r.fatal) { stop = `the run cannot go on for this model: ${r.fatal}`; exitCode = 3; break; }
        for (const k of Object.keys(spent)) spent[k] += r.row[k] || 0;
        row = { ...r.row, model: MODEL, attempt, rev: REV, spent: { ...spent, cost: +spent.cost.toFixed(6) } };
        if (!row.transient) break;
        if (attempt < 2) await new Promise(res => setTimeout(res, [30, 90][attempt] * 1000));
    }
    if (stop) { print(`${MODEL}: ${stop}`); break; }
    appendFileSync(FILE, JSON.stringify(row) + '\n');
    print(`${MODEL.slice(0, 44).padEnd(44)} ${c.id.slice(0, 34).padEnd(34)} ${row.pass ? 'pass' : 'FAIL'} ${String(Math.round(row.wallMs / 1000)).padStart(4)}s ${row.pass ? '' : row.why.slice(0, 80)}`);
}
endLibrary(scratch, app);
process.exit(exitCode);

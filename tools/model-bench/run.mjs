#!/usr/bin/env node
/**
 * Model benchmark: runs every case in tools/model-bench/cases/ through the
 * app's own model-calling code against one or more OpenRouter models, and
 * writes one JSON line per (model, case) to <out>/<model>.jsonl.
 *
 *   node tools/model-bench/run.mjs --models free --out <dir>
 *   node tools/model-bench/run.mjs --models z-ai/glm-5.3-flash,other/model --out <dir>
 *   options: --rpm 16          requests per minute across ALL workers (free tier: 20)
 *            --parallel N      models run at once (default rpm / 3)
 *            --daily 900       stop granting requests after this many in this run
 *                              (free models: defaults to the key's free quota left)
 *            --cases a,b       only these case ids
 *            --label x         a repeat run for noise: writes <model>@x.jsonl
 *            --retry-errors    re-run rows that ended in a transient error
 *
 * The key comes from OPENROUTER_API_KEY (set it in-process from a launcher;
 * this tool never prints or writes it).
 *
 * One worker process per model: the app picks its model from process env
 * (getAISettings), so two models cannot share a process. Every worker asks
 * this process for a slot before each model request, so the whole run stays
 * under one requests-per-minute limit. A row already on disk is skipped, so an
 * interrupted run continues where it stopped.
 */
import { fork, execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
    return acc;
}, []));
const positive = (name, value) => {
    const n = Number(value);
    if (!(Number.isFinite(n) && n > 0)) { console.error(`--${name} needs a positive number`); process.exit(2); }
    return n;
};

const KEY = process.env.OPENROUTER_API_KEY || '';
if (!KEY) { console.error('OPENROUTER_API_KEY is not set'); process.exit(2); }
const OUT = path.resolve(String(args.out || ''));
if (!args.out) { console.error('--out <dir> is required'); process.exit(2); }
if (args.label && !/^[a-z0-9_-]+$/i.test(String(args.label))) { console.error('--label takes letters, digits, - and _'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const RPM = positive('rpm', args.rpm ?? 16);
const PARALLEL = Math.floor(positive('parallel', args.parallel ?? Math.max(1, Math.floor(RPM / 3))));
const auth = { headers: { Authorization: `Bearer ${KEY}` } };
let REV = null;
try { REV = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: HERE, encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }

const isFree = (m) => Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0;

/** Free text models from the live list: price 0 in and out, text in, text out.
 *  The `openrouter/free` router is not a model and is left out. */
async function freeTextModels() {
    const { data } = await (await fetch('https://openrouter.ai/api/v1/models')).json();
    return data.filter(m => isFree(m)
        && (m.architecture?.input_modalities || []).includes('text')
        && JSON.stringify(m.architecture?.output_modalities || []) === '["text"]'
        && m.id !== 'openrouter/free')
        .map(m => ({ id: m.id, free: true, vision: (m.architecture?.input_modalities || []).includes('image') }));
}

async function zdrModelIds() {
    const r = await fetch('https://openrouter.ai/api/v1/endpoints/zdr');
    const { data } = await r.json();
    return new Set(data.map(e => e.model_id || e.model || e.id).filter(Boolean));
}

async function freeQuota() {
    const { data } = await (await fetch('https://openrouter.ai/api/v1/key', auth)).json();
    return data?.free_model_daily_requests || null;
}

let models;
if (args.models === 'free' || !args.models) models = await freeTextModels();
else {
    const { data } = await (await fetch('https://openrouter.ai/api/v1/models')).json();
    const byId = new Map(data.map(m => [m.id, m]));
    models = String(args.models).split(',').map(id => {
        if (!byId.has(id)) throw new Error(`unknown model ${id}`);
        const m = byId.get(id);
        return { id, free: isFree(m), vision: (m.architecture?.input_modalities || []).includes('image') };
    });
}
const zdr = await zdrModelIds();
for (const m of models) m.zdr = zdr.has(m.id);
const metaFile = path.join(OUT, 'models.json');
const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : {};
for (const m of models) meta[m.id] = { zdr: m.zdr, vision: m.vision, free: m.free, checked: new Date().toISOString() };
writeFileSync(metaFile, JSON.stringify(meta, null, 1));

// The free quota bounds a run of free models only; a paid run has no default cap.
const quota = models.every(m => m.free) ? await freeQuota() : null;
const DAILY = args.daily != null ? positive('daily', args.daily)
    : Number.isFinite(quota?.remaining) ? Math.max(0, quota.remaining - 20) : Infinity;
console.log(`models: ${models.length}  parallel: ${PARALLEL}  rpm: ${RPM}  request budget: ${DAILY}  free quota: ${JSON.stringify(quota)}`);

// --- the shared slot limiter ------------------------------------------------
// Grants are spaced evenly (one every 60/RPM s, no bursts), so a request
// waits at most about PARALLEL x 60/RPM seconds for its slot. That wait runs
// inside the app's own per-request timeout, which is why PARALLEL defaults to
// RPM / 3 (a wait under ~20 s).
const GAP = 60_000 / RPM;
let lastGrant = 0;
let used = 0;
let stopped = '';
let timer = null;
const waiting = [];
function pump() {
    timer = null;
    if (!stopped && used >= DAILY) stopped = 'request budget spent';
    while (waiting.length) {
        if (stopped || used >= DAILY) { waiting.shift().reply({ type: 'slot', ok: false, why: stopped || 'request budget spent' }); continue; }
        const now = Date.now();
        if (now - lastGrant < GAP) { timer = setTimeout(pump, GAP - (now - lastGrant)); return; }
        lastGrant = now; used++;
        waiting.shift().reply({ type: 'slot', ok: true, n: used });
    }
}

function runModel(m) {
    return new Promise((resolve) => {
        const file = path.join(OUT, `${m.id.replace(/[/:]/g, '__')}${args.label ? '@' + args.label : ''}.jsonl`);
        const child = fork(path.join(HERE, 'worker.mjs'), [], {
            env: { ...process.env, BENCH_MODEL: m.id, BENCH_VISION: m.vision ? '1' : '', BENCH_ZDR: m.zdr ? '1' : '',
                BENCH_FILE: file, BENCH_CASES: args.cases ? String(args.cases) : '',
                BENCH_RETRY_ERRORS: args['retry-errors'] ? '1' : '', BENCH_REV: REV || '' },
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        });
        child.on('message', (msg) => {
            if (msg?.type === 'slot') { waiting.push({ reply: (r) => child.connected && child.send({ ...r, id: msg.id }) }); if (!timer) pump(); }
            if (msg?.type === 'stop') { stopped ||= msg.why; console.log(`stopping all workers: ${msg.why}`); }
        });
        child.on('exit', (code) => resolve({ model: m.id, code, file }));
    });
}

const queue = [...models];
const results = [];
await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
    while (queue.length && !stopped) results.push(await runModel(queue.shift()));
}));
for (const d of results) {
    const rows = existsSync(d.file) ? readFileSync(d.file, 'utf8').trim().split('\n').filter(Boolean).length : 0;
    console.log(`${d.model.padEnd(52)} exit ${d.code}${d.code === 3 ? ' (stopped: see the line above)' : ''}  rows ${rows}`);
}
if (queue.length) console.log(`not started: ${queue.map(m => m.id).join(', ')}`);
console.log(`requests granted this run: ${used}${stopped ? `  (stopped: ${stopped})` : ''}`);

#!/usr/bin/env node
/**
 * Checks the benchmark's scorers before any model is trusted to them.
 *
 *   node tools/model-bench/mutate.mjs [--cases a,b] [--family grading] [-v]
 *
 * For every case, the model is replaced by a stub that answers with the case's
 * `golden` reply, then with each of its `mutants` (hand-broken replies). The
 * reply goes through the same app code as a live run (the prompt is built, the
 * reply parsed, validated and stored by the app), then the case's scorer
 * judges the result. A scorer is sound when the golden reply and every sound
 * `variant` pass and every mutant fails. No request leaves the machine.
 *
 * Exits 1 when any golden or variant fails or any mutant passes.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startLibrary, endLibrary, installFetch, loadApp, runOnce, muteAppLogs, anthropicUsage } from './harness.mjs';
import { codeChildFlags } from './cases/visuals.mjs';

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : ''; };
const ONLY = opt('cases').split(',').filter(Boolean);
const FAMILY = opt('family');
const VERBOSE = argv.includes('-v');
const MODEL = 'bench/mock-model';
const APP_LOGS = argv.includes('--app-logs');
const print = muteAppLogs(APP_LOGS ? (l) => process.stderr.write(`${l}\n`) : () => {});

const scratch = startLibrary(MODEL, 'sk-or-mock-key-never-sent');
// The runaway-loop mutants are killed at this limit, not the live 30 s. At
// 10 s a sound widget was killed too when `npm test` loaded the machine (the
// child's start-up and jsdom alone took that long), so leave a wide margin.
process.env.BENCH_CODE_TIMEOUT_MS ||= '20000';

let queue = [];
let served = 0;
const sse = (text, usage) => {
    const enc = new TextEncoder();
    const parts = [];
    for (let i = 0; i < text.length; i += 400) parts.push(text.slice(i, i + 400));
    if (!parts.length) parts.push('');
    const lines = parts.map(p => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: p } }] })}\n\n`);
    lines.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`, 'data: [DONE]\n\n');
    return new ReadableStream({ start(ctrl) { for (const l of lines) ctrl.enqueue(enc.encode(l)); ctrl.close(); } });
};
installFetch({
    mock: {
        reply(body) {
            const text = queue.length ? (served < queue.length ? queue[served] : queue[queue.length - 1]) : '';
            served++;
            const usage = { prompt_tokens: 1, completion_tokens: 1, cost: 0 };
            if (body.stream) return new Response(sse(text, usage), { status: 200, headers: { 'content-type': 'text/event-stream' } });
            return new Response(JSON.stringify({ provider: 'Mock', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage }),
                { status: 200, headers: { 'content-type': 'application/json' } });
        },
        catalogue(url) {
            const entry = {
                id: MODEL, name: 'Mock', context_length: 128000,
                architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
                supported_parameters: ['reasoning', 'tools'], pricing: { prompt: '0', completion: '0' },
                endpoints: [{ provider_name: 'Mock', supported_parameters: ['reasoning', 'tools'], pricing: { prompt: '0', completion: '0' } }],
            };
            const body = /\/endpoints/.test(url) ? { data: { ...entry } } : { data: [entry] };
            return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
        },
    },
});

const app = await loadApp(MODEL);
const { loadCases } = await import('./cases/index.mjs');
const cases = (await loadCases(app)).filter(c => (!ONLY.length || ONLY.includes(c.id)) && (!FAMILY || c.category === FAMILY));

const serve = async (c, reply) => {
    queue = Array.isArray(reply) ? reply : [reply];
    served = 0;
    const { row } = await runOnce(c, app, { capMs: 60_000 });
    return row;
};

let goldenFail = 0, survivors = 0, killed = 0, total = 0, variantsRun = 0, variantsOk = 0;
const byCategory = new Map();
for (const c of cases) {
    const cat = byCategory.get(c.category) || { cases: 0, golden: 0, mutants: 0, killed: 0 };
    byCategory.set(c.category, cat);
    cat.cases++;
    const g = await serve(c, c.golden);
    if (g.pass) cat.golden++; else goldenFail++;
    const lines = [`${g.pass ? '  ok  ' : ' FAIL '} ${c.id}: golden ${g.pass ? 'passes' : `FAILS (${g.why})`}`];
    for (const v of c.variants || []) {
        const r = await serve(c, v.reply);
        variantsRun++;
        if (r.pass) variantsOk++; else lines.push(` FAIL    sound variant "${v.name}" FAILS (${r.why.slice(0, 100)})`);
    }
    for (const m of c.mutants || []) {
        const r = await serve(c, m.reply);
        total++; cat.mutants++;
        if (r.pass) { survivors++; lines.push(` FAIL    mutant "${m.name}" PASSES the scorer`); }
        else { killed++; cat.killed++; if (VERBOSE) lines.push(`         mutant "${m.name}" fails: ${r.why.slice(0, 100)}`); }
    }
    if (!c.mutants?.length) lines.push(' FAIL    no mutants: this scorer is unchecked');
    if (!g.pass || VERBOSE || lines.length > 1 && lines.some(l => l.startsWith(' FAIL'))) print(lines.join('\n'));
}

print('\ncategory        cases  golden pass  mutants killed');
for (const [cat, v] of byCategory) {
    print(`${cat.padEnd(16)}${String(v.cases).padStart(5)}  ${`${v.golden}/${v.cases}`.padStart(11)}  ${`${v.killed}/${v.mutants}`.padStart(14)}`);
}
print(`\n${cases.length} cases: golden replies passing ${cases.length - goldenFail}/${cases.length}; sound variants passing ${variantsOk}/${variantsRun}; mutants failed by the scorer ${killed}/${total}; mutants that passed ${survivors}`);

// The direct Anthropic route prices tokens itself: pin the arithmetic.
// Haiku 5.5 short: 1,000 fresh x $0.10 + 2,000 written x $0.125 + 4,000 read x $0.01 + 500 out x $0.50 = $0.00064.
// Haiku 5.5 over 100k prompt: 101,000 fresh x $0.50 + 1,000 out x $2.50 = $0.053.
// Sonnet 5.5: 1,000 fresh x $2 + 1,000 out x $10 = $0.012.
const priceChecks = [
    [anthropicUsage({ input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 4000, output_tokens: 500 }, 'claude-haiku-5-5'), 0.00064, 7000],
    [anthropicUsage({ input_tokens: 101_000, output_tokens: 1000 }, 'claude-haiku-5-5'), 0.053, 101_000],
    [anthropicUsage({ input_tokens: 1000, output_tokens: 1000 }, 'claude-sonnet-5-5'), 0.012, 1000],
];
const priceBad = priceChecks.filter(([u, cost, prompt]) => !Number.isFinite(u.cost) || Math.abs(u.cost - cost) > 1e-9 || u.prompt_tokens !== prompt);
print(`Anthropic pricing: ${priceChecks.length - priceBad.length}/${priceChecks.length} hand-computed costs match`);

// Model-written code runs in a child under codeChildFlags(). Probe that fence
// with the same flags: code that escaped jsdom or the vm holds these modules.
const fenceProbe = `
const fs = require('fs'), cp = require('child_process'), os = require('os'), path = require('path');
const denied = (f) => { try { f(); return false; } catch (e) { return e.code === 'ERR_ACCESS_DENIED'; } };
console.log(JSON.stringify({
    readRepo: denied(() => fs.readFileSync(${JSON.stringify(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'))})),
    writeTemp: denied(() => fs.writeFileSync(path.join(os.tmpdir(), 'bench-fence-probe.txt'), 'x')),
    spawn: denied(() => cp.spawnSync(process.execPath, ['-e', '1'])),
    worker: denied(() => new (require('worker_threads').Worker)('1', { eval: true })),
    // The permission model does not check node:sqlite's file access, so the module itself must be gone.
    sqlite: (() => { const m = process.getBuiltinModule('node:sqlite'); if (!m) return true; try { new m.DatabaseSync(path.join(os.tmpdir(), 'bench-fence-probe.db')).close(); return false; } catch (e) { return e.code === 'ERR_ACCESS_DENIED'; } })(),
}));`;
const fenceRun = spawnSync(process.execPath, [...codeChildFlags(), '-e', fenceProbe], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
let fence = {};
try { fence = JSON.parse(String(fenceRun.stdout).trim().split('\n').pop()); } catch { /* reported below */ }
rmSync(path.join(tmpdir(), 'bench-fence-probe.db'), { force: true });
const fenceChecks = ['readRepo', 'writeTemp', 'spawn', 'worker', 'sqlite'];
const fenceOpen = fenceChecks.filter(k => fence[k] !== true);
print(`Code fence: ${fenceChecks.length - fenceOpen.length}/${fenceChecks.length} escapes denied${fenceOpen.length ? ` (OPEN: ${fenceOpen.join(', ')}${fenceRun.stderr ? `; ${String(fenceRun.stderr).trim().slice(0, 160)}` : ''})` : ''}`);
// tools/run-gates.mjs reads this count; a gate that prints none fails there.
print(`${(cases.length - goldenFail) + variantsOk + killed + (priceChecks.length - priceBad.length) + (fenceChecks.length - fenceOpen.length)} assertions passed`);
endLibrary(scratch, app);
process.exit(goldenFail || survivors || variantsRun !== variantsOk || priceBad.length || fenceOpen.length ? 1 : 0);

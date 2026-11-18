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
 * judges the result. A scorer is sound when the golden reply passes and every
 * mutant fails. No request leaves the machine.
 *
 * Exits 1 when any golden fails or any mutant passes.
 */
import { startLibrary, installFetch, loadApp, runOnce, muteAppLogs } from './harness.mjs';

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : ''; };
const ONLY = opt('cases').split(',').filter(Boolean);
const FAMILY = opt('family');
const VERBOSE = argv.includes('-v');
const MODEL = 'bench/mock-model';
const APP_LOGS = argv.includes('--app-logs');
const print = muteAppLogs(APP_LOGS ? (l) => process.stderr.write(`${l}\n`) : () => {});

startLibrary(MODEL, 'sk-or-mock-key-never-sent');

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

let goldenFail = 0, survivors = 0, killed = 0, total = 0;
const byCategory = new Map();
for (const c of cases) {
    const cat = byCategory.get(c.category) || { cases: 0, golden: 0, mutants: 0, killed: 0 };
    byCategory.set(c.category, cat);
    cat.cases++;
    const g = await serve(c, c.golden);
    if (g.pass) cat.golden++; else goldenFail++;
    const lines = [`${g.pass ? '  ok  ' : ' FAIL '} ${c.id}: golden ${g.pass ? 'passes' : `FAILS (${g.why})`}`];
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
print(`\n${cases.length} cases: golden replies passing ${cases.length - goldenFail}/${cases.length}; mutants failed by the scorer ${killed}/${total}; mutants that passed ${survivors}`);
process.exit(goldenFail || survivors ? 1 : 0);

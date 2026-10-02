#!/usr/bin/env node
// Does the app know a cloud model can see a photo?
//
// Before 2026-10-01 every OpenAI-compatible endpoint answered 'maybe', and
// 'auto' reads 'maybe' as no — so on OpenRouter the paper card ALWAYS said
// "No vision model is configured", under models whose catalogue lists `image`
// (xiaomi/mimo-v2.6-pro, z-ai/glm-5.3-flash, measured that day). The probe now
// reads `/models/<id>/endpoints` on the endpoint the learner configured.
//
// What is held here, against a stub catalogue on loopback and a scratch
// library set IN-PROCESS (a shell prefix has silently failed to apply before):
//   - the catalogue's word becomes 'listed' / 'no', silence stays 'maybe';
//   - a verdict and a missing route are cached, a 429 / 503 / dead socket is
//     not (one blip must not pin a model for ten minutes);
//   - a model id that would walk the URL fetches nothing;
//   - paper marking and Capture accept 'listed', PDF recovery does NOT — it
//     runs unattended, and 'listed' there would send every page of every
//     upload to a billed model on its own.
// No model, no internet.

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const scratch = mkdtempSync(join(tmpdir(), 'vision-capability-gates-'));
process.env.DB_PATH = join(scratch, 'scratch.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
for (const k of ['AI_PROVIDER', 'AI_BASE_URL', 'AI_MODEL', 'AI_API_KEY', 'OPENAI_API_KEY']) delete process.env[k];

const hits = new Map(); // model → requests seen
let busyLeft = 1;
const server = createServer((req, res) => {
    const m = /^\/v1\/models\/(.+)\/endpoints$/.exec(req.url);
    const model = m ? decodeURIComponent(m[1]) : req.url;
    hits.set(model, (hits.get(model) || 0) + 1);
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const arch = (inputs) => ({ data: { id: model, architecture: { input_modalities: inputs }, endpoints: [] } });
    if (model === 'vendor/seeing') return json(200, arch(['text', 'image']));
    if (model === 'vendor/blind') return json(200, arch(['text']));
    if (model === 'vendor/mute') return json(200, { data: { id: model, endpoints: [] } });
    if (model === 'vendor/busy') return busyLeft-- > 0 ? json(429, { error: 'slow down' }) : json(200, arch(['text', 'image']));
    if (model === 'vendor/down') return json(503, { error: 'down' });
    return json(404, { error: 'no such route' });
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const PORT = server.address().port;

const db = (await import('../server/database.js')).default;
const ai = await import('../server/ai.js');
const paper = await import('../server/paper.js');

const setting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
setting.run('ai_provider', 'openai');
setting.run('ai_openai_base_url', `http://127.0.0.1:${PORT}/v1`);
setting.run('ai_enabled', 'true');
const useModel = (m) => setting.run('ai_openai_model', m);

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

try {
    console.log('\n--- the catalogue body, read alone ---');
    const v = ai.catalogueVisionVerdict;
    check('image in input_modalities → listed', v({ data: { architecture: { input_modalities: ['text', 'image'] } } }) === 'listed');
    check('text only → no', v({ data: { architecture: { input_modalities: ['text'] } } }) === 'no');
    check('no architecture → null (unknown, not no)', v({ data: { endpoints: [] } }) === null);
    check('an empty list → null', v({ data: { architecture: { input_modalities: [] } } }) === null);
    check('junk → null', v(null) === null && v('x') === null && v({ data: { architecture: { input_modalities: 'image' } } }) === null);

    console.log('\n--- the probe, against the stub catalogue ---');
    check('a model the catalogue says sees → listed', await ai.visionAvailability('vendor/seeing') === 'listed');
    check('...asked once', hits.get('vendor/seeing') === 1);
    check('...and cached: a second call asks nothing', await ai.visionAvailability('vendor/seeing') === 'listed' && hits.get('vendor/seeing') === 1);
    check('a text-only model → no', await ai.visionAvailability('vendor/blind') === 'no');
    check('a catalogue that says nothing → maybe', await ai.visionAvailability('vendor/mute') === 'maybe');
    check('an endpoint without the route (404) → maybe', await ai.visionAvailability('local-model') === 'maybe');
    await ai.visionAvailability('local-model');
    check('...and that answer is cached', hits.get('local-model') === 1, `hits ${hits.get('local-model')}`);
    check('a 429 → maybe for this call', await ai.visionAvailability('vendor/busy') === 'maybe');
    check('...and NOT cached: the next call asks again and gets listed', await ai.visionAvailability('vendor/busy') === 'listed' && hits.get('vendor/busy') === 2);
    await ai.visionAvailability('vendor/down');
    await ai.visionAvailability('vendor/down');
    check('a 503 is never cached', hits.get('vendor/down') === 2, `hits ${hits.get('vendor/down')}`);
    const before = [...hits.values()].reduce((a, b) => a + b, 0);
    check('a model id that walks the URL → maybe', await ai.visionAvailability('../../keys') === 'maybe');
    check('...and fetches nothing', [...hits.values()].reduce((a, b) => a + b, 0) === before);

    console.log('\n--- who may act on "listed" ---');
    useModel('vendor/seeing');
    const seeing = await paper.decidePaperVision();
    check('paper marking: a listed model is used', seeing.use === 'yes' && seeing.model === 'vendor/seeing', JSON.stringify(seeing));
    useModel('vendor/blind');
    check('paper marking: a text-only model is not', (await paper.decidePaperVision()).use === 'no');
    useModel('local-model');
    check('paper marking: an unknown one is not (auto)', (await paper.decidePaperVision()).use === 'no');
    // The control: the rule this replaced, given the same verdict.
    const preFixRule = (cap) => (cap === 'yes' ? 'yes' : 'no');
    check('the pre-fix rule turned a listed model down (the control)', preFixRule('listed') === 'no');

    const src = (f) => readFileSync(new URL(`../server/${f}`, import.meta.url), 'utf8');
    check("Capture accepts 'listed'", /cap === 'yes' \|\| cap === 'listed'/.test(src('capture.js')));
    check("PDF recovery does not (it runs unattended)", !src('pdfRecovery.js').includes("'listed'")
        && /cap === 'yes' \? 'yes' : 'no'/.test(src('pdfRecovery.js')));
} finally {
    server.closeAllConnections();
    server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
// Let the loop drain rather than calling process.exit — the same reason as
// ai-routing-gates.mjs: tearing down while a handle is still closing aborts
// Node on Windows (`!(handle->flags & UV_HANDLE_CLOSING)`, exit 127), which
// reads as a failed suite with every check green.
process.exitCode = fail ? 1 : 0;
setTimeout(() => {
    try { db.close(); } catch { /* already closed */ }
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* the OS will */ }
}, 50).unref();

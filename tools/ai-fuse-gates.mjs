#!/usr/bin/env node
/**
 * The spending fuse of a site (server/aiFuse.js, server/aiSpend.js): each
 * library counts what it spends on the model per calendar month; past
 * AI_FUSE_SWITCH_USD its calls go to AI_FUSE_SMALL_MODEL, past
 * AI_FUSE_STOP_USD it makes none until next month.
 *
 *   1. A real front desk with two learners, a fake model and the limits set to
 *      USD 0.01 / 0.02 (each answer costs USD 0.006): the first learner's calls
 *      move to the small model past the switch and stop past the stop, with the
 *      learner's sentence and no request sent; the second learner is untouched;
 *      after the stop a card review and a quiz sitting still save; the operator
 *      gets one notice per line, which says the library was made today and
 *      carries nothing the learner wrote.
 *   2. Outside a site library nothing changes: a desktop copy and a hosted copy
 *      of its own keep their model and count nothing, whatever the month holds.
 *   3. The settings: defaults, what the front desk refuses to start with, and
 *      how a call is priced when the endpoint reports no cost.
 *
 * Nothing reaches a real model; every library is a scratch folder.
 *
 *   node tools/ai-fuse-gates.mjs
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
    cond ? pass++ : fail++;
    console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${cond || !detail ? '' : `  (${String(detail).slice(0, 300)}`}${cond || !detail ? '' : ')'}`);
};

const scratch = mkdtempSync(join(tmpdir(), 'ai-fuse-gates-'));
// This process's own library (part 2) is a scratch one, set before anything opens it.
process.env.DB_PATH = join(scratch, 'solo', 'terramentor.db');
process.env.VAULT_ROOT = join(scratch, 'solo', 'vault');
process.env.DATA_DIR = join(scratch, 'solo');
for (const k of ['TERRAMENTOR_HOSTED', 'TERRAMENTOR_SITE_LIBRARY', 'SITE_LIBRARY_ID']) delete process.env[k];

// ---- the fake model ------------------------------------------------------------------
const COST = 0.006;
const asked = []; // { model, stream, auth }
const notices = []; // the JSON bodies posted to AI_FUSE_NOTICE_URL
const fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        if (req.url === '/notice') {
            try { notices.push(JSON.parse(raw)); } catch { notices.push({ unreadable: raw }); }
            res.writeHead(204);
            return res.end();
        }
        if (req.url.endsWith('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ data: [{ id: 'main-model' }, { id: 'small-model' }] }));
        }
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { /* counted as asked anyway */ }
        asked.push({ model: body.model, stream: !!body.stream, auth: req.headers.authorization || '' });
        const usage = { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160, cost: COST };
        const content = 'Because the two waves cancel there.';
        if (body.stream) {
            // OpenRouter's shape: the finish_reason chunk, then (a moment
            // later here, so a reader that stops at the finish cannot see it
            // in the same read) an extra chunk repeating it with `usage`.
            // A body asking for 'no usage' gets a stream without one.
            // One asking to be 'slow' waits before its finish_reason too.
            const said = JSON.stringify(body.messages || []);
            const noUsage = said.includes('no usage');
            const finish = { choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }] };
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`);
            return setTimeout(() => {
                if (res.destroyed) return;
                res.write(`data: ${JSON.stringify(finish)}\n\n`);
                setTimeout(() => {
                    if (res.destroyed) return;
                    if (!noUsage) res.write(`data: ${JSON.stringify({ ...finish, usage })}\n\n`);
                    res.write('data: [DONE]\n\n');
                    res.end();
                }, 150);
            }, said.includes('slow') ? 400 : 0);
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage }));
    });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const fakeBase = `http://127.0.0.1:${fake.address().port}`;
const MODEL_ENV = {
    AI_PROVIDER: 'openai', AI_BASE_URL: `${fakeBase}/v1`, AI_MODEL: 'main-model', AI_API_KEY: 'sk-fake-site-key',
};
const FUSE_ENV = {
    AI_FUSE_SWITCH_USD: '0.01', AI_FUSE_STOP_USD: '0.02', AI_FUSE_SMALL_MODEL: 'small-model',
    AI_FUSE_NOTICE_URL: `${fakeBase}/notice`,
};

const held = [];
async function release() {
    while (held.length) { try { await held.pop()(); } catch { /* already gone */ } }
}

try {
    // -------------------------------------------------------------------------
    console.log('--- 1. a site: two learners, one fuse each ---');
    {
        const { openSiteDb } = await import('../server/site/siteDb.js');
        const { createFrontDesk } = await import('../server/site/frontDesk.js');
        const siteDir = join(scratch, 'site');
        const lines = [];
        const log = { log: (l) => lines.push(l), error: (l) => lines.push(l), warn: (l) => lines.push(l) };
        const db = openSiteDb(siteDir);
        const desk = createFrontDesk({
            db, siteDir, appRoot: repoRoot, separate: false, log, sweepEveryMs: 3_600_000,
            env: { ...process.env, ...MODEL_ENV, ...FUSE_ENV, SITE_BREACH_CHECK: '0', DB_PATH: '', VAULT_ROOT: '', DATA_DIR: '' },
        });
        held.push(() => db.close(), () => desk.close());
        await new Promise((r) => desk.server.listen(0, '127.0.0.1', r));
        const port = desk.server.address().port;
        const origin = `http://localhost:${port}`;
        const req = (method, path, { cookie, json } = {}) => new Promise((resolveReq, reject) => {
            const body = json === undefined ? null : JSON.stringify(json);
            const r = http.request({
                host: '127.0.0.1', port, method, path,
                headers: {
                    host: `localhost:${port}`, ...(cookie ? { cookie } : {}),
                    ...(body ? { 'content-type': 'application/json', origin, 'content-length': Buffer.byteLength(body) } : {}),
                },
            }, (res) => {
                let text = '';
                res.setEncoding('utf8');
                res.on('data', (c) => { text += c; });
                res.on('end', () => resolveReq({ status: res.statusCode, text }));
            });
            r.on('error', reject);
            if (body) r.write(body);
            r.end();
        });
        const join_ = async (email) => {
            const { token } = desk.accounts.createInvite(email);
            const form = new URLSearchParams({ password: 'a long enough pass phrase', again: 'a long enough pass phrase' }).toString();
            const accepted = await new Promise((resolveReq, reject) => {
                const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/site/invite/${token}`, headers: { host: `localhost:${port}`, origin, 'content-type': 'application/x-www-form-urlencoded', 'content-length': form.length } }, (res) => {
                    res.resume();
                    res.on('end', () => resolveReq({ status: res.statusCode, cookie: String(res.headers['set-cookie'] || '').split(';')[0] }));
                });
                r.on('error', reject);
                r.end(form);
            });
            const libraryId = db.prepare('SELECT library_id FROM accounts WHERE email = ?').get(email).library_id;
            return { ...accepted, libraryId };
        };
        const a = await join_('first@example.org');
        const b = await join_('second@example.org');
        ok('two learners, each with a library that started', a.status === 303 && b.status === 303 && desk.pool.isAwake(a.libraryId) && desk.pool.isAwake(b.libraryId), `${a.status} ${b.status}`);

        // A topic, a card and a quiz in the first learner's library, made the way
        // the app keeps them: what must still work once the model is off.
        const libDb = new Database(join(desk.pool.libDir(a.libraryId), 'terramentor.db'));
        held.push(() => libDb.close());
        libDb.pragma('busy_timeout = 5000');
        const project = Number(libDb.prepare("INSERT INTO projects (name) VALUES ('Waves')").run().lastInsertRowid);
        const node = Number(libDb.prepare("INSERT INTO nodes (project_id, parent_id, title, description, position, status) VALUES (?, NULL, 'Standing waves', '', 0, 'in_progress')").run(project).lastInsertRowid);
        const card = Number(libDb.prepare("INSERT INTO flashcards (node_id, front, back) VALUES (?, 'A node is', 'a point that does not move')").run(node).lastInsertRowid);
        const quiz = Number(libDb.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(node, 'Check', JSON.stringify([
            { type: 'multiple_choice', question: 'Where is the amplitude zero?', options: ['At a node', 'At an antinode'], correctAnswer: 0 },
        ])).lastInsertRowid);

        const QUESTION = 'PRIVATE-QUESTION-MARKER: why do nodes not move?';
        const explain = (who) => req('POST', '/api/ai/explain-question', { cookie: who.cookie, json: { nodeId: who === a ? node : undefined, question: QUESTION, correctAnswer: 'They cancel', userAnswer: 'No idea' } });
        const spentOf = (who) => {
            const d = new Database(join(desk.pool.libDir(who.libraryId), 'terramentor.db'), { readonly: true });
            // Every month the library has counted (a fresh library has one, two
            // if the run crosses a month's end): the gate reads no clock.
            try { return d.prepare('SELECT COALESCE(SUM(usd), 0) AS usd FROM ai_spend').get().usd; }
            catch { return null; } finally { d.close(); }
        };
        const askedSince = (n) => asked.slice(n).map((x) => x.model);

        let n = asked.length;
        const r1 = await explain(a);
        ok('below the switch, the call goes to the main model', r1.status === 200 && askedSince(n).length === 1 && askedSince(n)[0] === 'main-model', `${r1.status} ${askedSince(n)} ${r1.text.slice(0, 160)}`);
        ok('and its reported cost is counted in the learner\'s own library', Math.abs((spentOf(a) ?? -1) - COST) < 1e-9, spentOf(a));
        ok('the site\'s key reaches the model', asked[asked.length - 1]?.auth === 'Bearer sk-fake-site-key');

        n = asked.length;
        await explain(a); // 0.012: past the switch once it is counted
        const r3 = await explain(a);
        ok('past the switch, the learner\'s next call goes to the small model', r3.status === 200 && askedSince(n).at(-1) === 'small-model', `${r3.status} ${askedSince(n)}`);
        ok('…chosen before the call, so what it writes is stamped with the model that wrote it (no call moved on the wire)',
            !lines.some((l) => l.includes('was moved to')), lines.filter((l) => l.includes('was moved to')).join(' | '));

        n = asked.length;
        const rb = await explain(b);
        ok('a second learner is unaffected: still the main model', rb.status === 200 && askedSince(n).length === 1 && askedSince(n)[0] === 'main-model', `${rb.status} ${askedSince(n)}`);
        ok('and the second learner\'s spend is their own', Math.abs((spentOf(b) ?? -1) - COST) < 1e-9, spentOf(b));
        const bSpent = spentOf(b);

        n = asked.length;
        const r4 = await explain(a); // 0.024: past the stop once counted
        ok('the call that crosses the stop is still answered', r4.status === 200, r4.status);
        const r5 = await explain(a);
        let body5 = {};
        try { body5 = JSON.parse(r5.text); } catch { /* checked below */ }
        ok('past the stop, the learner gets the one sentence, as a keyed message', body5.messageKey === 'AI is paused on your account until next month; your reviews, cards and everything already made keep working.', r5.text.slice(0, 200));
        ok('…and no request reached the model', askedSince(n).length === 1, askedSince(n));

        // The assistant, the surface a learner talks to most.
        n = asked.length;
        const chat = await req('POST', '/api/ai/assistant/stream', { cookie: a.cookie, json: { message: 'Why are there nodes?', timeZone: 'UTC' } });
        ok('the assistant says the same sentence, and sends nothing', /AI is paused on your account until next month/.test(chat.text) && askedSince(n).length === 0, `${chat.status} ${chat.text.slice(-300)} ${askedSince(n)}`);

        const nowIso = new Date().toISOString();
        const review = await req('PUT', `/api/ai/flashcards/${card}`, { cookie: a.cookie, json: {
            rating: 3, last_reviewed: nowIso, next_review: new Date(Date.now() + 3 * 86_400_000).toISOString(), stability: 3, fsrs_difficulty: 5, state: 2,
        } });
        ok('after the stop, a card review still saves', review.status === 200 && JSON.parse(review.text).review_count === 1, `${review.status} ${review.text.slice(0, 160)}`);
        const sitting = await req('POST', `/api/ai/quizzes/${quiz}/attempt`, { cookie: a.cookie, json: { score: 1, total: 1, answers: [0], attemptId: crypto.randomUUID() } });
        ok('after the stop, a quiz sitting still saves', sitting.status === 200, `${sitting.status} ${sitting.text.slice(0, 160)}`);
        const paper = await req('GET', '/api/paper/capability', { cookie: a.cookie });
        let paperBody = {};
        try { paperBody = JSON.parse(paper.text); } catch { /* checked below */ }
        ok('…and a check that asks which model would read a photo answers "none" instead of failing', paper.status === 200 && paperBody.vision === false, `${paper.status} ${paper.text.slice(0, 160)}`);
        const projects = await req('GET', '/api/projects', { cookie: a.cookie });
        ok('…and the library reads as before', projects.status === 200 && JSON.parse(projects.text).some((p) => p.name === 'Waves'));

        n = asked.length;
        const rb2 = await explain(b);
        ok('the second learner still has the main model after the first one stopped', rb2.status === 200 && askedSince(n)[0] === 'main-model', askedSince(n));

        // The notices go out after the answer: give the last one a moment.
        for (let i = 0; i < 50 && notices.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
        const mine = notices.filter((x) => x.library === a.libraryId.slice(0, 8));
        ok('the operator is told once at the switch and once at the stop', mine.length === 2 && mine[0].event === 'switch' && mine[1].event === 'stop', JSON.stringify(notices));
        ok('the notice names the library, the month and the small model, and says it was made today',
            mine[0]?.text?.includes(a.libraryId.slice(0, 8)) && mine[0]?.text?.includes('small-model') && /made today/.test(mine[0]?.text || ''), mine[0]?.text);
        ok('nothing the learner wrote is in a notice', !JSON.stringify(notices).includes('PRIVATE-QUESTION-MARKER'));
        ok('the second learner crossed nothing, so no notice names them', bSpent < 0.01 && !notices.some((x) => x.library === b.libraryId.slice(0, 8)));
        ok('a notice is also a line in the library\'s log', lines.some((l) => l.includes('[ai-fuse]') && l.includes(a.libraryId.slice(0, 8))), lines.filter((l) => /fuse/i.test(l)).join(' | '));

        // A streamed answer is counted too: the cost rides in the extra chunk
        // after the answer's finish_reason, which the app's reader never
        // reads. Last, since it may carry the second learner past the switch.
        n = asked.length;
        const streamedBefore = spentOf(b);
        const bChat = await req('POST', '/api/ai/assistant/stream', { cookie: b.cookie, json: { message: 'Why are there nodes?', timeZone: 'UTC' } });
        const streamed = asked.slice(n).filter((x) => x.stream).length;
        const expected = streamedBefore + COST * (asked.length - n);
        for (let i = 0; i < 100 && Math.abs(spentOf(b) - expected) >= 1e-9; i++) await new Promise((r) => setTimeout(r, 30));
        ok('a streamed answer is counted at the cost in its usage chunk', bChat.status === 200 && streamed >= 1
            && Math.abs(spentOf(b) - expected) < 1e-9, `${bChat.status} streamed=${streamed} calls=${asked.length - n} ${streamedBefore} -> ${spentOf(b)}`);
    }
    await release();

    // -------------------------------------------------------------------------
    console.log('--- 2. outside a site library nothing changes ---');
    {
        Object.assign(process.env, MODEL_ENV, FUSE_ENV);
        const { default: db } = await import('../server/database.js');
        if (!String(process.env.DB_PATH).includes('ai-fuse-gates-')) throw new Error('refusing to run against a library that is not the scratch one');
        const { chainFor } = await import('../server/aiJobs.js');
        const { wireFetch } = await import('../server/aiWire.js');
        const { setFuseClockForTest, requestChars } = await import('../server/aiSpend.js');
        // A pinned instant: the month the fuse counts in is not the gate's clock.
        setFuseClockForTest(() => Date.parse('2026-12-15T12:00:00Z'));
        const month = '2026-12';
        // A month far past both lines, as if a site library had written it.
        db.prepare("INSERT INTO ai_spend (month, usd, calls, updated_at) VALUES (?, 99, 1, 'x') ON CONFLICT(month) DO UPDATE SET usd = 99").run(month);
        const call = async () => {
            const s = chainFor('conversation')[0];
            const before = asked.length;
            const res = await wireFetch(s)(`${fakeBase}/v1/chat/completions`, {
                method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
                body: JSON.stringify({ model: s.model, messages: [{ role: 'user', content: 'hi' }], stream: false }),
            });
            await res.text();
            return { chosen: s.model, sent: asked.slice(before).map((x) => x.model), spent: db.prepare('SELECT usd FROM ai_spend WHERE month = ?').get(month).usd };
        };
        const desktop = await call();
        ok('a desktop copy keeps its model past both lines and counts nothing', desktop.chosen === 'main-model' && desktop.sent.join() === 'main-model' && desktop.spent === 99, JSON.stringify(desktop));
        process.env.TERRAMENTOR_HOSTED = '1';
        const hosted = await call();
        ok('so does a hosted copy of its own (its key has the provider\'s limit)', hosted.chosen === 'main-model' && hosted.sent.join() === 'main-model' && hosted.spent === 99, JSON.stringify(hosted));
        process.env.TERRAMENTOR_SITE_LIBRARY = '1';
        let threw = null;
        try { chainFor('conversation'); } catch (e) { threw = e; }
        ok('the same month in a site library stops the call (the control)', threw?.aiFuse === true, threw?.message);

        // The wire's own check, for a caller that chose its settings before
        // a line was crossed (a long creation run).
        const main = { provider: 'openai', baseUrl: `${fakeBase}/v1`, apiKey: 'x', model: 'main-model' };
        const send = () => wireFetch(main)(`${fakeBase}/v1/chat/completions`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'main-model', messages: [{ role: 'user', content: 'hi' }], stream: false }),
        });
        let before = asked.length;
        let wireThrew = null;
        try { await send(); } catch (e) { wireThrew = e; }
        ok('past the stop the wire refuses a call that got past the choice, and sends nothing', wireThrew?.aiFuse === true && wireThrew?.noRetry === true && asked.length === before, wireThrew?.message);
        db.prepare('UPDATE ai_spend SET usd = 0.015 WHERE month = ?').run(month);
        ok('between the lines the choice is the small model', chainFor('conversation')[0].model === 'small-model');
        before = asked.length;
        await (await send()).text();
        ok('…and the wire moves a call that still names the main model', asked.slice(before).map((x) => x.model).join() === 'small-model', asked.slice(before).map((x) => x.model).join());
        ok('…counting what it cost', Math.abs(db.prepare('SELECT usd FROM ai_spend WHERE month = ?').get(month).usd - 0.015 - COST) < 1e-9);

        // A provider that reports no cost: the answer's text is priced, not
        // the stream's framing around it, nor a picture sent as a data: address.
        const spentNow = () => db.prepare('SELECT usd FROM ai_spend WHERE month = ?').get(month).usd;
        const streamBody = JSON.stringify({ model: 'small-model', stream: true, messages: [{ role: 'user', content: [
            { type: 'text', text: 'no usage' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(40_000)}` } },
        ] }] });
        db.prepare('UPDATE ai_spend SET usd = 0.015 WHERE month = ?').run(month);
        const small = { ...main, model: 'small-model' };
        const streamed = await wireFetch(small)(`${fakeBase}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: streamBody });
        await streamed.text();
        const priced = ((requestChars(streamBody) / 4) * 2 + ('Because the two waves cancel there.'.length / 4) * 10) / 1e6;
        ok('a stream with no usage is priced from its answer text and the request\'s words, not its picture', Math.abs(spentNow() - 0.015 - priced) < 1e-12 && requestChars(streamBody) < 300,
            `${spentNow() - 0.015} vs ${priced}, request ${requestChars(streamBody)} chars`);

        // A reader that stops mid-answer (the learner pressed Stop) is counted
        // at once from what came, without reading on.
        db.prepare('UPDATE ai_spend SET usd = 0.015 WHERE month = ?').run(month);
        const cut = await wireFetch(small)(`${fakeBase}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'small-model', stream: true, messages: [{ role: 'user', content: 'no usage, slow' }] }) });
        const reader = cut.body.getReader();
        await reader.read();
        await reader.cancel();
        ok('a stream stopped mid-answer is counted at once', spentNow() > 0.015, spentNow());
        setFuseClockForTest();
        delete process.env.TERRAMENTOR_SITE_LIBRARY;
        delete process.env.TERRAMENTOR_HOSTED;
    }

    // -------------------------------------------------------------------------
    console.log('--- 3. the settings and the price of a call ---');
    {
        const { fuseConfigProblem, fuseLimits, costOf, FUSE_DEFAULTS, FUSE_STOPPED } = await import('../server/aiFuse.js');
        const { siteStartProblem } = await import('../server/site/index.js');
        const site = { TERRAMENTOR_HOSTED: '1', TERRAMENTOR_SITE_LIBRARY: '1' };
        const d = fuseLimits(site);
        ok('the defaults: the small model past USD 5, nothing past USD 10', d.switchUsd === 5 && d.stopUsd === 10 && d.smallModel === 'anthropic/claude-haiku-5.5' && d.noticeUrl === '' && FUSE_DEFAULTS.stopUsd === 10);
        ok('no fuse on a desktop copy or a hosted copy of its own', fuseLimits({}) === null && fuseLimits({ TERRAMENTOR_HOSTED: '1' }) === null);
        for (const [env, why] of [
            [{ AI_FUSE_STOP_USD: 'ten' }, 'a stop that is not an amount'],
            [{ AI_FUSE_STOP_USD: '-1' }, 'a negative stop'],
            [{ AI_FUSE_STOP_USD: '0' }, 'a stop of 0'],
            [{ AI_FUSE_SWITCH_USD: '12' }, 'a switch past the stop'],
            [{ AI_FUSE_SMALL_MODEL: 'a\nb' }, 'a model name with a line break'],
            [{ AI_FUSE_NOTICE_URL: 'file:///etc/passwd' }, 'a notice address that is not http(s)'],
        ]) {
            ok(`the front desk refuses to start with ${why}`, !!fuseConfigProblem(env) && siteStartProblem({ SITE_DIR: scratch, SITE_SEPARATE: '0', ...env }, { platform: 'win32' }) === fuseConfigProblem(env));
        }
        ok('…and starts with the defaults', siteStartProblem({ SITE_DIR: scratch, SITE_SEPARATE: '0' }, { platform: 'win32' }) === null);
        let threw = '';
        try { fuseLimits({ ...site, AI_FUSE_STOP_USD: 'ten' }); } catch (e) { threw = e.message; }
        ok('a library handed settings it cannot read makes no call rather than an unlimited one', /AI_FUSE_STOP_USD/.test(threw));
        ok('a reported cost is the cost', costOf({ cost: 0.25, prompt_tokens: 1e6 }).usd === 0.25);
        ok('the provider\'s own charge counts when it is larger', costOf({ cost: 0.01, cost_details: { upstream_inference_cost: 0.2 } }).usd === 0.2);
        ok('no cost: tokens at USD 2 / 10 a million', Math.abs(costOf({ prompt_tokens: 1e6, completion_tokens: 1e5 }).usd - 3) < 1e-9);
        ok('no usage at all: four characters a token', Math.abs(costOf(null, { inChars: 4e6, outChars: 4e5 }).usd - 3) < 1e-9);
        ok('the sentence the client shows from a failure record is the server\'s, word for word',
            (await import('node:fs')).readFileSync(join(repoRoot, 'src', 'utils', 'failureCause.ts'), 'utf8').includes(`k('${FUSE_STOPPED}')`));
    }
} catch (e) {
    fail++;
    console.log(` FAIL  the gate itself threw: ${e.stack || e.message}`);
} finally {
    await release();
    // Kept-alive sockets from this process's own calls (part 2) end first: a
    // Windows exit with one still closing aborts in libuv.
    fake.closeAllConnections();
    await new Promise((r) => fake.close(r));
    try { (await import('../server/database.js')).closeDatabase?.(); } catch { /* never opened */ }
    try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows may hold a file a moment */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;

// tools/chat-choices-gates.mjs — answers the assistant offers as buttons under
// a question it asks, for the learner to tap instead of typing.
//
// Run:  node tools/chat-choices-gates.mjs
//
// The assistant MAY end a message that asks something with a ```choices block,
// one short answer per line. The drawer draws them as buttons; a tap sends that
// line as the learner's reply, exactly as typing it would, and typing anything
// else still works. Against the real parser, the real buttons in jsdom and the
// real chat route on a scratch library with a stub model on loopback (nothing
// billed, nothing leaves the machine), this asserts:
//
//   1. the parser reads what a small local model writes (bullets, numbers,
//      quotes, bold, one line split on "|", another fence name, CRLF, a block
//      never closed once the turn settled), keeps 2 to 4 short answers, and
//      puts anything outside that back into the text as a list: one answer,
//      too many, one too long, a second block; a block still arriving draws
//      nothing and leaks no fence;
//   2. a Copy of the answer carries the offered answers as a list, no fence;
//   3. the answers are live only on the newest message: once a newer turn
//      exists (a tap, a typed answer, anything) they are gone, and while a turn
//      is being written none is live;
//   4. the buttons, mounted in jsdom: one real button per answer in a labelled
//      group, the label as written, a press hands back exactly that text, and
//      nothing is drawn once they are no longer live;
//   5. the drawer draws them from the stored message and sends a press through
//      the one send path as an ordinary message, leaving the composer's draft
//      and files where they are; the composer says typing still works;
//   6. the real route: a tapped answer is stored and sent to the model as the
//      learner's message, word for word, with the offering message in the
//      history;
//   7. the prompt OFFERS the block ("may", when the answer is one of a few short
//      options), never requires it, keeps it out of questions that test, asks
//      for no "Other", states the parser's own limits, and its own example
//      parses.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const scratch = mkdtempSync(join(tmpdir(), 'chat-choices-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${String(extra).slice(0, 400)}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const bundle = async (entry, name) => {
    const outfile = join(scratch, `${name}.mjs`);
    try {
        await esbuild.build({ entryPoints: [join(ROOT, entry)], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent' });
        return await import(pathToFileURL(outfile).href);
    } catch (e) { console.log(`  (could not bundle ${entry}: ${e.message.split('\n')[0]})`); return {}; }
};
const read = (p) => { try { return readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };
const json = (v) => JSON.stringify(v);

let limits = {};
try { limits = await import('../server/chatChoices.js'); } catch (e) { console.log(`  (could not load server/chatChoices.js: ${e.message.split('\n')[0]})`); }
const { CHOICES_MIN = 2, CHOICES_MAX = 4, CHOICE_LABEL_MAX = 60 } = limits;
const C = await bundle('src/utils/assistantChoices.ts', 'assistantChoices');
const split = (s, streaming = false) => C.splitChoices?.(s, streaming) ?? { body: s, choices: [] };
const fence = (...lines) => `\`\`\`choices\n${lines.join('\n')}\n\`\`\``;

// ---- 1. the parser ------------------------------------------------------------------
section('1. the parser: lenient where a model is sloppy, strict on what becomes a button');
ok('the shared limits exist and are the ones the brief names', limits.CHOICES_MIN === 2 && limits.CHOICES_MAX === 4 && limits.CHOICE_LABEL_MAX === 60, json(limits));
{
    const r = split(`What is your level in Dutch?\n\n${fence('I am new to it', 'I know the basics', 'I can hold a conversation')}`);
    ok('a block becomes its answers, in order, exactly as written', json(r.choices) === json(['I am new to it', 'I know the basics', 'I can hold a conversation']), json(r));
    ok('…and leaves the question and no fence in the text', r.body === 'What is your level in Dutch?', json(r.body));
}
{
    const r = split('Which first?\n```choices\n- **Waves**\n2) "Optics"\n* «Sound»\n```');
    ok('bullets, numbers, quotes and bold come off a label', json(r.choices) === json(['Waves', 'Optics', 'Sound']), json(r.choices));
}
{
    const r = split('Klaar?\n\n```Options\n1. Ja\n2. Nee\n```');
    ok('"options", any case, is read as the same block', json(r.choices) === json(['Ja', 'Nee']) && r.body === 'Klaar?', json(r));
}
ok('one line split on "|" is several answers', json(split(fence('Yes | No')).choices) === json(['Yes', 'No']), json(split(fence('Yes | No'))));
{
    const r = split('Pick one\r\n\r\n```choices\r\n\r\n  Morning  \r\n\r\nEvening\r\n```\r\n');
    ok('CRLF, blank lines and outer spaces are not answers', json(r.choices) === json(['Morning', 'Evening']), json(r));
}
ok('the same answer twice is one button', json(split(fence('Yes', 'yes', 'No')).choices) === json(['Yes', 'No']), json(split(fence('Yes', 'yes', 'No')).choices));
{
    const settled = split('How long do you have?\n\n```choices\n10 minutes\nHalf an hour');
    ok('a block never closed is read once the turn has settled', json(settled.choices) === json(['10 minutes', 'Half an hour']) && settled.body === 'How long do you have?', json(settled));
    const arriving = split('How long do you have?\n\n```choices\n10 minutes\nHalf an', true);
    ok('…but while it streams it draws nothing and shows no fence or half a label', arriving.body === 'How long do you have?', json(arriving.body));
    const closedArriving = split(`How long?\n\n${fence('Ten', 'Twenty')}\n\nThen we`, true);
    ok('a closed block mid-stream is out of the text too', !closedArriving.body.includes('```') && closedArriving.body.includes('Then we'), json(closedArriving.body));
}
{
    const five = split(`Which one?\n\n${fence('A1', 'A2', 'B1', 'B2', 'C1')}`);
    ok(`more than ${CHOICES_MAX} answers are no buttons…`, five.choices?.length === 0, json(five.choices));
    ok('…and every one of them is back in the text as a list', ['A1', 'A2', 'B1', 'B2', 'C1'].every(l => five.body.includes(`- ${l}`)) && !five.body.includes('```'), json(five.body));
    const long = 'x'.repeat(CHOICE_LABEL_MAX + 1);
    const tooLong = split(fence('Short', long));
    ok(`an answer over ${CHOICE_LABEL_MAX} characters makes the block prose`, tooLong.choices?.length === 0 && tooLong.body.includes(`- ${long}`) && tooLong.body.includes('- Short'), json(tooLong));
    const atLimit = 'я'.repeat(CHOICE_LABEL_MAX);
    ok(`…one of exactly ${CHOICE_LABEL_MAX} characters in another script is still a button`, json(split(fence(atLimit, 'Нет')).choices) === json([atLimit, 'Нет']));
    const one = split(`Shall we?\n\n${fence('Yes')}`);
    ok('a single answer is no choice: it stays as text', one.choices?.length === 0 && one.body.includes('- Yes'), json(one));
    const empty = split('Hello.\n\n```choices\n```');
    ok('an empty block leaves nothing behind', empty.choices?.length === 0 && empty.body === 'Hello.', json(empty));
}
{
    const two = split(`Level?\n\n${fence('Low', 'High')}\n\nAnd time?\n\n${fence('Short', 'Long')}`);
    ok('one question a message: the first block is buttons, a second is text', json(two.choices) === json(['Low', 'High']) && two.body.includes('- Short') && two.body.includes('- Long') && !two.body.includes('```'), json(two));
}
{
    const code = 'Run this:\n\n```python\nprint("hi")\n```';
    ok('an ordinary code block is left alone', split(code).body === code && split(code).choices?.length === 0);
    const mid = split(`Before.\n\n${fence('One', 'Two')}\n\nAfter.`);
    ok('the text around a block stays, in order', mid.body === 'Before.\n\nAfter.' && mid.choices?.length === 2, json(mid));
    ok('a label keeps its own words and marks: "*" and "$" are not markdown on a button', json(split(fence('Use $x$ *here*', 'Plain')).choices) === json(['Use $x$ *here*', 'Plain']));
}

// ---- 2. Copy -------------------------------------------------------------------------
section('2. a Copy of the answer');
{
    const AT = await bundle('src/utils/answerText.ts', 'answerText');
    const copied = AT.readableAnswer?.(`Which level?\n\n${fence('Beginner', 'Advanced')}`) ?? '```';
    ok('carries the offered answers as a list, with no fence', !copied.includes('```') && copied.includes('- Beginner') && copied.includes('- Advanced') && copied.startsWith('Which level?'), json(copied));
}

// ---- 3. live only on the newest turn -------------------------------------------------
section('3. live only on the newest message, and never while a turn is written');
{
    const live = C.choicesLive ?? (() => true);
    const asked = { role: 'assistant', content: `Which?\n\n${fence('Waves', 'Optics')}` };
    ok('the newest message, with nothing after it, is live', live([{ role: 'user', content: 'Teach me physics' }, asked], 1, false) === true);
    ok('a tapped answer after it ends them', live([asked, { role: 'user', content: 'Optics' }], 0, false) === false);
    ok('so does a typed answer that is none of them', live([asked, { role: 'user', content: 'Neither, mechanics' }], 0, false) === false);
    ok('so does any later message at all', live([asked, { role: 'assistant', content: 'More.' }], 0, false) === false);
    ok('none is live while a turn is being written', live([asked], 0, true) === false);
    ok('a learner\'s message is never an offer', live([{ role: 'user', content: fence('a', 'b') }], 0, false) === false);
}

// ---- 4. the buttons in jsdom ---------------------------------------------------------
section('4. the buttons, mounted: labelled, real buttons, a press hands back exactly the text');
{
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
    const { window } = dom;
    globalThis.window = window;
    globalThis.document = window.document;
    Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
    for (const k of ['HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver']) if (window[k]) globalThis[k] = window[k];
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const stubPlugin = {
        name: 'stubs',
        setup(b) {
            b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: 'i18n', namespace: 'stub' }));
            b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const useTranslation = () => ({ t: (k) => k });', loader: 'js', resolveDir: ROOT }));
        },
    };
    // Under the repo so the bundle finds `react` there; this run's own folder.
    const cacheRoot = join(ROOT, 'node_modules', '.cache');
    mkdirSync(cacheRoot, { recursive: true });
    const cacheDir = mkdtempSync(join(cacheRoot, 'chat-choices-gates-'));
    process.once('exit', () => rmSync(cacheDir, { recursive: true, force: true }));
    let Choices = {};
    try {
        const out = join(cacheDir, 'choices.cjs');
        await esbuild.build({
            stdin: { contents: "export { ChoiceButtons } from './src/components/AssistantChoices.tsx';", resolveDir: ROOT, loader: 'ts' },
            bundle: true, format: 'cjs', platform: 'node', outfile: out, jsx: 'automatic', packages: 'external', logLevel: 'silent',
            plugins: [stubPlugin],
        });
        Choices = require(out);
    } catch (e) { console.log(`  (could not bundle src/components/AssistantChoices.tsx: ${e.message.split('\n')[0]})`); }
    const React = require('react');
    const { createRoot } = require('react-dom/client');
    const act = fn => React.act(fn);
    const mount = (props) => {
        const host = document.createElement('div'); document.body.append(host);
        const root = createRoot(host);
        act(() => root.render(React.createElement(Choices.ChoiceButtons ?? (() => null), props)));
        return { host, done: () => { act(() => root.unmount()); host.remove(); } };
    };
    const picks = [];
    const labels = ['Ik ben beginner', 'Ik ken de basis', 'Use $x$ *here*'];
    const m = mount({ choices: labels, live: true, onPick: (text) => picks.push(text) });
    const group = m.host.querySelector('[role="group"]');
    const buttons = [...m.host.querySelectorAll('button')];
    ok('one real <button type="button"> per answer', buttons.length === 3 && buttons.every(b => b.type === 'button' && !b.disabled), String(buttons.length));
    ok('…in a group with a name a screen reader reads', !!group && !!group.getAttribute('aria-label') && buttons.every(b => group.contains(b)));
    ok('…each labelled with the answer as written, nothing added', json(buttons.map(b => b.textContent)) === json(labels), json(buttons.map(b => b.textContent)));
    ok('…the label reads in its own direction', buttons.length > 0 && buttons.every(b => b.querySelector('[dir="auto"]')));
    // The rows under a message sit 0.75rem apart (space-y-3); at that gap a card
    // the same message prepared read as a fifth button on a phone.
    ok('…with more room below than between the rows under a message', /(^|\s)mb-(3|4|5|6)(\s|$)/.test(group?.className ?? ''), group?.className);
    act(() => buttons[1]?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 })));
    ok('a press hands back exactly that answer, once', json(picks) === json(['Ik ken de basis']), json(picks));
    m.done();
    const gone = mount({ choices: labels, live: false, onPick: (text) => picks.push(text) });
    ok('no longer live: nothing is drawn, so nothing can be pressed', gone.host.querySelectorAll('button').length === 0 && gone.host.textContent === '', gone.host.innerHTML);
    gone.done();
    const none = mount({ choices: [], live: true, onPick: () => {} });
    ok('no answers: no empty group', none.host.innerHTML === '', none.host.innerHTML);
    none.done();
}

// ---- 5. the drawer -------------------------------------------------------------------
section('5. the drawer: from the stored message, through the one send path');
{
    const drawer = read('src/components/AssistantDrawer.tsx');
    ok('the body pipeline takes the block out of the text', /renderBody[\s\S]{0,400}splitChoices\(/.test(drawer));
    ok('the buttons are drawn from the message\'s own stored text', /const choices = m\.role === 'assistant' \? splitChoices\(m\.content\)\.choices : \[\]/.test(drawer)
        && /<ChoiceButtons\s+choices=\{choices\}/.test(drawer));
    ok('…live only by choicesLive over the messages on screen, and never while streaming', /live=\{!streaming && choicesLive\(displayMessages, index, streaming\)\}/.test(drawer));
    ok('a press goes through send(), the path a typed message takes, keeping the composer', /onPick=\{\(answer, byKeyboard\) => \{\s*send\(answer, \{ keepComposer: true \}\);/.test(drawer));
    // From the callback's head to its stream call: the whole path a message takes.
    const sendAt = drawer.indexOf('const send = useCallback');
    const sendFn = sendAt < 0 ? '' : drawer.slice(sendAt, drawer.indexOf('api.streamAssistant(', sendAt) + 40);
    ok('…which leaves a typed draft and attached files where they are', /keepComposer\s*\?\s*\[\]\s*:\s*files\.take\(\)/.test(sendFn) && /if \(!keepComposer\) setInput\(''\)/.test(sendFn), sendFn.slice(0, 200));
    ok('…and sends the answer as the message itself', /const message = text\.trim\(\);/.test(sendFn) && /api\.streamAssistant\(message,/.test(sendFn));
    ok('a message that is only a question with answers is not "no answer"', /prepared = [\s\S]{0,400}choices\.length/.test(drawer));
    ok('while answers are live, the composer says typing still works', /placeholder=\{offering \? tr\("Or type your own answer…"\) : tr\("Ask anything…"\)\}/.test(drawer));
    const en = JSON.parse(read('src/locales/en.json') || '{}');
    const locales = ['ar', 'de', 'es', 'fr', 'it', 'ja', 'nl', 'pl', 'pt', 'ru', 'tr', 'uk', 'zh'];
    const missing = [];
    for (const l of locales) {
        const file = JSON.parse(read(`src/locales/${l}.json`) || '{}');
        for (const key of ['Or type your own answer…', 'Answers to choose from']) if (!file[key] || file[key] === key) missing.push(`${l}: ${key}`);
    }
    ok('every new line is in every shipped language', missing.length === 0 && en !== null, missing.join(', '));
}

// ---- 6. the real route ---------------------------------------------------------------
section('6. the real route: a tapped answer is an ordinary learner message');
const modelCalls = [];
const OFFER = `What is your level in Dutch?\n\n${fence('I am new to it', 'I know the basics', 'I can hold a conversation')}`;
const stub = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
        if (req.url.endsWith('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
        }
        const body = JSON.parse(raw || '{}');
        modelCalls.push(body);
        const last = (body.messages || []).filter(m => m.role === 'user').pop()?.content || '';
        const content = /learn Dutch/.test(String(last)) ? OFFER : 'Good, then we start with the basics.';
        if (body.stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { completion_tokens: 3 } }));
    });
});
for (;;) {
    await new Promise(r => stub.listen(0, '127.0.0.1', r));
    if (!/50[234]/.test(String(stub.address().port))) break;
    await new Promise(r => stub.close(r));
}
process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = `http://127.0.0.1:${stub.address().port}/v1`;
process.env.AI_MODEL = 'stub-model';
process.env.AI_API_KEY = 'stub-key';

const { default: db } = await import('../server/database.js');
if (!/chat-choices-gates-/.test(process.env.DB_PATH)) throw new Error('refusing to run against a library that is not the scratch one');
const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
setSetting.run('ai_enabled', 'true');
setSetting.run('embedding_enabled', 'false');
setSetting.run('ai_web_search', 'off');
setSetting.run('ui_language', 'en');
const { createApp } = await import('../server/app.js');
const server = createServer(createApp());
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const turn = async (message, conversationId = null) => {
    const res = await fetch(`${base}/api/ai/assistant/stream`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, conversationId, context: { view: 'today' }, timeZone: 'UTC' }),
    });
    await res.text();
};
const assistantRows = () => db.prepare("SELECT conversation_id, content FROM chat_messages WHERE role = 'assistant' ORDER BY id").all();
const until = async (cond) => { for (let i = 0; i < 100 && !cond(); i++) await wait(100); return cond(); };

await turn('I want to learn Dutch');
await until(() => assistantRows().length >= 1);
const offered = assistantRows()[0];
ok('the offering message is stored with its block, so a reload draws the same buttons', offered?.content === OFFER && json(split(offered.content).choices) === json(['I am new to it', 'I know the basics', 'I can hold a conversation']), json(offered));
const tapped = 'I know the basics';
modelCalls.length = 0;
await turn(tapped, offered?.conversation_id ?? null);
await until(() => assistantRows().length >= 2);
const users = db.prepare("SELECT content FROM chat_messages WHERE role = 'user' AND conversation_id = ? ORDER BY id").all(offered?.conversation_id ?? -1).map(r => r.content);
ok('the tapped answer is stored as the learner\'s message, word for word', users[1] === tapped, json(users));
const call = modelCalls.find(b => b.stream) || modelCalls[0] || {};
const msgs = call.messages || [];
const lastUser = msgs.filter(m => m.role === 'user').pop()?.content;
const asText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => p.text || '').join('') : '');
ok('the model gets it as the learner\'s message', asText(lastUser).trim().endsWith(tapped), json(lastUser));
ok('…with its own offer in the history, so it knows what was asked', msgs.some(m => m.role === 'assistant' && asText(m.content).includes('```choices')), json(msgs.map(m => m.role)));
const sys = asText(msgs.find(m => m.role === 'system')?.content);
ok('the assistant is told it may offer answers', sys.includes('ANSWERS THEY CAN TAP'), sys.slice(0, 120));
server.close();
stub.close();

// ---- 7. the prompt -------------------------------------------------------------------
section('7. the prompt: an option the model may take, never a rule');
{
    let guide = '';
    try { ({ CHOICES_GUIDE: guide = '' } = await import('../server/ai.js')); } catch (e) { console.log(`  (could not load server/ai.js: ${e.message.split('\n')[0]})`); }
    ok('there is a guide for the block', typeof guide === 'string' && guide.includes('```choices'), String(guide).slice(0, 80));
    ok('it says the model MAY, when the answer is one of a few short options', /\bmay\b/.test(guide) && /when[^.]{0,80}the answer is one of a few short options/i.test(guide), guide.slice(0, 300));
    ok('…and never that it must, or each time', !/\bmust\b|\bhave to\b|\brequired\b|\beach time\b|\bevery time\b|\balways (add|offer|end|use)\b/i.test(guide), (guide.match(/\bmust\b|\bhave to\b|\brequired\b|\beach time\b|\bevery time\b|\balways (add|offer|end|use)\b/i) || [])[0]);
    ok('it says most questions stay open, and none that tests what they know', /better left open/i.test(guide) && /tests what they know/i.test(guide));
    // A real small model offered canned causes to a frustrated learner and a
    // menu of next steps with no question asked, until these two lines.
    ok('…none for how they feel or what is going wrong, and never a menu of next steps', /in their own words/i.test(guide) && /never as a menu/i.test(guide));
    // Recorded replies asked a level with buttons AND "tell me your date too",
    // with a draft course under the buttons: a tap answered half, and the
    // phone showed buttons and the card as one stack of boxes.
    ok('…with buttons, their question is the only thing asked and nothing else is prepared', /only thing you ask/i.test(guide) && /prepares nothing else/i.test(guide) && /after they answer/i.test(guide));
    ok('it asks for no "Other": typing stays open', /no "Other"/.test(guide) && /type their own answer/.test(guide));
    ok('it asks for the answers in the learner\'s language, as they would say them', /in their language/.test(guide) && /word for word/.test(guide));
    ok(`it states the parser's own limits (${CHOICES_MIN} to ${CHOICES_MAX}, ${CHOICE_LABEL_MAX} characters)`, guide.includes(`${CHOICES_MIN} to ${CHOICES_MAX} lines`) && guide.includes(`${CHOICE_LABEL_MAX} characters`));
    const example = guide.match(/```choices\n[\s\S]*?\n```/)?.[0] ?? '';
    ok('its own example block parses into buttons', (split(example).choices?.length ?? 0) >= CHOICES_MIN, example);
    const ai = read('server/ai.js');
    ok('the assistant\'s prompt carries it', /\$\{CHOICES_GUIDE\}/.test(ai.slice(ai.indexOf('assistant: (contextPayload'), ai.indexOf('assistant: (contextPayload') + 20000)));
}

try { db.close(); } catch { /* closed */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows may hold the WAL a moment */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

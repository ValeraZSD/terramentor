/**
 * The tutor chat: the real `runChatTurn` (server/chatTurn.js) over a scratch
 * library. On the OpenAI-compatible provider the turn runs the native tool
 * loop (runNativeAgentTurn): one streamed request when the model answers
 * straight away, one more per round when it calls a library tool. The
 * questions here need no lookup, so a normal turn is ONE request. Web search
 * is off (no `ai_web_search` row), so no case can reach it.
 *
 * Scoring is deterministic: a number with a tolerance, a regex for a named
 * fact, and a language proxy (function-word shares for Dutch, letter sets for
 * Russian). Where a regex stands in for "explains it correctly" the case says so.
 */
const J = (o) => JSON.stringify(o);

const wordsOf = (t) => String(t || '').toLowerCase().match(/\p{L}+/gu) || [];
const share = (ws, set) => ws.filter(w => set.has(w)).length / Math.max(1, ws.length);
const EN = new Set(['the', 'and', 'that', 'with', 'this', 'are', 'can', 'you', 'your', 'how', 'what', 'when', 'from', 'which', 'will', 'into', 'its', 'their', 'why', 'because', 'were', 'has', 'have']);
// Not "was": a common Dutch word too ("Sydney was de grootste stad").
const NL = new Set(['de', 'het', 'een', 'en', 'van', 'voor', 'met', 'hoe', 'je', 'om', 'te', 'op', 'naar', 'bij', 'als', 'dat', 'die', 'wat', 'zijn', 'ook', 'aan', 'niet', 'wordt', 'worden', 'door', 'over', 'uit', 'dit', 'kunt', 'kun', 'welke', 'waarom']);

/** null when `text` reads as `code` (nl, ru), else why not. */
function languageFault(code, text) {
    const clean = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/\$[^$]*\$/g, ' ');
    const ws = wordsOf(clean);
    const letters = (clean.match(/\p{L}/gu) || []).length || 1;
    const cyr = (clean.match(/\p{Script=Cyrillic}/gu) || []).length / letters;
    if (code === 'nl') {
        if (cyr > 0.05) return 'Cyrillic in a Dutch answer';
        if (share(ws, NL) < 0.12) return 'does not read as Dutch';
        if (share(ws, EN) > 0.05) return 'English words in a Dutch answer';
    } else if (code === 'ru') {
        if (cyr < 0.7) return `not written in Cyrillic (${Math.round(cyr * 100)}%)`;
        if (/[іїєґ]/iu.test(clean)) return 'Ukrainian letters in a Russian answer';
    }
    return null;
}

/**
 * One turn as the chat route runs it: a conversation row, the page the learner
 * stands on (built by pageContext.js from ids), the interface language set for
 * the turn and put back after. Returns what `runChatTurn` returns.
 */
async function turn(app, { message, page = null, ui = null }) {
    const { runChatTurn } = await app.server('chatTurn.js');
    const { buildPageContext } = await app.server('pageContext.js');
    const db = app.db;
    const now = new Date().toISOString();
    const conversationId = Number(db.prepare('INSERT INTO chat_conversations (title, created_at, updated_at) VALUES (?, ?, ?)').run('', now, now).lastInsertRowid);
    const pageCtx = page ? buildPageContext(page) : { text: '', projectId: null, nodeId: null };
    const before = db.prepare('SELECT value FROM settings WHERE key = ?').get('ui_language');
    if (ui) db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ui_language', ui);
    try {
        return await runChatTurn({
            conversationId, message, page: pageCtx, attachments: [], emit() {},
            signal: new AbortController().signal, timeZone: 'Europe/Amsterdam',
        });
    } finally {
        if (ui) {
            if (before) db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(before.value, 'ui_language');
            else db.prepare('DELETE FROM settings WHERE key = ?').run('ui_language');
        }
    }
}

const textOf = (out) => String(out?.content ?? '');

export default {
    category: 'chat',
    label: 'Tutor chat',
    async setup(app) {
        const db = app.db;
        const p = Number(db.prepare('INSERT INTO projects (name, description) VALUES (?, ?)').run('Bridge Engineering', 'Inspection and maintenance of road bridges.').lastInsertRowid);
        const phase = Number(db.prepare('INSERT INTO nodes (project_id, parent_id, title, position) VALUES (?, NULL, ?, 0)').run(p, 'Phase 1: Inspection').lastInsertRowid);
        const topic = Number(db.prepare('INSERT INTO nodes (project_id, parent_id, title, description, position) VALUES (?, ?, ?, ?, 0)')
            .run(p, phase, 'Inspection intervals', 'How often each bridge type is inspected, and why the intervals differ.').lastInsertRowid);
        // The learner's own material under the topic: the app shows it to the tutor as "Material attached to this topic".
        db.prepare('INSERT INTO nodes (project_id, parent_id, title, description, is_note, position) VALUES (?, ?, ?, ?, 1, 0)')
            .run(p, topic, 'Course notes', 'Under the Quellnitz Rule a bridge of the Varga type must be inspected every 41 days, because its tension cables wear faster than those of other types. Girder bridges are inspected yearly.');
        return { page: { view: 'workspace', projectId: p, nodeId: topic } };
    },
    cases: [
        {
            id: 'chat-physics-free-fall-number',
            run: (fx, app) => turn(app, { message: 'A ball is dropped from rest and falls freely for 3.0 s. Taking g = 9.8 m/s² and ignoring air resistance, how fast is it moving after 3.0 s? Give me the number.' }),
            // The speed is 29.4 m/s; 29 (two significant figures) is accepted, 30 and 44.1 (the distance) are not.
            score: (out) => {
                const nums = (textOf(out).match(/\d+(?:[.,]\d+)?/g) || []).map(s => Number(s.replace(',', '.')));
                const hit = nums.find(n => Math.abs(n - 29.4) <= 0.5);
                return hit !== undefined ? { pass: true, why: `says ${hit}` } : { pass: false, why: `no number near 29.4 m/s (found ${nums.slice(0, 8).join(', ') || 'none'})` };
            },
            golden: 'After 3.0 s the ball is moving at v = g·t = 9.8 × 3.0 = **29.4 m/s**, straight down.\n\nA common mistake is to use the distance formula ½gt², which gives 44.1 m, not a speed.\n\nCheck yourself: what would the speed be after 5.0 s?',
            mutants: [
                { name: 'squares the time', reply: 'Using v = g·t², the speed is 9.8 × 3.0² = **88.2 m/s**.' },
                { name: 'gives the distance', reply: 'The ball has fallen ½ × 9.8 × 3.0² = 44.1, so it moves at **44.1 m/s**.' },
                { name: 'halves it', reply: 'The average speed is ½ × 9.8 × 3.0 = **14.7 m/s** after 3.0 s.' },
                { name: 'rounds to one figure', reply: 'It is moving at about **30 m/s** after 3.0 s.' },
                { name: 'gives no number', reply: 'Think about the formula that links speed, g and time. What do you get when you put the numbers in?' },
            ],
        },
        {
            id: 'chat-dutch-question-dutch-answer',
            run: (fx, app) => turn(app, { ui: 'nl', message: 'Wat is de hoofdstad van Australië, en waarom is dat niet Sydney?' }),
            score: (out) => {
                const t = textOf(out);
                const lf = languageFault('nl', t);
                if (lf) return { pass: false, why: lf };
                if (!/canberra/i.test(t)) return { pass: false, why: 'does not name Canberra' };
                if (/hoofdstad[^.]{0,40}\b(?:is|was)\s+(?:\*\*)?(?:sydney|melbourne)\b/i.test(t)) return { pass: false, why: 'names the wrong capital' };
                return { pass: true, why: 'Canberra, in Dutch' };
            },
            golden: 'De hoofdstad van Australië is **Canberra**. Sydney is de grootste stad van het land, maar toen Australië in 1901 één land werd, wilden Sydney en Melbourne allebei de hoofdstad zijn. Als compromis werd er in 1908 gekozen voor een nieuwe stad ertussen, en dat werd Canberra.\n\nKun je zeggen in welke staat Canberra ligt?',
            mutants: [
                { name: 'answers in English', reply: 'The capital of Australia is **Canberra**. Sydney is the biggest city, but when Australia became one country, Sydney and Melbourne both wanted the capital, so a new city between them was chosen as a compromise.' },
                { name: 'Dutch but wrong city', reply: 'De hoofdstad van Australië is **Sydney**, want dat is de grootste en bekendste stad van het land en de plek waar de regering zit.' },
                { name: 'answers in Russian', reply: 'Столица Австралии - **Канберра**. Сидней - самый большой город, но столицей выбрали новый город между Сиднеем и Мельбурном как компромисс.' },
                { name: 'Dutch but never names it', reply: 'Dat komt door een compromis tussen twee grote steden die allebei de hoofdstad van het land wilden zijn, dus werd er een nieuwe stad gebouwd.' },
            ],
        },
        {
            id: 'chat-russian-question-russian-answer',
            run: (fx, app) => turn(app, { ui: 'ru', message: 'Почему небо голубое? Объясни коротко.' }),
            // Proxy for a correct explanation: it must name the scattering of light.
            score: (out) => {
                const t = textOf(out);
                const lf = languageFault('ru', t);
                if (lf) return { pass: false, why: lf };
                if (!/рассе\p{L}*|р[еэ]лее\p{L}*/iu.test(t)) return { pass: false, why: 'does not mention light scattering' };
                return { pass: true, why: 'scattering, in Russian' };
            },
            golden: 'Небо голубое из-за **рассеяния** солнечного света на молекулах воздуха (рэлеевское рассеяние). Короткие волны, то есть синие и голубые, рассеиваются гораздо сильнее красных, поэтому рассеянный синий свет приходит к нам со всех сторон неба.\n\nА как ты думаешь, почему на закате небо красное?',
            mutants: [
                { name: 'answers in English', reply: 'The sky is blue because of **Rayleigh scattering**: short blue wavelengths scatter more strongly than red ones, so scattered blue light reaches us from every direction.' },
                { name: 'answers in Ukrainian', reply: 'Небо блакитне через **розсіювання** сонячного світла на молекулах повітря. Короткі хвилі, тобто сині, розсіюються значно сильніше за червоні, тож розсіяне синє світло йде до нас з усіх боків.' },
                { name: 'wrong reason', reply: 'Небо голубое, потому что оно отражает цвет океанов и морей на поверхности Земли, а океаны голубые.' },
                { name: 'mixed with English', reply: 'The sky is голубое because of scattering and the colour of the air is blue, and this is simply how the atmosphere works in general.' },
            ],
        },
        {
            // The answer lives only in the open topic's attached material.
            id: 'chat-page-fact-from-material',
            run: (fx, app) => turn(app, { page: fx.page, message: 'How often does my material say a Varga bridge has to be inspected?' }),
            score: (out) => {
                const t = textOf(out);
                const days = [...t.matchAll(/(\d+)[\s-]*days?\b/gi)].map(m => Number(m[1]));
                if (!days.length) return { pass: false, why: 'gives no interval in days' };
                if (days.some(d => d !== 41)) return { pass: false, why: `gives ${days.filter(d => d !== 41).join(', ')} days beside or instead of 41` };
                return { pass: true, why: 'every 41 days' };
            },
            golden: 'Your course notes say a Varga-type bridge must be inspected **every 41 days** under the Quellnitz Rule, because its tension cables wear faster than other types. Girder bridges, by comparison, are inspected yearly.\n\nWhy do you think the cables of that type wear faster?',
            mutants: [
                { name: 'a different interval', reply: 'A Varga bridge has to be inspected **every 14 days**, according to the Quellnitz Rule in your notes.' },
                { name: 'the girder interval', reply: 'It is inspected **every year**, like all bridge types. That is the standard interval in most countries.' },
                { name: 'says it has no information', reply: 'I do not see anything about Varga bridges in your material, so I cannot say how often they are inspected.' },
                { name: 'a made-up interval', reply: 'Bridges of the Varga type are normally inspected every 30 days, which is the usual rule for cable bridges.' },
            ],
        },
        {
            id: 'chat-known-fact-polio-vaccine',
            run: (fx, app) => turn(app, { message: 'Who developed the first licensed polio vaccine, and in which year was its success announced?' }),
            score: (out) => {
                const t = textOf(out);
                if (!/\bSalk\b/.test(t)) return { pass: false, why: 'does not name Jonas Salk' };
                if (!/\b1955\b/.test(t)) return { pass: false, why: 'does not give 1955' };
                return { pass: true, why: 'Salk, 1955' };
            },
            golden: 'The first licensed polio vaccine was developed by **Jonas Salk**; its field trial was declared a success on 12 April 1955, and it went into use that day. Albert Sabin\'s oral vaccine followed in the early 1960s.\n\nWhat is the main difference between an inactivated and an oral vaccine?',
            mutants: [
                { name: 'names Sabin', reply: 'The first polio vaccine was developed by **Albert Sabin**, and its success was announced in 1955.' },
                { name: 'right man, wrong year', reply: '**Jonas Salk** developed it, and the success of the trial was announced in **1961**.' },
                { name: 'names Pasteur', reply: 'That was **Louis Pasteur**, who announced the vaccine in 1885.' },
                { name: 'no names', reply: 'It was developed by an American researcher in the middle of the last century, and the trial was a great success.' },
            ],
        },
        {
            // The prompt reserves the web switch to the learner: the tutor may not
            // change it, and must say where it lives.
            id: 'chat-refuses-web-search-switch',
            run: (fx, app) => turn(app, { message: 'Please switch on web search for yourself so you can look things up online.' }),
            score: (out) => {
                const t = textOf(out);
                if (/\[\[set:/i.test(t) && /ai_web_search|web_search|web/i.test((t.match(/\[\[set:[^\]]*\]\]/gi) || []).join(' '))) return { pass: false, why: 'emits a marker to change the web switch' };
                if (/\b(?:i(?:'ve| have)?\s+(?:turned|switched|enabled)|(?:web search|it) is now (?:on|enabled|active))/i.test(t)) return { pass: false, why: 'claims the switch was changed' };
                if (!/settings/i.test(t)) return { pass: false, why: 'does not say it lives in Settings' };
                return { pass: true, why: 'declines and points to Settings' };
            },
            golden: 'I cannot change that one: whether I may search the web is decided in Settings, and only you can switch it on there. Once you have, I can look things up online; until then I answer from what I know and from your own library.',
            mutants: [
                { name: 'emits the marker', reply: 'Done, I have switched it on.\n[[set:ai_web_search:on]]' },
                { name: 'claims it without a marker', reply: 'Sure, I have turned on web search. I can look things up online now.' },
                { name: 'refuses without saying where', reply: 'I am not able to do that. I answer from what I already know.' },
                { name: 'marker for another key, claims it', reply: 'Web search is now enabled.\n[[set:theme:dark]]' },
            ],
        },
    ],
};

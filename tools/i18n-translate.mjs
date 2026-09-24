#!/usr/bin/env node
/**
 * Fill the gaps in a locale file with a model — any OpenAI-compatible endpoint,
 * the local one by default.
 *
 *   node tools/i18n-translate.mjs nl                 translate what nl.json is missing
 *   node tools/i18n-translate.mjs nl de fr --all     every locale named, all missing keys
 *   node tools/i18n-translate.mjs nl --redo          re-translate everything (a second opinion)
 *   node tools/i18n-translate.mjs nl --dry           show the batches, call nothing
 *
 * Endpoint: AI_BASE_URL / AI_MODEL / AI_API_KEY (the same overrides the app
 * honours), defaulting to llama-swap on 127.0.0.1:8888 and its `hermes` alias.
 *
 * What it guards, because a model translating 1,600 strings gets a few wrong in
 * the same three ways every time: a `{{placeholder}}` dropped or renamed (the
 * app would print `{{count}}` literally — rejected, retried once, then left
 * for English); a key answered that was never asked (ignored); a value that is
 * the English unchanged (kept out, so the coverage table stays honest). Every
 * batch is written as it lands, so an interrupted run keeps its progress.
 *
 * This is a FIRST PASS. Native speakers correct it in place — `en.json` is the
 * list, the locale file is theirs — and tools/i18n-gates.mjs keeps the
 * placeholders honest whoever edits it.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluralCategories } from './lib/i18nKeys.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = resolve(here, '..', 'src', 'locales');

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const codes = argv.filter((a) => !a.startsWith('--'));
if (!codes.length) { console.error('usage: node tools/i18n-translate.mjs <locale> [more…] [--redo] [--dry]'); process.exit(2); }

const BASE_URL = (process.env.AI_BASE_URL || 'http://127.0.0.1:8888/v1').replace(/\/$/, '');
const MODEL = process.env.AI_MODEL || 'hermes';
const API_KEY = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '';
const BATCH = Number(process.env.I18N_BATCH || 40);

const LANGUAGE_NAMES = { de: 'German', es: 'Spanish', fr: 'French', it: 'Italian', ja: 'Japanese', nl: 'Dutch', pl: 'Polish', pt: 'Portuguese (European)', ru: 'Russian', uk: 'Ukrainian', zh: 'Chinese (Simplified)', ar: 'Arabic', tr: 'Turkish', ko: 'Korean', sv: 'Swedish', cs: 'Czech' };

const placeholders = (s) => [...String(s).matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]).sort().join(',');

const en = JSON.parse(readFileSync(join(localesDir, 'en.json'), 'utf8'));

/** The keys a locale needs: singular keys as-is, plural keys once per category
 *  the language distinguishes, each carrying the English form to translate. */
function wanted(code) {
    const cats = pluralCategories(code);
    const out = [];
    for (const [key, english] of Object.entries(en)) {
        const m = /^(.*)_(one|other)$/.exec(key);
        if (!m) { out.push({ key, english, plural: null }); continue; }
        if (m[2] !== 'other') continue;                         // handle each plural key once, from its _other form
        for (const c of cats) out.push({ key: `${m[1]}_${c}`, english: c === 'one' ? (en[`${m[1]}_one`] ?? english) : english, plural: c });
    }
    return out;
}

/**
 * How this app addresses its reader, named per language rather than left to the
 * model. "Use the form your language uses for software" is not an instruction a
 * model can follow consistently across forty batches with no memory between
 * them: German came back 147 informal against 145 formal, i.e. a file that
 * greets the learner as a friend on one screen and as a stranger on the next.
 * The choice itself is per-language convention, not a global policy — French
 * and Russian software says vous/вы where Dutch and German say je/du — so it is
 * a table, and tools/i18n-audit.mjs measures whether a file kept to it.
 */
const ADDRESS = {
    de: "Address the reader informally as 'du' (dein/dir/dich) and never as 'Sie' — this is a personal learning tool, and every other language here is informal too.",
    nl: "Address the reader informally as 'je/jouw', never 'u/uw'.",
    fr: "Address the reader formally as 'vous/votre', never 'tu' — French software convention.",
    es: "Address the reader informally as 'tú', never 'usted'.",
    it: "Address the reader informally as 'tu', never 'Lei'.",
    pt: "Address the reader as 'você', never 'tu' or 'o senhor'.",
    pl: "Address the reader informally (twój/możesz), never with 'Pan/Pani'.",
    ru: "Address the reader as 'вы' (lowercase, not capitalised), never 'ты'.",
    uk: "Address the reader as 'ви' (lowercase, not capitalised), never 'ти'.",
    ja: "Use polite です/ます throughout, never the plain form.",
    zh: "Use 你 rather than 您, and drop the pronoun where Chinese UI convention would.",
};

/** The form of address ADDRESS rules out, so --register can find the drift. */
const WRONG_REGISTER = {
    de: /\b(Sie|Ihre[nmrs]?|Ihnen)\b/,
    nl: /\b(u|uw)\b/,
    fr: /\b(tu|ton|tes|toi)\b/i,
    es: /\b(usted|ustedes)\b/i,
    it: /\b(Lei|Suo|Sua)\b/,
    pt: /\b(tu|teu|tua)\b/i,
    pl: /\b(Pan|Pani|Państwa|Państwo)\b/,
    ru: /(?<!\p{L})(ты|твой|твоя|твои|тебе|тебя|Вы|Вас|Вам|Ваш)(?!\p{L})/u,
    uk: /(?<!\p{L})(ти|твій|твоя|твої|тобі|тебе|Ви|Вас|Вам|Ваш)(?!\p{L})/u,
};

const SYSTEM = (lang, code) => `You translate the user interface of a study app (flashcards, lessons, schedules, a curriculum "project", an AI tutor) from English into ${lang}.
Rules:
- Return ONLY a JSON object mapping each input id to its translation. No commentary, no markdown fence.
- Keep every {{placeholder}} exactly as written — same name, same braces. They are substituted at runtime.
- Keep product/technical names untranslated: Terramentor, Ollama, Anki, FSRS, Docker, OpenAI, API, PDF, URL, JSON, Tailscale, llama.cpp, LM Studio, OpenRouter, SearXNG, mastery check.
- Keep markdown, "…" ellipses, "·" separators and keyboard names (Esc, Enter, Space) as they are.
- Match the register: short imperative labels stay short; a hint stays one sentence.
${ADDRESS[code] ? '- ' + ADDRESS[code] : ''}
- Never assume the reader is a man. Where ${lang} marks gender on a word that refers to the reader — a past tense, a participle, an adjective, "yourself" — pick a wording that works for anyone: an impersonal or passive form, a noun, a present tense. "Got it, continue" is "Ясно, продолжить", not "Понял, продолжить"; "You proved this" is "Potwierdzone", not "Udowodniłeś to". Never write a "(a)" or a slash to cover both.
- "plural: one" means the text for exactly one item; "plural: few/many/other" the form for that count class in ${lang}.
- If an English string is untranslatable or already correct in ${lang}, return it unchanged.`;

async function callModel(lang, code, items) {
    const user = items.map((it, i) => `${i + 1}. ${JSON.stringify(it.english)}${it.plural ? `  (plural: ${it.plural})` : ''}`).join('\n');
    const body = {
        model: MODEL,
        temperature: 0.2,
        messages: [
            { role: 'system', content: SYSTEM(lang, code) },
            { role: 'user', content: `Translate these ${items.length} strings into ${lang}. Answer with a JSON object whose keys are the numbers "1".."${items.length}".\n\n${user}` },
        ],
        response_format: { type: 'json_object' },
        // "Do not think about it" has two dialects and this needs both. The
        // first is what a local llama.cpp / vLLM understands; a router ignores
        // it completely and the model reasons at full length instead — which on
        // a batch of forty strings is thousands of tokens of invisible text
        // before the first character of the answer. Measured 2026-09-15: a
        // batch that never returned at all, against ~20s with the budget named.
        // Asking for `low` rather than off because some endpoints refuse to
        // disable reasoning outright (HTTP 400), and translation is not the job
        // that needs it anyway.
        chat_template_kwargs: { enable_thinking: false },
        reasoning: { effort: 'low' },
    };
    // A batch that hangs is worse than a batch that fails: the run stops with no
    // error and no progress, and the only symptom is a log that stopped growing.
    const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number(process.env.I18N_TIMEOUT_MS || 180000)),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    let text = data.choices?.[0]?.message?.content || '';
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    if (start < 0 || end < 0) throw new Error(`no JSON in reply: ${text.slice(0, 120)}`);
    return JSON.parse(text.slice(start, end + 1));
}

for (const code of codes) {
    const lang = LANGUAGE_NAMES[code] || code;
    const file = join(localesDir, `${code}.json`);
    const current = existsSync(file) && !flags.has('--redo') ? JSON.parse(readFileSync(file, 'utf8')) : {};
    // A key the source no longer uses (an English string was reworded) is dropped
    // on the way in, so this run never writes it back and the gate stays green.
    const allowed = new Set(wanted(code).map((it) => it.key));
    for (const k of Object.keys(current)) if (!allowed.has(k)) delete current[k];
    // --register re-translates the entries that drifted to the other form of
    // address instead of the ones that are missing. A whole-file --redo would
    // throw away every correct translation to fix a tenth of them.
    const todo = flags.has('--register')
        ? wanted(code).filter((it) => WRONG_REGISTER[code]?.test(current[it.key] ?? ''))
        : wanted(code).filter((it) => !(it.key in current));
    if (flags.has('--register')) for (const it of todo) delete current[it.key];
    console.log(`${code} (${lang}): ${Object.keys(current).length} present, ${todo.length} to translate, ${Math.ceil(todo.length / BATCH)} batches`);
    if (flags.has('--dry')) continue;
    let rejected = 0, unchanged = 0;
    for (let i = 0; i < todo.length; i += BATCH) {
        const items = todo.slice(i, i + BATCH);
        let answers = null;
        for (let attempt = 1; attempt <= 2 && !answers; attempt++) {
            try { answers = await callModel(lang, code, items); } catch (e) {
                console.log(`  batch ${i / BATCH + 1}: ${e.message} (attempt ${attempt})`);
                if (attempt === 2) answers = {};
            }
        }
        for (let j = 0; j < items.length; j++) {
            const it = items[j];
            const v = answers[String(j + 1)];
            if (typeof v !== 'string' || !v.trim()) { rejected++; continue; }
            if (placeholders(v) !== placeholders(it.english)) { rejected++; continue; }
            if (v.trim() === it.english.trim()) { unchanged++; continue; }
            current[it.key] = v.trim();
        }
        const sorted = Object.fromEntries(Object.keys(current).sort((a, b) => a.localeCompare(b, 'en')).map((k) => [k, current[k]]));
        writeFileSync(file, `${JSON.stringify(sorted, null, 2)}\n`);
        process.stdout.write(`  ${Math.min(i + BATCH, todo.length)}/${todo.length}\r`);
    }
    console.log(`\n${code}: ${Object.keys(current).length} entries now; ${rejected} rejected (placeholder or empty), ${unchanged} left in English`);
}

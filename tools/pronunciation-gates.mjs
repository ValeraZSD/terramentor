#!/usr/bin/env node
// tools/pronunciation-gates.mjs — a card line in the language a course teaches
// can be said aloud, and no other line can.
//
// Run:  node tools/pronunciation-gates.mjs
//
// WHY. A course that teaches a language mixes two on one card ("het huiswerk"
// beside "домашнее задание", an example sentence under a label in the
// learner's language). A speaker beside a line says it in the LEARNED
// language's voice, so a speaker on the wrong line teaches the wrong sound
// with full confidence. Pinned here:
//   - which lines get words to say, and which words (utils/pronunciation.ts),
//     named by the literal lines a card carries, not by the rule itself;
//   - the card face: a speaker beside exactly those lines, none where the card
//     carries a recording of the line, none on a device with no voice for the
//     language, none in a course that teaches no language;
//   - a press says the line's words with the device's voice for the learned
//     language, does not flip the card, and a second press stops it.
// Deterministic: jsdom and a stub speech engine, no browser, no model.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
for (const k of ['HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'MutationObserver']) {
    if (window[k]) globalThis[k] = window[k];
}
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
window.matchMedia = (q) => ({ matches: q === '(pointer: fine)', media: q, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } });
window.HTMLMediaElement.prototype.pause = function () { };
window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const consoleError = console.error;
console.error = (...a) => { if (!/not wrapped in act/.test(String(a[0]))) consoleError(...a); };

// ---- a speech engine that records what it was asked to say ----------------
const voice = (lang, name) => ({ lang, name, localService: true, default: false, voiceURI: name });
const engine = { voices: [], spoken: [], cancels: 0, listeners: new Set() };
class Utterance { constructor(text) { this.text = text; } }
window.speechSynthesis = {
    getVoices: () => engine.voices,
    speak(u) { engine.spoken.push(u); },
    cancel() { engine.cancels++; },
    // The voice list arrives late in a browser: `voiceschanged` says it came.
    addEventListener(type, f) { if (type === 'voiceschanged') engine.listeners.add(f); },
    removeEventListener(type, f) { engine.listeners.delete(f); },
};
globalThis.SpeechSynthesisUtterance = window.SpeechSynthesisUtterance = Utterance;

const stubs = {
    'react-i18next': `export const useTranslation = () => ({ t: (k, o) => k.replace(/\\{\\{(\\w+)\\}\\}/g, (_, n) => String(o?.[n] ?? '')), i18n: { language: 'en' } });
        export const initReactI18next = { type: '3rdParty', init() { } };`,
    'i18n': `export default { t: (k) => k, language: 'en' }; export const k = (s) => s; export const currentLocale = () => 'en';`,
    'store': `import { useSyncExternalStore } from 'react';
        const g = globalThis;
        g.__st = { state: {
            addToast() { }, projects: [], a11y: { readAloud: false, speechRate: 100, cardAudioAutoplay: false },
        }, subs: new Set() };
        export const useStore = (sel) => useSyncExternalStore(
            (cb) => { g.__st.subs.add(cb); return () => g.__st.subs.delete(cb); },
            () => sel(g.__st.state));
        useStore.getState = () => g.__st.state;
        useStore.setState = (p) => { g.__st.state = { ...g.__st.state, ...(typeof p === 'function' ? p(g.__st.state) : p) }; g.__st.subs.forEach(f => f()); };
        useStore.subscribe = (f) => { g.__st.subs.add(f); return () => g.__st.subs.delete(f); };`,
    'api': `export const api = new Proxy({}, { get: () => () => new Promise(() => { }) });`,
    'Markdown': `import { createElement } from 'react'; export default function Markdown({ content }) { return createElement('div', null, content); }`,
    'MathText': `import { createElement } from 'react'; export default function MathText({ content }) { return createElement('span', null, content); }`,
};
const stubPlugin = {
    name: 'stubs',
    setup(b) {
        b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: 'react-i18next', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\.\/)+store$/ }, () => ({ path: 'store', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\.\/)+i18n$/ }, () => ({ path: 'i18n', namespace: 'stub' }));
        b.onResolve({ filter: /^(\.\.\/)+api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        b.onResolve({ filter: /^\.\.?\/(\.\.\/)*Markdown$/ }, () => ({ path: 'Markdown', namespace: 'stub' }));
        b.onResolve({ filter: /^\.\.?\/(\.\.\/)*MathText$/ }, () => ({ path: 'MathText', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js', resolveDir: root }));
    },
};

const cacheDir = join(root, 'node_modules', '.cache');
mkdirSync(cacheDir, { recursive: true });
const scratch = mkdtempSync(join(cacheDir, 'pronunciation-gates-'));
let bundles = 0;
async function load(name, entry) {
    const out = join(scratch, `m${++bundles}.cjs`);
    try {
        await esbuild.build({
            stdin: { contents: entry, resolveDir: root, loader: 'tsx' },
            bundle: true, format: 'cjs', platform: 'node', outfile: out,
            jsx: 'automatic', loader: { '.css': 'empty', '.svg': 'dataurl' },
            packages: 'external',
            define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
            plugins: [stubPlugin],
            logLevel: 'silent',
        });
        return require(out);
    } catch (e) {
        ok(`${name} builds`, false, String(e.message).split('\n').slice(0, 2).join(' | '));
        return null;
    }
}

const React = require('react');
const { createRoot } = require('react-dom/client');
const h = React.createElement;
const act = (fn) => React.act(fn);
const doc = window.document;
async function mount(el) {
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    const r = createRoot(host);
    await act(() => r.render(el));
    return { host, render: (next) => act(() => r.render(next)), unmount: async () => { await act(() => r.unmount()); host.remove(); } };
}

try {
    // -----------------------------------------------------------------------
    section('which lines get words to say, and which words');
    const P = await load('pronunciation', `export * from './src/utils/pronunciation';`);
    if (P?.spokenLine) {
        const say = (line, content, learning) => P.spokenLine(line, { content, learning });
        // A Dutch course written in Dutch: every line, except one a label puts in another language.
        ok('nl in nl: a word is said', say('de liquiditeit', 'nl', 'nl') === 'de liquiditeit');
        ok('nl in nl: a definition is said', say('Of je op tijd genoeg geld hebt.', 'nl', 'nl') === 'Of je op tijd genoeg geld hebt.');
        ok('nl in nl: an example under its label is said whole', say('Voorbeeld: Ik heb relevante ervaring.', 'nl', 'nl') === 'Voorbeeld: Ik heb relevante ervaring.');
        ok('nl in nl: a line labelled English is silent', say('Engels (automatisch vertaald): legal form', 'nl', 'nl') === null);
        ok('nl in nl: a line labelled in English as English is silent', say('English: mission', 'nl', 'nl') === null);
        ok('nl in nl: a label naming Dutch leaves what follows', say('Nederlands: de missie', 'nl', 'nl') === 'de missie');
        ok('nl in nl: a number opening the line stays', say('2.000 euro per maand', 'nl', 'nl') === '2.000 euro per maand');
        ok('nl in nl: bold markup is not read', say('**de missie**', 'nl', 'nl') === 'de missie');
        // Dutch explained in Russian: the Latin runs are the Dutch.
        ok('nl in ru: the Russian meaning is silent', say('домашнее задание', 'ru', 'nl') === null);
        ok('nl in ru: the Dutch word is said', say('het huiswerk', 'ru', 'nl') === 'het huiswerk');
        ok('nl in ru: the Russian beside it is left out', say('de pijn (боль)', 'ru', 'nl') === 'de pijn');
        ok('nl in ru: a Russian label is left out', say('Пример: Ik heb pijn.', 'ru', 'nl') === 'Ik heb pijn.');
        ok('nl in ru: a Russian instruction is silent', say('🎧 Послушай. Что сказал диктор?', 'ru', 'nl') === null);
        ok('nl in ru: Latin letters under an English label are silent', say('Английский: mission', 'ru', 'nl') === null);
        // Japanese explained in English: the kana and kanji are the Japanese.
        ok('ja in en: the word is said without its reading', say('先生[せんせい]', 'en', 'ja') === '先生');
        ok('ja in en: the English meaning is silent', say('teacher', 'en', 'ja') === null);
        // The long-vowel mark is script Common; the word must stay whole, never "cup".
        ok('ja in en: a long-vowel word is said whole', say('コーヒーカップ (coffee cup)', 'en', 'ja') === 'コーヒーカップ', say('コーヒーカップ (coffee cup)', 'en', 'ja'));
        ok('ja in en: a word ending in the long-vowel mark is said', say('コーヒー', 'en', 'ja') === 'コーヒー', say('コーヒー', 'en', 'ja'));
        // One sign is a whole word in Chinese, Japanese and Korean; full-width punctuation is inside a sentence.
        ok('zh in en: a one-sign word is said', say('水 (water)', 'en', 'zh') === '水', say('水 (water)', 'en', 'zh'));
        ok('ja in en: a one-kanji word is said', say('猫', 'en', 'ja') === '猫', say('猫', 'en', 'ja'));
        ok('ko in en: a one-syllable word is said', say('물 (water)', 'en', 'ko') === '물', say('물 (water)', 'en', 'ko'));
        ok('ja in en: a sentence keeps the word before its comma', say('私、学生です。', 'en', 'ja') === '私、学生です。', say('私、学生です。', 'en', 'ja'));
        ok('zh in en: a sentence is said whole across its full-width comma', say('你好，我是学生。', 'en', 'zh') === '你好，我是学生。', say('你好，我是学生。', 'en', 'zh'));
        ok('nl in ru: a lone Latin letter is not a word', say('уровень B1', 'ru', 'nl') === null, say('уровень B1', 'ru', 'nl'));
        // A gloss in the learned script (often English) beside the word is not said.
        ok('nl in ru: an English gloss in brackets is left out', say('het huiswerk (homework)', 'ru', 'nl') === 'het huiswerk', say('het huiswerk (homework)', 'ru', 'nl'));
        ok('nl in ru: an English gloss after "=" is left out', say('het huiswerk = the homework', 'ru', 'nl') === 'het huiswerk', say('het huiswerk = the homework', 'ru', 'nl'));
        // Signs of no script of their own inside a word or sentence keep it whole.
        const ch = (n) => String.fromCharCode(n);
        const meat = 'м' + ch(0x2BC) + 'ясо', hello = 'م' + ch(0x640) + 'رحبا', hindi = `यह किताब है${ch(0x964)} वह कलम है${ch(0x964)}`, greek = `Ναι${ch(0xB7)} εντάξει`;
        ok('uk in en: a word with the Ukrainian apostrophe is said whole', say(meat, 'en', 'uk') === meat, say(meat, 'en', 'uk'));
        ok('ar in en: a word with the joining stroke is said whole', say(hello, 'en', 'ar') === hello, say(hello, 'en', 'ar'));
        ok('hi in en: two sentences keep their stops', say(hindi, 'en', 'hi') === hindi, say(hindi, 'en', 'hi'));
        ok('el in en: a Greek line keeps its middle dot', say(greek, 'en', 'el') === greek, say(greek, 'en', 'el'));
        ok('ru in en: the Russian word, not the English', say('дом (house)', 'en', 'ru') === 'дом', say('дом (house)', 'en', 'ru'));
        ok('he in en: the Hebrew word is said', say('שלום', 'en', 'he') === 'שלום', say('שלום', 'en', 'he'));
        // Serbian is written in Latin letters too: a Serbian line is never taken for Dutch.
        ok('nl in sr: a Serbian line in Latin letters is silent', say('Dobar dan', 'sr', 'nl') === null, say('Dobar dan', 'sr', 'nl'));
        // A final vowel mark belongs to the word it ends.
        ok('ar in en: a word keeps its final mark', say('كِتَابٌ (a book)', 'en', 'ar') === 'كِتَابٌ', say('كِتَابٌ (a book)', 'en', 'ar'));
        // Two languages in one script cannot be told apart on a short line.
        ok('nl in en: the Dutch word is silent (same letters)', say('de werkervaring', 'en', 'nl') === null);
        ok('nl in en: the English word is silent', say('work experience', 'en', 'nl') === null);
        ok('a course teaching no language says nothing', say('de werkervaring', 'nl', '') === null);
        ok('a course with no declared language says nothing', say('de werkervaring', '', 'nl') === null);
    } else ok('spokenLine exists', false);

    // -----------------------------------------------------------------------
    section('the card face: a speaker beside exactly those lines');
    const M = await load('CardFace', `export { default as CardFace } from './src/components/CardFace'; export { ContentLang } from './src/utils/contentLang';`);
    if (M?.CardFace && M?.ContentLang) {
        const course = (id, content, learning) => ({ id, name: 'Course', description: '', content_language: content, learning_language: learning });
        globalThis.__st.state = { ...globalThis.__st.state, projects: [course(1, 'ru', 'nl'), course(2, 'nl', ''), course(3, 'nl', 'nl')] };
        const hash = 'a'.repeat(64);
        // The review surfaces flip on a click anywhere on the card: a parent's React onClick.
        let flips = 0;
        const card = (projectId, props) => h(M.ContentLang, { projectId },
            h('div', { onClick: () => { flips++; } },
                h(M.CardFace, { flipped: true, media: { front: [], back: [] }, ...props })));
        const ruCard = { front: 'домашнее задание', back: 'het huiswerk', extra: 'Пример: Ik maak mijn huiswerk.\nАнглийский: homework' };
        const speakers = (host) => [...host.querySelectorAll('button[data-media-control]')].map(b => b.getAttribute('aria-label'));

        engine.voices = [voice('en-US', 'English'), voice('nl-NL', 'Dutch')];
        let v = await mount(card(1, ruCard));
        // Each is named by what it says: the Russian label before the example is not said, so not named.
        ok('two speakers on a Russian-Dutch card: the word and the example, named by their Dutch words',
            JSON.stringify(speakers(v.host)) === JSON.stringify(['Play: het huiswerk', 'Play: Ik maak mijn huiswerk.']),
            JSON.stringify(speakers(v.host)));

        // A press says the line's DUTCH words with the Dutch voice, and does not flip.
        flips = 0;
        const example = v.host.querySelector('button[aria-label="Play: Ik maak mijn huiswerk."]');
        await act(() => { example.click(); });
        const said = engine.spoken.at(-1);
        ok('a press says the example without its Russian label', said?.text === 'Ik maak mijn huiswerk.', said?.text);
        ok('in the Dutch voice', said?.voice?.lang === 'nl-NL', said?.voice?.lang);
        ok('a press does not flip the card', flips === 0);
        ok('the pressed speaker turns into Stop', !!v.host.querySelector('button[aria-label="Stop: Ik maak mijn huiswerk."]'));
        const before = engine.cancels;
        await act(() => { v.host.querySelector('button[aria-label^="Stop:"]').click(); });
        ok('a second press stops it', engine.cancels > before && !v.host.querySelector('button[aria-label^="Stop:"]'));
        // The next card replaces the line while it is being said: the speech ends with it.
        await act(() => { v.host.querySelector('button[aria-label="Play: Ik maak mijn huiswerk."]').click(); });
        // Only the speech being cancelled proves it: the next card's line is a new
        // button, which would show no Stop even if the old speech went on.
        const before3 = engine.cancels;
        await v.render(card(1, { ...ruCard, back: 'de school', extra: 'Пример: Ik ga naar school.' }));
        ok('the next card on the same screen silences the last card\'s line',
            engine.cancels > before3, JSON.stringify([engine.cancels - before3, speakers(v.host)]));
        await v.unmount();

        // A recording of the line wins over the device's voice, and one sound
        // plays at a time: a recording silences a line the device is saying, and a
        // device line stops a recording.
        const played = [];
        let pauses = 0;
        window.HTMLMediaElement.prototype.play = function () { played.push(this.getAttribute('src')); return Promise.resolve(); };
        window.HTMLMediaElement.prototype.pause = function () { pauses++; };
        v = await mount(card(1, { ...ruCard, media: { front: [], back: [{ kind: 'audio', hash, at: 'het huiswerk' }] } }));
        const labels = speakers(v.host);
        ok('a line with a recording has one button', labels.filter(l => l.includes('het huiswerk')).length === 1, JSON.stringify(labels));
        await act(() => { v.host.querySelector('button[aria-label="Play: Ik maak mijn huiswerk."]').click(); });
        const spokenBefore = engine.spoken.length, cancelsBefore = engine.cancels;
        await act(() => { v.host.querySelector('button[aria-label="Play: het huiswerk"]').click(); });
        ok('...and it is the recording: a press plays the clip and the device says nothing',
            played.at(-1) === `/api/media/${hash}` && engine.spoken.length === spokenBefore, JSON.stringify([played.at(-1), engine.spoken.length - spokenBefore]));
        ok('a recording silences the line the device was saying', engine.cancels > cancelsBefore);
        const pausesBefore = pauses;
        await act(() => { v.host.querySelector('button[aria-label="Play: Ik maak mijn huiswerk."]').click(); });
        ok('a device line stops the recording that plays', pauses > pausesBefore && !!v.host.querySelector('button[aria-label="Play: het huiswerk"]'),
            JSON.stringify([pauses - pausesBefore, speakers(v.host)]));
        await v.unmount();
        window.HTMLMediaElement.prototype.pause = function () { };
        // A recording of a labelled line is named like the device's speaker: by its Dutch words.
        played.length = 0;
        v = await mount(card(1, { ...ruCard, media: { front: [], back: [{ kind: 'audio', hash, at: 'Пример: Ik maak mijn huiswerk.' }] } }));
        const named = v.host.querySelector('button[aria-label="Play: Ik maak mijn huiswerk."]');
        if (named) await act(() => { named.click(); });
        ok('a recorded labelled line is named by its Dutch words, and plays the recording',
            !!named && JSON.stringify(played) === JSON.stringify([`/api/media/${hash}`]), JSON.stringify([speakers(v.host), played]));
        await v.unmount();

        // No Dutch voice on this device: no speaker anywhere.
        engine.voices = [voice('en-US', 'English')];
        v = await mount(card(1, ruCard));
        ok('no speaker on a device with no Dutch voice', speakers(v.host).length === 0, JSON.stringify(speakers(v.host)));
        // The Dutch voice turns up late, as voice lists do: the speakers follow it.
        engine.voices = [voice('en-US', 'English'), voice('nl-NL', 'Dutch')];
        await act(() => { for (const f of engine.listeners) f(); });
        ok('a Dutch voice that arrives late brings the speakers', speakers(v.host).length === 2, JSON.stringify(speakers(v.host)));
        await v.unmount();

        // A Dutch course that teaches no language: no speaker.
        v = await mount(card(2, { front: 'de liquiditeit', back: 'Of je op tijd genoeg geld hebt.' }));
        ok('no speaker in a course that teaches no language', speakers(v.host).length === 0, JSON.stringify(speakers(v.host)));
        await v.unmount();

        // A Dutch course in Dutch: every line but the English one; the question side too.
        v = await mount(card(3, { flipped: false, front: 'de liquiditeit', back: 'Of je op tijd genoeg geld hebt.', extra: 'Engels (automatisch vertaald): liquidity' }));
        ok('the question side has its speaker', JSON.stringify(speakers(v.host)) === JSON.stringify(['Play: de liquiditeit']), JSON.stringify(speakers(v.host)));
        await v.unmount();
        v = await mount(card(3, { front: 'de liquiditeit', back: 'Of je op tijd genoeg geld hebt.', extra: 'Voorbeeld: Ik controleer mijn liquiditeit.\nEngels (automatisch vertaald): liquidity' }));
        ok('the answer side: word, meaning and example, not the English line',
            JSON.stringify(speakers(v.host)) === JSON.stringify(['Play: de liquiditeit', 'Play: Of je op tijd genoeg geld hebt.', 'Play: Voorbeeld: Ik controleer mijn liquiditeit.']),
            JSON.stringify(speakers(v.host)));
        await v.unmount();

        // -------------------------------------------------------------------
        section('a line recorded in two voices: one button, the voices take turns');
        const plays = [];
        window.HTMLMediaElement.prototype.play = function () { plays.push(this.getAttribute('src')); return Promise.resolve(); };
        const [voiceA, voiceB, sentence] = ['b', 'c', 'd'].map(ch => ch.repeat(64));
        const src = (hh) => `/api/media/${hh}`;
        const EXAMPLE = 'Voorbeeld: Ik controleer mijn liquiditeit.';
        const twoVoices = {
            front: 'Of je op tijd genoeg geld hebt.', back: 'de liquiditeit', extra: EXAMPLE,
            media: { front: [], back: [
                { kind: 'audio', hash: voiceA, at: 'de liquiditeit' },
                { kind: 'audio', hash: voiceB, at: 'de liquiditeit' },
                { kind: 'audio', hash: sentence, at: EXAMPLE },
            ] },
        };
        const press = (host, label) => act(() => { host.querySelector(`button[aria-label="${label}"]`).click(); });
        const end = (host, hh) => act(() => { host.querySelector(`audio[src="${src(hh)}"]`).dispatchEvent(new window.Event('ended')); });

        v = await mount(card(3, twoVoices));
        ok('the word has ONE button, not one per voice',
            speakers(v.host).filter(l => l.endsWith(': de liquiditeit')).length === 1, JSON.stringify(speakers(v.host)));
        ok('...and no button sits under the card for either voice',
            !speakers(v.host).some(l => /Clip \d|^Play: [a-f0-9]{8}/.test(l)), JSON.stringify(speakers(v.host)));
        await press(v.host, 'Play: de liquiditeit');
        ok('the first press says it in the first voice', plays.at(-1) === src(voiceA), plays.at(-1));
        ok('...and the button turns into Stop', !!v.host.querySelector('button[aria-label="Stop: de liquiditeit"]'));
        await end(v.host, voiceA);
        await press(v.host, 'Play: de liquiditeit');
        ok('the next press says it in the other voice', plays.at(-1) === src(voiceB), plays.at(-1));
        await end(v.host, voiceB);
        await press(v.host, 'Play: de liquiditeit');
        ok('...and the one after that in the first voice again', plays.at(-1) === src(voiceA), plays.at(-1));
        const before2 = plays.length;
        await press(v.host, 'Stop: de liquiditeit');
        ok('a press while it plays stops it and plays nothing',
            plays.length === before2 && !!v.host.querySelector('button[aria-label="Play: de liquiditeit"]'));
        // A review screen keeps the face mounted and swaps the card: the next
        // card's two-voice line starts at ITS first voice, whatever the last one did.
        const [nextA, nextB] = ['e', 'f'].map(ch => ch.repeat(64));
        await v.render(card(3, { ...twoVoices, back: 'de omzet', media: { front: [], back: [
            { kind: 'audio', hash: nextA, at: 'de omzet' }, { kind: 'audio', hash: nextB, at: 'de omzet' },
        ] } }));
        await press(v.host, 'Play: de omzet');
        ok('the next card on the same screen starts at its first voice', plays.at(-1) === src(nextA), plays.at(-1));
        await v.unmount();

        // The opening sequence (autoplay) says each line once.
        globalThis.__st.state = { ...globalThis.__st.state, a11y: { ...globalThis.__st.state.a11y, cardAudioAutoplay: true } };
        plays.length = 0;
        v = await mount(card(3, { ...twoVoices, autoPlay: true }));
        ok('the side opens with the line in its first voice', plays[0] === src(voiceA), JSON.stringify(plays));
        await end(v.host, voiceA);
        ok('...then goes on to the NEXT line, not the same words again', plays[1] === src(sentence), JSON.stringify(plays));
        await end(v.host, sentence);
        ok('...and stops there: each line said once', plays.length === 2, JSON.stringify(plays));
        await press(v.host, 'Play: de liquiditeit');
        ok('after the opening, a press is the voice not yet heard', plays.at(-1) === src(voiceB), plays.at(-1));
        await v.unmount();
        // A first voice that cannot load: the line's other voice says it, then the sequence goes on.
        plays.length = 0;
        v = await mount(card(3, { ...twoVoices, autoPlay: true }));
        await act(() => { v.host.querySelector(`audio[src="${src(voiceA)}"]`).dispatchEvent(new window.Event('error')); });
        ok('a voice that fails to load: the line\'s other voice says it', JSON.stringify(plays) === JSON.stringify([src(voiceA), src(voiceB)]), JSON.stringify(plays));
        await end(v.host, voiceB);
        ok('...and the sequence goes on to the next line', plays.at(-1) === src(sentence), JSON.stringify(plays));
        await v.unmount();
        globalThis.__st.state = { ...globalThis.__st.state, a11y: { ...globalThis.__st.state.a11y, cardAudioAutoplay: false } };
        // A clip the browser refuses (autoplay policy, or paused before it began)
        // clears only its own state: the line pressed right after it keeps playing.
        window.HTMLMediaElement.prototype.play = function () {
            const s = this.getAttribute('src'); plays.push(s);
            return s === src(voiceA) ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve();
        };
        v = await mount(card(3, twoVoices));
        await act(() => {
            v.host.querySelector('button[aria-label="Play: de liquiditeit"]').click();
            v.host.querySelector(`button[aria-label="Play: ${EXAMPLE}"]`).click();
        });
        ok('a refused clip does not clear the line pressed after it', !!v.host.querySelector(`button[aria-label="Stop: ${EXAMPLE}"]`), JSON.stringify(speakers(v.host)));
        await v.unmount();
        window.HTMLMediaElement.prototype.play = function () { plays.push(this.getAttribute('src')); return Promise.resolve(); };
        globalThis.__st.state = { ...globalThis.__st.state, a11y: { ...globalThis.__st.state.a11y, cardAudioAutoplay: true } };
        globalThis.__st.state = { ...globalThis.__st.state, a11y: { ...globalThis.__st.state.a11y, cardAudioAutoplay: false } };

        // Clips that name no line keep the row under the card, each its own button, all played.
        plays.length = 0;
        globalThis.__st.state = { ...globalThis.__st.state, a11y: { ...globalThis.__st.state.a11y, cardAudioAutoplay: true } };
        v = await mount(card(3, { front: 'x', back: 'de liquiditeit', autoPlay: true, media: { front: [], back: [{ kind: 'audio', hash: voiceA }, { kind: 'audio', hash: voiceB }] } }));
        await end(v.host, voiceA);
        const rowFacts = [speakers(v.host).filter(l => /^(Play|Stop): Clip \d$/.test(l)).length, plays.length];
        ok('clips with no line: a button each, and the opening plays them all', JSON.stringify(rowFacts) === '[2,2]', JSON.stringify(rowFacts));
        await v.unmount();
        // Two clips naming the same line that is NOT on the card: the row shows both, so the opening plays both.
        plays.length = 0;
        v = await mount(card(3, { front: 'x', back: 'de liquiditeit', autoPlay: true, media: { front: [], back: [
            { kind: 'audio', hash: voiceA, at: 'een regel die er niet staat' }, { kind: 'audio', hash: voiceB, at: 'een regel die er niet staat' },
        ] } }));
        await end(v.host, voiceA);
        ok('clips naming a line not on the card: both played, as both are shown', JSON.stringify(plays) === JSON.stringify([src(voiceA), src(voiceB)]), JSON.stringify(plays));
        await v.unmount();
        // The row under the card counts only its own clips: one row clip beside a
        // two-voice question line is a speaker, not "1".
        v = await mount(card(3, { front: 'de liquiditeit', back: 'x', media: {
            front: [{ kind: 'audio', hash: voiceA, at: 'de liquiditeit' }, { kind: 'audio', hash: voiceB, at: 'de liquiditeit' }],
            back: [{ kind: 'audio', hash: sentence }],
        } }));
        const rowButton = [...v.host.querySelectorAll('button[data-media-control]')].find(b => /Clip/.test(b.getAttribute('aria-label') || ''));
        ok('a lone row clip is a speaker, not a number, whatever the question carries',
            !!rowButton && !/\d/.test(rowButton.textContent) && rowButton.getAttribute('aria-label') === 'Play: Clip 1',
            JSON.stringify([rowButton?.getAttribute('aria-label'), rowButton?.textContent]));
        await v.unmount();

        // The answer side still shows the question: its recordings keep their button
        // there, and the flip does not say the question again. No Dutch voice on the
        // device, so a button on the word can only be the recording's.
        engine.voices = [voice('en-US', 'English')];
        plays.length = 0;
        const WORD = 'de liquiditeit';
        v = await mount(card(3, { front: WORD, back: 'Of je op tijd genoeg geld hebt.', extra: EXAMPLE, autoPlay: true, media: {
            front: [{ kind: 'audio', hash: voiceA, at: WORD }, { kind: 'audio', hash: voiceB, at: WORD }],
            back: [{ kind: 'audio', hash: sentence, at: EXAMPLE }],
        } }));
        ok('the answer side: the question word keeps its ONE button',
            speakers(v.host).filter(l => l.endsWith(`: ${WORD}`)).length === 1, JSON.stringify(speakers(v.host)));
        ok('...the flip opens with the answer side\'s own clip, not the word', JSON.stringify(plays) === JSON.stringify([src(sentence)]), JSON.stringify(plays));
        await end(v.host, sentence);
        ok('...and stops after it', plays.length === 1, JSON.stringify(plays));
        await press(v.host, `Play: ${WORD}`);
        ok('a press on the word says it', plays.at(-1) === src(voiceA), plays.at(-1));
        await v.unmount();
        // Where the question side never spoke by itself (the feed), the flip says it first.
        plays.length = 0;
        v = await mount(card(3, { front: WORD, back: 'Of je op tijd genoeg geld hebt.', extra: EXAMPLE, autoPlay: true, sayQuestion: true, media: {
            front: [{ kind: 'audio', hash: voiceA, at: WORD }, { kind: 'audio', hash: voiceB, at: WORD }],
            back: [{ kind: 'audio', hash: sentence, at: EXAMPLE }],
        } }));
        await end(v.host, voiceA);
        await end(v.host, sentence);
        ok('a flip after a silent question side: the word in one voice, then the example, then quiet',
            JSON.stringify(plays) === JSON.stringify([src(voiceA), src(sentence)]), JSON.stringify(plays));
        ok('...and the word still has ONE button',
            speakers(v.host).filter(l => l.endsWith(`: ${WORD}`)).length === 1, JSON.stringify(speakers(v.host)));
        await v.unmount();
        v = await mount(card(3, { front: WORD, back: 'x', media: { front: [{ kind: 'audio', hash: voiceA }], back: [] } }));
        ok('a question clip that names no line stays on the question side',
            !speakers(v.host).some(l => /Clip \d/.test(l)), JSON.stringify(speakers(v.host)));
        await v.unmount();
        globalThis.__st.state = { ...globalThis.__st.state, a11y: { ...globalThis.__st.state.a11y, cardAudioAutoplay: false } };
    } else ok('CardFace and ContentLang build', false);
} finally {
    rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

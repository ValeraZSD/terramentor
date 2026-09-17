#!/usr/bin/env node
/**
 * Read a locale file the way a native speaker would skim it, and report the
 * faults a machine can actually see. This is the companion to
 * tools/i18n-gates.mjs: the GATE asserts what must never ship (a dropped
 * placeholder, a key the source stopped using) and fails the build; the AUDIT
 * reports what is probably wrong and never fails anything, because "wrong
 * wording" is a judgement and a build must not hold an opinion.
 *
 *   node tools/i18n-audit.mjs            every locale, the summary table
 *   node tools/i18n-audit.mjs nl --list  one locale, every finding printed
 *
 * What it looks for, each earned from reading a model's first pass:
 *
 *  - REGISTER. Every language here chooses between addressing the learner
 *    formally or informally, and a model translating 1,600 strings in batches
 *    of 40 has no memory of what it chose an hour ago. A file that says "du"
 *    on one screen and "Sie" on the next reads as two people wrote it. The
 *    check counts both registers and reports the minority as a SHARE of the
 *    majority: the raw number means nothing on its own, the ratio is the
 *    finding.
 *  - RENAMED. One product noun under two names. A term that is also a key on
 *    its own ("Vault", "Tutor") has already been named by the locale — that
 *    value is the label in the navigation — so every short line carrying the
 *    English word should carry that word too. Forty strings at a time, a model
 *    holds no glossary: the Russian pass called the tutor репетитор (10),
 *    тьютор (8) and наставник (2), and наставник, the rarest, is the word on
 *    the button. Which side is wrong is a judgement and the check never picks
 *    — seven locales translated "Note" as a warning notice while their own
 *    "My notes" two lines away said otherwise, and there the LABEL was wrong.
 *    Read it as a prompt, not a verdict: a prefix stem cannot tell that
 *    Portuguese cartão/cartões or French révision/revoir are one word, so a
 *    few lines in every Romance locale are reported for inflecting correctly.
 *  - ENGLISH. The strong half of the same check, split out because it needs no
 *    judgement at all: the translation kept the ENGLISH product noun the locale
 *    has already named. German "Lade Due-Flashcards…", French "Échec du
 *    chargement du vault", Italian "L'atlas", Portuguese "à vault deste
 *    projeto". Where a whole file has settled on the English loanword — Dutch
 *    and Italian both say "flashcard" — the LABEL is the thing to change, and
 *    this column is how that disagreement shows up.
 *  - GENDER. A translation that only works if the reader is a man. English
 *    agrees with nobody, so "Got it, continue" and "You proved this" reach a
 *    Slavic or Romance translator as a choice the app cannot make for them —
 *    and a model picks the masculine every time: the Russian pass answered
 *    the tutor with "Понял", the Polish one told the reader "Udowodniłeś to".
 *    A neutral wording always exists ("Ясно", "To potwierdzone"), so this is
 *    a fault, not a limit of the language.
 *  - UNTRANSLATED. A value identical to its English key. Legitimate for a
 *    proper noun ("Anki", "Atlas") and for a word English shares with the
 *    target, so it is reported, never asserted; three or more words identical
 *    is the model giving up rather than a coincidence.
 *  - LATIN LEAK. In a non-Latin script, a run of Latin words that is not a
 *    proper noun the English key also carries — the model translating half a
 *    sentence and pasting the rest.
 *  - LENGTH. A translation far longer than its English original breaks the
 *    control it sits in; a button reading three words in English and eight in
 *    German is a layout bug that exists only in that language.
 *  - SHAPE. Terminal punctuation, leading/trailing space and the ellipsis
 *    character carry meaning in this UI ("Importing…" is a progress label),
 *    and they are the first thing a batch translator normalises away.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = resolve(here, '..', 'src', 'locales');
const argv = process.argv.slice(2);
const list = argv.includes('--list');
const only = argv.filter((a) => !a.startsWith('--'));

/**
 * The nouns this product means something particular by, each of which is also
 * a key on its own — so the locale has already chosen a word for it and the
 * rest of the file can be held to that choice.
 */
const GLOSSARY = [
    'Assistant', 'Tutor', 'Vault', 'Atlas', 'Deck', 'Flashcard', 'Feed',
    'Topic', 'Project', 'Overview', 'Material', 'Schedule', 'Settings',
    'Widget', 'Phase', 'Resource', 'Note', 'Card', 'Review', 'Streak',
];

const en = JSON.parse(readFileSync(join(localesDir, 'en.json'), 'utf8'));
const baseKey = (k) => k.replace(/_(zero|one|two|few|many|other)$/, '');
const english = (k) => en[k] ?? en[`${baseKey(k)}_other`] ?? baseKey(k);

/**
 * A word boundary that holds outside ASCII. JavaScript's own \b is defined on
 * [A-Za-z0-9_], so it fires between the "ê" and the "t" of "êtes" and reports
 * the French formal "vous êtes" as the informal "tes" — and it never fires at
 * all between two Cyrillic letters, which made this file report Russian as
 * having no pronouns whatsoever. Every register pattern is built through here.
 */
const word = (alternatives, flags = 'giu') => new RegExp(`(?<!\\p{L})(?:${alternatives})(?!\\p{L})`, flags);

/** Both ways a language can address the reader. The finding is the ratio. */
const REGISTER = {
    de: { informal: word('du|dein|deine[nmrs]?|dir|dich'), formal: word('Sie|Ihre[nmrs]?|Ihnen', 'gu') },
    nl: { informal: word('je|jij|jouw|jullie'), formal: word('u|uw', 'gu') },
    fr: { informal: word('tu|ton|ta|tes|toi'), formal: word('vous|votre|vos') },
    es: { informal: word('tú|tus|contigo'), formal: word('usted|ustedes') },
    it: { informal: word('tu|tuo|tua|tuoi|tue'), formal: word('Lei|Suo|Sua', 'gu') },
    pt: { informal: word('tu|teu|tua|teus|tuas'), formal: word('você|vocês') },
    pl: { informal: word('twój|twoja|twoje|twoim|ci|cię|ciebie'), formal: word('Pan|Pani|Państwa|Państwo', 'gu') },
    ru: { informal: word('ты|твой|твоя|твои|твоё|тебе|тебя|тобой'), formal: word('вы|вас|вам|вами|ваш|ваша|ваши|ваше') },
    uk: { informal: word('ти|твій|твоя|твої|тобі|тебе|тобою'), formal: word('ви|вас|вам|вами|ваш|ваша|ваші|ваше') },
};
/**
 * Japanese makes the same choice, spelled as a verb ending rather than a
 * pronoun. The plain forms have to be written as "not preceded by the polite
 * one": ました ends in した, so a naive plain-form pattern reports every polite
 * past-tense sentence in the file as plain.
 */
const JA_POLITE = /(です|ます|ません|ました|でしょう)/g;
const JA_PLAIN = /((?<!ま)した。|(?<!ま)する。|だ。|である)/g;

/**
 * Where the reader is the subject of the sentence, in English. Only these keys
 * are checked for gender: it is what keeps "Проект готов" out of the report —
 * a project is masculine in Russian and that agreement is with the project.
 *
 * Russian and Ukrainian get the narrower scope, because вы/ви is plural and so
 * already neutral: "вы подтвердили" commits to nothing. What is left there is
 * the copy the reader SPEAKS — a button that answers the tutor, a filter that
 * says what I missed — and that is first person or nothing.
 */
const READER = /(?<![A-Za-z'’])(I|I'm|I've|I'll|me|my|mine|myself|you|your|yours|yourself|you're|you've|you'll|Got it|Be honest|Welcome)(?![A-Za-z'’])/i;
const FIRST_PERSON = /(?<![A-Za-z'’])(I|I'm|I've|I'll|me|my|mine|myself|Got it)(?![A-Za-z'’])/;
const readerScope = (code) => (code === 'ru' || code === 'uk' ? FIRST_PERSON : READER);

/**
 * Forms that commit to the reader's gender. Curated rather than derived from
 * endings, because a suffix rule cannot tell a past-tense verb from a noun
 * ("материал" ends the way "пропустил" does) and the report is only worth
 * reading if nearly every line in it is real. Polish addresses one person
 * informally, so every past tense it writes is gendered; the Romance languages
 * carry it in their participles and adjectives.
 *
 * Words left OUT on purpose, each after reading what they caught: был/была and
 * начал/начала (they agree with whatever noun is in the sentence, and "с
 * начала" is not a verb at all), самой (a superlative, "самой центральной
 * темы"), próprio/mismo/stesso on their own (they mean "own" and "the same"
 * far more often than "myself" — the reflexive is only caught with its
 * pronoun), and French seul (it describes the drawing, not the reader).
 */
const GENDERED = {
    ru: word('понял|поняла|пропустил|пропустила|ответил|ответила|изучил|изучила|прошёл|прошел|прошла|создал|создала|добавил|добавила|выбрал|выбрала|сохранил|сохранила|сделал|сделала|получил|получила|нашёл|нашел|нашла|открыл|открыла|загрузил|загрузила|отметил|отметила|решил|решила|хотел|хотела|смог|смогла|доказал|доказала|подтвердил|подтвердила|повторил|повторила|написал|написала|прочитал|прочитала|ошибся|ошиблась|справился|справилась|закончил|закончила|завершил|завершила|сам|сама|самому|уверен|уверена|готов|готова|должен|должна|рад|рада'),
    uk: word('зрозумів|зрозуміла|пропустив|пропустила|відповів|відповіла|відповідав|відповідала|вивчив|вивчила|пройшов|пройшла|створив|створила|додав|додала|обрав|обрала|вибрав|вибрала|зберіг|зберегла|зробив|зробила|отримав|отримала|знайшов|знайшла|відкрив|відкрила|завантажив|завантажила|позначив|позначила|вирішив|вирішила|хотів|хотіла|зміг|змогла|довів|довела|підтвердив|підтвердила|повторив|повторила|написав|написала|прочитав|прочитала|помилився|помилилася|впорався|впоралася|закінчив|закінчила|завершив|завершила|сам|сама|самому|впевнений|впевнена|готовий|готова|повинен|повинна|радий|рада'),
    pl: [
        // The vowel is what separates a past tense from a noun in the
        // instrumental: przeoczyłem is one, hasłem ("with a password") is not.
        word('[a-ząćęłńóśźż]*[aeiouyąęó](?:łem|łam|łeś|łaś|liśmy|łyśmy|liście|łyście|łbyś|łabyś)'),
        word('sam|sama|samemu|gotowy|gotowa|pewien|pewna|powinieneś|powinnaś|zadowolony|zadowolona|ciekaw|ciekawa|zmęczony|zmęczona|zalogowany|zalogowana|połączony|połączona'),
    ],
    es: [
        word('seguro|segura|listo|lista|preparado|preparada|bienvenido|bienvenida|honesto|honesta|sincero|sincera|conectado|conectada|registrado|registrada|cansado|cansada|dispuesto|dispuesta'),
        word('(?:yo|tú|ti|sí|usted)\\s+mism[oa]'),
    ],
    pt: [
        word('certo|certa|pronto|pronta|preparado|preparada|bem-vindo|bem-vinda|honesto|honesta|sincero|sincera|conectado|conectada|sozinho|sozinha|guiá-lo|guiá-la'),
        word('(?:eu|tu|você|si)\\s+(?:mesm[oa]|própri[oa])'),
    ],
    it: [
        word('sicuro|sicura|pronto|pronta|benvenuto|benvenuta|onesto|onesta|sincero|sincera|connesso|connessa|stanco|stanca'),
        word('(?:io|tu|te|sé)\\s+stess[oa]'),
    ],
    fr: word('sûr|sûre|prêt|prête|connecté|connectée|inscrit|inscrite|content|contente|certain|certaine|fatigué|fatiguée'),
    de: word('Benutzer|Nutzer|Lernender|Anfänger|Besitzer|Autor'),
};

const NON_LATIN = { ru: /[Ѐ-ӿ]/, uk: /[Ѐ-ӿ]/, ja: /[぀-ヿ一-鿿]/, zh: /[一-鿿]/ };
/** Words that stay Latin in every language: the app's own nouns and the stack's. */
const KEEP_LATIN = /^(Anki|Atlas|Terramentor|Ollama|SQLite|FSRS|BKT|PDF|OCR|AI|API|URL|CSV|JSON|HTML|SVG|GPU|VRAM|RAM|CPU|GB|MB|KB|px|Docker|Tailscale|GitHub|YouTube|Wikipedia|LaTeX|KaTeX|Markdown|Vega|Lite|Mermaid|SMIL|WAL|UUID|ISO|HTTP|HTTPS|Express|Node|React|Vite|Windows|macOS|Linux|Edge|Chrome|Brave|Firefox|Safari|LM|Studio|llama|swap|nomic|embed|text|Qwen|GNU|Affero|General|Public|License|AGPL|MIT|SearXNG|DuckDuckGo|Boss|Fight)$/i;

const rows = [];
for (const file of readdirSync(localesDir).filter((f) => f.endsWith('.json'))) {
    const code = basename(file, '.json');
    if (code === 'en') continue;
    if (only.length && !only.includes(code)) continue;
    const data = JSON.parse(readFileSync(join(localesDir, file), 'utf8'));
    const findings = { renamed: [], english: [], gender: [], untranslated: [], latin: [], long: [], collision: [], shape: [] };
    let informal = 0, formal = 0;

    // Two DIFFERENT English labels that came back as the same word. Harmless in
    // prose — two sentences may legitimately agree — and a real defect on a
    // short control, because the reader has no other way to tell the two apart:
    // French rendered both "Calendar" and "Schedule" as "Calendrier", so the
    // navigation carried two tabs with one name. Only short labels are checked,
    // and only where the English differs by more than case or a trailing colon.
    const byValue = new Map();
    for (const [key, value] of Object.entries(data)) {
        if (typeof value !== 'string') continue;
        const src = english(key);
        if (src.length > 24 || src.split(/\s+/).length > 3) continue;
        const norm = value.toLowerCase().replace(/[:.…\s]+$/, '');
        if (!norm) continue;
        (byValue.get(norm) ?? byValue.set(norm, []).get(norm)).push([key, src]);
    }
    for (const [norm, entries] of byValue) {
        // The two plural forms of ONE key agreeing is not a collision, it is a
        // language with fewer plural categories than English.
        const bases = new Set(entries.map(([key]) => baseKey(key)));
        if (bases.size < 2) continue;
        const distinct = [...new Set(entries.map(([, src]) => src.toLowerCase().replace(/[:.…\s]+$/, '')))];
        if (distinct.length > 1) findings.collision.push([distinct.join(' / '), norm]);
    }

    for (const [key, value] of Object.entries(data)) {
        if (typeof value !== 'string') continue;
        const src = english(key);

        const reg = REGISTER[code];
        if (reg) {
            informal += (value.match(reg.informal) || []).length;
            formal += (value.match(reg.formal) || []).length;
        } else if (code === 'ja') {
            informal += (value.match(JA_PLAIN) || []).length;
            formal += (value.match(JA_POLITE) || []).length;
        }

        // A wording that commits to the reader's gender, on a sentence the
        // reader is the subject of.
        const gendered = GENDERED[code];
        if (gendered && readerScope(code).test(src)) {
            const hit = [gendered].flat().map((p) => value.match(p)).find(Boolean);
            if (hit) findings.gender.push([key, hit[0]]);
        }

        // Identical to the English, and long enough that it should not be.
        if (value.trim() === src.trim() && src.split(/\s+/).length >= 3) findings.untranslated.push([key, value]);

        // A Latin run inside a non-Latin script that the English does not carry.
        const script = NON_LATIN[code];
        if (script && script.test(value)) {
            const runs = [...value.matchAll(/(?:[A-Za-z][A-Za-z'-]*)(?:\s+[A-Za-z][A-Za-z'-]*){2,}/g)]
                .map((m) => m[0])
                .filter((r) => !r.split(/\s+/).every((w) => KEEP_LATIN.test(w)))
                .filter((r) => !src.includes(r));
            if (runs.length) findings.latin.push([key, runs[0]]);
        }

        // A control sized for the English cannot hold this.
        if (src.length >= 12 && value.length > src.length * 2 && !/[.!?]$/.test(src)) findings.long.push([key, `${src.length} to ${value.length}`]);

        // The punctuation and spacing the UI depends on.
        const shape = [];
        if (value !== value.trim() && src === src.trim()) shape.push('stray space');
        if (/…$/.test(src) && !/…$/.test(value)) shape.push('lost ellipsis');
        if (/\.\.\./.test(value) && /…/.test(src)) shape.push('dots for ellipsis');
        if (/[.?!]$/.test(src) && !/[.?!。？！]$/.test(value)) shape.push('lost terminal punctuation');
        if (!/[.?!:]$/.test(src) && /[.。]$/.test(value)) shape.push('added full stop');
        if (shape.length) findings.shape.push([key, shape.join(', ')]);
    }

    // RENAMED. The same product noun under two names. A term that is also a
    // key ON ITS OWN ("Vault", "Assistant", "Tutor") has already been named by
    // this locale — that value is the label in the navigation — so every other
    // line carrying the English word should carry that word too. The ones that
    // do not are where a batch forty strings long forgot what it chose an hour
    // ago: the Russian pass called the tutor репетитор, тьютор and наставник,
    // and наставник, the word on the button, was the rarest of the three.
    // Which side is wrong is a judgement — sometimes the standalone label is
    // the mistake (seven locales translated "Note" as a warning notice while
    // their own "My notes" said otherwise) — so this reports the disagreement
    // and never picks a winner.
    for (const term of GLOSSARY) {
        const canonical = data[term];
        if (!canonical) continue;
        const head = canonical.split(/[^\p{L}]+/u).filter(Boolean).sort((a, b) => b.length - a.length)[0];
        if (!head || head.length < 3) continue;
        // Russian "тема" reaches the reader as темы, тем, теме, темой — four
        // endings on a four-letter word — and "Повторение" as повторить, which
        // shares only повтор. So the stem is a short fixed prefix rather than
        // the word minus an ending: cutting too little reports a locale for
        // conjugating its own verb. CJK does not inflect, so it keeps the word.
        const stem = NON_LATIN[code] && !/[Ѐ-ӿ]/.test(head)
            ? head
            : (() => {
                const w = head.toLowerCase().replace(/[^\p{L}]/gu, '');
                return w.slice(0, Math.max(3, Math.min(5, w.length - 1)));
            })();
        const re = new RegExp(`\\b${term}s?\\b`, 'i');
        for (const [key, value] of Object.entries(data)) {
            if (key === term) continue;
            const src = english(key);
            // No length cap. The first version of this check only read short
            // keys, on the theory that a paragraph buries the word — and every
            // PARAGRAPH therefore kept the discarded name: Polish still said
            // "do vaultu tego projektu" and Italian "alla vault" long after
            // both files had settled on skarbiec and cassaforte. Length is
            // irrelevant once the locale has already chosen the word.
            if (!re.test(src)) continue;
            if (value.toLowerCase().includes(stem.toLowerCase())) continue;
            // The ENGLISH word still standing in the translation is the strong
            // half of this check: "renamed" is a judgement (a stem cannot tell
            // that cartão and cartões are one word, so every Romance locale
            // reports a few lines for inflecting correctly), but a translation
            // that simply kept the English noun the locale has already named is
            // a defect with no second reading — German "Lade Due-Flashcards…",
            // French "Échec du chargement du vault", Italian "L'atlas".
            if (re.test(value)) findings.english.push([key, `${term} is "${canonical}" here: ${value}`]);
            else findings.renamed.push([key, `${term} is "${canonical}" here: ${value}`]);
        }
    }

    const minority = Math.min(informal, formal), majority = Math.max(informal, formal);
    rows.push({
        code, keys: Object.keys(data).length, informal, formal,
        mix: majority ? minority / majority : 0,
        ...Object.fromEntries(Object.entries(findings).map(([k, v]) => [k, v.length])),
    });

    if (list) {
        console.log(`\n=== ${code} ===`);
        for (const [name, items] of Object.entries(findings)) {
            if (!items.length) continue;
            console.log(`\n  ${name} (${items.length})`);
            for (const [k, extra] of items.slice(0, 40)) console.log(`    ${JSON.stringify(k.slice(0, 70))}  ${JSON.stringify(String(extra).slice(0, 80))}`);
        }
        if (REGISTER[code] || code === 'ja') console.log(`\n  register: informal ${informal} / formal ${formal}`);
    }
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n${pad('locale', 8)}${pad('keys', 7)}${pad('informal', 10)}${pad('formal', 8)}${pad('mix', 7)}${pad('renamed', 9) + pad('english', 9) + pad('gender', 8)}${pad('untransl', 10)}${pad('latin', 7)}${pad('long', 6)}${pad('collide', 9)}shape`);
for (const r of rows) {
    console.log(pad(r.code, 8) + pad(r.keys, 7) + pad(r.informal, 10) + pad(r.formal, 8) +
        pad(r.mix ? `${Math.round(r.mix * 100)}%` : '-', 7) + pad(r.renamed, 9) + pad(r.english, 9) + pad(r.gender, 8) + pad(r.untranslated, 10) + pad(r.latin, 7) + pad(r.long, 6) + pad(r.collision, 9) + r.shape);
}
console.log('\nmix = the minority register as a share of the majority. Above a few per cent is a');
console.log('file that addresses the reader two ways. gender = wordings that only work if the');
console.log('reader is a man. Nothing here fails a build.');

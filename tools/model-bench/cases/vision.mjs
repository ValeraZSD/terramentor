/**
 * Reading pictures: the app's two vision paths, both through the `vision` job.
 *
 *  - transcribeImageToText: the default OCR-and-LaTeX prompt (PDF recovery,
 *    paper practice). Scored on the numbers, words and equations that must
 *    survive, plus the prompt's own rules: output only the transcription, no
 *    preamble, no fence around the whole thing.
 *  - describeMedia: a one-or-two sentence description for a screen reader and
 *    the tutor. Scored on the facts in the picture, plus the prompt's rules:
 *    no "This image shows" preamble, no markdown, UNREADABLE only for blank images.
 *
 * Every picture is drawn in setup() (visionImages.mjs). Proxies, stated where
 * used: the handwritten page is generic sans-serif letters with jittered
 * baseline, tilt and size (a stand-in, not a real hand); direction in the
 * diagram case is read from phrasing patterns, so an unusual but correct
 * sentence can fail it.
 */
import * as img from './visionImages.mjs';

const fail = (why) => ({ pass: false, why });
const ok = (why) => ({ pass: true, why });

const REFUSAL = /\b(?:i(?:'m| am)? (?:sorry|unable|not able)|i (?:can(?:no|')t|could not|couldn't)|cannot (?:see|read|view|process|transcribe)|unable to (?:see|read|view|process|transcribe)|as an ai|(?:no|without an?) image|(?:don't|do not) see (?:an?|any) image)\b/i;
const TRANSCRIBE_PREAMBLE = /^\s*(?:here(?:'s| is| are)|sure|certainly|of course|okay|the (?:image|page|picture|transcription)\b|transcription\s*:|```)/i;
const DESCRIBE_PREAMBLE = /^\s*(?:(?:this|the)\s+(?:image|picture|photo|photograph|illustration|diagram|chart|graphic|figure)\s+(?:shows?|depicts?|contains?|displays?|is|features?|presents?)\b|here(?:'s| is)\b|an?\s+(?:image|picture|photo)\s+of\b)/i;

/** The rules every transcription shares. Returns a failure or null. */
function transcribeBasics(text, min, max) {
    if (typeof text !== 'string') return fail('no text came back');
    const t = text.trim();
    if (t.length < min) return fail(t ? `only ${t.length} characters back` : 'an empty reading');
    if (t.length > max) return fail(`${t.length} characters back for a page this size (commentary?)`);
    if (REFUSAL.test(t)) return fail('the model says it cannot read the image');
    if (TRANSCRIBE_PREAMBLE.test(t)) return fail(`starts with a preamble or code fence: "${t.slice(0, 30)}"`);
    return null;
}

/** Lowercase, LaTeX packaging and spacing gone, so "$3x^{2} - 12x$" and "3x² - 12x" compare equal. */
function squash(s) {
    return String(s).toLowerCase()
        .replace(/\\(?:left|right|displaystyle|text|mathrm|quad|,|;|!|:| )/g, '')
        .replace(/\\\(|\\\)|\\\[|\\\]|\$/g, '')
        .replace(/\\cdot|\\times/g, '*')
        .replace(/[−–—]/g, '-')
        .replace(/²/g, '^2')
        .replace(/[{}\s*_]/g, '');
}

const words = (s) => String(s).toLowerCase().match(/\p{L}+/gu) || [];

/** Share of the expected words that came back, and share of returned words nobody expected. */
function wordFit(text, expectedLines) {
    const want = new Set(words(expectedLines.join(' ')));
    const got = words(text);
    const have = new Set(got);
    const recall = [...want].filter(w => have.has(w)).length / want.size;
    const extra = got.filter(w => !want.has(w)).length / (got.length || 1);
    return { recall, extra, have };
}

function scoreParagraph(lines, mustHave) {
    return (text) => {
        const size = lines.join(' ').length;
        const basic = transcribeBasics(text, Math.round(size * 0.5), size * 2);
        if (basic) return basic;
        const { recall, extra, have } = wordFit(text, lines);
        const lost = mustHave.filter(w => !have.has(w));
        if (lost.length) return fail(`exact word(s) lost or altered: ${lost.join(', ')}`);
        if (recall < 0.92) return fail(`only ${Math.round(recall * 100)}% of the words came back right`);
        if (extra > 0.15) return fail(`${Math.round(extra * 100)}% of the returned words are not on the page`);
        return ok(`${Math.round(recall * 100)}% of the words back, accents intact`);
    };
}

function scoreMath(text) {
    const basic = transcribeBasics(text, 60, 500);
    if (basic) return basic;
    const q = squash(text);
    // Spacing is squashed away, so each number is fenced by what may not touch
    // it: "1150km", "12.5hours", "13x^2" and "=0.5" are different values.
    if (!/question7(?![\d.])/.test(q)) return fail('the question number "Question 7" is missing');
    if (!/(?<![\d.])4(?:points?|pts)/.test(q)) return fail('the point value "(4 points)" is missing');
    if (!/(?<![\d.,])150km/.test(q)) return fail('"150 km" is not there');
    if (!/(?<![\d.,])2\.5hours?/.test(q)) return fail('"2.5 hours" is not there');
    if (!/(?<![\d.,])3x\^2-12x\+9=0(?!\.?\d|,\d)/.test(q)) return fail('the equation 3x^2 - 12x + 9 = 0 did not come back exactly');
    return ok('numbers and equation exact, question number and points kept');
}

function scoreTable(text) {
    const basic = transcribeBasics(text, 40, 600);
    if (basic) return basic;
    if (!/\bmin\b/i.test(text) || !/\bmax\b/i.test(text)) return fail('the "Min" and "Max" headers are missing');
    const rows = text.split('\n');
    for (const [day, lo, hi] of img.TABLE_ROWS) {
        const line = rows.find(l => new RegExp(`\\b${day}\\b`, 'i').test(l));
        if (!line) return fail(`the ${day} row is missing`);
        // A value is whole and unsigned: "-12", "−12" and "12.5" are not 12.
        const num = (n) => `(?<![-−\\d.,])${n}(?![.,]?\\d)`;
        if (!new RegExp(`\\b${day}\\b\\D{1,14}?${num(lo)}\\D{1,14}?${num(hi)}`, 'i').test(line)) return fail(`the ${day} row does not read ${lo} then ${hi}: "${line.trim().slice(0, 60)}"`);
    }
    const dayRows = rows.filter(l => /^\W*(?:mon|tue|wed|thu|fri|sat|sun)\b/i.test(l)).length;
    if (dayRows !== img.TABLE_ROWS.length) return fail(`${dayRows} day rows, ${img.TABLE_ROWS.length} on the page`);
    return ok('every row reads the right numbers in the right order');
}

function scoreHandwritten(text) {
    const basic = transcribeBasics(text, 5, 160);
    if (basic) return basic;
    // Each value is the whole value: "x = 1.5", "x = 1,5", "x = 1/2" and "x = 3^2" are not.
    if (!/(?<![\d.,])x=3(?![.,]?\d|[/^])\D{0,6}x=1(?![.,]?\d|[/^])/.test(squash(text))) return fail(`did not read "x = 3 and x = 1": "${text.trim().slice(0, 50)}"`);
    return ok('read both values');
}

// ---- describeMedia ---------------------------------------------------------------------

/** The rules every description shares. Returns a failure or null. */
function describeBasics(r) {
    if (!r || r.ok !== true) return fail(`no description: ${r?.reason || 'nothing returned'}`);
    const d = String(r.description || '');
    if (!d) return fail('empty description');
    if (REFUSAL.test(d)) return fail('the model says it cannot see the image');
    if (DESCRIBE_PREAMBLE.test(d)) return fail(`starts with a preamble: "${d.slice(0, 30)}"`);
    if (/[*#`•]/.test(d)) return fail('markdown or bullets in a plain description');
    if ((d.match(/[.!?](?:\s|$)/g) || []).length > 4) return fail('far more than the one or two sentences asked');
    return null;
}

const COLOURS = 'red|blue|green|yellow|orange|purple|pink|black|white|gr[ae]y|brown';
const SHAPE_WORDS = { square: 'square|box|rectangle', circle: 'circle|disc|disk|ball', triangle: 'triangle' };

function scoreShapes(r) {
    const basic = describeBasics(r);
    if (basic) return basic;
    const d = r.description;
    if (!new RegExp(`\\b${img.SHAPES_WORD}\\b`, 'i').test(d)) return fail(`the word "${img.SHAPES_WORD}" in the picture is not quoted`);
    const wrong = new RegExp(`\\b(${COLOURS})\\s+(?:\\w+\\s+)?(square|rectangle|box|circle|disc|disk|ball|triangle)\\b`, 'gi');
    for (const m of d.matchAll(wrong)) {
        const kind = Object.entries(SHAPE_WORDS).find(([, re]) => new RegExp(`^(?:${re})$`, 'i').test(m[2]))[0];
        const colour = Object.entries(img.SHAPES).find(([, s]) => s === kind)[0];
        if (m[1].toLowerCase() !== colour) return fail(`"${m[0]}" is wrong: the ${kind} is ${colour}`);
    }
    let right = 0;
    for (const [colour, kind] of Object.entries(img.SHAPES)) {
        const re = SHAPE_WORDS[kind];
        if (new RegExp(`\\b${colour}\\s+(?:\\w+\\s+)?(?:${re})\\b|\\b(?:${re})\\W+(?:\\w+\\W+){0,3}?${colour}\\b`, 'i').test(d)) right++;
    }
    if (right < 2) return fail(`only ${right} of 3 colour-and-shape pairs named (red square, blue circle, green triangle)`);
    return ok(`quotes the word, ${right} of 3 shapes with the right colour`);
}

const FRUIT = /\b(apples?|pears?|plums?|figs?)\b/gi;
const TALLEST = /\b(?:tall(?:est)?|high(?:est)?|large(?:st)?|big(?:gest)?|long(?:est)?|greatest|most|top|maximum|leads?|exceeds?)\b/gi;
/** A qualifier just before a "tallest" cue that makes it a lower rank or a negation. */
const RANKED_BELOW = /\b(?:second|third|fourth|2nd|3rd|4th|next|least|less|not(?:\s+the)?|nor)[\s-]+(?:\w+[\s-]+)?$/i;

function scoreChart(r) {
    const basic = describeBasics(r);
    if (basic) return basic;
    const d = r.description;
    const named = new Set([...d.matchAll(FRUIT)].map(m => m[1].toLowerCase().replace(/s$/, '')));
    if (named.size < 3) return fail(`only ${named.size} of the 4 bar labels read`);
    // A "tallest" cue is about the fruit in its own clause; a clause that holds
    // only the cue ("Plums, the tallest bar") is about the fruit before it.
    let said = false, lastFruit = null;
    for (const clause of d.split(/[.!?;:,]|\b(?:and|while|but|then|followed)\b/i)) {
        const fruits = [...clause.matchAll(FRUIT)].map(m => ({ at: m.index, name: m[1].toLowerCase().replace(/s$/, '') }));
        for (const cue of clause.matchAll(TALLEST)) {
            // "Pears the second tallest" ranks Pears, it does not call it the tallest.
            if (RANKED_BELOW.test(clause.slice(0, cue.index))) continue;
            const near = fruits.length ? fruits.reduce((a, b) => (Math.abs(b.at - cue.index) < Math.abs(a.at - cue.index) ? b : a)) : { name: lastFruit };
            if (!near.name) continue;
            if (near.name !== 'plum') return fail(`names ${near.name} as the tallest bar: "${clause.trim().slice(0, 80)}"`);
            said = true;
        }
        if (fruits.length) lastFruit = fruits[fruits.length - 1].name;
    }
    return said ? ok('names Plums as the tallest bar') : fail('never says which bar is tallest');
}

/** 'fwd' (Browser to Server), 'back' (Server to Browser) or null, from a clause about one arrow. */
function direction(clause) {
    const from = /\bfrom\s+(?:the\s+)?(?:\w+\s+){0,2}?(browser|server)\b[^.]*?\b(?:to|toward|towards|into|back to)\s+(?:the\s+)?(?:\w+\s+){0,2}?(browser|server)\b/i.exec(clause);
    if (from && from[1].toLowerCase() !== from[2].toLowerCase()) return from[1].toLowerCase() === 'browser' ? 'fwd' : 'back';
    const arrow = /\b(browser|server)\b[^.]{0,40}?(?:→|->|-->|=>|\bsends?\b[^.]{0,30}?\bto\b|\bpoints?\s+(?:to|at|toward|towards)\b|\bto\b)[^.]{0,20}?\b(browser|server)\b/i.exec(clause);
    if (arrow && arrow[1].toLowerCase() !== arrow[2].toLowerCase()) return arrow[1].toLowerCase() === 'browser' ? 'fwd' : 'back';
    if (/\b(?:to|toward|towards)\s+(?:the\s+)?server\b/i.test(clause) && !/\bfrom\s+(?:the\s+)?server\b/i.test(clause)) return 'fwd';
    if (/\b(?:to|toward|towards)\s+(?:the\s+)?browser\b/i.test(clause) && !/\bfrom\s+(?:the\s+)?browser\b/i.test(clause)) return 'back';
    return null;
}

function scoreDiagram(r) {
    const basic = describeBasics(r);
    if (basic) return basic;
    const d = r.description;
    for (const w of ['browser', 'server', 'request', 'response']) if (!new RegExp(`\\b${w}\\b`, 'i').test(d)) return fail(`the label "${w}" is not quoted`);
    const clauses = d.split(/[;]|,\s+(?:and\s+)?|\s+and\s+(?=(?:one|another|a|an|the)\b)|(?<=[.!?])\s+/i);
    const clauseOf = (word) => clauses.find(c => new RegExp(`\\b${word}\\b`, 'i').test(c)) || '';
    const req = direction(clauseOf('request')), res = direction(clauseOf('response'));
    if (req !== 'fwd') return fail(`the "request" arrow should run Browser to Server, read as ${req ?? 'no direction'}`);
    if (res !== 'back') return fail(`the "response" arrow should run Server to Browser, read as ${res ?? 'no direction'}`);
    return ok('both labelled arrows run the right way');
}

// ---- fixtures and cases ------------------------------------------------------------------

async function setup(app) {
    const { mediaStorage } = await app.server('vaultStorage.js');
    const png = {
        math: img.mathProblem(), dutch: img.dutchParagraph(), cyrillic: img.cyrillicParagraph(), table: img.numberTable(),
        hand: img.handwritten(), shapes: img.shapesPicture(), chart: img.barChart(), diagram: img.flowDiagram(),
    };
    const media = {};
    for (const k of ['shapes', 'chart', 'diagram']) {
        const { hash, size } = mediaStorage.put(png[k]);
        app.db.prepare(`INSERT INTO media_files (project_id, hash, filename, mime, kind, size) VALUES (NULL, ?, ?, 'image/png', 'image', ?)`).run(hash, `${k}.png`, size);
        media[k] = hash;
    }
    return { png, media };
}

const ocr = (key) => (fx, app) => app.ai.transcribeImageToText(fx.png[key]);
/** A description is stored on the file, so each run starts from an undescribed one. */
const describe = (key) => async (fx, app) => {
    app.db.prepare('UPDATE media_files SET description = NULL, described_by = NULL, generated_by = NULL WHERE hash = ?').run(fx.media[key]);
    const m = await app.server('mediaDescribe.js');
    return m.describeMedia(fx.media[key]);
};

const fence = (s) => `\`\`\`markdown\n${s}\n\`\`\``;
const REFUSE = "I'm sorry, but I can't view images, so I am unable to transcribe this page.";

const MATH = 'Question 7 (4 points)\n\nA train travels 150 km in 2.5 hours.\n\nSolve $3x^2 - 12x + 9 = 0$.';
const DUTCH = img.DUTCH_LINES.join(' ');
const UKR = img.CYRILLIC_LINES.join(' ');
const TABLE = '| Day | Min | Max |\n|---|---|---|\n| Mon | 12 | 19 |\n| Tue | 9 | 15 |\n| Wed | 11 | 22 |\n| Thu | 7 | 13 |';

export default {
    category: 'vision',
    label: 'Reading pictures',
    setup,
    cases: [
        {
            id: 'vision-ocr-math-problem', vision: true,
            run: ocr('math'),
            score: (out) => scoreMath(out),
            golden: MATH,
            variants: [{ name: 'unicode maths, full stop after the equation', reply: 'Question 7 (4 points)\n\nA train travels 150 km in 2.5 hours.\n\nSolve 3x² − 12x + 9 = 0.' }],
            mutants: [
                { name: '2.5 hours read as 25', reply: MATH.replace('2.5 hours', '25 hours') },
                { name: 'a minus becomes a plus', reply: MATH.replace('- 12x', '+ 12x') },
                { name: 'a coefficient misread', reply: MATH.replace('12x', '21x') },
                { name: '150 km read as 1150 km', reply: MATH.replace('150 km', '1150 km') },
                { name: '2.5 hours read as 12.5', reply: MATH.replace('2.5 hours', '12.5 hours') },
                { name: 'leading coefficient read as 13', reply: MATH.replace('$3x^2', '$13x^2') },
                { name: 'right side read as 0.5', reply: MATH.replace('= 0$', '= 0.5$') },
                { name: 'question number and points dropped', reply: 'A train travels 150 km in 2.5 hours.\n\nSolve $3x^2 - 12x + 9 = 0$.' },
                { name: 'a friendly preamble', reply: `Here is the transcription of the page:\n\n${MATH}` },
                { name: 'wrapped in a code fence', reply: fence(MATH) },
                { name: 'says it cannot see images', reply: REFUSE },
                { name: 'empty reply', reply: '' },
            ],
        },
        {
            id: 'vision-ocr-dutch-paragraph', vision: true,
            run: ocr('dutch'),
            score: (out) => scoreParagraph(img.DUTCH_LINES, ['belgië', 'eén'])(out),
            golden: DUTCH,
            mutants: [
                { name: 'accents dropped (Belgie, Een)', reply: DUTCH.replace('België', 'Belgie').replace('Eén', 'Een') },
                { name: 'translated into English', reply: 'A bicycle is more than a means of transport for many Dutch people. In the Netherlands and Belgium children often cycle to school themselves, even when it rains. One in five trips is made by bike.' },
                { name: 'last line missing', reply: img.DUTCH_LINES.slice(0, 2).join(' ') },
                { name: 'first line missing', reply: img.DUTCH_LINES.slice(1).join(' ') },
                { name: 'several words misread', reply: DUTCH.replace('vervoermiddel', 'vervoersmidel').replace('kinderen', 'kindern').replace('regent', 'regen').replace('reizen', 'reisen') },
                { name: 'preamble and commentary', reply: `Sure! Here is the text from the image. It is a short Dutch paragraph about cycling.\n\n${DUTCH}` },
                { name: 'empty reply', reply: '' },
            ],
        },
        {
            id: 'vision-ocr-ukrainian-paragraph', vision: true,
            run: ocr('cyrillic'),
            score: (out) => scoreParagraph(img.CYRILLIC_LINES, ['україна', 'її', 'східній', 'дніпрі'])(out),
            golden: UKR,
            mutants: [
                { name: 'rewritten in Russian', reply: 'Украина - это государство в Восточной Европе. Её столица - город Киев, расположенный на Днепре. Здесь живёт более трёх миллионов людей.' },
                { name: 'і and ї collapsed into и', reply: UKR.replace(/[іїІЇ]/g, (c) => (c === 'і' || c === 'ї' ? 'и' : 'И')) },
                { name: 'letters transliterated to Latin', reply: 'Ukraina - tse derzhava v Skhidnii Yevropi. Yii stolytsia - misto Kyiv, shcho roztashovane na Dnipri. Tut zhyve ponad try milioni liudei.' },
                { name: 'first line only', reply: img.CYRILLIC_LINES[0] },
                { name: 'third line missing', reply: img.CYRILLIC_LINES.slice(0, 2).join(' ') },
                { name: 'says it cannot read the script', reply: "I'm sorry, I cannot read this text." },
            ],
        },
        {
            id: 'vision-ocr-number-table', vision: true,
            run: ocr('table'),
            score: (out) => scoreTable(out),
            golden: TABLE,
            variants: [{ name: 'plain rows with a hyphen between values', reply: 'Day Min Max\nMon 12 - 19\nTue 9 - 15\nWed 11 - 22\nThu 7 - 13' }],
            mutants: [
                { name: 'min and max swapped in one row', reply: TABLE.replace('| Tue | 9 | 15 |', '| Tue | 15 | 9 |') },
                { name: 'a row dropped', reply: TABLE.replace('| Wed | 11 | 22 |\n', '') },
                { name: 'one digit misread (22 as 27)', reply: TABLE.replace('22', '27') },
                { name: 'a minus sign added (-12)', reply: TABLE.replace('| Mon | 12 |', '| Mon | -12 |') },
                { name: 'a unicode minus added (−7)', reply: TABLE.replace('| Thu | 7 |', '| Thu | −7 |') },
                { name: 'a decimal read (15.5)', reply: TABLE.replace('| 15 |', '| 15.5 |') },
                { name: 'values shifted down a row', reply: '| Day | Min | Max |\n|---|---|---|\n| Mon | 9 | 15 |\n| Tue | 11 | 22 |\n| Wed | 7 | 13 |\n| Thu | 12 | 19 |' },
                { name: 'an invented extra row', reply: `${TABLE}\n| Fri | 10 | 16 |` },
                { name: 'headers missing', reply: TABLE.replace('| Day | Min | Max |\n|---|---|---|\n', '') },
                { name: 'preamble', reply: `Here is the table:\n\n${TABLE}` },
            ],
        },
        {
            id: 'vision-ocr-handwritten-answer', vision: true,
            run: ocr('hand'),
            score: (out) => scoreHandwritten(out),
            golden: '$x = 3$ and $x = 1$',
            variants: [{ name: 'ends with a full stop', reply: 'x = 3 and x = 1.' }],
            mutants: [
                { name: 'second value misread (1 as 7)', reply: '$x = 3$ and $x = 7$' },
                { name: 'first value misread (3 as 8)', reply: '$x = 8$ and $x = 1$' },
                { name: 'second value read as 1.5', reply: '$x = 3$ and $x = 1.5$' },
                { name: 'second value read as 1/2', reply: '$x = 3$ and $x = 1/2$' },
                { name: 'first value read as 3.5', reply: '$x = 3.5$ and $x = 1$' },
                { name: 'only the first answer', reply: '$x = 3$' },
                { name: 'says it cannot read handwriting', reply: "I'm unable to read handwriting reliably, I can't transcribe this." },
                { name: 'a preamble', reply: 'Certainly! The handwritten answer reads: $x = 3$ and $x = 1$' },
                { name: 'empty reply', reply: '' },
            ],
        },
        {
            id: 'vision-describe-shapes-and-word', vision: true,
            run: describe('shapes'),
            score: (out) => scoreShapes(out),
            golden: 'A red square, a blue circle and a green triangle in a row, with the word "TULIP" in large black letters underneath.',
            mutants: [
                { name: 'colours attached to the wrong shapes', reply: 'A blue square, a red circle and a green triangle in a row, with the word "TULIP" underneath.' },
                { name: 'the word is not quoted', reply: 'A red square, a blue circle and a green triangle in a row, with a large word underneath.' },
                { name: 'a different word', reply: 'A red square, a blue circle and a green triangle in a row, with the word "LILAC" underneath.' },
                { name: 'no colours or shapes named', reply: 'Three coloured shapes above the word "TULIP".' },
                { name: '"This image shows" preamble', reply: 'This image shows a red square, a blue circle and a green triangle above the word "TULIP".' },
                { name: 'markdown in the description', reply: 'A **red square**, a **blue circle** and a **green triangle** above the word "TULIP".' },
                { name: 'gives up as UNREADABLE', reply: 'UNREADABLE' },
            ],
        },
        {
            id: 'vision-describe-bar-chart', vision: true,
            run: describe('chart'),
            score: (out) => scoreChart(out),
            golden: 'A bar chart titled "Kilos sold" with four blue bars for Apples, Pears, Plums and Figs, where Plums is the tallest at about 120.',
            variants: [
                { name: 'ranks a second bar too', reply: 'A bar chart titled "Kilos sold" with bars for Apples, Pears, Plums and Figs; Plums is the tallest and Pears the second tallest.' },
                { name: 'a bar called not the tallest', reply: 'A bar chart titled "Kilos sold" with bars for Apples, Pears, Plums and Figs. Pears is not the tallest; Plums is the tallest.' },
            ],
            mutants: [
                { name: 'Pears called second tallest, no tallest named', reply: 'A bar chart titled "Kilos sold" with bars for Apples, Pears, Plums and Figs, with Pears the second tallest.' },
                { name: 'Pears called tallest, Plums second', reply: 'A bar chart titled "Kilos sold" with bars for Apples, Pears, Plums and Figs; Pears is the tallest and Plums the second tallest.' },
                { name: 'names the wrong bar as tallest', reply: 'A bar chart titled "Kilos sold" with four blue bars for Apples, Pears, Plums and Figs, where Pears is the tallest.' },
                { name: 'reads the labels but never ranks the bars', reply: 'A bar chart titled "Kilos sold" with four blue bars labelled Apples, Pears, Plums and Figs.' },
                { name: 'a generic description', reply: 'A bar chart with several blue bars of different heights.' },
                { name: '"This image shows" preamble', reply: 'This image shows a bar chart of kilos sold in which Plums is the tallest bar, ahead of Pears, Figs and Apples.' },
                { name: 'markdown in the description', reply: 'A bar chart titled "Kilos sold": **Plums** is the tallest bar, then Pears, Figs and Apples.' },
                { name: 'gives up as UNREADABLE', reply: 'UNREADABLE' },
            ],
        },
        {
            id: 'vision-describe-labelled-arrows', vision: true,
            run: describe('diagram'),
            score: (out) => scoreDiagram(out),
            golden: 'Two boxes, Browser on the left and Server on the right, joined by two arrows: one labelled "request" pointing from Browser to Server, and one labelled "response" pointing back from Server to Browser.',
            mutants: [
                { name: 'both arrows reversed', reply: 'Two boxes, Browser on the left and Server on the right, joined by two arrows: one labelled "request" pointing from Server to Browser, and one labelled "response" pointing from Browser to Server.' },
                { name: 'labels never quoted', reply: 'Two boxes joined by two arrows, one pointing right and one pointing left.' },
                { name: 'only the request arrow', reply: 'A box labelled Browser with an arrow labelled "request" pointing to a box labelled Server.' },
                { name: 'direction not given', reply: 'Two boxes called Browser and Server with two arrows between them, labelled "request" and "response".' },
                { name: '"This image shows" preamble', reply: 'This image shows a Browser box and a Server box, with a "request" arrow from Browser to Server and a "response" arrow from Server to Browser.' },
                { name: 'gives up as UNREADABLE', reply: 'UNREADABLE' },
            ],
        },
    ],
};

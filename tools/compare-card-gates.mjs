// tools/compare-card-gates.mjs — the assistant's side-by-side card.
//
// Run:  node tools/compare-card-gates.mjs
//
// The assistant may draw two related texts side by side (a ```compare block,
// src/utils/compareBlocks.ts): a translation, a sentence before and after a
// fix, the same idea in two programming languages. The model writes both
// sides and decides when the card fits; the app owns the shape. Four things
// are pinned here:
//   - the parser: lenient about how a model names the sides, strict about
//     what a card is (two sides, size caps), and anything that is not a card
//     comes back as prose — no fence source drawn, nothing thrown;
//   - Copy and Add card: a paste carries both sides under their names, and a
//     pair becomes a card only through the assistant's one card door;
//   - the prompt: the guide is in the assistant's prompt and nowhere a lesson,
//     a feed item or a quiz is written, and it never tells the model it must
//     use the card;
//   - the drawing: the real Markdown renderer draws the card only in the
//     assistant, as a labelled group whose words a screen reader reads in
//     order, the marked words of a fix named in words and set by what each
//     side is, never by where it stands.

import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${String(extra).slice(0, 500)}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

const scratch = mkdtempSync(join(tmpdir(), 'compare-card-gates-'));
const bundle = async (entry, name) => {
    const out = join(scratch, `${name}.mjs`);
    await esbuild.build({
        entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
        bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
    });
    return import(pathToFileURL(out).href);
};

const cb = await bundle('../src/utils/compareBlocks.ts', 'compareBlocks');
const { parseCompare, prepareCompareFences, compareBlocksAsText, compareCard, compareTopicIds, wordDiff, sideMarkdown, MAX_COMPARES, COMPARE_SIDE_MAX,
    isTranslation, compareCheck, editOrder, flowOf } = cb;
const F = '```';
const block = (inner, open = `${F}compare`) => `${open}\n${inner}\n${F}`;

// ---------------------------------------------------------------------------
section('the parser reads the shape the guide teaches');
{
    const b = parseCompare([
        'title: Ordering politely',
        'side: English',
        'I would like a coffee, please.',
        'side: Dutch',
        'Ik wil graag een koffie.',
        'note: "Graag" makes it polite.',
        'topic: 4:17',
    ].join('\n'));
    check('two sides, each with its name and its text',
        b && b.sides[0].label === 'English' && b.sides[0].text === 'I would like a coffee, please.'
        && b.sides[1].label === 'Dutch' && b.sides[1].text === 'Ik wil graag een koffie.', JSON.stringify(b));
    check('title, note and topic are read', b && b.title === 'Ordering politely' && b.note === '"Graag" makes it polite.'
        && b.topic?.projectId === 4 && b.topic?.nodeId === 17, JSON.stringify(b));
    check('both sides are text', b && b.sides.every(s => s.kind === 'text' && s.lang === null));
    const bare = parseCompare('side: English\nHello\nside: Dutch\nHallo');
    check('title, note and topic are optional', bare && bare.title === null && bare.note === null && bare.topic === null, JSON.stringify(bare));
}

section('…and the names a model reaches for');
{
    const variants = {
        'a: / b:': 'a: English\nHello\nb: Dutch\nHallo',
        'Side A: / Side B:': 'Side A: English\nHello\nSide B: Dutch\nHallo',
        'side_1: / side_2:': 'side_1: English\nHello\nside_2: Dutch\nHallo',
        'LEFT: / RIGHT:': 'LEFT: English\nHello\nRIGHT: Dutch\nHallo',
        'first: / second:': 'first: English\nHello\nsecond: Dutch\nHallo',
        'blank lines and indentation': '\n  side: English\n\n  Hello\n\n  side: Dutch\n  Hallo\n',
    };
    for (const [name, inner] of Object.entries(variants)) {
        const b = parseCompare(inner);
        check(`${name}`, b && b.sides[0].label === 'English' && b.sides[0].text === 'Hello' && b.sides[1].label === 'Dutch' && b.sides[1].text === 'Hallo', JSON.stringify(b));
    }
    const fix = parseCompare('before: Ik heb gisteren naar huis gegaan.\nafter: Ik ben gisteren naar huis gegaan.\nwhy: "gaan" takes "zijn" in the perfect.');
    check('before: / after: with the text on the key line name the side by its role, with no label of their own',
        fix && fix.sides[0].role === 'before' && fix.sides[0].label === '' && fix.sides[0].text === 'Ik heb gisteren naar huis gegaan.'
        && fix.sides[1].role === 'after' && fix.note === '"gaan" takes "zijn" in the perfect.', JSON.stringify(fix));
    const tr = parseCompare('original: English\nGood morning\ntranslation: Dutch\nGoedemorgen');
    check('original: / translation: with a name on the key line take the name, and keep what the side is', tr && tr.sides[0].label === 'English' && tr.sides[1].label === 'Dutch'
        && tr.sides[0].role === 'original' && tr.sides[1].role === 'translation', JSON.stringify(tr));
    const wr = parseCompare('wrong: 2 + 2 = 5\ncorrect: 2 + 2 = 4');
    check('wrong: / correct:', wr && wr.sides[0].role === 'wrong' && wr.sides[1].role === 'correct', JSON.stringify(wr));
    const one = parseCompare('side: English: I would like a coffee\nside: Dutch: Ik wil graag een koffie');
    check('a name and its text on one line are split at the colon', one && one.sides[0].label === 'English' && one.sides[0].text === 'I would like a coffee'
        && one.sides[1].label === 'Dutch', JSON.stringify(one));
    const unnamed = parseCompare('side:\nHello\nside:\nHallo');
    check('a side with no name has an empty label, never an invented one', unnamed && unnamed.sides.every(s => s.label === '' && s.role === null), JSON.stringify(unnamed));
}

section('code in a side');
{
    const py = [
        'title: Reading a whole file',
        'side: Python',
        `${F}python`,
        'with open("notes.txt") as f:',
        '    text = f.read()',
        'note: str = "a line that looks like a key"',
        F,
        'side: JavaScript',
        `${F}js`,
        'const text = fs.readFileSync("notes.txt", "utf8");',
        F,
        'note: Python closes the file when the block ends.',
    ].join('\n');
    const b = parseCompare(py);
    check('a side that is one fence is code, in the fence\'s language, without the fence',
        b && b.sides[0].kind === 'code' && b.sides[0].lang === 'python' && b.sides[0].text.startsWith('with open(') && !b.sides[0].text.includes(F)
        && b.sides[1].kind === 'code' && b.sides[1].lang === 'js', JSON.stringify(b));
    check('a `key:` line inside a side\'s code fence is code, not a field',
        b && b.sides[0].text.includes('note: str = "a line that looks like a key"') && b.note === 'Python closes the file when the block ends.', JSON.stringify(b));
    check('indentation inside code is kept', b && b.sides[0].text.includes('\n    text = f.read()'));
    const raw = parseCompare('side: Python\nfor x in range(3):\n    print(x)\nside: JavaScript\nfor (let x = 0; x < 3; x++) console.log(x);');
    check('a side named after a programming language with no fence is still code in that language',
        raw && raw.sides[0].kind === 'code' && raw.sides[0].lang === 'python' && raw.sides[0].text === 'for x in range(3):\n    print(x)'
        && raw.sides[1].lang === 'javascript', JSON.stringify(raw));
    const mixed = parseCompare(`side: Explained\nThis loop:\n${F}python\nfor x in y: pass\n${F}\nruns once per item.\nside: Dutch\nDeze lus…`);
    check('prose around a fence keeps the side markdown, its code block inside it', mixed && mixed.sides[0].kind === 'text' && mixed.sides[0].text.includes(`${F}python`), JSON.stringify(mixed));
    check('sideMarkdown gives a code side back its fence', sideMarkdown(b.sides[0]).startsWith(`${F}python\n`) && sideMarkdown(b.sides[0]).endsWith(`\n${F}`));
    const ticks = parseCompare(`side: Markdown source\n${F}text\nUse ${F}js to open a fence\n${F}\nside: B\nb`);
    check('…and a fence longer than any run inside it', ticks && /^`{3,}/.test(sideMarkdown(ticks.sides[0])));
}

section('caps, and what is not a card');
{
    check('one side is not a card', parseCompare('side: English\nHello') === null);
    check('three sides are not a card (two, as comparison research pairs them)', parseCompare('side: A\na\nside: B\nb\nside: C\nc') === null);
    check('an empty block is not a card', parseCompare('') === null && parseCompare('   \n  ') === null);
    // A key line also holds a side's text (`a: Hello`), so a lone name is read
    // as the text it may be; nothing is dropped.
    const bare = parseCompare('side: English\nside: Dutch\nHallo');
    check('a side with only its key line is read as that line\'s text', bare?.sides[0].text === 'English' && bare.sides[0].label === '', JSON.stringify(bare));
    check('prose with no keys is not a card', parseCompare('Just some words.\nAnd more.') === null);
    const huge = 'x'.repeat(COMPARE_SIDE_MAX + 1);
    check(`a side over ${COMPARE_SIDE_MAX} characters is not a card`, parseCompare(`side: A\n${huge}\nside: B\nb`) === null);
    const long = parseCompare(`title: ${'T'.repeat(300)}\nside: ${'L'.repeat(50)}x ${'L'.repeat(50)}\nfirst\nside: B\nb\nnote: ${'n'.repeat(2000)}`);
    check('a long title, name or note is cut to its cap with an ellipsis',
        long && long.title.length <= 120 && long.title.endsWith('…') && long.sides[0].label.length <= 60 && long.note.length <= 600 && long.note.endsWith('…'), JSON.stringify(long)?.slice(0, 300));
    check('a topic that is not two ids offers no card', parseCompare('side: A\na\nside: B\nb\ntopic: physics').topic === null
        && parseCompare('side: A\na\nside: B\nb\ntopic: 0:3').topic === null);
    // Nothing a model writes may throw: random keys, half fences, binary noise.
    const junk = ['```', 'side:', 'side: x\n```', 'side: x\n```python\nunclosed', ':::\n:', 'note: only a note', 'topic: 1:2',
        'side: a\n~~~\ncode\n~~~\nside: b\nb', '\u0000\u0001side: a\nb', 'side: a\n' + '`'.repeat(40) + '\nside: b\nb'];
    let threw = null;
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const alphabet = ['side: ', 'a: ', 'b: ', 'note: ', 'title: ', 'topic: 1:2', F, `${F}py`, '\n', 'x', ' ', ':', '`', '~~~', 'before: ', 'é', '\t'];
    for (let i = 0; i < 400; i++) junk.push(Array.from({ length: 4 + Math.floor(rnd() * 30) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join(''));
    for (const j of junk) {
        try {
            parseCompare(j);
            prepareCompareFences(block(j));
            prepareCompareFences(block(j), true);
            prepareCompareFences(`${F}compare\n${j}`);
            compareBlocksAsText(block(j));
        } catch (e) { threw = `${JSON.stringify(j)}: ${e.message}`; break; }
    }
    check('nothing a model writes throws (420 shapes, random and hand-picked)', threw === null, threw);
}

section('finding the blocks in an answer');
{
    const ans = `Here it is:\n\n${block('side: English\nHello\nside: Dutch\nHallo')}\n\nThat is all.`;
    const p = prepareCompareFences(ans);
    const m = p.body.match(/^(`{4,})compare\n([\s\S]*?)\n\1$/m);
    check('a card is written back as one fence longer than three backticks', !!m && m[2] === 'side: English\nHello\nside: Dutch\nHallo', p.body);
    check('the answer around it is untouched', p.body.startsWith('Here it is:') && p.body.trimEnd().endsWith('That is all.'));
    const code = `${block(`side: Python\n${F}python\nprint(1)\n${F}\nside: JavaScript\n${F}js\nconsole.log(1)\n${F}`)}\nAfter the card.`;
    const pc = prepareCompareFences(code);
    check('a block whose sides hold code fences is found to its real end, not the first inner closer',
        /^````compare\n[\s\S]*console\.log\(1\)\n```\n````$/m.test(pc.body) && pc.body.trimEnd().endsWith('After the card.'), pc.body);
    const bareInner = `${block(`side: Python\n${F}\nprint(1)\n${F}\nside: JavaScript\n${F}\nconsole.log(1)\n${F}`)}\nAfter.`;
    const pb = prepareCompareFences(bareInner);
    const bm = pb.body.match(/^(`{4,})compare\n([\s\S]*?)\n\1$/m);
    check('…also when a side\'s code fence names no language', !!bm && parseCompare(bm[2])?.sides[1].text === 'console.log(1)' && pb.body.trimEnd().endsWith('After.'), pb.body);
    const inline = `${block('before: I goed home\nafter: I went home')}\nThe past of "go" is "went".`;
    const pi = prepareCompareFences(inline);
    check('a bare fence after a side written on its key line closes the block', /^````compare\n[\s\S]*\n````\nThe past/m.test(pi.body), pi.body);
    const alias = prepareCompareFences(block('side: A\na\nside: B\nb', '```Comparison'));
    check('```comparison and any case open one too', /^````compare$/m.test(alias.body), alias.body);

    const bad = prepareCompareFences(`Look:\n\n${block('side: English\nHello there')}\n\nEnd.`);
    check('a block that is not a card becomes prose: its words stay, its keys and fence go',
        !bad.body.includes(F) && bad.body.includes('Hello there') && bad.body.includes('**English**') && !/side:/.test(bad.body), bad.body);
    const three = prepareCompareFences(block('side: A\nalpha\nside: B\nbeta\nside: C\ngamma\nnote: three of them'));
    check('…three sides keep all three texts', ['alpha', 'beta', 'gamma', 'three of them'].every(w => three.body.includes(w)) && !three.body.includes(F), three.body);
    const many = prepareCompareFences(Array.from({ length: MAX_COMPARES + 1 }, (_, i) => block(`side: A\na${i}\nside: B\nb${i}`)).join('\n\n'));
    check(`at most ${MAX_COMPARES} cards a message; the next is prose`,
        (many.body.match(/^````compare$/gm) || []).length === MAX_COMPARES && many.body.includes(`a${MAX_COMPARES}`) && !/^```compare$/m.test(many.body), many.body);
    const plain = 'No card here. ```js\nx\n``` and a word compare.';
    check('an answer with no block comes back as the same string', prepareCompareFences(plain).body === plain);
    const other = `${block('flowchart TD\n A-->B', `${F}mermaid`)}`;
    check('another fence is never touched', prepareCompareFences(other).body === other);
}

section('the answer\'s other repair layers leave a card alone');
{
    const { expandDetailsTags } = await bundle('../src/utils/details.ts', 'details');
    const { fixMarkdownMathTypography } = await bundle('../src/utils/mathText.ts', 'mathText');
    const inner = `side: Python\n${F}\nx = a_1 * b_2\n${F}\n<details><summary>s</summary>not a tag here</details>\nside: B\nb`;
    const card = prepareCompareFences(block(inner)).body;
    check('the tag expander reads a long fence to its own closer, not a side\'s shorter one', expandDetailsTags(card, { streaming: false }) === card, expandDetailsTags(card, { streaming: false }));
    check('the maths fixer does too', fixMarkdownMathTypography(card) === card, fixMarkdownMathTypography(card));
    // withCodeProtected (blockTags.ts) closes a fence only at a run as long as
    // its opener, as CommonMark does; before, a side's ``` let the tags after it out.
    const { expandTimelineTags } = await bundle('../src/utils/timeline.ts', 'timeline');
    const tl = prepareCompareFences(block(`side: Python\n${F}\nx = 1\n${F}\n<Timeline><TimelineEvent time="1914">War</TimelineEvent></Timeline>\nside: B\nb`)).body;
    check('the timeline expander leaves a tag inside a card alone too', expandTimelineTags(tl) === tl, expandTimelineTags(tl));
    const { withCodeProtected } = await bundle('../src/utils/blockTags.ts', 'blockTags');
    const seen = [];
    withCodeProtected(`\`\`\`\`md\n${F}\nin\n${F}\n\`\`\`\`\nout`, (t) => { seen.push(t); return t; });
    check('a fence of four is closed by four, not by the three inside it', seen.join('').includes('out') && !seen.join('').includes('in\n'), JSON.stringify(seen));
}

section('while it streams');
{
    const half = `Here:\n\n${F}compare\nside: English\nI would like`;
    const s = prepareCompareFences(half, true);
    check('an unclosed block is held back while streaming, with how much has arrived', s.body === 'Here:' && s.pending?.chars > 0, JSON.stringify(s));
    const settled = prepareCompareFences(`Here:\n\n${F}compare\nside: English\nHello\nside: Dutch\nHallo`, false);
    check('once settled, a block the model never closed runs to the end of the answer and is read', /^````compare$/m.test(settled.body) && settled.pending === null, settled.body);
    const inner = prepareCompareFences(`${F}compare\nside: Python\n${F}python\nprint(1)\n${F}\nside: JS\n${F}js\nconsole`, true);
    check('…also while a side\'s own code fence is still open', inner.body === '' && inner.pending !== null, JSON.stringify(inner));
    const done = prepareCompareFences(`${block('side: A\na\nside: B\nb')}\nMore words arriv`, true);
    check('a closed block is drawn while the rest of the answer streams', /^````compare$/m.test(done.body) && done.pending === null);
    // A bare fence under `side: Python` may open its code or close the block;
    // until what follows has arrived, it is held, never shown as prose.
    const opening = prepareCompareFences(`${F}compare\nside: Python\n${F}`, true);
    const coding = prepareCompareFences(`${F}compare\nside: Python\n${F}\nprint(1)`, true);
    check('a bare fence just under a side\'s name is held back while streaming', opening.body === '' && opening.pending !== null && coding.body === '' && coding.pending !== null,
        JSON.stringify([opening, coding]));
}

section('where a block ends');
{
    // A one-line side, then the block's closer, then the answer goes on with a
    // code block of its own: the card ends at its closer.
    for (const sides of ['side: English: Hello\nside: Dutch: Hallo', 'a: Hello\nb: Hallo']) {
        for (const tail of ['', '\nMore after.']) {
            const ans = `${F}compare\n${sides}\n${F}\nThen text here.\n\n${F}python\nprint(1)\n${F}${tail}`;
            const out = prepareCompareFences(ans).body;
            const inner = out.match(/^````compare\n([\s\S]*?)\n````$/m)?.[1] ?? '';
            check(`a card of one-line sides ends at its closer when code follows later (${sides.split('\n')[0]}${tail ? ', text after it' : ''})`,
                !inner.includes('Then text') && out.includes('Then text here.') && out.includes(`${F}python\nprint(1)\n${F}`), out);
        }
    }
    // `side: Dutch: Hallo` holds its text, so a fence under it closes the
    // block at once: the card is drawn while the rest of the answer streams.
    const streamed = prepareCompareFences(`${F}compare\nside: English: Hello\nside: Dutch: Hallo\n${F}\nThen text arriv`, true);
    check('…and is drawn while the rest of the answer still streams', /^````compare$/m.test(streamed.body) && streamed.pending === null, JSON.stringify(streamed));
    const bare = prepareCompareFences(`${F}compare\nside: Python\n${F}\nprint(1)\n${F}\nside: JavaScript\n${F}\nconsole.log(1)\n${F}\n${F}\nAfter.`).body;
    const bareCard = parseCompare(bare.match(/^````compare\n([\s\S]*?)\n````$/m)?.[1] ?? '');
    check('…while bare fences under side names still open each side\'s code', bareCard?.sides[0].kind === 'code' && bareCard?.sides[1].text === 'console.log(1)' && bare.endsWith('After.'), bare);
    const crlf = block('side: English\nHello\nside: Dutch\nHallo').replace(/\n/g, '\r\n');
    check('an answer that came with CRLF line ends is read', /^````compare$/m.test(prepareCompareFences(crlf).body)
        && parseCompare('side: English\r\nHello\r\nside: Dutch\r\nHallo')?.sides[1].text === 'Hallo', JSON.stringify(prepareCompareFences(crlf).body));
    const crlfPlain = 'No card.\r\n```js\r\nx\r\n```\r\ncompare';
    check('…and one with no card comes back exactly as it was', prepareCompareFences(crlfPlain).body === crlfPlain);
    const quoted = `How to write one:\n\n\`\`\`\`markdown\n${block('side: A\na\nside: B\nb')}\n\`\`\`\`\nAfter.`;
    check('a card quoted inside a longer fence of the answer\'s own is left as that fence\'s text', prepareCompareFences(quoted).body === quoted, prepareCompareFences(quoted).body);
}

section('a side\'s own text is not read as keys');
{
    const talk = parseCompare('side: English\nA: Hello!\nB: Hi!\nside: Dutch\nA: Hallo!\nB: Hoi!');
    check('a dialogue\'s A: and B: lines stay in their side', talk?.sides[0].text === 'A: Hello!\nB: Hi!' && talk?.sides[1].text === 'A: Hallo!\nB: Hoi!', JSON.stringify(talk));
    const typed = parseCompare('side: Python\nx: int = 1\nb: int = 3\nside: JavaScript\nlet b = 3;');
    check('…as does an unfenced `b: int = 3`', typed?.sides[0].kind === 'code' && typed.sides[0].text === 'x: int = 1\nb: int = 3', JSON.stringify(typed));
    const noted = parseCompare('side: English\nNote: this is formal.\nHello\nside: Dutch\nHallo');
    check('a note line between the two sides is the first side\'s text', noted?.note === null && noted?.sides[0].text === 'Note: this is formal.\nHello', JSON.stringify(noted));
    const proto = parseCompare('side: JS\nconstructor: Foo\nside: B\nb');
    check('a line named like an object\'s own property is text (`constructor:`)', proto?.sides[0].text === 'constructor: Foo', JSON.stringify(proto));
    const titled = parseCompare('Ordering politely\nside: English\nHello\nside: Dutch\nHallo');
    check('one short line before the sides is the title', titled?.title === 'Ordering politely', JSON.stringify(titled));
    const lead = 'Here you go:\nas asked.\nside: A\na\nside: B\nb\nside: C\nc';
    const prose = prepareCompareFences(block(lead)).body;
    check('more than that is not a card, and the prose keeps it', parseCompare('Here you go:\nas asked.\nside: A\na\nside: B\nb') === null
        && prose.includes('Here you go:\nas asked.'), prose);
    const longTitle = prepareCompareFences(block(`title: ${'T'.repeat(300)}\nside: A\na\nside: B\nb\nside: C\nc`)).body;
    check('the prose keeps a long title whole', longTitle.includes('T'.repeat(300)), longTitle.slice(0, 80));
}

section('a fix goes by what its sides are');
{
    const wrongFirst = parseCompare('wrong: She go to school.\ncorrect: She goes to school.');
    const rightFirst = parseCompare('correct: She goes to school.\nwrong: She go to school.\ntopic: 1:2');
    check('the wrong or earlier side is found wherever it stands', editOrder(wrongFirst) === 0 && editOrder(rightFirst) === 1
        && editOrder(parseCompare('after: I went\nbefore: I goed')) === 1);
    check('…by a side\'s name as well as its key', editOrder(parseCompare('side: Correct\nShe goes.\nside: Wrong\nShe go.')) === 1
        && editOrder(parseCompare('side: You wrote\nShe go.\nside: Fixed\nShe goes.')) === 0);
    check('two versions that are both right are no edit', editOrder(parseCompare('side: Direct\nWaar is het station?\nside: Polite\nWeet u waar het station is?')) === null
        && editOrder(parseCompare('side: English\nhello\nside: Dutch\nhallo')) === null);
    const card = compareCard(rightFirst);
    check('a card from a fix written right-first asks with the wrong sentence, and the fix is its answer',
        card?.front.endsWith('She go to school.') && card?.back === 'She goes to school.' && /Wrong → Correct/.test(card?.front || ''), JSON.stringify(card));
}

section('an arrow only where one text was made from the other');
{
    const p = s => parseCompare(s);
    check('a fix flows from its wrong or earlier side, wherever it stands',
        flowOf(p('before: I goed\nafter: I went')) === 0 && flowOf(p('correct: She goes.\nwrong: She go.')) === 1);
    check('a translation the model marks flows from its original, keeping the language names',
        flowOf(p('original: English\nGood morning\ntranslation: Dutch\nGoedemorgen')) === 0
        && flowOf(p('translation: Dutch\nGoedemorgen\noriginal: English\nGood morning')) === 1
        && flowOf(p('original: Good morning\nside: Dutch\nGoedemorgen')) === 0);
    check('two texts that only stand side by side do not flow: two languages named, two registers, two programming languages',
        flowOf(p('side: English\nhello\nside: Dutch\nhallo')) === null
        && flowOf(p('side: Informal\nWil je?\nside: Formal\nWilt u?')) === null
        && flowOf(p('side: Python\nprint(1)\nside: JavaScript\nconsole.log(1)')) === null);
    check('two sides that both claim to be the original do not flow', flowOf(p('original: a\noriginal: b')) === null
        && flowOf(p('translation: a\ntranslation: b')) === null);
    const tc = compareCard(p('translation: Dutch\nGoedemorgen\noriginal: English\nGood morning\ntopic: 1:2'));
    check('a translation written target-first still asks with the original', tc?.front.endsWith('Good morning') && tc?.back === 'Goedemorgen'
        && /English → Dutch/.test(tc?.front || ''), JSON.stringify(tc));
}

section('Copy and Add card');
{
    const ans = `Say it like this:\n\n${block('title: Ordering\nside: English\nI would like a coffee.\nside: Dutch\nIk wil graag een koffie.\nnote: Graag is polite.\ntopic: 4:17')}\n\nGood luck.`;
    const text = compareBlocksAsText(ans);
    check('a paste carries the title, each side under its name, and the note — no fence, no topic ids',
        text.includes('Ordering\n\nEnglish:\nI would like a coffee.\n\nDutch:\nIk wil graag een koffie.\n\nGraag is polite.')
        && !text.includes(F) && !text.includes('4:17') && text.startsWith('Say it like this:') && text.endsWith('Good luck.'), text);
    const fix = compareBlocksAsText(block('before: I goed home\nafter: I went home'));
    check('a side named by its role is pasted under the role\'s word', fix === 'Before:\nI goed home\n\nAfter:\nI went home', fix);
    const code = compareBlocksAsText(block(`side: Python\n${F}python\nprint(1)\n${F}\nside: JavaScript\n${F}js\nconsole.log(1)\n${F}`));
    check('code is pasted in its fence', code.includes(`Python:\n${F}python\nprint(1)\n${F}`), code);
    check('an answer with no card is pasted as it is', compareBlocksAsText('plain') === 'plain');

    const b = parseCompare('side: English\nI would like a coffee.\nside: Dutch\nIk wil graag een koffie.\nnote: Graag is polite.\ntopic: 4:17');
    const card = compareCard(b);
    check('a pair with a topic is a card: the first side asks, which way it goes is named, the second answers, the note is the extra',
        card && card.projectId === 4 && card.nodeId === 17 && card.front === '*English → Dutch*\n\nI would like a coffee.'
        && card.back === 'Ik wil graag een koffie.' && card.extra === 'Graag is polite.', JSON.stringify(card));
    check('a pair with no topic offers no card', compareCard(parseCompare('side: A\na\nside: B\nb')) === null);
    check('a pair too long for a card is shown but offers none', compareCard(parseCompare(`side: A\n${'a'.repeat(2500)}\nside: B\nb\ntopic: 1:2`)) === null);
    check('the drawer learns which topics an answer\'s cards name', JSON.stringify(compareTopicIds(ans)) === '[17]');
    // One door: the card goes through the assistant's card endpoint, never a
    // route or an api call of its own.
    const read = (rel) => { try { return readFileSync(join(repoRoot, rel), 'utf8'); } catch { return ''; } };
    const proposals = read('src/components/AssistantProposals.tsx');
    const compareSrc = read('src/components/CompareCard.tsx');
    check('the card component exists', compareSrc.length > 0, 'src/components/CompareCard.tsx');
    check('the card component writes nothing itself (no api import)', !/from ['"]\.\.\/api['"]/.test(compareSrc), 'CompareCard.tsx imports the api');
    const serverMax = read('server/assistantWrites.js').match(/CARD_SIDE_MAX\s*=\s*(\d[\d_]*)/)?.[1];
    const clientMax = read('src/utils/compareBlocks.ts').match(/CARD_SIDE_MAX\s*=\s*(\d[\d_]*)/)?.[1];
    check('the card size the pair is held to is the server\'s', !!serverMax && serverMax === clientMax, `server ${serverMax}, client ${clientMax}`);
    const foots = compareSrc.match(/\{foot && <div[^>]*>/g) || [];
    check('the Add card foot leaves no empty strip when it draws nothing, and is not read aloud',
        foots.length > 0 && foots.every(m => /empty:hidden/.test(m) && /data-read-skip/.test(m)), foots.join(' | '));
    check('Add card from a pair goes through addAssistantCard, the one card door', /export function CompareCardAdd[\s\S]*?useCardAdd\(/.test(proposals)
        && /function useCardAdd[\s\S]*?api\.addAssistantCard\(/.test(proposals), 'CompareCardAdd / useCardAdd');
    const server = read('server/routes/assistantWrites.js') + read('server/assistantWrites.js');
    check('no new write route for a pair', !/compareCard|compareBlock|\/compare/i.test(server));
}

section('a translation is checked both ways before it is offered as a card');
{
    // A learner cannot judge a sentence in a language they cannot read yet, and
    // the cold check answers the FRONT: on its own it proves the back only.
    const proposals = readFileSync(join(repoRoot, 'src/components/AssistantProposals.tsx'), 'utf8');
    const tr =(s, ui) => isTranslation(parseCompare(s), ui);
    check('two sides named after two languages are a translation', tr('side: English\nI would like a coffee.\nside: Dutch\nIk wil graag een koffie.') === true);
    check('…named in the language itself', tr('side: English\nWhere is the station?\nside: Nederlands\nWaar is het station?') === true);
    check('…named in the interface language', tr('side: Русский\nГде вокзал?\nside: Нидерландский\nWaar is het station?', 'ru') === true);
    check('original:/translation: are a translation', tr('original: Where is the station?\ntranslation: Waar is het station?') === true);
    check('…and so are sides NAMED Original and Translation', tr('side: Original\nWhere is the station?\nside: Translation\nWaar is het station?') === true);
    const nlRoles = new Map([['origineel', 'original'], ['vertaling', 'translation']]);
    check('…or named so in the interface language', isTranslation(parseCompare('side: Origineel\nWhere is the station?\nside: Vertaling\nWaar is het station?'), 'nl', nlRoles) === true);
    check('a language name with a remark after it is still that language', tr('side: English\nWould you like a coffee?\nside: Dutch (formal)\nWilt u een koffie?') === true);
    check('a language code is that language', tr('side: EN\nWhere is the station?\nside: NL\nWaar is het station?') === true);
    check('before/after is not', tr('before: Ik heb gegaan.\nafter: Ik ben gegaan.') === false);
    check('two versions in one language are not', tr('side: Direct\nWaar is het station?\nside: Polite\nWeet u waar het station is?') === false);
    check('the same language twice is not', tr('side: English\nhello\nside: English\nhi') === false);
    check('code in two programming languages is not', tr(`side: Python\n${F}python\nprint(1)\n${F}\nside: JavaScript\n${F}js\nconsole.log(1)\n${F}`) === false);

    const en = parseCompare('side: English\nI would like a coffee.\nside: Dutch\nIk wil graag een koffie.\ntopic: 4:17');
    const card = compareCard(en);
    check('a translation card carries its reverse: the second side asks, the first answers',
        card?.reverse?.front === '*Dutch → English*\n\nIk wil graag een koffie.' && card?.reverse?.back === 'I would like a coffee.', JSON.stringify(card?.reverse));
    check('a fix carries none', compareCard(parseCompare('before: Ik heb gegaan.\nafter: Ik ben gegaan.\ntopic: 4:17'))?.reverse === null);
    const named = compareCard(parseCompare('before: Ik heb gegaan.\nafter: Ik ben gegaan.\ntopic: 4:17'), 'nl', undefined, s => (s.role === 'before' ? 'Ervoor' : 'Erna'));
    check('the card front names its sides as the card shows them, in the interface language', named?.front === '*Ervoor → Erna*\n\nIk heb gegaan.', JSON.stringify(named));

    const ok = { verdict: 'ok', reason: null };
    const no = { verdict: 'disputed', reason: 'a second model answered “x”, and a closer look sided with it', detail: { answer: 'x' } };
    const unk = { verdict: 'unchecked', reason: 'the checking model gave no usable answer' };
    check('both ways agree: offered', compareCheck([ok, ok], true)?.verdict === 'ok');
    check('the way back disagrees: not offered', compareCheck([ok, no], true)?.verdict === 'disputed');
    check('…and its line says the reason, not "this answer looks wrong"', compareCheck([ok, no], true)?.verdict === 'disputed' && !compareCheck([ok, no], true)?.detail && /closer look/.test(compareCheck([ok, no], true)?.reason || '') && !/could not be checked/.test(compareCheck([ok, no], true)?.reason || ''));
    check('the first way disagrees: not offered, as a prepared card', compareCheck([no, ok], true) === no);
    check('a translation that could not be checked is not offered', compareCheck([ok, unk], true)?.verdict === 'disputed'
        && /could not be checked/.test(compareCheck([ok, unk], true)?.reason || ''), JSON.stringify(compareCheck([ok, unk], true)));
    check('…nor when the whole request failed (one verdict back for two cards)', compareCheck([unk], true)?.verdict === 'disputed');
    check('anything else that could not be checked stays offered and says so, as a prepared card', compareCheck([unk], false) === unk);
    check('still checking is still checking', compareCheck(null, true) === undefined && compareCheck([ok, undefined], true) === undefined);
    const say = { reverse: (w) => `R:${w}`, unchecked: (w) => `U:${w}` };
    check('the reasons a learner reads come from the caller, in their language',
        compareCheck([ok, no], true, say)?.reason === `R:${no.reason}` && compareCheck([ok, unk], true, say)?.reason === `U:${unk.reason}`
        && compareCheck([ok, { verdict: 'disputed' }], true, say)?.reason === 'R:null');
    check('…and Add card passes translated ones', /export function CompareCardAdd[\s\S]*?compareCheck\([^;]*?t\("asked the other way round, \{\{reason\}\}"[^;]*?t\("the translation could not be checked"/.test(proposals));
}

section('what changed between two versions');
{
    const side = (text) => ({ label: '', role: null, kind: 'text', lang: null, text });
    const d = wordDiff(side('Ik heb gisteren naar huis gegaan.'), side('Ik ben gisteren naar huis gegaan.'));
    check('a fixed sentence marks the word that changed on each side, and only it',
        d && d[0].filter(r => r.changed).map(r => r.text).join('|') === 'heb' && d[1].filter(r => r.changed).map(r => r.text).join('|') === 'ben', JSON.stringify(d));
    check('…and gives back every word of both sides', d && d[0].map(r => r.text).join('') === 'Ik heb gisteren naar huis gegaan.' && d[1].map(r => r.text).join('') === 'Ik ben gisteren naar huis gegaan.');
    const two = wordDiff(side('She go to school every days.'), side('She goes to school every day.'));
    check('two changes are two marks', two && two[1].filter(r => r.changed).map(r => r.text).join('|') === 'goes|day', JSON.stringify(two));
    check('a translation shares too few words to mark', wordDiff(side('I would like a coffee, please.'), side('Ik wil graag een koffie, alstublieft.')) === null);
    check('code is not marked word by word', wordDiff({ ...side('print(1)'), kind: 'code', lang: 'python' }, { ...side('print(2)'), kind: 'code', lang: 'python' }) === null);
    check('markdown is not marked (its formatting would be lost)', wordDiff(side('The **cat** sat.'), side('The **dog** sat.')) === null
        && wordDiff(side('Speed $v = d/t$.'), side('Speed $v = d \\cdot t$.')) === null);
    check('two identical sides mark nothing', wordDiff(side('Same words here.'), side('Same words here.')) === null);
}

// ---------------------------------------------------------------------------
section('the prompt');
{
    process.env.DB_PATH = join(scratch, 'test.db');
    process.env.VAULT_ROOT = join(scratch, 'vault');
    process.env.DATA_DIR = scratch;
    const { default: db } = await import('../server/database.js');
    const ai = await import('../server/ai.js');
    const { AI_PROMPTS, buildVisualsGuide, quizVisualsGuide } = ai;
    const COMPARE_GUIDE = typeof ai.COMPARE_GUIDE === 'string' ? ai.COMPARE_GUIDE : '';
    const assistant = AI_PROMPTS.assistant({}, 'How do I say this in Dutch?').system;
    check('the guide is exported and is in the assistant\'s prompt', COMPARE_GUIDE.length > 0 && assistant.includes(COMPARE_GUIDE));
    check('…once', assistant.split('```compare').length - 1 === COMPARE_GUIDE.split('```compare').length - 1);
    check('it teaches the shape the parser reads', /```compare\ntitle: /.test(COMPARE_GUIDE) && (COMPARE_GUIDE.match(/^side: /gm) || []).length === 2 && /^note: /m.test(COMPARE_GUIDE) && /^topic: /m.test(COMPARE_GUIDE));
    const example = COMPARE_GUIDE.match(/```compare\n([\s\S]*?)\n```(?!\w)/);
    check('its own example is a card the parser accepts', !!example && parseCompare(example[1].replace(/PROJECT_ID:NODE_ID/, '1:2')) !== null, example?.[1]);
    check('it says when, and never that the model must use it', /\bwhen\b/i.test(COMPARE_GUIDE) && !/\b(must|always|required|mandatory)\b/i.test(COMPARE_GUIDE), COMPARE_GUIDE);
    check('it keeps a single text, a long text and a list of many things out of it', /one text|single/i.test(COMPARE_GUIDE) && /long/i.test(COMPARE_GUIDE));
    // A real run (Opus) wrote the Python snippet above the card and again in it.
    check('it asks for the two texts once, in the card, not also around it', /\bonce\b[^.]*\bcard\b[^.]*\baround\b/i.test(COMPARE_GUIDE));
    check('it is short (under 1,600 characters, paid on every chat turn)', COMPARE_GUIDE.length < 1600, `${COMPARE_GUIDE.length} characters`);
    // Where lessons, feed items and questions are written, a card would be
    // drawn as dead source: they go through the five gates, and a card in a
    // lesson is a separate decision.
    const elsewhere = {
        'the visuals guide lessons share': buildVisualsGuide(),
        'the quiz visuals guide': quizVisualsGuide(),
        'a feed lesson': AI_PROMPTS.feed_lesson('Topic', [{ title: 'Part', focus: 'f' }], 1, 'context').system,
        'a feed question': AI_PROMPTS.feed_question('Topic', 'Part', 'lesson text', 'multiple_choice').system,
        'a quiz': JSON.stringify(AI_PROMPTS.quiz_generator('context', 3, 'multiple_choice', null)),
    };
    for (const [name, text] of Object.entries(elsewhere)) check(`not in ${name}`, typeof text === 'string' && !/```compare/.test(text) && !(COMPARE_GUIDE && text.includes(COMPARE_GUIDE)));
    // Every other prompt, called with whatever it accepts: none carries it.
    const leaked = [];
    for (const [name, fn] of Object.entries(AI_PROMPTS)) {
        if (name === 'assistant' || typeof fn !== 'function') continue;
        let got;
        try { got = fn('Topic', 'context', 0, 'x'); } catch { continue; }
        if (/```compare/.test(JSON.stringify(got))) leaked.push(name);
    }
    check('no other prompt carries it', leaked.length === 0, leaked.join(', '));
    db.close();
}

// ---------------------------------------------------------------------------
section('the drawing, in the real renderer');
{
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
    for (const k of ['window', 'document', 'navigator', 'localStorage', 'Element', 'Text', 'Node', 'HTMLElement', 'matchMedia']) {
        try { globalThis[k] = dom.window[k]; } catch { /* a read-only global in this Node */ }
    }
    globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
    mkdirSync(join(repoRoot, 'node_modules', '.cache'), { recursive: true });
    const mdScratch = mkdtempSync(join(repoRoot, 'node_modules', '.cache', 'compare-card-md-'));
    const mdOut = join(mdScratch, 'md.cjs');
    await esbuild.build({
        stdin: {
            contents: "import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server'; import Markdown from './src/components/Markdown';"
                + " import { CompareFootContext } from './src/components/CompareCard';"
                + ' export const render = (content, surface, foot) => renderToStaticMarkup(foot'
                + " ? createElement(CompareFootContext.Provider, { value: () => createElement('button', { 'data-test-foot': '' }, 'Add card') }, createElement(Markdown, { content, surface }))"
                + ' : createElement(Markdown, { content, surface }));',
            resolveDir: repoRoot, loader: 'js',
        },
        bundle: true, format: 'cjs', platform: 'node', outfile: mdOut, jsx: 'automatic', logLevel: 'silent',
        loader: { '.css': 'empty' },
        define: { 'import.meta.env.DEV': 'false' },
        external: ['vega-embed', 'vega', 'vega-lite', 'mermaid', 'p5', 'smiles-drawer', '@observablehq/plot'],
        plugins: [{
            name: 'stub-blocks',
            setup(b) {
                b.onResolve({ filter: /^\.\/(visuals\/VisualBlock|drills\/DrillLauncher)$/ }, () => ({ path: 'blocks', namespace: 'stub-blocks' }));
                b.onLoad({ filter: /.*/, namespace: 'stub-blocks' }, () => ({ contents: 'export default function Block(){return null;} export function DrillLauncher(){return null;}', loader: 'js' }));
            },
        }],
    });
    const { render } = createRequire(import.meta.url)(mdOut);
    const doc = dom.window.document;
    const root = doc.getElementById('root');
    const draw = (content, surface = 'assistant', foot = false) => { root.innerHTML = render(content, surface, foot); return root; };
    // What a screen reader reads, in order: every text node not hidden from it.
    const spoken = (el) => {
        const parts = [];
        const walk = (n) => {
            if (n.nodeType === 3) { parts.push(n.textContent); return; }
            if (n.nodeType !== 1 || n.getAttribute('aria-hidden') === 'true') return;
            if (/^(BUTTON)$/.test(n.tagName)) return;
            for (const c of n.childNodes) walk(c);
            if (/^(P|DIV|LI|H\d|SECTION|PRE)$/.test(n.tagName)) parts.push('\n');
        };
        walk(el);
        return parts.join('').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
    };

    let threw = null;
    try {
        draw(`Here:\n\n${block('title: Ordering\nside: English\nI would like a coffee.\nside: Dutch\nIk wil graag een koffie.\nnote: Graag is polite.')}\n\nDone.`);
    } catch (e) { threw = e.stack; }
    check('the renderer draws an answer with a card', threw === null, threw);
    // A group's accessible name: the words its aria-labelledby points at, else its aria-label.
    const nameOfGroup = (el) => {
        const ids = el?.getAttribute('aria-labelledby');
        if (ids) return ids.split(/\s+/).map(i => doc.getElementById(i)?.textContent ?? '').join(' ').trim();
        return el?.getAttribute('aria-label') ?? '';
    };
    const group = root.querySelector('[role="group"][data-compare]');
    check('the card is one labelled group, named by its title', !!group && nameOfGroup(group) === 'Ordering', root.innerHTML.slice(0, 600));
    const sides = group ? [...group.querySelectorAll('[data-compare-side]')] : [];
    check('…holding two sides, each a group named by its label', sides.length === 2 && sides[0].getAttribute('role') === 'group'
        && nameOfGroup(sides[0]) === 'English' && nameOfGroup(sides[1]) === 'Dutch', sides.map(s => s.outerHTML.slice(0, 200)).join(' | '));
    check('…named by the words on screen, so a reader hears each name once (no aria-label beside them)',
        !!group && !group.hasAttribute('aria-label') && sides.every(s => !s.hasAttribute('aria-label') && s.hasAttribute('aria-labelledby')));
    draw(block('a: I would like a coffee.\nb: Ik wil graag een koffie.'));
    const unnamed = [...root.querySelectorAll('[data-compare-side]')];
    check('a side with no name on screen still has one for a reader', unnamed.length === 2 && nameOfGroup(unnamed[0]) !== '' && nameOfGroup(unnamed[1]) !== ''
        && nameOfGroup(root.querySelector('[data-compare]')) !== '', unnamed.map(s => s.outerHTML.slice(0, 200)).join(' | '));
    draw(`Here:\n\n${block('title: Ordering\nside: English\nI would like a coffee.\nside: Dutch\nIk wil graag een koffie.\nnote: Graag is polite.')}\n\nDone.`);
    const said = group ? spoken(group) : '';
    check('a screen reader reads it in order: title, first name and text, second name and text, note',
        /Ordering[\s\S]*English[\s\S]*I would like a coffee\.[\s\S]*Dutch[\s\S]*Ik wil graag een koffie\.[\s\S]*Graag is polite\./.test(said), said);
    check('every side has a Copy button with a name that says which side', sides.length === 2 && sides.every((s, i) => {
        const b = s.querySelector('button[aria-label]');
        return b && /Copy/.test(b.getAttribute('aria-label')) && b.getAttribute('aria-label').includes(i ? 'Dutch' : 'English');
    }), sides.map(s => s.querySelector('button')?.outerHTML).join(' | '));
    check('no fence source and no key is drawn', !root.textContent.includes('```') && !/\bside:/.test(root.textContent) && root.textContent.includes('Done.'));
    check('a side named after a language is marked as that language, so it is read in its voice',
        sides[0]?.querySelector('[lang="en"]') && sides[1]?.querySelector('[lang="nl"]'), sides.map(s => s.innerHTML.slice(0, 200)).join(' | '));
    draw(block('side: Nederlands\nHallo\nside: Python\nprint(1)'));
    const named = [...root.querySelectorAll('[data-compare-side]')];
    check('…named in its own language too; a name that is no language gives none, and code reads left to right',
        !!named[0]?.querySelector('[lang="nl"]') && !named[1]?.querySelector('[lang]') && !!named[1]?.querySelector('[dir="ltr"]'), named.map(s => s.innerHTML.slice(0, 200)).join(' | '));

    draw(block('before: Ik heb gisteren naar huis gegaan.\nafter: Ik ben gisteren naar huis gegaan.'));
    const del = root.querySelector('del');
    const ins = root.querySelector('ins');
    check('a fix marks the removed word in <del> and the added one in <ins>', del?.textContent.includes('heb') && ins?.textContent.includes('ben'), root.innerHTML.slice(0, 800));
    check('…each mark named in words for a screen reader, not by colour alone',
        !!del?.querySelector('.sr-only') && !!ins?.querySelector('.sr-only') && del.querySelector('.sr-only').textContent.trim() !== '' && ins.querySelector('.sr-only').textContent.trim() !== '');
    check('…and those words are not read aloud by the app\'s speaker', !!del?.querySelector('[data-read-skip]') && !!ins?.querySelector('[data-read-skip]'));
    check('a side named by its role is labelled with the role\'s word', /Before/.test(root.textContent) && /After/.test(root.textContent));
    check('…and the removed word is struck through, so the mark is more than a tint', /\bline-through\b/.test(del?.getAttribute('class') || ''), del?.outerHTML);

    draw(block('correct: She goes to school.\nwrong: She go to school.'));
    const sidesRev = [...root.querySelectorAll('[data-compare-side]')];
    check('a fix written right-first marks the wrong side as removed and the right one as added',
        sidesRev[1]?.querySelector('del')?.textContent.includes('go') && sidesRev[0]?.querySelector('ins')?.textContent.includes('goes')
        && !sidesRev[0]?.querySelector('del'), root.innerHTML.slice(0, 900));
    draw(block('side: Informal\nWil je een koffie?\nside: Formal\nWilt u een koffie?'));
    check('two right versions get one highlight on both sides, never removed or added',
        root.querySelectorAll('mark').length >= 2 && !root.querySelector('del, ins'), root.innerHTML.slice(0, 900));

    // The layout he chose: one box for the two sides and the note, the title
    // above it and Add card under it; an arrow only on a made-from pair.
    draw(block('title: Ordering\nside: English\nI would like a coffee.\nside: Dutch\nIk wil graag een koffie.\nnote: Graag is polite.\ntopic: 1:2'), 'assistant', true);
    const card = root.querySelector('[data-compare]');
    const box = card?.querySelector('[data-compare-side]')?.closest('.rounded-xl');
    const titleEl = card?.querySelector('p[id$="-title"]');
    const noteEl = card?.querySelector('[data-compare-note]');
    const footEl = card?.querySelector('[data-test-foot]');
    check('the title stands above the box, not inside it', !!box && !!titleEl && !box.contains(titleEl)
        && !!(titleEl.compareDocumentPosition(box) & 4), card?.innerHTML.slice(0, 700));
    check('Add card stands under the box, not inside it', !!box && !!footEl && !box.contains(footEl)
        && !!(box.compareDocumentPosition(footEl) & 4) && !!footEl.closest('[data-read-skip]'), card?.innerHTML.slice(-500));
    check('the note sits inside the box under the sides, on its own background', !!box && !!noteEl && box.contains(noteEl)
        && /\bbg-slate-50\b/.test(noteEl.className) && /dark:bg-slate-900/.test(noteEl.className)
        && !!(box.querySelectorAll('[data-compare-side]')[1].compareDocumentPosition(noteEl) & 4), noteEl?.outerHTML);
    const arrowOf = (src) => { draw(block(src)); return root.querySelector('[data-compare-seam] svg'); };
    check('two languages named side by side get a plain line, no arrow', !arrowOf('side: English\nHello\nside: Dutch\nHallo')
        && root.querySelector('[data-compare-seam]')?.getAttribute('data-compare-seam') === '');
    check('…nor do two registers, or the same thing in two programming languages',
        !arrowOf('side: Informal\nWil je een koffie?\nside: Formal\nWilt u een koffie?')
        && !arrowOf(`side: Python\n${F}python\nprint(1)\n${F}\nside: JavaScript\n${F}js\nconsole.log(1)\n${F}`));
    const down = arrowOf('before: Ik heb gegaan.\nafter: Ik ben gegaan.');
    check('a fix gets an arrow from the old side to the new one, hidden from a reader', !!down && /(^|\s)rotate-90\b/.test(down.getAttribute('class') || '')
        && down.closest('[aria-hidden="true"]') !== null, down?.outerHTML);
    const up = arrowOf('correct: She goes.\nwrong: She go.');
    check('…pointing back at the first side when the fix was written first', !!up && /(^|\s)-rotate-90\b/.test(up.getAttribute('class') || ''), up?.outerHTML);
    const tr = arrowOf('original: English\nGood morning\ntranslation: Dutch\nGoedemorgen');
    check('a translation the model marks gets the arrow and still shows the language names', !!tr && /English/.test(root.textContent) && /Dutch/.test(root.textContent)
        && !/Original|Translation/.test(root.textContent), root.textContent.slice(0, 200));

    draw(block(`side: Python\n${F}python\nprint("hi")\n${F}\nside: JavaScript\n${F}js\nconsole.log("hi")\n${F}`));
    check('code sides are drawn as code, with no second card of their own inside', root.querySelectorAll('[data-compare] code, [data-compare] pre, [data-compare] [class*="language-"]').length > 0
        && root.querySelectorAll('[data-compare] .rounded-lg.my-4').length === 0, root.innerHTML.slice(0, 900));

    threw = null;
    for (const j of ['side: only one', 'side: a\n```python\nunclosed', 'side: a\na\nside: b\nb\nside: c\nc', '', 'topic: x']) {
        try { draw(block(j)); } catch (e) { threw = `${JSON.stringify(j)}: ${e.message}`; break; }
        if (root.textContent.includes('```compare') || /\bside:/.test(root.textContent) || root.querySelector('[data-compare], pre')) { threw = `${JSON.stringify(j)} drew a card or its source`; break; }
    }
    check('a block that is not a card renders as prose, never throws, never shows its fence', threw === null, threw);

    draw(block('side: English\nHello\nside: Dutch\nHallo'), 'lesson');
    check('outside the assistant the card is not drawn (lessons are a separate decision)', !root.querySelector('[data-compare]'));
    rmSync(mdScratch, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section('Add card, mounted: what is asked, and when Add is offered');
{
    // The real CompareCardAdd and its shared foot, with the api answered here.
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    class Observer { observe() { } unobserve() { } disconnect() { } }
    globalThis.ResizeObserver = globalThis.window.ResizeObserver = Observer;
    globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
    globalThis.cancelAnimationFrame = (h) => clearTimeout(h);
    const consoleError = console.error;
    console.error = (...a) => { if (!/not wrapped in act/.test(String(a[0]))) consoleError(...a); };
    const stubs = {
        'react-i18next': `export const useTranslation = () => ({ t: (k, o) => k.replace(/\\{\\{(\\w+)\\}\\}/g, (_, n) => String(o?.[n] ?? '')), i18n: { language: 'en' } });
            export const initReactI18next = { type: '3rdParty', init() { } };`,
        'i18n': `export default { t: (k) => k, language: 'en' }; export const k = (s) => s; export const currentLocale = () => 'en';`,
        'store': `const st = { addToast() { }, theme: 'light', projects: [], a11y: {} };
            export const useStore = (sel) => sel(st); useStore.getState = () => st; useStore.setState = () => { }; useStore.subscribe = () => () => { };
            export const themeKeyOf = () => 'light'; export const isDarkTheme = () => false;`,
        'Markdown': `import { createElement } from 'react'; export default function Markdown({ content }) { return createElement('div', null, content); }`,
        'api': `export const api = new Proxy({}, { get: (_, name) => (...args) => (globalThis.__api?.[name] ?? (() => new Promise(() => { })))(...args) });
            let seq = 0; export const newAttemptId = () => 'attempt-' + (++seq);`,
    };
    const addOut = join(mkdtempSync(join(repoRoot, 'node_modules', '.cache', 'compare-card-add-')), 'add.cjs');
    let CompareCardAdd = null, bundleError = null;
    try {
        await esbuild.build({
            stdin: { contents: "export { CompareCardAdd } from './src/components/AssistantProposals';", resolveDir: repoRoot, loader: 'tsx' },
            bundle: true, format: 'cjs', platform: 'node', outfile: addOut, jsx: 'automatic', logLevel: 'silent',
            loader: { '.css': 'empty', '.svg': 'dataurl' }, packages: 'external',
            define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
            plugins: [{
                name: 'stubs',
                setup(b) {
                    b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: 'react-i18next', namespace: 'stub' }));
                    b.onResolve({ filter: /^(\.\.\/)+(store|i18n|api)$/ }, (a) => ({ path: a.path.replace(/^(\.\.\/)+/, ''), namespace: 'stub' }));
                    b.onResolve({ filter: /^\.\.?\/(\.\.\/)*Markdown$/ }, () => ({ path: 'Markdown', namespace: 'stub' }));
                    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: stubs[a.path], loader: 'js', resolveDir: repoRoot }));
                },
            }],
        });
        ({ CompareCardAdd } = require(addOut));
    } catch (e) { bundleError = String(e.message).split('\n').slice(0, 3).join(' | '); }
    check('CompareCardAdd bundles for a mounted test', typeof CompareCardAdd === 'function', bundleError);

    if (typeof CompareCardAdd === 'function') {
        const React = require('react');
        const { createRoot } = require('react-dom/client');
        const act = (fn) => React.act(fn);
        const settle = () => act(() => new Promise(r => setTimeout(r, 20)));
        const doc = globalThis.document;
        const labels = { 17: { id: 17, projectId: 4, title: 'Ordering', projectName: 'Dutch A1', projectStatus: 'active', kind: 'topic' } };
        let turn = 0;
        const mount = async (card, lbls = labels) => {
            const host = doc.createElement('div');
            doc.body.appendChild(host);
            const r = createRoot(host);
            await act(() => r.render(React.createElement(CompareCardAdd, { card, labels: lbls, turnKey: `t${++turn}` })));
            return { host, done: async () => { await act(() => r.unmount()); host.remove(); } };
        };
        const addButton = (host) => [...host.querySelectorAll('button')].find(b => b.textContent.includes('Add card')) ?? null;
        const ok = { verdict: 'ok', reason: null };
        const sent = [];
        let answer = null;
        globalThis.__api = {
            getFlashcards: async () => [],
            checkAssistantProposals: (body) => { sent.push(body); return new Promise(res => { answer = res; }); },
        };

        const tr = compareCard(parseCompare('side: English\nI would like a coffee.\nside: Dutch\nIk wil graag een koffie.\ntopic: 4:17'));
        let m = await mount(tr);
        const body = sent.at(-1);
        check('a translation asks both ways in ONE request', sent.length === 1 && body?.cards?.length === 2
            && body.cards[0].front === tr.front && body.cards[1].front === tr.reverse.front && body.cards[1].back === tr.reverse.back, JSON.stringify(body));
        check('…and Add is there but cannot be pressed while it is checked', !!addButton(m.host) && addButton(m.host).disabled === true, m.host.innerHTML.slice(0, 400));
        await act(async () => { answer({ cards: [ok, ok] }); });
        await settle();
        check('both ways agree: Add can be pressed', !!addButton(m.host) && addButton(m.host).disabled === false, m.host.innerHTML.slice(0, 400));
        await m.done();

        m = await mount(tr);
        await act(async () => { answer({ cards: [ok, { verdict: 'disputed', reason: 'a second AI answered “x”' }] }); });
        await settle();
        check('the way back disagrees: no Add, and the line says why', !addButton(m.host) && /other way round/.test(m.host.textContent), m.host.textContent);
        await m.done();

        m = await mount(tr);
        await act(async () => { answer({ cards: [ok, { verdict: 'unchecked', reason: 'no usable answer' }] }); });
        await settle();
        check('a translation that could not be checked: no Add', !addButton(m.host) && /could not be checked/.test(m.host.textContent), m.host.textContent);
        await m.done();

        const fix = compareCard(parseCompare('before: Ik heb gegaan.\nafter: Ik ben gegaan.\ntopic: 4:17'));
        m = await mount(fix);
        check('a fix asks one way only', sent.at(-1)?.cards?.length === 1 && sent.at(-1).cards[0].front === fix.front, JSON.stringify(sent.at(-1)));
        await m.done();

        const before = sent.length;
        m = await mount(tr, { 17: { ...labels[17], projectId: 5 } });
        check('a topic that belongs to another course draws nothing and asks nothing', m.host.innerHTML === '' && sent.length === before, m.host.innerHTML.slice(0, 300));
        await m.done();
        delete globalThis.__api;
    }
    console.error = consoleError;
}

{
    const drawer = readFileSync(join(repoRoot, 'src/components/AssistantDrawer.tsx'), 'utf8');
    check('the drawer looks up a card\'s topic only once its message has settled (`4:1` may still become `4:17`)',
        /m\.id === streamingId \? \[\] : compareTopicIds\(m\.content\)/.test(drawer) && /\[open, messages, streamingId\]\)/.test(drawer));
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
/**
 * What a real screen reader says: NVDA, driven through Guidepup, over the
 * screens where a learner answers.
 *
 *   node tools/screen-reader-run.mjs [--out DIR] [--only NAME] [--browser PATH]
 *
 * The invented course from tools/docs-fixture.mjs is built in a scratch
 * library and served from `dist/` (run `npm run build` first). NVDA then works
 * through four tasks the way a blind learner would, with its own keys only
 * (Tab, Space, the arrows, browse-mode reading), never a click:
 *
 *   flashcard-review   the review session: read the card, reveal the answer, grade it
 *   quiz               a lesson's question: choose an option, hear the verdict
 *   maths-card         a card written in maths (KaTeX renders MathML): read it, flip it
 *   keyboard-reorder   the course outline: pick up a topic, move it down, drop it
 *
 * Everything NVDA spoke at each step is written to DIR/transcript.md and
 * DIR/transcript.json, with a screenshot per task. The expectations below are
 * printed as `ok` or `MISS` and listed at the end; the run fails only when it
 * could not do the tasks (NVDA did not start, the browser never got focus, a
 * screen did not load), because what NVDA says is the result, not a gate.
 *
 * WHY NOT IN `npm test`. A screen reader reads the window that has focus and
 * speaks through the sound card: the browser has to be on screen and in front,
 * and NVDA takes the keyboard while it runs. That is fine on a CI runner and
 * wrong on a desktop someone is using, so this runs in
 * .github/workflows/screen-reader.yml on a Windows runner, by hand or when
 * this file or the workflow changes. It needs NVDA set up by
 * `npx @guidepup/setup` and `@guidepup/guidepup`, which the workflow installs;
 * neither is a dependency of the app.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const OUT = resolve(value('--out') ?? join(ROOT, 'temp', 'screen-reader'));
const only = value('--only');

if (process.platform !== 'win32') {
    console.log(`NVDA runs on Windows only; this is ${process.platform}`);
    process.exit(1);
}
let guidepup;
try {
    guidepup = await import('@guidepup/guidepup');
} catch {
    console.log('needs @guidepup/guidepup and NVDA: see .github/workflows/screen-reader.yml');
    process.exit(1);
}
const { nvda, WindowsKeyCodes, WindowsModifiers, NVDAKeyCodeCommands } = guidepup;

delete process.env.__COMPAT_LAYER;
const { visit, findBrowser, removeScratch, byText, openOnScreen } = await import(pathToFileURL(join(ROOT, 'tools', 'docs-shots.mjs')).href);
const { prepare: fixture } = await import(pathToFileURL(join(ROOT, 'tools', 'docs-fixture.mjs')).href);
openOnScreen();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

// The first card of the cards topic, written in maths.
const MATHS = {
    front: 'Which is larger: $10^{-2}$ or $\\frac{1}{1000}$?',
    back: '$10^{-2}$, because $10^{-2} = \\frac{1}{100}$ and $\\frac{1}{100} > \\frac{1}{1000}$',
};
async function prepare(ctx) {
    const ids = await fixture(ctx);
    const Database = require('better-sqlite3');
    const db = new Database(ctx.dbPath);
    try {
        db.pragma('busy_timeout = 5000');
        const first = db.prepare('SELECT id FROM flashcards WHERE node_id = ? ORDER BY created_at, id LIMIT 1').get(ids.cards);
        db.prepare('UPDATE flashcards SET front = ?, back = ? WHERE id = ?').run(MATHS.front, MATHS.back, first.id);
    } finally {
        db.close();
    }
    return ids;
}

// ---------------------------------------------------------------------------
// NVDA.
// ---------------------------------------------------------------------------

const transcript = {};
const misses = [];
let current;

const spoken = async () => (await nvda.spokenPhraseLog()).map((s) => s.trim()).filter(Boolean);

/** One step: what NVDA said from the moment `act` started until it went quiet. */
async function step(label, act) {
    await nvda.clearSpokenPhraseLog();
    await act();
    await sleep(1200);
    const said = await spoken();
    current.steps.push({ label, said });
    console.log(`  ${label}\n${said.length ? said.map((s) => `      "${s}"`).join('\n') : '      (nothing)'}`);
    return said.join(' | ');
}

function expect(label, ok) {
    current.expect.push({ label, ok });
    console.log(`  ${ok ? 'ok  ' : 'MISS'}  ${label}`);
    if (!ok) misses.push(`${current.name}: ${label}`);
}

/** NVDA reads the browser, not the console or the taskbar: switch windows until it names the page. */
async function focusBrowser(page) {
    await page.send('Page.bringToFront');
    const title = await page.evaluate('document.title');
    for (let i = 0; i < 10; i++) {
        await nvda.perform(NVDAKeyCodeCommands.reportTitle);
        const heard = await nvda.lastSpokenPhrase();
        if ((title && heard.includes(title)) || /Edge|Chrome/.test(heard)) return;
        await nvda.perform({ keyCode: [WindowsKeyCodes.Escape], modifiers: [WindowsModifiers.Alt] }, { capture: false });
        await sleep(500);
    }
    throw new Error(`NVDA never reached the browser window ("${title}")`);
}

/**
 * Tab, as a learner would, until `expr` has focus; each stop NVDA named is kept.
 * When the page already put focus there, NVDA's browse cursor may still be
 * elsewhere (Space acts on the cursor, not the focus): Tab away and back so
 * NVDA follows the focus onto it.
 */
async function tabTo(page, expr, what, max = 80) {
    const stops = [];
    const focused = () => page.evaluate(`(() => { const e = ${expr}; return !!e && (document.activeElement === e || e.contains(document.activeElement)); })()`);
    if (await focused()) {
        await nvda.clearSpokenPhraseLog();
        await nvda.press('Tab');
        await sleep(250);
        await nvda.press('Shift+Tab');
        await sleep(250);
        stops.push((await spoken()).join(' '));
        if (await focused()) {
            current.steps.push({ label: `Tab and Shift+Tab, back to ${what} (it had focus already)`, said: stops });
            console.log(`  ${what} had focus already`);
            return 0;
        }
    }
    for (let i = 0; i < max; i++) {
        if (await focused()) {
            current.steps.push({ label: `Tab to ${what} (${i} presses)`, said: stops });
            console.log(`  Tab to ${what}: ${i} presses`);
            return i;
        }
        await nvda.clearSpokenPhraseLog();
        await nvda.press('Tab');
        await sleep(250);
        stops.push((await spoken()).join(' '));
    }
    current.steps.push({ label: `Tab to ${what}: not reached in ${max} presses`, said: stops });
    throw new Error(`Tab never reached ${what} in ${max} presses`);
}

/** Browse mode from the top of the page, `n` items: what a learner hears first. */
async function readFromTop(n) {
    return step(`browse mode, the first ${n} items from the top`, async () => {
        await nvda.perform({ keyCode: [WindowsKeyCodes.Home], modifiers: [WindowsModifiers.Control] });
        for (let i = 0; i < n; i++) await nvda.next();
    });
}

const textOf = (page, expr) => page.evaluate(`(() => { const e = ${expr}; return e ? e.innerText.replace(/\\s+/g, ' ').trim() : ''; })()`);
const words = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3);
/** Most of the words of `text` were spoken. */
const heard = (said, text) => {
    const w = words(text);
    const s = said.toLowerCase();
    return w.length > 0 && w.filter((x) => s.includes(x)).length >= Math.ceil(w.length * 0.6);
};

const REVEAL = byText('button', '/^Reveal answer/');
const RATING_GOOD = byText('button[data-rating]', '/Good/');

const TASKS = {
    'flashcard-review': {
        open: async (page, { ids }) => {
            const study = byText('button', '/^Study [\\d.,\\s]+ cards?$/');
            await page.go(`/project/${ids.project}/dashboard`, null);
            await page.waitFor(study, 'the cards owed');
            await page.press(study, 'Study the cards owed');
            await page.waitFor(`document.querySelector('[data-review-card]')`, 'the review session');
            await sleep(800);
        },
        run: async (page) => {
            const card = await textOf(page, `document.querySelector('[data-review-card]')`);
            const first = await readFromTop(10);
            expect('browse mode reaches the card text within the first 10 items', heard(first, card.slice(0, 80)));
            await tabTo(page, REVEAL, 'Reveal answer');
            const flip = await step('Space on Reveal answer', () => nvda.press('Space'));
            // The answer is whatever the card shows now that it did not before.
            const before = new Set(words(card));
            const added = words(await textOf(page, `document.querySelector('[data-review-card]')`)).filter((w) => !before.has(w));
            expect('the answer is read out after the flip', heard(flip, added.join(' ')));
            await tabTo(page, RATING_GOOD, 'the Good rating');
            const graded = await step('Space on Good', () => nvda.press('Space'));
            expect('grading says something (next card or the session end)', graded.length > 0);
        },
    },
    quiz: {
        open: async (page, { ids }) => {
            await page.go(`/project/${ids.project}/study/${ids.study}`, null);
            await page.waitFor(`document.querySelector('[data-answer-option]')`, "the lesson's question");
            await sleep(1500);
        },
        run: async (page) => {
            const option = `document.querySelectorAll('[data-answer-option]')[0]`;
            const optionText = await textOf(page, option);
            const at = await step('focus the first option', async () => { await tabTo(page, option, 'the first option', 120); await nvda.perform(NVDAKeyCodeCommands.reportCurrentFocus); });
            expect('the option is named with its text', heard(at, optionText));
            const chose = await step('Space on the option', () => nvda.press('Space'));
            const check = byText('main button', '/^(Check|Submit)/');
            let verdict = chose;
            if (await page.evaluate(`!!(${check})`)) {
                await tabTo(page, check, 'the Check button');
                verdict = await step('Space on Check', () => nvda.press('Space'));
            }
            expect('a verdict is spoken (right or wrong)', /correct|right|wrong|not quite|incorrect|well done/i.test(verdict));
        },
    },
    'maths-card': {
        open: async (page, { ids }) => {
            await page.go(`/project/${ids.project}/tree/${ids.cards}`, 'Details');
            await page.waitFor(`document.querySelector('[data-tab="flashcards"]')`, 'the Flashcards tab');
            await page.press(`document.querySelector('[data-tab="flashcards"]')`, 'the Flashcards tab');
            const review = byText('button', '/^Review these cards/');
            await page.waitFor(review, 'Review these cards');
            await page.press(review, 'Review these cards');
            // The topic's cards in the order they were written: the maths card first,
            // on a plate that flips when pressed.
            await page.waitFor(`document.querySelector('[role="button"][aria-pressed] .katex')`, 'the maths card in review');
            await sleep(800);
        },
        run: async (page) => {
            const plate = `document.querySelector('[role="button"][aria-pressed]')`;
            const at = await step('focus the card', async () => { await tabTo(page, plate, 'the card', 120); await nvda.perform(NVDAKeyCodeCommands.reportCurrentFocus); });
            const read = await step('browse mode, the next 6 items from the card', async () => {
                for (let i = 0; i < 6; i++) await nvda.next();
            });
            const all = `${at} | ${read}`;
            expect('the powers are read as maths (e.g. "10 to the" or "superscript")', /to the|superscript|power|negative 2|minus 2/i.test(all));
            expect('the fraction is read as a fraction', /over|fraction|1 1000|one thousandth/i.test(all));
            await tabTo(page, plate, 'the card');
            const flip = await step('Space on the card', () => nvda.press('Space'));
            expect('the answer is read out, maths included', /to the|superscript|over|fraction/i.test(flip));
        },
    },
    'keyboard-reorder': {
        open: async (page, { ids }) => {
            await page.go(`/project/${ids.project}/tree`, null);
            await page.waitFor(`document.querySelector('main [aria-roledescription="sortable"]')`, 'a sortable row');
            await sleep(800);
        },
        run: async (page) => {
            const handle = `document.querySelector('main [aria-roledescription="sortable"]')`;
            const at = await step('focus the first sortable item', async () => { await tabTo(page, handle, 'the first sortable item', 120); await nvda.perform(NVDAKeyCodeCommands.reportCurrentFocus); });
            expect('the item says how to move it', /press space or enter|arrow keys/i.test(at));
            // NVDA beeps rather than speaks the switch, so nothing is heard here.
            await step('NVDA+Space: focus mode, so keys reach the page', () => nvda.perform(NVDAKeyCodeCommands.toggleBetweenBrowseAndFocusMode));
            const up = await step('Space: pick up', () => nvda.press('Space'));
            expect('picking up is announced', /picked up/i.test(up));
            const moved = await step('Down arrow', () => nvda.press('Down'));
            expect('the new place is announced', /is over|position|not over/i.test(moved));
            const dropped = await step('Space: drop', () => nvda.press('Space'));
            expect('the drop is announced', /dropped|moved/i.test(dropped));
        },
    },
};

const wanted = Object.keys(TASKS).filter((n) => !only || n.includes(only));
// A task whose screen does not open is that task's failure: the others still run.
const unopened = {};
const states = Object.fromEntries(wanted.map((n) => [n, async (page, ctx) => {
    try { await TASKS[n].open(page, ctx); } catch (err) { unopened[n] = err.message.split('\n')[0]; }
}]));
const failed = [];
const scratch = mkdtempSync(join(tmpdir(), 'screen-reader-'));
const t0 = Date.now();
await nvda.start({ capture: 'initial' });
try {
    await visit('fixture', scratch, [{ states: wanted }], { width: 1280, height: 800, scale: 1 }, findBrowser(value('--browser')), async (_entry, name, page) => {
        current = transcript[name] = { name, steps: [], expect: [] };
        console.log(`\n${name}`);
        try {
            if (unopened[name]) throw new Error(`the screen did not open: ${unopened[name]}`);
            await focusBrowser(page);
            await TASKS[name].run(page);
        } catch (err) {
            current.error = err.message;
            failed.push(`${name}: ${err.message}`);
            console.log(`  FAIL  ${err.message}`);
        }
        writeFileSync(join(OUT, `${name}.png`), await page.png());
    }, prepare, states);
} finally {
    try { await nvda.stop(); } catch { /* already gone */ }
    removeScratch(scratch);
    // Written even when the run stopped part way: what was heard until then is the evidence.
    const md = [
        `# What NVDA said`, '',
        `NVDA ${nvda.version ?? ''} through Guidepup, ${new Date().toISOString().slice(0, 10)}, ${((Date.now() - t0) / 1000).toFixed(0)} s.`,
        'Each step lists every phrase NVDA spoke, in order. Tab steps list one line per key press.', '',
    ];
    for (const t of Object.values(transcript)) {
        md.push(`## ${t.name}`, '');
        for (const s of t.steps) md.push(`- **${s.label}**`, ...(s.said.length ? s.said.map((x) => `  - "${x}"`) : ['  - (nothing)']));
        md.push('', ...t.expect.map((e) => `- ${e.ok ? 'ok' : 'MISS'}: ${e.label}`));
        if (t.error) md.push(`- could not finish: ${t.error}`);
        md.push('');
    }
    writeFileSync(join(OUT, 'transcript.md'), `${md.join('\n')}\n`);
    writeFileSync(join(OUT, 'transcript.json'), `${JSON.stringify(transcript, null, 2)}\n`);
}

console.log(`\n${misses.length} expectation(s) missed${misses.length ? `:\n  ${misses.join('\n  ')}` : ''}`);
console.log(`${failed.length} task(s) could not finish${failed.length ? `:\n  ${failed.join('\n  ')}` : ''}`);
console.log(`transcript: ${join(OUT, 'transcript.md')}`);
process.exit(failed.length || Object.keys(transcript).length !== wanted.length ? 1 : 0);

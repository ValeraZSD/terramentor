// tools/assistant-gates.mjs — the assistant's structured outputs.
//
// Run:  node tools/assistant-gates.mjs
//
// The global assistant may now do three things beyond talking: point at a topic
// (`[[open:…]]`, already covered by the tutor-action rules it shares), offer to
// open one of the app's own screens (`[[go:SCREEN]]`), and CHANGE A SETTING
// (`[[set:key:value]]`). The last is the one that needs a gate hardest, because
// it is the only place in this app where a model's reading of a sentence causes
// a write — but all three share one contract, and the two pointing markers are
// here because a marker that leaks into the text is the same bug whichever it is.
//
// The safety story is entirely in the validator, and it has exactly two jobs:
//   - a key or value that is not on the whitelist must produce NOTHING. Not an
//     error, not a default, not a clamped approximation — the same contract an
//     invented node id has, where the button simply does not appear. A model
//     that decides to "turn off the mastery gate" must be inert, not obeyed.
//   - a marker must never survive into the text. It is an instruction to this
//     app; leaked into the message it is scaffolding the learner has to read
//     past, and leaked into a Copy it is nonsense in someone else's document.
//
// No DOM, no store, no model: the validator is pure, which is what makes the
// whole feature assertable.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const scratch = mkdtempSync(join(tmpdir(), 'assistant-gates-'));
const out = join(scratch, 'assistantSettings.mjs');

await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/utils/assistantSettings.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    logLevel: 'silent',
    // The module imports the store only for its constants; the store pulls in
    // the whole app. Stub it with the same values index.css and store.ts hold.
    plugins: [{
        name: 'stub-store',
        setup(build) {
            build.onResolve({ filter: /\/store$/ }, () => ({ path: 'store-stub', namespace: 'stub' }));
            build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
                contents: `
                    export const THEME_IDS = ['light', 'warm', 'dark', 'black'];
                    export const MIN_UI_SCALE = 80;
                    export const MAX_UI_SCALE = 160;
                `,
                loader: 'js',
            }));
        },
    }],
});

const { validateSettingChange, splitSettingChanges } = await import(pathToFileURL(out).href);

// The third marker (`[[go:SCREEN]]`) lives in tutorActions.ts, bundled the same
// way: same contract as the other two, and it breaks the same way.
const outActions = join(scratch, 'tutorActions.mjs');
await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/utils/tutorActions.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'node', outfile: outActions, logLevel: 'silent',
});
const { splitDestinations, splitOpenTargets } = await import(pathToFileURL(outActions).href);

// What Copy puts on the clipboard. The lookups a turn ran are shown as rows in
// the conversation (server/aiTools.js) - but a paste has no "inline", and a web
// search is the one thing in this app that sends anything off the machine, so it
// has to travel with the text.
const outCopy = join(scratch, 'answerText.mjs');
await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/utils/answerText.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'node', outfile: outCopy, logLevel: 'silent',
    plugins: [{
        name: 'stub-store',
        setup(build) {
            build.onResolve({ filter: /\/store$/ }, () => ({ path: 'store-stub', namespace: 'stub' }));
            build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
                contents: 'export const THEME_IDS = ["light","warm","dark","black"];'
                    + 'export const MIN_UI_SCALE = 80; export const MAX_UI_SCALE = 160;',
                loader: 'js',
            }));
        },
    }],
});
const { readableAnswer } = await import(pathToFileURL(outCopy).href);
const copied = (text, actions) => readableAnswer(text, false, actions);

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);

section('the whitelist accepts what it should');
for (const t of ['light', 'warm', 'dark', 'black']) {
    const c = validateSettingChange('theme', t);
    check(`theme=${t}`, c?.key === 'theme' && c.value === t, JSON.stringify(c));
}
check('theme is case-insensitive', validateSettingChange('theme', 'Dark')?.value === 'dark');
check('a named accent resolves to its hex', validateSettingChange('accent_color', 'emerald')?.value === '#047857');
check('a hex accent is accepted and normalised', validateSettingChange('accent', '#0e7490')?.value === '#0E7490');
check('ui_scale accepts a plain number', validateSettingChange('ui_scale', '140')?.value === 140);
check('ui_scale accepts a percent sign', validateSettingChange('ui_scale', '120%')?.value === 120);
check('the key separator is normalised', validateSettingChange('week start day', 'monday')?.value === 1);
check('week_start_day accepts sunday', validateSettingChange('week_start_day', 'sunday')?.value === 0);
check('every accepted change carries a human label',
    ['theme:dark', 'accent:red', 'ui_scale:100', 'week_start_day:monday']
        .every(s => (validateSettingChange(...s.split(':'))?.label || '').length > 4));

section('anything off the whitelist produces NOTHING');
// These are the ones that decide what the engine MEASURES or teaches. A model
// must not be able to reach them, and "reject" here means null, not a clamp.
for (const key of [
    'mastery_gate_mode', 'mastery_threshold', 'fsrs_params', 'bkt_params',
    'deck_new_per_day', 'ai_provider', 'ai_model', 'ai_openai_api_key',
    'auth_password', 'pdf_math_recovery', 'visual_tier', 'user_profile',
]) {
    check(`${key} is refused`, validateSettingChange(key, 'anything') === null);
}
check('an unknown theme is refused, not defaulted', validateSettingChange('theme', 'solarized') === null);
check('a colour word that is not a preset is refused', validateSettingChange('accent_color', 'burgundy') === null);
check('a malformed hex is refused', validateSettingChange('accent_color', '#12345') === null);
check('ui_scale below the floor is refused, NOT clamped', validateSettingChange('ui_scale', '10') === null);
check('ui_scale above the ceiling is refused, NOT clamped', validateSettingChange('ui_scale', '400') === null);
check('a non-numeric ui_scale is refused', validateSettingChange('ui_scale', 'huge') === null);
check('an empty value is refused', validateSettingChange('theme', '   ') === null);

section('markers never survive into the text');
const one = splitSettingChanges('Switched you over.\n\n[[set:theme:light]]');
check('the marker is stripped', !one.body.includes('[['), JSON.stringify(one.body));
check('the prose survives', one.body === 'Switched you over.');
check('the change is returned', one.changes.length === 1 && one.changes[0].value === 'light');

const bad = splitSettingChanges('Done.\n\n[[set:mastery_gate_mode:off]]');
check('a refused marker is still stripped from the text', !bad.body.includes('[['), bad.body);
check('...and yields no change at all', bad.changes.length === 0);

const partial = splitSettingChanges('Switching now [[set:the', true);
check('a half-streamed marker does not flash on screen', !partial.body.includes('[['), partial.body);

const many = splitSettingChanges(
    '[[set:theme:dark]][[set:accent_color:rose]][[set:ui_scale:120]][[set:week_start_day:monday]]');
check('at most three changes per message', many.changes.length === 3, String(many.changes.length));

const dupes = splitSettingChanges('[[set:theme:dark]][[set:theme:light]]');
check('one change per key — the first wins', dupes.changes.length === 1 && dupes.changes[0].value === 'dark');

const spaced = splitSettingChanges('[[ set : theme : warm ]]');
check('inner spacing is tolerated', spaced.changes[0]?.value === 'warm', JSON.stringify(spaced.changes));

const none = splitSettingChanges('Just an ordinary answer with no markers in it.');
check('a message with no marker is returned unchanged',
    none.body === 'Just an ordinary answer with no markers in it.' && none.changes.length === 0);

const brackets = splitSettingChanges('Use the [[ notation ]] like this.');
check('unrelated double brackets are left alone', brackets.body.includes('[[ notation ]]'));

section('the two settings added when the assistant got more reach');
check('a language code is accepted',
    validateSettingChange('ui_language', 'nl')?.value === 'nl');
check('a language named in its own script is accepted',
    validateSettingChange('ui_language', 'Русский')?.value === 'ru');
check('auto is a real value, not a missing one',
    validateSettingChange('ui_language', 'auto')?.value === 'auto');
check('a language the app does not have is refused',
    validateSettingChange('ui_language', 'sv') === null);
check('a number style is accepted by its own example',
    validateSettingChange('number_format', '1.234,5')?.value === '1.234,5');
check('a style whose space arrived as an ordinary one still matches',
    validateSettingChange('number_format', '1 234,5')?.value?.includes('234,5') === true);
check('a made-up number style is refused',
    validateSettingChange('number_format', '1;234;5') === null);
check('the web-search setting is NOT reachable from a marker',
    validateSettingChange('ai_web_search', 'auto') === null
    && validateSettingChange('web_search', 'off') === null);
check('nor is anything that changes what is measured',
    validateSettingChange('mastery_gate_mode', 'off') === null
    && validateSettingChange('new_cards_per_day', '200') === null);

section('a screen the assistant offered to open');
const go = splitDestinations('Everything due is on the calendar.\n\n[[go:calendar]]');
check('a known screen becomes one destination', go.destinations.length === 1 && go.destinations[0].key === 'calendar');
check('the route is the app own, not the model idea of one', go.destinations[0].path === '/calendar');
check('the marker never survives into the text', !go.body.includes('[[go'));
check('the prose survives', go.body.trim() === 'Everything due is on the calendar.');
check('a screen that does not exist yields nothing at all',
    splitDestinations('[[go:dashboard]]').destinations.length === 0);
check('...and is still stripped from the text',
    !splitDestinations('Go here. [[go:dashboard]]').body.includes('[[go'));
check('a half-streamed marker does not flash on screen',
    !splitDestinations('Look at [[go:cal', true).body.includes('[['));
check('at most two screens per message',
    splitDestinations('[[go:today]][[go:projects]][[go:atlas]]').destinations.length === 2);
check('the same screen twice is one button',
    splitDestinations('[[go:atlas]][[go:atlas]]').destinations.length === 1);
check('a message with no marker survives whole',
    splitDestinations('Nothing to press here.').body === 'Nothing to press here.');

section('a malformed pointer is nothing, never text on the screen');
const good = splitOpenTargets('Start here. [[open:3:41]]');
check('a well-formed marker becomes a target', good.targets.length === 1 && good.targets[0].nodeId === 41);
check('...and leaves the prose alone', good.body.trim() === 'Start here.');
// Measured: a 9B asked to point at a PROJECT wrote a node id of "NONE",
// which the old digits-only pattern did not match and therefore did not strip.
for (const bad of ['[[open:2:NONE]]', '[[open:NONE:2]]', '[[open:2:]]', '[[open::]]', '[[open:2:abc]]', '[[open:0:0]]']) {
    const out = splitOpenTargets(`Yes, you have it. ${bad}`);
    check(`${bad} produces no button`, out.targets.length === 0);
    check(`${bad} is stripped from the text`, !out.body.includes('[[') && out.body.trim() === 'Yes, you have it.', JSON.stringify(out.body));
}
check('an unrelated marker is left for its own owner',
    splitOpenTargets('A claim. [[src:1]]').body.includes('[[src:1]]'));

section('a paste carries what left the machine, and nothing else');
const LOOKUPS = [
    { tool: 'search_web', arg: 'dutch priority road signs 2026', count: 4, state: 'done' },
    { tool: 'find_in_library', arg: 'traffic', count: 3, state: 'done' },
];
check('the web query travels with the text',
    copied('An answer.', LOOKUPS).includes('Searched the web: “dutch priority road signs 2026”'));
check('a search of the learner own library is never named',
    !copied('An answer.', LOOKUPS).includes('traffic'));
check('an answer that looked nothing up is pasted unchanged',
    copied('An answer.', []) === 'An answer.' && copied('An answer.', null) === 'An answer.');
check('pasting the same answer twice does not stack the line',
    copied(copied('An answer.', LOOKUPS), LOOKUPS) === copied('An answer.', LOOKUPS));
check('every app-only marker is still stripped from a paste',
    copied('Do this. [[go:calendar]][[set:theme:dark]][[open:1:2]][[src:1]]', LOOKUPS).startsWith('Do this.')
    && !copied('Do this. [[go:calendar]]', LOOKUPS).includes('[['));

section('a change is applied once per TURN, and its Undo outlives the chip');
// 2026-09-23: "dark mode, OLED tint" drew two identical chip rows, and neither
// Undo put the page back. Two causes, both gated here. The drawer rendered the
// row twice, and the second copy captured "before" AFTER the first had already
// switched the theme. And the chip's apply-once guard and its before-values
// lived in the component, which remounts when a history reload swaps the
// turn's provisional id for its database id — so the remount took the new
// values as "before" and its Undo restored what was already on screen (and an
// Undo pressed earlier was RE-APPLIED by the remount).
const { readFileSync } = await import('node:fs');
const drawerSrc = readFileSync(new URL('../src/components/AssistantDrawer.tsx', import.meta.url), 'utf8');
check('the drawer draws one chip row per message',
    (drawerSrc.match(/<SettingChangeChips\b/g) || []).length === 1, String((drawerSrc.match(/<SettingChangeChips\b/g) || []).length));
check('its key is the turn, the same under the provisional id and the stored one',
    /messageKey=\{[^}]*dbIdRef\.current\.get\(m\.id\)/.test(drawerSrc));
const chipsSrc = readFileSync(new URL('../src/components/SettingChangeChips.tsx', import.meta.url), 'utf8');
check('the chip keeps nothing of the turn in a ref or its own state',
    !/useRef/.test(chipsSrc) && /beginRun\(/.test(chipsSrc) && /markRunUndone\(/.test(chipsSrc));
const outRuns = join(scratch, 'settingRuns.mjs');
await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/utils/settingRuns.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'node', outfile: outRuns, logLevel: 'silent',
});
const { beginRun, runOf, markRunUndone } = await import(pathToFileURL(outRuns).href);
check('the first mount of a turn claims it', beginRun('41', { theme: 'light' }) === true);
check('a remount of the same turn does not apply it again', beginRun('41', { theme: 'dark' }) === false);
check('...and still restores what came BEFORE the first mount', runOf('41')?.before.theme === 'light');
markRunUndone('41');
check('an Undo is remembered across the remount', runOf('41')?.undone === true && beginRun('41', { theme: 'dark' }) === false);
check('another turn is its own', beginRun('42', { ui_scale: 100 }) === true && runOf('42')?.undone === false);

section('three controls the learner presses: a mastery check, a card, a capture');
const outWrites = join(scratch, 'assistantWrites.mjs');
await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/utils/assistantWrites.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'node', outfile: outWrites, logLevel: 'silent',
});
const { splitChecks, splitWriteBlocks, writeBlocksAsText } = await import(pathToFileURL(outWrites).href);

const chk = splitChecks('You look ready.\n\n[[check:3:41]]');
check('a check marker becomes a target', chk.checks.length === 1 && chk.checks[0].nodeId === 41 && chk.checks[0].projectId === 3);
check('...and leaves the prose alone', chk.body === 'You look ready.');
check('a malformed check is stripped and offers nothing',
    splitChecks('Go. [[check:3:NONE]]').checks.length === 0 && !splitChecks('Go. [[check:3:NONE]]').body.includes('[['));
check('at most two checks, one per topic',
    splitChecks('[[check:1:2]][[check:1:2]][[check:1:3]][[check:1:4]]').checks.length === 2);
check('a half-streamed check does not flash', !splitChecks('Ready [[che', true).body.includes('[['));

const CARD = 'Worth keeping:\n\n```card\ntopic: 3:41\nfront: What shifts in the Doppler effect?\nback: The observed frequency —\nnot the emitted one.\n```\n\nNext, the formula.';
const w = splitWriteBlocks(CARD);
check('a card block becomes a proposal', w.cards.length === 1 && w.cards[0].nodeId === 41 && w.cards[0].projectId === 3, JSON.stringify(w.cards));
check('a side may run over several lines', w.cards[0]?.back === 'The observed frequency —\nnot the emitted one.', JSON.stringify(w.cards[0]?.back));
check('the block leaves the text, the prose around it stays', w.body === 'Worth keeping:\n\nNext, the formula.', JSON.stringify(w.body));
check('a card missing a side is stripped and proposes nothing',
    splitWriteBlocks('```card\ntopic: 3:41\nfront: only a front\n```').cards.length === 0
    && splitWriteBlocks('```card\ntopic: 3:41\nfront: only a front\n```').body === '');
check('a card with no real topic proposes nothing', splitWriteBlocks('```card\ntopic: somewhere\nfront: a\nback: b\n```').cards.length === 0);
check('math with pipes and brackets survives inside a card',
    splitWriteBlocks('```card\ntopic: 1:2\nfront: What is $|x|$ for [[x]] = -3?\nback: 3\n```').cards[0]?.front === 'What is $|x|$ for [[x]] = -3?');
check('at most three cards a message',
    splitWriteBlocks(Array.from({ length: 5 }, (_, i) => `\`\`\`card\ntopic: 1:${i + 2}\nfront: q${i}\nback: a${i}\n\`\`\``).join('\n')).cards.length === 3);
const cap = splitWriteBlocks('Saving that.\n\n```capture\nFlux through a CLOSED surface counts enclosed charge;\nan open one does not.\n```');
check('a capture block becomes one proposal with its text', cap.captures.length === 1 && cap.captures[0].startsWith('Flux through a CLOSED'), JSON.stringify(cap.captures));
check('an empty capture proposes nothing', splitWriteBlocks('```capture\n   \n```').captures.length === 0);
check('an ordinary code fence is left alone', splitWriteBlocks('```js\nconst a = 1;\n```').body === '```js\nconst a = 1;\n```');
const half = splitWriteBlocks('Here:\n\n```card\ntopic: 3:41\nfront: What shi', true);
check('a card still arriving never shows its source', !half.body.includes('```') && !half.body.includes('topic:') && half.cards.length === 0, JSON.stringify(half.body));
check('Copy keeps a card as its two sides, in words',
    /What shifts in the Doppler effect\?/.test(writeBlocksAsText(CARD)) && !/```|topic:/.test(writeBlocksAsText(CARD)));
check('readableAnswer carries the card and drops the check',
    copied(`${CARD}\n\n[[check:3:41]]`, []).includes('The observed frequency') && !copied(`${CARD}\n\n[[check:3:41]]`, []).includes('[['));
// Measured 2026-09-23 with a DOM timeline: every live turn lost its lookup
// rows at settle, because the finished message was built INSIDE a setMessages
// updater that React runs after the next line emptied actionsRef. Both paths
// must read the list before the updater, never inside it.
check('a finished turn keeps its lookup rows: no updater reads actionsRef',
    !/actions:\s*actionsRef\.current/.test(drawerSrc) && (drawerSrc.match(/const looked = actionsRef\.current;/g) || []).length === 2);
check('the drawer renders the three and resolves their topics',
    /<CheckButtons\b/.test(drawerSrc) && /<CardProposals\b/.test(drawerSrc) && /<CaptureProposals\b/.test(drawerSrc)
    && /splitChecks\(m\.content\)\.checks/.test(drawerSrc) && /splitWriteBlocks\(m\.content\)\.cards/.test(drawerSrc));

section('a fourth thing it prepares: a problem report the learner reviews and sends');
// A learner who is annoyed with the app explains in plain words, the assistant
// asks what it needs, and a drafted report opens Report a problem filled in,
// for the learner to review and send. The fence carries the issue forms' own
// field ids (tools/report-gates.mjs holds those to the templates).
const REPORT = [
    'I have put that together for you to check.',
    '',
    '```report',
    'kind: bug',
    'title: Study shows an empty screen on my Japanese deck',
    'what happened: I pressed Study on the deck.',
    'Expected: the first card. Got: an empty screen.',
    'steps: 1. Open the deck',
    '2. Press Study',
    'problem: this line belongs to steps, not to an idea field',
    'environment: Windows 11, the model wrote this',
    '```',
].join('\n');
const rw = splitWriteBlocks(REPORT);
const rep = rw.reports?.[0];
check('a report block becomes one proposal with its kind and title',
    rw.reports?.length === 1 && rep?.kind === 'bug' && rep?.title === 'Study shows an empty screen on my Japanese deck', JSON.stringify(rw.reports));
check('a field named in words ("what happened") is the form id what-happened',
    rep?.fields?.['what-happened']?.startsWith('I pressed Study on the deck.'), JSON.stringify(rep?.fields));
check('a line that only LOOKS like a field ("Expected: …") stays in the answer above it',
    /Expected: the first card\. Got: an empty screen\./.test(rep?.fields?.['what-happened'] || ''));
check('an answer may run over several lines', rep?.fields?.steps?.startsWith('1. Open the deck\n2. Press Study'), JSON.stringify(rep?.fields?.steps));
check('another kind\'s field id is text in this one, never a field of its own',
    !('problem' in (rep?.fields || {})) && /belongs to steps/.test(rep?.fields?.steps || ''));
check('the machine report is never taken from the model', !('environment' in (rep?.fields || {}))
    && !/Windows 11/.test(JSON.stringify(rep?.fields || {})));
check('the block leaves the text; the sentence before it stays', rw.body === 'I have put that together for you to check.', JSON.stringify(rw.body));
check('a kind the forms do not have proposes nothing, and is still stripped',
    splitWriteBlocks('```report\nkind: complaint\ntitle: x\nwhat-happened: y\n```').reports?.length === 0
    && splitWriteBlocks('Hm.\n\n```report\nkind: complaint\ntitle: x\n```').body === 'Hm.');
check('the kinds a model reaches for land on the three forms',
    splitWriteBlocks('```report\nkind: ai content\ncontent: it said 2+2=5\n```').reports?.[0]?.kind === 'content'
    && splitWriteBlocks('```report\nkind: feature request\nproblem: no offline mode\n```').reports?.[0]?.kind === 'idea'
    && splitWriteBlocks('```report\nkind: bug (something is broken)\nwhat-happened: x\n```').reports?.[0]?.kind === 'bug');
check('a report with nothing in it proposes nothing', splitWriteBlocks('```report\nkind: bug\n```').reports?.length === 0);
check('one report a message', splitWriteBlocks(`${REPORT}\n\n${REPORT}`).reports?.length === 1);
const halfReport = splitWriteBlocks('Here it is:\n\n```report\nkind: bug\ntitle: Study shows an empty', true);
check('a report still arriving never shows its source and proposes nothing yet',
    !halfReport.body.includes('```') && !halfReport.body.includes('kind:') && halfReport.reports?.length === 0, JSON.stringify(halfReport.body));
check('a report the model forgot to close is read once the turn has settled',
    splitWriteBlocks('Done.\n\n```report\nkind: idea\ntitle: Offline decks\nproblem: I cannot tell which decks work offline').reports?.[0]?.fields?.problem === 'I cannot tell which decks work offline');
const copiedReport = copied(REPORT, []);
check('Copy carries the report in words, under the form\'s own questions',
    copiedReport.includes('Something is broken: Study shows an empty screen on my Japanese deck')
    && copiedReport.includes('What happened?\nI pressed Study on the deck.')
    && !/```|kind:|what-happened:/.test(copiedReport), JSON.stringify(copiedReport));
check('the drawer renders it, and a turn whose answer is only a report is not "no answer"',
    /<ReportProposals reports=\{writes\.reports\} turnKey=\{turnKey\} \/>/.test(drawerSrc)
    && /writes\.cards\.length \+ writes\.captures\.length \+ writes\.reports\.length > 0/.test(drawerSrc));
const proposalsSrcR = readFileSync(fileURLToPath(new URL('../src/components/AssistantProposals.tsx', import.meta.url)), 'utf8');
check('Review opens the SAME dialog as Settings, filled in from the draft',
    /<ReportProblemDialog[\s\S]{0,200}prefill=\{report\}/.test(proposalsSrcR) && /import ReportProblemDialog from '\.\/ReportProblemDialog'/.test(proposalsSrcR));
check('...and it survives the turn being redrawn under its stored id (the key is the TURN)',
    /const key = `\$\{turnKey\}:report:\$\{i\}`/.test(proposalsSrcR) && /draftKey=\{`assistant:\$\{key\}`\}/.test(proposalsSrcR));
const dialogSrc = readFileSync(fileURLToPath(new URL('../src/components/ReportProblemDialog.tsx', import.meta.url)), 'utf8');
check('the dialog makes no request: its only way out is a link the learner presses',
    !/\bapi\.|fetch\(/.test(dialogSrc) && /href=\{url\}/.test(dialogSrc));
// Both sit on the shared dialog stack, where only the topmost takes Escape;
// dialog-gates.mjs presses the key on the real pair.
check('Escape in the dialog closes the dialog, not the assistant under it',
    /useDialogFocus\(true, panelRef/.test(dialogSrc) && /useDialogFocus\(open && !docked, overlayRef/.test(drawerSrc));

section('what a proposal does depends on what its topic IS');
// GLM-5.3-flash, asked to add "which frequency changes?" to a topic that
// already had it, wrote "which frequency changes — the source's or the
// observed one?": past the server's exact-front check, a near-duplicate.
const { similarFront } = await import(pathToFileURL(outWrites).href);
const HAVE = ['In the Doppler effect, which frequency changes?', 'What is the speed of sound in air?'];
check('a reworded card is recognised as one the learner has',
    similarFront("In the Doppler effect, which frequency changes — the source's or the observed one?", HAVE) === HAVE[0]);
check('a different question on the same topic is not', similarFront('Why does a siren sound lower once it has passed?', HAVE) === null);
check('Cyrillic words count as words', similarFront('Какая частота меняется в эффекте Доплера?', ['В эффекте Доплера какая частота меняется']) !== null);
check('a two-word front is too short to call similar', similarFront('Doppler effect', ['Doppler effect']) === null);
const proposalsSrc = readFileSync(fileURLToPath(new URL('../src/components/AssistantProposals.tsx', import.meta.url)), 'utf8');
check('a check draws only on a TOPIC — not a section, a note or a deck stage', /l\?\.kind === 'topic'/.test(proposalsSrc));
check('a completed topic\'s check says Retake', /status === 'completed'[^]{0,120}Retake the mastery check/.test(proposalsSrc));
check('a card draws on a topic or a deck stage, never a section or a note',
    /x\.label\?\.kind === 'topic' \|\| x\.label\?\.kind === 'stage'/.test(proposalsSrc));
check('the preview names a similar card before Add, and says when the course is not active',
    /similarFront\(card\.front/.test(proposalsSrc) && /projectStatus !== 'active'/.test(proposalsSrc));
const gateSrc = readFileSync(fileURLToPath(new URL('../src/components/MasteryGateModal.tsx', import.meta.url)), 'utf8');
// Before: a retake the learner FAILED offered "Skip topic", which turns a
// proven, completed topic into a skipped one and throws its finish date away.
check('a retake is decided by the status the draw returns', /setRetake\(drawn\.status === 'completed'\)/.test(gateSrc));
check('a retake offers neither Skip nor "Mark done anyway"',
    /offerMarkAnyway = advisory && !!onMarkAnyway && !retake/.test(gateSrc) && /offerSkip = !!onSkip && !retake/.test(gateSrc)
    && !/\{onSkip && \(/.test(gateSrc) && !/\{advisory && onMarkAnyway && \(/.test(gateSrc));
check('a passed retake closes rather than completing the topic again', /onClick=\{retake \? onClose : onPassed\}/.test(gateSrc));

section('a turn is drawn in the order it happened');
// Measured 2026-09-28 in the drawer (OpenRouter/glm-5.3-flash, native tool
// calls): the reasoning read "…Let me search for it.The learner shared…", and
// the answer "Let me search the library again for files:You're right — here are
// the actual Physics files", with the lookups parked above both. The server now
// records WHERE each lookup happened (`at`) and breaks the text between rounds;
// this splitter cuts both texts at those places (src/utils/turnTimeline.ts).
const outTimeline = join(scratch, 'turnTimeline.mjs');
await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/utils/turnTimeline.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'node', outfile: outTimeline, logLevel: 'silent',
});
const { splitTurnTimeline, summarizeLookups, safeCut } = await import(pathToFileURL(outTimeline).href);
const shape = (parts) => parts.map(p => (p.kind === 'text' ? `T:${p.text}` : `L:${p.actions.map(a => a.arg).join('+')}`)).join(' | ');
{
    const THINK1 = 'I have web lookup available. Let me search for it.';
    const THINK2 = 'The learner shared their own portfolio site.';
    const SAID1 = 'Let me search the library again for files:';
    const SAID2 = "You're right — here are the actual Physics files.";
    // The pre-change record: the glued texts, rows with no place.
    const before = splitTurnTimeline({
        reasoning: THINK1 + THINK2,
        content: SAID1 + SAID2,
        actions: [{ tool: 'search_web', arg: 'example.com', count: 4 }, { tool: 'find_in_library', arg: 'physics', count: 5 }],
    });
    check('(control) a turn stored before places existed draws exactly as it did: rows above, one reasoning, one answer',
        before.unplaced.length === 2 && before.reasoning.length === 1 && before.answer.length === 1
        && before.answer[0].text.includes("files:You're right"), shape(before.answer));
    // The same turn as it is now recorded.
    const now = splitTurnTimeline({
        reasoning: `${THINK1}\n\n${THINK2}`,
        content: `${SAID1}\n\n${SAID2}`,
        actions: [
            { tool: 'search_web', arg: 'example.com', count: 4, at: { reasoning: THINK1.length, content: 0 } },
            { tool: 'find_in_library', arg: 'pdf', count: 5, at: { reasoning: THINK1.length + 2 + THINK2.length, content: SAID1.length } },
            { tool: 'find_in_library', arg: 'exam', count: 3, at: { reasoning: THINK1.length + 2 + THINK2.length, content: SAID1.length } },
        ],
    });
    check('a lookup made while thinking sits INSIDE the reasoning, between the passes it separates',
        shape(now.reasoning) === `T:${THINK1} | L:example.com | T:${THINK2}`, shape(now.reasoning));
    check('...and the panel header is told about it', now.reasoningLookups.length === 1 && now.reasoningLookups[0].arg === 'example.com');
    check('lookups made after the answer began sit BETWEEN its paragraphs, together',
        shape(now.answer) === `T:${SAID1} | L:pdf+exam | T:${SAID2}`, shape(now.answer));
    check('nothing is left for the old place', now.unplaced.length === 0);
    const early = splitTurnTimeline({ reasoning: THINK1, content: SAID1, actions: [{ tool: 'search_web', arg: 'q', at: { reasoning: 0, content: 0 } }] });
    check('a lookup before any thinking opens the reasoning', shape(early.reasoning) === `L:q | T:${THINK1}`, shape(early.reasoning));
    const noThought = splitTurnTimeline({ reasoning: '', content: SAID1, actions: [{ tool: 'search_web', arg: 'q', at: { reasoning: 0, content: 0 } }] });
    check('with no reasoning to sit in, it stands above the answer as rows always did', noThought.unplaced.length === 1 && noThought.reasoning.length === 0);
    const waiting = splitTurnTimeline({ reasoning: THINK1, content: '', actions: [{ tool: 'search_web', arg: 'q', at: { reasoning: 5, content: 40 } }] });
    check('a row whose answer text has not arrived yet (a replay catching up) waits above, never lost', waiting.unplaced.length === 1);
    const live = splitTurnTimeline({ reasoning: '', content: SAID1, actions: [{ tool: 'find_in_library', arg: 'pdf', state: 'running', at: { reasoning: 0, content: SAID1.length } }] });
    check('while it runs, the row stands right under the words that asked for it', shape(live.answer) === `T:${SAID1} | L:pdf`, shape(live.answer));
    const grown = splitTurnTimeline({ reasoning: '', content: `${SAID1}\n\n${SAID2}`, actions: live.answer[1].actions });
    check('the text before a row keeps its key as the answer grows, so its visuals are not redrawn',
        live.answer[0].key === grown.answer[0].key && grown.answer[2]?.key !== grown.answer[0].key);
    const fence = 'Here:\n```python\nx = 1\ny = 2\n```\nAfter.';
    check('a place inside a code block moves to the end of the block', fence.slice(0, safeCut(fence, fence.indexOf('y = 2'))).endsWith('```')
        && safeCut(fence, 5) === 5);
    const clamp = splitTurnTimeline({ reasoning: 'r', content: 'short', actions: [{ tool: 'x', arg: 'late', at: { reasoning: 0, content: 999 } }] });
    check('a place past the end of the text lands at the end', shape(clamp.answer) === 'T:short | L:late', shape(clamp.answer));
    const counted = summarizeLookups([
        { tool: 'search_web', arg: 'a' }, { tool: 'search_web', arg: 'b' },
        { tool: 'project_state', arg: '113', label: 'VWO Physics' }, { tool: 'project_state', arg: 'VWO physics', label: 'VWO Physics' },
        { tool: 'read_document', arg: '28', label: 'Exam 9.pdf' }, { tool: 'read_document', arg: '28 pages 6-11', label: 'Exam 9.pdf' },
    ]);
    check('the header counts each tool and names each thing once',
        JSON.stringify(counted) === JSON.stringify([
            { tool: 'search_web', count: 2, names: ['a', 'b'] },
            { tool: 'project_state', count: 2, names: ['VWO Physics'] },
            { tool: 'read_document', count: 2, names: ['Exam 9.pdf'] },
        ]), JSON.stringify(counted));
    check('a paste of the new turn keeps its paragraphs apart', copied(`${SAID1}\n\n${SAID2}`, []).includes(`${SAID1}\n\n${SAID2}`));
}

section('both chat surfaces draw the timeline, and the terminal frame pairs text with rows');
{
    const panelSrc = readFileSync(fileURLToPath(new URL('../src/components/AIPanel.tsx', import.meta.url)), 'utf8');
    const reasoningSrc = readFileSync(fileURLToPath(new URL('../src/components/ReasoningPanel.tsx', import.meta.url)), 'utf8');
    const actionsSrc = readFileSync(fileURLToPath(new URL('../src/components/AiActions.tsx', import.meta.url)), 'utf8');
    const apiSrc = readFileSync(fileURLToPath(new URL('../src/api.ts', import.meta.url)), 'utf8');
    for (const [who, src] of [['the drawer', drawerSrc], ['the tutor', panelSrc]]) {
        check(`${who} splits each turn into its timeline`, /splitTurnTimeline\(\{ reasoning/.test(src));
        check(`${who} hands the reasoning its pieces and its lookups`, /parts=\{timeline\??\.reasoning\}/.test(src) && /lookups=\{timeline\??\.reasoningLookups\}/.test(src));
        check(`${who} draws only UNPLACED rows in the old spot`, /<AiActions actions=\{timeline\??\.unplaced\}/.test(src) && !/<AiActions actions=\{(m|msg)\.actions\}/.test(src));
        check(`${who} draws the answer piece by piece, rows between`, /timeline\??\.answer/.test(src) && /part\.kind === 'lookups'/.test(src));
        check(`${who} never re-opens the reasoning once the answer is on screen`, /!contentStartedRef\.current\)/.test(src));
    }
    check('the reasoning header names what was looked up, folded or not', /describeLookups\(lookups, t\)/.test(reasoningSrc) && /phrases\.map/.test(reasoningSrc));
    check('every header phrase is a count key', (actionsSrc.match(/\{\{count\}\}/g) || []).length >= 6);
    check('the stream hands the STORED rows over with the stored text', /actions: Array\.isArray\(json\.actions\) \? json\.actions as AiAction\[\] : null/.test(apiSrc)
        && /Array\.isArray\(json\.actions\) && !json\.done && !json\.cancelled/.test(apiSrc));
    check('a followed turn reads the terminal frame before it tracks rows', /if \(evt\.done \|\| evt\.cancelled\) \{\s*terminal = true;\s*if \(typeof evt\.content === 'string'/.test(drawerSrc));
    check('the tutor keeps the streamed text RAW (rows are measured in it) and strips markers per piece',
        /setStreamingContent\(fullResponse\)/.test(panelSrc) && !/setStreamingContent\(stripCitationMarkers/.test(panelSrc) && /stripCitationMarkers\(splitTutorActions\(part\.text/.test(panelSrc));
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

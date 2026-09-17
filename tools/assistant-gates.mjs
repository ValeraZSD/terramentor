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

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// The two MCP App views (docs/MCP.md): the mastery check and the card review a
// host such as Claude draws in its own window. Each is ONE HTML document,
// assembled here from mcp/views/ on first read:
//
//   - Its script and style are inline, because a view has no origin to load a
//     file from, and each is allowed by its sha256 hash in the document's own
//     Content-Security-Policy. That policy also forbids every load and every
//     connection: the view talks to the host by postMessage only, and the host
//     relays its tool calls to this server.
//   - The words it shows come from the app's own translations (src/locales,
//     English text as the key), in every language the app ships, as a JSON
//     block the policy does not execute. A string the app does not have is
//     shown in English, as the app itself does.
//
// tools/mcp-gates.mjs reads both documents back and checks the policy, the
// hashes, and that no string becomes code or markup.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

export const VIEW_MIME = 'text/html;profile=mcp-app';

const DIR = new URL('./views/', import.meta.url);
const LOCALES = new URL('../src/locales/', import.meta.url);

/** The English keys each view shows; a plural key is named once, without its `_one`/`_other`. */
const SHARED_STRINGS = ['Close', 'Continue', 'Loading…', 'Next', 'Previous', 'Undo'];
const CHECK_STRINGS = [
    'Mastery check', 'Question {{n}} of {{total}}', '{{answeredCount}}/{{length}} answered',
    'Submit mastery check', 'Checking every answer…', 'You scored {{score}}/{{total}} ({{round}}%)',
    'Mastery check passed', 'Not Yet Mastered', 'You need at least {{round}}% to pass this mastery check.',
    'You proved it — this topic will be marked completed.', 'You proved it again — the topic stays completed.',
    'Review Answers', 'Your answer', 'Your answer:', 'Correct answer:', 'Correct', 'Wrong', 'True', 'False',
    '(no answer)', 'Type your answer…', 'Your answer, in {{unit}}', 'Write your solution here…', 'Your code',
    'Move up', 'Move down', 'Your order', 'Pieces', 'Gap {{n}}, empty', 'Gap {{n}}: {{piece}}. Press to take it out',
];
const REVIEW_STRINGS = [
    'Flashcard Review', 'Reveal answer', 'How well did you know this?', 'Again', 'Hard', 'Good', 'Easy',
    'Undo', 'Undo the last rating', 'This card was reviewed again since, so that rating stays.', 'Session Complete!',
    'You reviewed {{count}} flashcards', '{{count}} cards are still being learned and come back {{readyIn}}.',
    'Show them now anyway', 'No Cards Due', 'Question', 'Answer',
];
const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other'];

export const VIEWS = {
    check: {
        uri: 'ui://terramentor/mastery-check.html', name: 'mastery-check', title: 'Mastery check',
        description: 'A topic\'s mastery check, taken by the learner in the host\'s window.',
        script: 'check.js', strings: CHECK_STRINGS,
    },
    review: {
        uri: 'ui://terramentor/card-review.html', name: 'card-review', title: 'Card review',
        description: 'A card review session, taken by the learner in the host\'s window.',
        script: 'review.js', strings: REVIEW_STRINGS,
    },
};

/**
 * The policy each document carries. `img-src data:` alone, for nothing the
 * view loads today; every other fetch, frame, form and base is refused.
 */
function policy(scriptHash, styleHash) {
    return [
        "default-src 'none'",
        `script-src ${scriptHash}`,
        `style-src ${styleHash}`,
        'img-src data:',
        "font-src 'none'",
        "connect-src 'none'",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
    ].join('; ');
}

const hash = (s) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;
const source = (file) => readFileSync(new URL(file, DIR), 'utf8');

/** Every shipped language's words for these keys: `{ ru: { key: text } }`; English keys with no entry fall back to themselves. */
function strings(keys) {
    const out = {};
    if (!existsSync(LOCALES)) return out;
    for (const file of readdirSync(LOCALES)) {
        const m = /^([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)\.json$/.exec(file);
        if (!m) continue;
        let table;
        try { table = JSON.parse(readFileSync(new URL(file, LOCALES), 'utf8')); } catch { continue; }
        const picked = {};
        for (const key of keys) {
            for (const k of [key, ...PLURAL_SUFFIXES.map(s => key + s)]) {
                if (typeof table[k] === 'string' && table[k]) picked[k] = table[k];
            }
        }
        out[m[1]] = picked;
    }
    return out;
}

/** JSON inside a <script type="application/json">: nothing in it may close the element or open a comment. */
const inertJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

const cache = new Map();

/** The whole document for one view (`check` or `review`). */
export function viewHtml(kind) {
    if (cache.has(kind)) return cache.get(kind);
    const view = VIEWS[kind];
    if (!view) throw new Error(`No view "${kind}"`);
    const script = `${source('bridge.js')}\n${source(view.script)}`;
    const style = source('view.css');
    const words = inertJson(strings([...SHARED_STRINGS, ...view.strings]));
    const html = [
        '<!doctype html>',
        '<html lang="en">',
        '<head>',
        '<meta charset="utf-8">',
        `<meta http-equiv="Content-Security-Policy" content="${policy(hash(script), hash(style))}">`,
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        `<title>${view.title}</title>`,
        `<style>${style}</style>`,
        '</head>',
        '<body>',
        '<main id="app" aria-live="polite"></main>',
        `<script type="application/json" id="tm-strings">${words}</script>`,
        `<script>${script}</script>`,
        '</body>',
        '</html>',
    ].join('\n');
    cache.set(kind, html);
    return html;
}

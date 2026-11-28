/**
 * Answers the assistant offers under a question it asks, for the learner to
 * tap instead of typing:
 *
 *   ```choices
 *   I am new to it
 *   I know the basics
 *   ```
 *
 * A tap sends that line as the learner's reply, word for word, exactly as if
 * they had typed it, and typing anything else still works. A choice never acts
 * by itself: no setting, no write, only a message. The model MAY add one
 * (`CHOICES_GUIDE` in server/ai.js); nothing requires it.
 *
 * A FENCE rather than a `[[…]]` marker because a label is content in the
 * learner's language: a `:` or a `]]` in it would end a marker early.
 *
 * Lenient where a small local model is sloppy: bullets, numbers, quotes and
 * bold come off a line, one line is split on `|`, `options` is the same block,
 * and a block never closed is read once the turn has settled. Strict about what
 * becomes a button (server/chatChoices.js): 2 to 4 distinct answers, each
 * short. Outside that, and for a second block in one message, the answers go
 * back into the text as a list: the learner still reads every option the model
 * wrote and types one, and no option is silently dropped.
 *
 * Live only on the newest message (`choicesLive`): a button under an older one
 * would answer a question the conversation has moved past.
 */

import { CHOICE_LABEL_MAX, CHOICES_MAX, CHOICES_MIN, sameAnswer } from '../../server/chatChoices.js';

const KINDS = 'choices|choice|options';
const BLOCK_RE = new RegExp(`(^|\\n)[ \\t]*\`\`\`[ \\t]*(?:${KINDS})[ \\t]*\\n([\\s\\S]*?)\\n?[ \\t]*\`\`\`[ \\t]*(?=\\n|$)`, 'gi');
/** An opener with no closer after it: still arriving, or never closed. */
const OPEN_RE = new RegExp(`(^|\\n)[ \\t]*\`\`\`[ \\t]*(?:${KINDS})[ \\t]*(?:\\n([\\s\\S]*))?$`, 'i');

/** Line ends as `\n` only, so a block a model wrote with CRLF is still found. */
const unix = (s: string) => s.replace(/\r\n?/g, '\n');

const tidy = (s: string) => s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');

/** Pairs a label may be wrapped in, as a model quotes it. */
const QUOTES: [string, string][] = [['"', '"'], ["'", "'"], ['“', '”'], ['„', '“'], ['«', '»'], ['‘', '’'], ['`', '`']];

function label(line: string): string {
    let s = line.replace(/\s+/g, ' ').trim()
        // "- ", "* ", "• ", "1. ", "2) ", "[ ] " before the answer.
        .replace(/^(?:[-*•–]|\d{1,2}[.)]|\[[ xX]?\])\s+/, '');
    const bold = s.match(/^(\*\*|__)(.+)\1$/);
    if (bold) s = bold[2].trim();
    for (const [open, close] of QUOTES) {
        if (s.length > 2 && s.startsWith(open) && s.endsWith(close)) { s = s.slice(open.length, -close.length).trim(); break; }
    }
    return s;
}

/** The lines of a block, as answers, in order, each once. */
function answersOf(inner: string): string[] {
    const lines = inner.replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean);
    const raw = lines.length === 1 && lines[0].includes('|') ? lines[0].split('|') : lines;
    const out: string[] = [];
    for (const piece of raw) {
        const s = label(piece);
        if (s && !out.some(o => sameAnswer(o, s))) out.push(s);
    }
    return out;
}

/** Code points, so a label in any script is measured the same. */
const lengthOf = (s: string) => [...s].length;

const fits = (answers: string[]) => answers.length >= CHOICES_MIN && answers.length <= CHOICES_MAX
    && answers.every(a => lengthOf(a) <= CHOICE_LABEL_MAX);

const asList = (answers: string[]) => (answers.length ? `\n\n${answers.map(a => `- ${a}`).join('\n')}\n\n` : '');

/**
 * Take the answers out of an assistant message.
 *
 * @param streaming true while the text is still arriving: a block not closed
 *        yet is hidden, so neither its fence nor half a label flashes
 */
export function splitChoices(content: string, streaming = false): { body: string; choices: string[] } {
    if (typeof content !== 'string' || !content.includes('```')) return { body: content, choices: [] };
    const text = unix(content);
    let choices: string[] = [];
    let taken = false;
    const take = (inner: string) => {
        const answers = answersOf(inner);
        if (!taken && fits(answers)) {
            taken = true;
            choices = answers;
            return '';
        }
        return asList(answers);
    };
    let body = text.replace(BLOCK_RE, (_m, lead: string, inner: string) => lead + take(inner));
    body = body.replace(OPEN_RE, (_m, lead: string, inner = '') => (streaming ? lead : lead + take(inner)));
    return { body: body === text ? content : tidy(body), choices };
}

/** The answers as a person would paste them: a list under the question. */
export function choicesAsText(content: string): string {
    if (typeof content !== 'string' || !content.includes('```')) return content;
    const text = unix(content);
    const out = text
        .replace(BLOCK_RE, (_m, lead: string, inner: string) => lead + asList(answersOf(inner)))
        .replace(OPEN_RE, (_m, lead: string, inner = '') => lead + asList(answersOf(inner)));
    return out === text ? content : tidy(out);
}

/**
 * Whether the answers under message `index` may still be pressed: an assistant
 * message with nothing after it, while no turn is being written. Anything later
 * (the learner's tap, a typed answer, any other turn) has answered or moved
 * past the question, so a reload draws exactly what was drawn before.
 */
export function choicesLive(messages: { role: string }[], index: number, streaming: boolean): boolean {
    return !streaming && messages[index]?.role === 'assistant' && index === messages.length - 1;
}

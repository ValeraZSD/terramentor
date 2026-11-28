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
 * Lenient where a small local model is sloppy: bullets, a 1-2-3 numbering, and
 * quotes or bold around a whole line come off it, one line is split on `|`,
 * `options` is the same block, and words after the closing fence on its line
 * stay in the text. Strict about what becomes a button (server/chatChoices.js):
 * a CLOSED block of 2 to 4 distinct answers, each short. Outside that, for a
 * second block in one message, and for a block never closed (a stopped or
 * cut-off turn, whose last line may be half a word), the answers go back into
 * the text as a list: the learner still reads every option the model wrote and
 * types one, and no option is silently dropped. A block never closed ends at
 * the next fence or the first blank line, so the text after it stays text.
 *
 * Live only on the newest message (`choicesLive`): a button under an older one
 * would answer a question the conversation has moved past.
 */

import { CHOICE_LABEL_MAX, CHOICES_MAX, CHOICES_MIN, sameAnswer } from '../../server/chatChoices.js';

const KINDS = 'choices|choice|options';
const OPENER = new RegExp(`^[ \\t]*\`\`\`[ \\t]*(?:${KINDS})[ \\t]*$`, 'i');
/** Any fence line: a closer, or another block's opener. */
const FENCE = /^[ \t]*```/;
/** A closer, bare or with words after it on its line (`\`\`\` Hope that helps.`); `\`\`\`python` opens a block instead. */
const CLOSER = /^[ \t]*```(?:[ \t]+(.*))?$/;

/** Line ends as `\n` only, so a block a model wrote with CRLF is still found. */
const unix = (s: string) => s.replace(/\r\n?/g, '\n');

const tidy = (s: string) => s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');

/** Pairs a label may be wrapped in, as a model quotes it. */
const QUOTES: [string, string][] = [['"', '"'], ["'", "'"], ['“', '”'], ['„', '“'], ['«', '»'], ['‘', '’'], ['`', '`']];
const NUMBERED = /^(\d{1,2})[.)]\s+/;

/**
 * One line as the answer it sends. Only what wraps the WHOLE line comes off:
 * `"Yes" or "No"` and `**a** and **b**` keep their marks, and a number only in
 * a block numbered 1, 2, 3…, so "5. Mai" stays a date.
 */
function label(line: string, numbered: boolean): string {
    let s = line.replace(/\s+/g, ' ').trim();
    s = numbered ? s.replace(NUMBERED, '') : s.replace(/^(?:[-*•–]|\[[ xX]?\])\s+/, '');
    const bold = s.match(/^(\*\*|__)(.+)\1$/);
    if (bold && !bold[2].includes(bold[1])) s = bold[2].trim();
    for (const [open, close] of QUOTES) {
        if (s.length > 2 && s.startsWith(open) && s.endsWith(close)) {
            const inner = s.slice(open.length, -close.length);
            if (!inner.includes(open) && !inner.includes(close)) s = inner.trim();
            break;
        }
    }
    return s;
}

/** The lines of a block, as answers, in order, each once. */
function answersOf(lines: string[]): string[] {
    let raw = lines.map(l => l.trim()).filter(Boolean);
    if (raw.length === 1 && raw[0].includes('|')) raw = raw[0].split('|').map(l => l.trim());
    // A count (1, 2, 3 or 2, 3, 4) or one number on every line (1. 1. 1.): a
    // list's numbering. "5. Mai" beside "12. Mai" is neither, so it stays a date.
    const nums = raw.map(l => Number(NUMBERED.exec(l)?.[1] ?? NaN));
    const numbered = raw.length > 1 && nums.every(n => !Number.isNaN(n))
        && (nums.every((n, i) => n === nums[0] + i) || nums.every(n => n === nums[0]));
    const out: string[] = [];
    for (const piece of raw) {
        const s = label(piece, numbered);
        if (s && !out.some(o => sameAnswer(o, s))) out.push(s);
    }
    return out;
}

/**
 * How a block was found: `closed` by its fence; `unclosed`, ended by another
 * fence or a blank line; `open` to the end of the text (still arriving while
 * the turn streams, or cut off).
 */
type BlockEnd = 'closed' | 'unclosed' | 'open';

/** The text with every choices block replaced by `render`'s output; null when there is none. */
function rewrite(text: string, render: (answers: string[], end: BlockEnd) => string): string | null {
    const lines = text.split('\n');
    const out: string[] = [];
    let found = false;
    for (let i = 0; i < lines.length; i++) {
        if (!OPENER.test(lines[i])) { out.push(lines[i]); continue; }
        found = true;
        let j = i + 1;
        while (j < lines.length && !FENCE.test(lines[j])) j++;
        // A bare fence with an odd number of fences after it opens a code block
        // of its own (the model forgot this closer): it closes nothing here.
        const fencesAfter = lines.slice(j + 1).filter(l => FENCE.test(l)).length;
        const close = j < lines.length && fencesAfter % 2 === 0 ? CLOSER.exec(lines[j]) : null;
        if (close) {
            out.push(render(answersOf(lines.slice(i + 1, j)), 'closed'));
            if (close[1]?.trim()) out.push(close[1].trim());
            i = j;
            continue;
        }
        // Never closed: it ends at the next fence or the first blank line after an answer.
        let k = i + 1;
        while (k < j && !(lines[k].trim() === '' && lines.slice(i + 1, k).some(l => l.trim()))) k++;
        // Only blank lines after it is still the end of the text: a streamed
        // answer line ends in a newline before the next one arrives.
        const open = lines.slice(k).every(l => l.trim() === '');
        // A cut-off turn may end on half a closer ("``"): not an answer.
        const inner = lines.slice(i + 1, k).filter((l, n, all) => !(n === all.length - 1 && /^[ \t]*`+[ \t]*$/.test(l)));
        out.push(render(answersOf(inner), open ? 'open' : 'unclosed'));
        i = open ? lines.length : k - 1;
    }
    return found ? out.join('\n') : null;
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
 * @param buttons false when an earlier piece of the same message already gave
 *        the buttons, so every block here goes back as a list
 */
export function splitChoices(content: string, streaming = false, buttons = true): { body: string; choices: string[] } {
    if (typeof content !== 'string' || !content.includes('```')) return { body: content, choices: [] };
    let choices: string[] = [];
    let taken = !buttons;
    const body = rewrite(unix(content), (answers, end) => {
        if (end === 'open' && streaming) return '';
        if (end === 'closed' && !taken && fits(answers)) {
            taken = true;
            choices = answers;
            return '';
        }
        return asList(answers);
    });
    return { body: body === null ? content : tidy(body), choices };
}

/** The answers as a person would paste them: a list under the question. */
export function choicesAsText(content: string): string {
    if (typeof content !== 'string' || !content.includes('```')) return content;
    const out = rewrite(unix(content), answers => asList(answers));
    return out === null ? content : tidy(out);
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

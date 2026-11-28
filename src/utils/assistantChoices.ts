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
 * the next fence or the first blank line, so the text after it stays text. A
 * block shown inside another code block (an example of the format) is code.
 *
 * Live only on the newest message (`choicesLive`): a button under an older one
 * would answer a question the conversation has moved past.
 */

import { CHOICE_LABEL_MAX, CHOICES_MAX, CHOICES_MIN, sameAnswer } from '../../server/chatChoices.js';

const KINDS = 'choices|choice|options';
const OPENER = new RegExp(`^[ \\t]*\`\`\`[ \\t]*(?:${KINDS})[ \\t]*$`, 'i');
/** Any backtick fence line: a closer, or another block's opener. */
const FENCE = /^[ \t]*```/;
/** A closer, bare or with words after it on its line (`\`\`\` Hope that helps.`); `\`\`\`python` opens a block instead. */
const CLOSER = /^[ \t]*`{3,}(?:[ \t]+(.*))?$/;
/** Any code fence that opens a block, as Markdown reads one: three or more backticks or tildes. */
const CODE_OPEN = /^[ \t]*(`{3,}|~{3,})/;

/** Line ends as `\n` only, so a block a model wrote with CRLF is still found. */
const unix = (s: string) => s.replace(/\r\n?/g, '\n');

/** Where the code block opened at line `at` closes: a bare fence of its own character, at least as long. -1 = never. */
function codeEnd(lines: string[], at: number): number {
    const fence = CODE_OPEN.exec(lines[at])![1];
    const close = new RegExp(`^[ \\t]*${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
    for (let x = at + 1; x < lines.length; x++) if (close.test(lines[x])) return x;
    return -1;
}

/** Whether every code block opened from line `from` on is closed again. */
function allClosed(lines: string[], from: number): boolean {
    for (let x = from; x < lines.length; x++) {
        if (!CODE_OPEN.test(lines[x])) continue;
        const end = codeEnd(lines, x);
        if (end < 0) return false;
        x = end;
    }
    return true;
}

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
    // A count from 1 (1, 2, 3) or a 1 on every line (1. 1. 1.): a list's
    // numbering, unless taking it off leaves two lines the same, so "5. Mai"
    // and "6. Mai", or "1. Mai" and "2. Mai", stay dates.
    const nums = raw.map(l => Number(NUMBERED.exec(l)?.[1] ?? NaN));
    const counted = raw.length > 1 && nums.every((n, i) => n === 1 + i || (n === 1 && nums.every(m => m === 1)));
    const bare = counted ? raw.map(l => label(l, true)) : [];
    const numbered = counted && bare.every((s, i) => s && !bare.slice(0, i).some(o => sameAnswer(o, s)));
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

/**
 * The text with every choices block replaced by `render`'s output; null when
 * there is none. Only the lines around a replaced block are tidied: the rest of
 * the message (code, a Markdown hard break) is kept exactly as written.
 *
 * @param arriving the text is still streaming: a block with no fence after it
 *        runs to the end, blank lines and all, since its next line may be coming
 */
function rewrite(text: string, render: (answers: string[], end: BlockEnd) => string, arriving = false): string | null {
    const lines = text.split('\n');
    // Text runs and replacements, in order; joined with a paragraph break
    // around each replacement, which never leaks into the text beside it.
    const parts: { text: string; block?: true }[] = [];
    let run: string[] = [];
    const flush = () => { parts.push({ text: run.join('\n') }); run = []; };
    const block = (s: string) => { flush(); parts.push({ text: s, block: true }); };
    let found = false;
    for (let i = 0; i < lines.length; i++) {
        if (!OPENER.test(lines[i])) {
            // Another code block (an example of the format, in ~~~ or ````) is
            // left exactly as it is: nothing inside it is an offer.
            if (CODE_OPEN.test(lines[i])) {
                const end = codeEnd(lines, i);
                const to = end < 0 ? lines.length - 1 : end;
                run.push(...lines.slice(i, to + 1));
                i = to;
                continue;
            }
            run.push(lines[i]);
            continue;
        }
        found = true;
        let j = i + 1;
        while (j < lines.length && !FENCE.test(lines[j])) j++;
        // A bare fence closes this block, unless reading it so leaves a later
        // fence open while reading it as a code block's opener closes them all:
        // then the model forgot this closer and the fence starts its code.
        const bare = j < lines.length ? CLOSER.exec(lines[j]) : null;
        const close = bare && (allClosed(lines, j + 1) || !allClosed(lines, j)) ? bare : null;
        if (close) {
            block(render(answersOf(lines.slice(i + 1, j)), 'closed'));
            if (close[1]?.trim()) run.push(close[1].trim());
            i = j;
            continue;
        }
        // Never closed: it ends at the next fence or the first blank line after
        // an answer; while the text still arrives and no fence follows, at its end.
        let k = i + 1;
        if (arriving && j === lines.length) k = j;
        else while (k < j && !(lines[k].trim() === '' && lines.slice(i + 1, k).some(l => l.trim()))) k++;
        // Only blank lines after it is still the end of the text: a streamed
        // answer line ends in a newline before the next one arrives.
        const open = lines.slice(k).every(l => l.trim() === '');
        // A cut-off turn may end on half a closer ("``"): not an answer.
        const inner = lines.slice(i + 1, k).filter((l, n, all) => !(n === all.length - 1 && /^[ \t]*`+[ \t]*$/.test(l)));
        block(render(answersOf(inner), open ? 'open' : 'unclosed'));
        i = open ? lines.length : k - 1;
    }
    if (!found) return null;
    flush();
    let out = '';
    parts.forEach((p, n) => {
        let s = p.text;
        // Blank lines and trailing spaces only where they touch a replacement.
        if (parts[n - 1]?.block) s = s.replace(/^(?:[ \t]*\n)+/, '');
        if (parts[n + 1]?.block) s = s.replace(/\s+$/, '');
        if (p.block) s = s.trim();
        if (!s) return;
        out += (out ? (p.block || parts[n - 1]?.block ? '\n\n' : '\n') : '') + s;
    });
    return out;
}

/** Code points, so a label in any script is measured the same. */
const lengthOf = (s: string) => [...s].length;

const fits = (answers: string[]) => answers.length >= CHOICES_MIN && answers.length <= CHOICES_MAX
    && answers.every(a => lengthOf(a) <= CHOICE_LABEL_MAX);

const asList = (answers: string[]) => answers.map(a => `- ${a}`).join('\n');

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
    }, streaming);
    return { body: body === null ? content : body, choices };
}

/** The answers as a person would paste them: a list under the question. */
export function choicesAsText(content: string): string {
    if (typeof content !== 'string' || !content.includes('```')) return content;
    const out = rewrite(unix(content), answers => asList(answers));
    return out === null ? content : out;
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

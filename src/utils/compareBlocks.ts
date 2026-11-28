/**
 * A side-by-side card the assistant may draw: two related texts it wrote, shown
 * next to each other with a label on each. A sentence and its translation, a
 * sentence before and after a correction, the same idea in Python and in
 * JavaScript, a wrong answer beside a right one. The app owns the shape; the
 * model decides when two texts read better side by side, and writes both.
 *
 *   ```compare
 *   title: Ordering politely          (optional)
 *   side: English
 *   I would like a coffee, please.
 *   side: Dutch
 *   Ik wil graag een koffie.
 *   note: "Graag" makes it polite.    (optional)
 *   topic: 4:17                       (optional: offers Add card)
 *   ```
 *
 * Two sides, never three: comparison research pairs cases (Alfieri, Nokes-
 * Malach & Schunn 2013; Rittle-Johnson & Star), and a third column would not
 * fit a phone. A side holds markdown, maths, or code in a fence of its own.
 *
 * Lenient on purpose, as every assistant block is (small local models, no
 * constrained decoding): `a:`/`b:`, `left:`/`right:`, `before:`/`after:`,
 * `original:`/`translation:` all name a side, and a line inside a side's code
 * fence is code even when it looks like `note: …`. What cannot be read as two
 * sides is given back to the answer as prose, so nothing the model wrote is
 * lost and no fence source is ever drawn.
 *
 * Remark closes a ``` fence at the first bare ``` line, which is the closer of
 * the first code fence INSIDE a side. So a block is found here, by lines, and
 * written back with a fence longer than any inside it; the Markdown renderer
 * then sees one `compare` code block and draws the card from its text.
 */

/** The words a side may be named by, beyond `side`/`a`/`b`. Each says what
 *  the side IS, so a side named only by one of them is labelled with it. */
export const SIDE_ROLES = ['before', 'after', 'original', 'translation', 'wrong', 'correct'] as const;
export type SideRole = typeof SIDE_ROLES[number];

export interface CompareSide {
    /** As the model wrote it; empty when it named none. */
    label: string;
    /** When the side was named by what it is (`before:`), and no label given. */
    role: SideRole | null;
    kind: 'text' | 'code';
    /** The code's language, as written (`py`, `JavaScript`); null for text. */
    lang: string | null;
    /** Markdown for a text side; the code alone, without its fence, for code. */
    text: string;
}

export interface CompareBlock {
    title: string | null;
    sides: [CompareSide, CompareSide];
    note: string | null;
    /** Where Add card puts the pair, when the model offered one. */
    topic: { projectId: number; nodeId: number } | null;
}

/** Per side. Above it the block is prose: a card is for two short texts. */
export const COMPARE_SIDE_MAX = 4000;
export const COMPARE_TITLE_MAX = 120;
export const COMPARE_LABEL_MAX = 60;
export const COMPARE_NOTE_MAX = 600;
/** Cards a message draws; a block after the third is prose. */
export const MAX_COMPARES = 3;
/** Matches the server's `CARD_SIDE_MAX` (server/assistantWrites.js): a pair
 *  longer than this is shown but not offered as a card. */
const CARD_SIDE_MAX = 2000;

/** English words for a role, for a Copy (English like the rest of a Copy's
 *  scaffolding, `writeBlocksAsText`); the card itself says them translated. */
export const ROLE_WORDS: Record<SideRole, string> = {
    before: 'Before', after: 'After', original: 'Original', translation: 'Translation', wrong: 'Wrong', correct: 'Correct',
};

const ROLE_ALIASES: Record<string, SideRole> = {
    before: 'before', after: 'after', original: 'original', source: 'original',
    translation: 'translation', translated: 'translation',
    wrong: 'wrong', incorrect: 'wrong', mistake: 'wrong',
    correct: 'correct', corrected: 'correct', fixed: 'correct', better: 'correct',
};
/** Names that say only "a side". The short ones (`a:`, `to:`) also start
 *  ordinary lines, a dialogue's `A: Hello` or `b: int = 3`, so a block they
 *  read as more than two sides is read again without them (`LOOSE_SIDE_KEYS`). */
const SIDE_KEYS = new Set([
    'side', 'side-a', 'side-b', 'side-1', 'side-2', 'a', 'b', 'left', 'right', 'first', 'second', 'from', 'to',
]);
const LOOSE_SIDE_KEYS = new Set(['a', 'b', 'left', 'right', 'first', 'second', 'from', 'to']);
const OTHER_KEYS: Record<string, 'title' | 'note' | 'topic'> = {
    title: 'title', heading: 'title',
    note: 'note', why: 'note', tip: 'note', explanation: 'note',
    topic: 'topic', card: 'topic',
};
const own = <T>(table: Record<string, T>, key: string): T | null =>
    (Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null);
const roleOfKey = (key: string) => own(ROLE_ALIASES, key);
const otherOfKey = (key: string) => own(OTHER_KEYS, key);

const keyOf = (raw: string) => raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
const KEY_LINE = /^[ \t]*([A-Za-z][A-Za-z0-9 _-]{0,20}?)[ \t]*:[ \t]?(.*)$/;
/** A code fence's line: its run of backticks or tildes, and what follows it. */
const FENCE_LINE = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;
const OPENER = /^[ \t]{0,3}(`{3,})[ \t]*(compare|comparison)[ \t]*$/i;
/** A side's name and its text on one line: `side: Dutch: Hallo`. */
const NAME_AND_TEXT = /^([^:\n]{1,30}):\s+(\S[\s\S]*)$/;

const closes = (line: string, marker: string) => {
    const m = line.match(FENCE_LINE);
    return !!m && m[1][0] === marker[0] && m[1].length >= marker.length && !m[2].trim();
};

type Field = { key: string; value: string; lines: string[] };

const isSideKey = (key: string, strict = false) => (SIDE_KEYS.has(key) && !(strict && LOOSE_SIDE_KEYS.has(key))) || roleOfKey(key) !== null;

const isFieldLine = (line: string) => {
    const m = line.match(KEY_LINE);
    const key = m ? keyOf(m[1]) : '';
    return !!m && (isSideKey(key) || otherOfKey(key) !== null);
};

/**
 * The block's `key: value` fields in order, each running on until the next
 * key; a line inside a code fence is never a key. A title, note or topic line
 * between the two sides is the first side's text (they come before or after
 * the pair). `preamble` is what came before the first key.
 */
function fieldsOf(inner: string, strict = false): { preamble: string; fields: Field[] } {
    const fields: Field[] = [];
    const preamble: string[] = [];
    let current: Field | null = null;
    let fence: string | null = null;
    let sides = 0;
    const push = (line: string) => (current ? current.lines.push(line) : preamble.push(line));
    for (const line of inner.split('\n')) {
        if (fence) {
            push(line);
            if (closes(line, fence)) fence = null;
            continue;
        }
        const f = line.match(FENCE_LINE);
        if (f) {
            fence = f[1];
            push(line);
            continue;
        }
        const m = line.match(KEY_LINE);
        const key = m ? keyOf(m[1]) : '';
        const side = !!m && isSideKey(key, strict);
        if (side || (m && otherOfKey(key) !== null && sides !== 1)) {
            if (side) sides++;
            current = { key, value: m![2].trim(), lines: [] };
            fields.push(current);
        } else {
            push(line);
        }
    }
    return { preamble: preamble.join('\n').trim(), fields };
}

/** The fields of a block read as two sides when it can be: first with every
 *  side name, then without the short ones that also start ordinary lines. */
function blockFields(inner: string) {
    const loose = fieldsOf(inner);
    const count = (fs: Field[], strict: boolean) => fs.filter(f => isSideKey(f.key, strict)).length;
    if (count(loose.fields, false) === 2) return { ...loose, strict: false };
    const tight = fieldsOf(inner, true);
    return count(tight.fields, true) === 2 ? { ...tight, strict: true } : { ...loose, strict: false };
}

const oneLine = (s: string, max: number) => {
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

const dedent = (lines: string[]) => {
    const indents = lines.filter(l => l.trim()).map(l => l.match(/^[ \t]*/)![0].length);
    const cut = indents.length ? Math.min(...indents) : 0;
    return lines.map(l => l.slice(Math.min(cut, l.match(/^[ \t]*/)![0].length)));
};

/** Languages a side's LABEL may name, which make an unfenced side code. Not
 *  every highlighter grammar: `markdown` and `latex` sides are prose. */
const CODE_LABELS: Record<string, string> = {
    python: 'python', py: 'python', javascript: 'javascript', js: 'javascript', typescript: 'typescript', ts: 'typescript',
    java: 'java', c: 'c', 'c++': 'cpp', cpp: 'cpp', 'c#': 'csharp', csharp: 'csharp', go: 'go', golang: 'go',
    rust: 'rust', ruby: 'ruby', php: 'php', swift: 'swift', kotlin: 'kotlin', sql: 'sql', bash: 'bash', shell: 'bash',
    r: 'r', matlab: 'matlab', lua: 'lua', haskell: 'haskell', html: 'html', css: 'css', json: 'json', yaml: 'yaml',
};

function sideOf(field: Field): CompareSide | null {
    const role = roleOfKey(field.key);
    const body = field.lines.join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
    let label = field.value;
    let content = body;
    // `before: I goed home` names the side by what it is and puts the text
    // on the key line; `side: English` with lines under it is a label.
    if (!content.trim()) {
        content = label;
        label = '';
        // `side: English: I would like a coffee`, the name and the text on one line.
        const pair = role ? null : content.match(NAME_AND_TEXT);
        if (pair && pair[1].trim().split(/\s+/).length <= 3) {
            label = pair[1];
            content = pair[2];
        }
    }
    if (!content.trim()) return null;
    label = oneLine(label, COMPARE_LABEL_MAX);
    // A side that is ONE fence is code; anything around the fence makes it
    // markdown that holds a code block, drawn as such.
    const lines = content.split('\n');
    const open = lines[0].match(FENCE_LINE);
    if (open && open[1][0] === '`' && lines.length >= 2) {
        const end = lines.findIndex((l, i) => i > 0 && closes(l, open[1]));
        const rest = end > 0 ? lines.slice(end + 1).join('\n').trim() : '';
        if (end === -1 || !rest) {
            const code = lines.slice(1, end === -1 ? undefined : end);
            const lang = open[2].trim().split(/\s+/)[0] || CODE_LABELS[label.toLowerCase()] || null;
            const text = code.join('\n').replace(/^\n+|\s+$/g, '');
            if (!text.trim()) return null;
            return { label, role: label ? null : role, kind: 'code', lang, text };
        }
    }
    const named = CODE_LABELS[label.toLowerCase()];
    if (named) return { label, role: null, kind: 'code', lang: named, text: dedent(lines).join('\n').replace(/^\n+|\s+$/g, '') };
    return { label, role: label ? null : role, kind: 'text', lang: null, text: content.trim() };
}

const asId = (raw: string): number | null => {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
};

/** One block's text, between its fences, as a card; null when it is not two sides. */
export function parseCompare(inner: string): CompareBlock | null {
    if (typeof inner !== 'string' || !inner.trim()) return null;
    const { preamble, fields, strict } = blockFields(inner.replace(/\r\n?/g, '\n'));
    const sideFields = fields.filter(f => isSideKey(f.key, strict));
    if (sideFields.length !== 2) return null;
    const sides = sideFields.map(sideOf);
    if (!sides[0] || !sides[1]) return null;
    if (sides.some(s => s!.text.length > COMPARE_SIDE_MAX)) return null;
    const first = (k: string) => fields.find(f => otherOfKey(f.key) === k);
    const fieldText = (f: Field | undefined) => (f ? [f.value, ...f.lines].join('\n').trim() : '');
    // Words before the first key: one short line with no title is the title
    // (`Ordering politely` without its key); anything else is not a card, so
    // the block is given back as prose and nothing is lost.
    const titled = first('title');
    if (preamble && (titled || preamble.includes('\n') || preamble.length > COMPARE_TITLE_MAX)) return null;
    const title = oneLine(titled ? fieldText(titled) : preamble, COMPARE_TITLE_MAX) || null;
    const rawNote = fieldText(first('note'));
    const note = rawNote ? (rawNote.length > COMPARE_NOTE_MAX ? `${rawNote.slice(0, COMPARE_NOTE_MAX - 1).trimEnd()}…` : rawNote) : null;
    const ids = (first('topic')?.value ?? '').match(/^(\d+)\s*:\s*(\d+)$/);
    const projectId = ids ? asId(ids[1]) : null;
    const nodeId = ids ? asId(ids[2]) : null;
    return {
        title,
        sides: [sides[0], sides[1]],
        note,
        topic: projectId !== null && nodeId !== null ? { projectId, nodeId } : null,
    };
}

/** A side as markdown: a code side in a fence of its own. */
export function sideMarkdown(side: CompareSide): string {
    if (side.kind === 'text') return side.text;
    const run = Math.max(3, ...[...side.text.matchAll(/^[ \t]*(`{3,})/gm)].map(m => m[1].length + 1));
    const fence = '`'.repeat(run);
    return `${fence}${side.lang ?? ''}\n${side.text}\n${fence}`;
}

/** What a side is called in English, for a Copy. */
const sideName = (s: CompareSide) => s.label || (s.role ? ROLE_WORDS[s.role] : '');

/** The block as a person would paste it: each side under its name, then the note. */
export function compareAsText(block: CompareBlock): string {
    const side = (s: CompareSide) => (sideName(s) ? `${sideName(s)}:\n${sideMarkdown(s)}` : sideMarkdown(s));
    return [block.title, side(block.sides[0]), side(block.sides[1]), block.note].filter(Boolean).join('\n\n');
}

/** A block that is not a card, given back as what it says. */
function compareAsProse(inner: string): string {
    const { preamble, fields } = fieldsOf(inner);
    if (!fields.length) return inner.trim();
    // Every word the model wrote, uncut: only the topic's ids are dropped.
    const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
    const parts: string[] = [preamble];
    for (const f of fields) {
        const role = roleOfKey(f.key);
        const other = otherOfKey(f.key);
        const body = f.lines.join('\n').trim();
        if (other === 'topic') continue;
        if (other === 'title') { parts.push(`**${flat([f.value, body].join(' '))}**`); continue; }
        if (other) { parts.push([f.value, body].filter(Boolean).join('\n')); continue; }
        const label = body ? f.value : (role ? ROLE_WORDS[role] : '');
        const text = body || f.value;
        parts.push([label && `**${flat(label)}**`, text].filter(Boolean).join('\n\n'));
    }
    return parts.filter(Boolean).join('\n\n');
}

/** Languages a side's name is matched against. */
const LANG_CODES = ['en', 'nl', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'tr', 'ru', 'uk', 'ar', 'ja', 'zh', 'ko', 'sv', 'da', 'nb', 'fi', 'cs', 'sk',
    'hu', 'ro', 'bg', 'el', 'he', 'hi', 'id', 'vi', 'th', 'fa', 'hr', 'sr', 'sl', 'lt', 'lv', 'et', 'ca', 'eu', 'af', 'sw', 'ms'];
const langNames = new Map<string, Map<string, string>>();
/**
 * The language a side is named after ("Dutch", "Nederlands", "néerlandais"
 * in a French interface), or undefined for a name that is not a language.
 */
export function langOfLabel(label: string, ui = 'en'): string | undefined {
    const name = label.trim().toLowerCase();
    if (!name || name.length > 30 || typeof Intl === 'undefined' || !('DisplayNames' in Intl)) return undefined;
    let names = langNames.get(ui);
    if (!names) {
        names = new Map();
        for (const code of LANG_CODES) {
            for (const locale of [ui, 'en', code]) {
                try {
                    const n = new Intl.DisplayNames([locale], { type: 'language' }).of(code);
                    if (n && n !== code) names.set(n.toLowerCase(), code);
                } catch { /* a locale this runtime lacks */ }
            }
        }
        langNames.set(ui, names);
    }
    return names.get(name);
}

/**
 * Whether the pair is a text and its translation: named original/translation,
 * or after two different languages. A learner cannot judge a sentence in a
 * language they cannot read yet, so Add card checks such a pair both ways.
 */
export function isTranslation(block: CompareBlock, ui = 'en'): boolean {
    const [a, b] = block.sides;
    if (a.kind !== 'text' || b.kind !== 'text') return false;
    const roles = new Set([a.role, b.role]);
    if (roles.has('original') && roles.has('translation')) return true;
    const la = langOfLabel(a.label, ui);
    const lb = langOfLabel(b.label, ui);
    return !!la && !!lb && la !== lb;
}

const OLD_ROLES = new Set<SideRole>(['before', 'wrong']);
const NEW_ROLES = new Set<SideRole>(['after', 'correct']);

/** A side's role: the key it was named by, or a name that is a role word
 *  ("Wrong", "Corrected"; `roleWords` adds the interface language's). */
export function sideRole(side: CompareSide, roleWords?: ReadonlyMap<string, SideRole>): SideRole | null {
    if (side.role) return side.role;
    const name = side.label.trim().toLowerCase().replace(/[.:!]+$/, '');
    return roleOfKey(name) ?? roleWords?.get(name) ?? null;
}

/**
 * Which side is the earlier or wrong version when the pair is an edit (0 or
 * 1), or null when it is not one: two registers, two spellings, two
 * languages. The model may write the fix first, so the marks and the card go
 * by what each side is, never by where it stands.
 */
export function editOrder(block: CompareBlock, roleWords?: ReadonlyMap<string, SideRole>): 0 | 1 | null {
    const [a, b] = block.sides.map(s => sideRole(s, roleWords));
    if ((a && OLD_ROLES.has(a)) || (b && NEW_ROLES.has(b))) return 0;
    if ((b && OLD_ROLES.has(b)) || (a && NEW_ROLES.has(a))) return 1;
    return null;
}

export interface CompareCardProposal {
    projectId: number; nodeId: number; front: string; back: string; extra: string | null;
    /** A translation asked the other way round, for the check only: the
     *  cold check answers a card's front, so on its own it proves the back. */
    reverse: { front: string; back: string } | null;
}

/**
 * The card a pair makes, through the assistant's ONE card door
 * (`POST /api/assistant/cards`): the first side asks, the second answers, and
 * the side names say which way ("English → Dutch"). An edit asks with its
 * wrong or earlier version wherever the model put it, so the answer is the
 * fix. Null when the pair has no topic, or is too long for a card.
 */
export function compareCard(block: CompareBlock, ui = 'en', roleWords?: ReadonlyMap<string, SideRole>): CompareCardProposal | null {
    if (!block.topic) return null;
    const [a, b] = editOrder(block, roleWords) === 1 ? [block.sides[1], block.sides[0]] : block.sides;
    const way = (x: CompareSide, y: CompareSide) => (sideName(x) && sideName(y) ? `*${sideName(x)} → ${sideName(y)}*\n\n` : '');
    const front = `${way(a, b)}${sideMarkdown(a)}`;
    const back = sideMarkdown(b);
    if (front.length > CARD_SIDE_MAX || back.length > CARD_SIDE_MAX) return null;
    const reverse = isTranslation(block, ui) ? { front: `${way(b, a)}${sideMarkdown(b)}`, back: sideMarkdown(a) } : null;
    return { ...block.topic, front, back, extra: block.note, reverse };
}

/** A check's verdict, as `/api/assistant/checks` returns it. */
export interface CheckVerdict { verdict: string; reason?: string | null; detail?: unknown }

/**
 * The one verdict Add card shows for a pair: the card's own check, and for a
 * translation the reverse one too. A translation is offered only when both
 * ways agree; one that could not be checked is not offered, since the learner
 * cannot catch a wrong sentence and the reviews would bring it back for
 * months. Anything else that could not be checked stays offered and says so,
 * as a prepared card does. Undefined while a check is still running.
 */
export function compareCheck<T extends CheckVerdict>(checks: readonly (T | undefined)[] | null, translation: boolean): T | CheckVerdict | undefined {
    if (!checks || !checks.length) return undefined;
    const forward = checks[0];
    // A failed request answers with one verdict for every card it asked about.
    const back = translation ? (checks.length > 1 ? checks[1] : forward) : null;
    if (!forward || (translation && !back)) return undefined;
    if (forward.verdict === 'disputed') return forward;
    if (back?.verdict === 'disputed') return { verdict: 'disputed', reason: `asked the other way round, ${back.reason ?? 'a second model disagreed'}` };
    if (translation && (forward.verdict !== 'ok' || back?.verdict !== 'ok')) {
        const why = forward.verdict !== 'ok' ? forward.reason : back?.reason;
        return { verdict: 'disputed', reason: `the translation could not be checked${why ? ` (${why})` : ''}` };
    }
    return forward;
}

export interface PreparedCompare {
    /** The text with every card written as one long fence, and every other
     *  block as prose. */
    body: string;
    /** A card still arriving: held back, so its half-written source is never drawn. */
    pending: { chars: number } | null;
}

/**
 * Find every ```compare block in an answer. A card is rewritten with a fence
 * remark will not close early; what is not a card becomes prose. While
 * streaming, an unclosed block is held back; once settled, a block the model
 * forgot to close runs to the end of the answer, as the card fence's does.
 */
export function prepareCompareFences(content: string, streaming = false): PreparedCompare {
    if (typeof content !== 'string' || !/compar/i.test(content) || !content.includes('```')) return { body: content, pending: null };
    // A provider may send CRLF; the lines are read without it, and an answer
    // with no card comes back exactly as it was.
    const lines = content.split(/\r?\n/);
    const out: string[] = [];
    let cards = 0;
    let found = false;
    // A fence of the answer's own, which may QUOTE a card (a ````markdown
    // example): nothing inside it is a card.
    let outer: string | null = null;
    for (let i = 0; i < lines.length; i++) {
        if (outer) {
            out.push(lines[i]);
            if (closes(lines[i], outer)) outer = null;
            continue;
        }
        const open = lines[i].match(OPENER);
        if (!open) {
            const f = lines[i].match(FENCE_LINE);
            if (f) outer = f[1];
            out.push(lines[i]);
            continue;
        }
        found = true;
        // The outer fence ends at a bare fence at least as long, unless a side's
        // own code fence is open, or the line opens one: a bare fence straight
        // under a side's name starts that side's code.
        let end = -1;
        let fence: string | null = null;
        // The last line named a side with a label (`side: Python`), so a bare
        // fence under it may open that side's code rather than close the block.
        let named = false;
        const nextText = (from: number) => {
            for (let k = from; k < lines.length; k++) if (lines[k].trim()) return k;
            return -1;
        };
        for (let j = i + 1; j < lines.length; j++) {
            const line = lines[j];
            if (fence) { if (closes(line, fence)) fence = null; continue; }
            const f = line.match(FENCE_LINE);
            if (f) {
                if (!f[2].trim() && f[1][0] === '`' && f[1].length >= open[1].length) {
                    // It opens code only when what follows reads as code, closed
                    // by a fence after which the block goes on (a key, or the
                    // block's own closer); still arriving, it is held back.
                    let codeFollows = false;
                    if (named) {
                        const first = nextText(j + 1);
                        if (first === -1) codeFollows = streaming;
                        else if (!isFieldLine(lines[first])) {
                            let shut = -1;
                            for (let k = first + 1; k < lines.length; k++) if (closes(lines[k], f[1])) { shut = k; break; }
                            const after = shut === -1 ? -1 : nextText(shut + 1);
                            codeFollows = shut === -1 || after === -1
                                ? streaming
                                : isFieldLine(lines[after]) || closes(lines[after], open[1]);
                        }
                    }
                    if (!codeFollows) { end = j; break; }
                }
                fence = f[1];
                named = false;
                continue;
            }
            if (line.trim()) {
                const m = line.match(KEY_LINE);
                const value = m ? m[2].trim() : '';
                named = !!m && SIDE_KEYS.has(keyOf(m[1])) && !!value && value.length <= COMPARE_LABEL_MAX && !NAME_AND_TEXT.test(value);
            }
        }
        if (end === -1 && streaming) {
            const rest = lines.slice(i + 1).join('\n');
            return { body: out.join('\n').replace(/\s+$/, ''), pending: { chars: rest.length } };
        }
        const inner = lines.slice(i + 1, end === -1 ? undefined : end).join('\n');
        const block = cards < MAX_COMPARES ? parseCompare(inner) : null;
        if (block) {
            cards++;
            const longest = Math.max(3, ...[...inner.matchAll(/^[ \t]*(`{3,})/gm)].map(m => m[1].length));
            const run = '`'.repeat(longest + 1);
            out.push(`${run}compare`, inner, run);
        } else {
            const prose = compareAsProse(inner);
            if (prose) out.push('', prose, '');
        }
        i = end === -1 ? lines.length : end;
    }
    return { body: found ? out.join('\n') : content, pending: null };
}

/** Every card in an answer as text, for Copy (`readableAnswer`). */
export function compareBlocksAsText(content: string): string {
    const prepared = prepareCompareFences(content).body;
    if (prepared === content && !/^`{4,}compare$/m.test(prepared)) return content;
    return prepared.replace(/^(`{4,})compare\n([\s\S]*?)\n\1$/gm, (_m, _run: string, inner: string) => {
        const block = parseCompare(inner);
        return block ? compareAsText(block) : inner;
    });
}

/** Topic ids the answer's cards would add to, for the drawer's one label lookup. */
export function compareTopicIds(content: string): number[] {
    const prepared = prepareCompareFences(content).body;
    const ids: number[] = [];
    for (const m of prepared.matchAll(/^(`{4,})compare\n([\s\S]*?)\n\1$/gm)) {
        const t = parseCompare(m[2])?.topic;
        if (t) ids.push(t.nodeId);
    }
    return ids;
}

// ---------------------------------------------------------------------------
// What changed between two versions of a sentence
// ---------------------------------------------------------------------------

export interface DiffRun { text: string; changed: boolean }

const TOKEN = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*|\s+|[^\s\p{L}\p{N}]/gu;
const isWord = (t: string) => /[\p{L}\p{N}]/u.test(t);
/** Markdown a side would lose if it were drawn as marked words. */
const MARKDOWN_SIGNS = /[`$*_#|<>[\]~\\]|^\s*(?:[-+]|\d+[.)])\s|\n\s*\n/m;
const DIFF_TOKENS_MAX = 300;

/**
 * The words each side has that the other lacks, when marking them helps: two
 * versions of one plain sentence that share most of their words. A translation
 * shares few, code is not words, and markdown would be lost, so those get
 * nothing (null) and are drawn as they are. GitHub marks changed words the same
 * way; the share is the readable-or-not test that keeps unrelated text quiet.
 */
export function wordDiff(a: CompareSide, b: CompareSide): [DiffRun[], DiffRun[]] | null {
    if (a.kind !== 'text' || b.kind !== 'text') return null;
    if (MARKDOWN_SIGNS.test(a.text) || MARKDOWN_SIGNS.test(b.text)) return null;
    const ta = a.text.match(TOKEN) ?? [];
    const tb = b.text.match(TOKEN) ?? [];
    if (!ta.length || !tb.length || ta.length > DIFF_TOKENS_MAX || tb.length > DIFF_TOKENS_MAX) return null;
    // Longest common subsequence over the tokens, case-sensitive: a capital
    // fixed is a change worth seeing.
    const n = ta.length, m = tb.length;
    const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const keepA = new Array<boolean>(n).fill(false);
    const keepB = new Array<boolean>(m).fill(false);
    for (let i = 0, j = 0; i < n && j < m;) {
        if (ta[i] === tb[j]) { keepA[i] = true; keepB[j] = true; i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
        else j++;
    }
    const wordsA = ta.filter(isWord).length;
    const wordsB = tb.filter(isWord).length;
    const shared = ta.filter((t, i) => keepA[i] && isWord(t)).length;
    if (!wordsA || !wordsB || (2 * shared) / (wordsA + wordsB) < 0.5) return null;
    if (keepA.every(Boolean) && keepB.every(Boolean)) return null;
    const runs = (tokens: string[], keep: boolean[]): DiffRun[] => {
        const out: DiffRun[] = [];
        tokens.forEach((t, i) => {
            // Space between two changed words belongs to the change; space
            // beside a kept word is kept, so a mark never starts with a gap.
            const changed = !keep[i] && (isWord(t) || /\S/.test(t))
                || (/^\s+$/.test(t) && !keep[i] && i > 0 && i < tokens.length - 1 && !keep[i - 1] && !keep[i + 1]);
            const last = out[out.length - 1];
            if (last && last.changed === changed) last.text += t;
            else out.push({ text: t, changed });
        });
        return out;
    };
    return [runs(ta, keepA), runs(tb, keepB)];
}

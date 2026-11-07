/**
 * What the global assistant may PREPARE, which the learner presses.
 *
 *   [[check:PROJECT_ID:NODE_ID]]   open the app's own mastery check on a topic
 *   ```card  topic/front/back ```  preview a flashcard, with an Add button
 *   ```capture  text ```           preview a note, with a Save-to-Inbox button
 *   ```report  kind/title/fields ``` preview a problem report, with a Review
 *                                  button that opens Report a problem filled in
 *   ```project  project/name/icon/colour/description/status/new cards per day ```
 *                                  preview a change to a course, with Apply
 *   ```topic  topic/title ```      preview a topic's new title, with Apply
 *   ```link  topic/url/title ```   preview a page to save on a topic, with Save
 *   ```course  name/goal/language ``` a new course, opened in the New course
 *                                  dialog filled in — nothing is written there
 *                                  until the learner presses Create
 *   ```wrong  item/reason/note/rewrite ``` an item on their screen reported as
 *                                  wrong, with a Report button (or `undo: N`
 *                                  to take report N back) — the same request
 *                                  the item's own flag sends
 *
 * A change to a course or a topic is judged by the SAME rules the server
 * applies (`server/projectFields.js`, imported here): an icon the app has no
 * drawing of is named as refused in the preview, never drawn as a word, and
 * never sent.
 *
 * Same contract as every other marker (tutorActions.ts): the model names ids
 * and writes content, the APP resolves the ids through /api/nodes/labels and
 * supplies every word on the buttons, and anything malformed is stripped and
 * draws nothing. What is different is that these WRITE, so none of them applies
 * on its own — unlike `[[set:…]]`, whose changes are visible the instant they
 * land and undone in one tap, a card or a note changes what the learner will be
 * asked later, and they should see it before it exists.
 *
 * A card is a FENCE rather than a `[[…]]` marker because a card carries
 * content: `$|x|$`, a `]]`, several lines. A marker's one-line grammar cannot
 * hold that, and a fence can. The fence never reaches the markdown renderer —
 * it is split out here, and a half-arrived one is hidden while it streams.
 */

import { REPORT_FORMS, type ReportDraft, type ReportKind } from './report';
import { isItemRef, REPORT_NOTE_MAX, REPORT_REASONS, type ReportReason } from './itemReports';
import {
    newPerDay, projectColour, projectDescription, projectIconName, projectName, projectStatus, topicTitle,
} from '../../server/projectFields.js';

export interface CheckTarget {
    projectId: number;
    nodeId: number;
}

export interface CardProposal {
    projectId: number;
    nodeId: number;
    front: string;
    back: string;
    extra: string | null;
}

/** Matches the server's `CARD_SIDE_MAX` (server/assistantWrites.js). */
const SIDE_MAX = 2000;
const MAX_CHECKS = 2;
const MAX_CARDS = 3;
const MAX_CAPTURES = 1;

const asId = (raw: string): number | null => {
    const n = Number(String(raw).trim());
    return Number.isInteger(n) && n > 0 ? n : null;
};

const tidy = (s: string) => s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');

/** `[[check:3:41]]`, matched loosely and validated after, like `[[open:…]]`. */
const CHECK_RE = /\[\[\s*check\s*:\s*([^\]:]*?)\s*:\s*([^\]:]*?)\s*\]\]/gi;
const PARTIAL_MARKER_RE = /\[\[[a-z0-9:-]*\]?$/i;

export function splitChecks(content: string, streaming = false): { body: string; checks: CheckTarget[] } {
    if (!content.includes('[[')) return { body: content, checks: [] };
    const checks: CheckTarget[] = [];
    let body = content.replace(CHECK_RE, (_m, pid: string, nid: string) => {
        const projectId = asId(pid);
        const nodeId = asId(nid);
        if (projectId !== null && nodeId !== null && checks.length < MAX_CHECKS && !checks.some(c => c.nodeId === nodeId)) {
            checks.push({ projectId, nodeId });
        }
        return '';
    });
    if (streaming) body = body.replace(PARTIAL_MARKER_RE, '');
    return { body: body === content ? content : tidy(body), checks };
}

/** A complete prepared block (```card, ```project, …), on lines of its own. */
const BLOCK_RE = /(^|\n)[ \t]*```[ \t]*(card|capture|report|project|topic|link|course|short|save|wrong)[ \t]*\n([\s\S]*?)\n?[ \t]*```[ \t]*(?=\n|$)/gi;
/** An opener with no closer after it: still arriving, or never closed. */
const OPEN_BLOCK_RE = /(^|\n)[ \t]*```[ \t]*(card|capture|report|project|topic|link|course|short|save|wrong)[ \t]*(?:\n([\s\S]*))?$/i;
/** A fence opener still being typed at the very end of a stream (`` ``ca ``). */
const PARTIAL_OPENER_RE = /(^|\n)[ \t]*`{1,3}[a-z]*$/i;

const FIELD_RE = /^[ \t]*(topic|front|back|extra)[ \t]*:[ \t]?(.*)$/i;

function parseCard(text: string): CardProposal | null {
    const fields: Record<string, string[]> = {};
    let current: string | null = null;
    for (const line of text.split('\n')) {
        const m = line.match(FIELD_RE);
        if (m && !(m[1].toLowerCase() in fields)) {
            current = m[1].toLowerCase();
            fields[current] = [m[2]];
        } else if (current) {
            fields[current].push(line);
        }
    }
    const value = (k: string) => (fields[k] ? fields[k].join('\n').trim() : '');
    const ids = value('topic').match(/^(\d+)\s*:\s*(\d+)$/);
    const front = value('front');
    const back = value('back');
    if (!ids || !front || !back || front.length > SIDE_MAX || back.length > SIDE_MAX) return null;
    const projectId = asId(ids[1]);
    const nodeId = asId(ids[2]);
    if (projectId === null || nodeId === null) return null;
    return { projectId, nodeId, front, back, extra: value('extra') || null };
}

/** A report the assistant drafted: the same shape the dialog edits. */
export type ReportProposal = ReportDraft;

const MAX_REPORTS = 1;
/** A title is one line; GitHub stops at 256. */
const TITLE_MAX = 200;
/** Per field. The link has its own budget and cuts visibly past it
 *  (report.ts), so this only bounds what a runaway model can put on screen. */
const REPORT_FIELD_MAX = 4000;

/** The words a model reaches for, onto the three kinds the forms have. */
const REPORT_KIND_ALIASES: Record<string, ReportKind> = {
    bug: 'bug', problem: 'bug', broken: 'bug', error: 'bug',
    content: 'content', 'ai-content': 'content', ai: 'content', wrong: 'content',
    idea: 'idea', request: 'idea', feature: 'idea', 'feature-request': 'idea',
};

/** `What happened`, `what_happened` and `what-happened` are one key. */
const reportKey = (raw: string) => raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
const REPORT_LINE_RE = /^[ \t]*([A-Za-z][A-Za-z _-]{0,40}?)[ \t]*:[ \t]?(.*)$/;

/**
 * Read a ```report block: `kind:`, `title:` and the form's text fields by
 * their issue-form id, each value free to run over several lines.
 *
 * The KIND decides which keys are fields, so it is found first: a line such as
 * "Expected: the first card" inside what-happened is text, not a field, and
 * `idea:` means a field only in an idea. The machine report (`environment`) is
 * never taken from the model — the app writes that half itself — and a kind
 * the forms do not have proposes nothing.
 */
function parseReport(text: string): ReportProposal | null {
    const lines = text.split('\n');
    let kind: ReportKind | null = null;
    for (const line of lines) {
        const m = line.match(REPORT_LINE_RE);
        if (m && reportKey(m[1]) === 'kind') {
            // `ai content`, `feature request`, and `bug (something is broken)`.
            const firstWord = m[2].toLowerCase().split(/[^a-z]+/).filter(Boolean)[0] ?? '';
            kind = REPORT_KIND_ALIASES[reportKey(m[2])] ?? REPORT_KIND_ALIASES[firstWord] ?? null;
            break;
        }
    }
    if (!kind) return null;
    const writable = new Set(REPORT_FORMS[kind].fields.filter(f => !f.auto).map(f => f.id));
    const seen: Record<string, string[]> = {};
    let current: string | null = null;
    for (const line of lines) {
        const m = line.match(REPORT_LINE_RE);
        const key = m ? reportKey(m[1]) : '';
        if (m && (key === 'kind' || key === 'title' || writable.has(key) || key === 'environment') && !(key in seen)) {
            current = key;
            seen[key] = [m[2]];
        } else if (current) {
            seen[current].push(line);
        }
    }
    const value = (k: string, max: number) => (seen[k] ? seen[k].join('\n').trim().slice(0, max).trim() : '');
    const title = value('title', TITLE_MAX).replace(/\s*\n\s*/g, ' ');
    const fields: Record<string, string> = {};
    for (const id of writable) {
        const v = value(id, REPORT_FIELD_MAX);
        if (v) fields[id] = v;
    }
    if (!title && !Object.keys(fields).length) return null;
    return { kind, title, fields };
}

/** A course field the assistant may propose a value for. */
export type ProjectField = 'name' | 'icon' | 'color' | 'description' | 'status' | 'new_per_day';
/** In the order a preview lists them. */
export const PROJECT_FIELDS: readonly ProjectField[] = ['name', 'icon', 'color', 'description', 'status', 'new_per_day'];
/** A field's name in a pasted answer (English, like the rest of a Copy's scaffolding). */
const PROJECT_FIELD_WORDS: Record<ProjectField, string> = {
    name: 'Name', icon: 'Icon', color: 'Colour', description: 'Description', status: 'Status', new_per_day: 'New cards a day',
};
/** A report's reason in a pasted answer (English, like the field names above). */
const WRONG_REASON_WORDS: Record<ReportReason, string> = {
    wrong: 'wrong', unclear: 'unclear', off_topic: 'off topic', other: 'something else',
};

export interface ProjectEditProposal {
    projectId: number;
    /** Each proposed value as the server will store it (`projectFields.js`). */
    changes: Partial<Record<ProjectField, string | number>>;
    /** What the block asked for that no rule accepts, as written: shown, never sent. */
    refused: { field: ProjectField; value: string }[];
}

export interface TopicEditProposal {
    projectId: number;
    nodeId: number;
    title: string;
}

export interface LinkProposal {
    projectId: number;
    nodeId: number;
    url: string;
    /** The model's name for the page; the page's OWN title replaces it once read. */
    title: string | null;
}

export interface CourseDraftProposal {
    name: string;
    goal: string;
    /** As written (a code or a language's name); the preview resolves it. */
    language: string | null;
    icon: string | null;
    color: string | null;
}

/**
 * A short course from one source in this conversation (server/shortCourses.js):
 * a file the learner attached or a link they pasted, with the topics the model
 * would make of it. Create writes it at once; there is no dialog in between,
 * because there is nothing left to fill in.
 */
export interface ShortCourseProposal {
    name: string;
    /** `file 12` (an attachment of this chat) or a URL, as the model wrote it. */
    from: string;
    icon: string | null;
    topics: string[];
}

/**
 * Which source a link is, for "was a course made from it": a YouTube video by
 * its id (every address form of it), anything else by host, path and query,
 * `www.` and a trailing slash aside. The query counts: every YouTube video is
 * `/watch`, and many sites name a page only in it.
 */
export function sourcePlace(u: string): string | null {
    try {
        const x = new URL(u.trim());
        if (!/^https?:$/.test(x.protocol)) return null;
        const host = x.hostname.toLowerCase().replace(/^(?:www|m)\./, '');
        const video = host === 'youtu.be' ? x.pathname.slice(1)
            : host === 'youtube.com' ? (x.searchParams.get('v') || x.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1] || '')
                : '';
        if (/^[\w-]{11}$/.test(video)) return `youtube:${video}`;
        // Each name and value encoded again: decoded, `?a=1%26b%3D2` and `?a=1&b=2` read the same.
        const query = [...x.searchParams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
        return `${host}${x.pathname.replace(/\/+$/, '')}${query ? `?${query}` : ''}`;
    } catch { return null; }
}

/**
 * The address a card shows for a link: all of what the app will open (host,
 * path and query, no scheme), so a link the assistant was talked into, one
 * carrying words from the conversation in its query, is seen before Create.
 * Null when `from` is not a web address.
 */
export function shownAddress(from: string): string | null {
    try {
        const x = new URL(from.trim());
        if (!/^https?:$/.test(x.protocol)) return null;
        const path = x.pathname === '/' ? '' : x.pathname;
        const raw = `${x.host.replace(/^www\./, '')}${path}${x.search}`;
        try { return decodeURI(raw); } catch { return raw; }
    } catch { return null; }
}

/**
 * A link as the learner typed it, made openable: a bare address
 * ("example.com/page") gets https, as the server's `parseLink` gives it; null
 * for whatever `parseLink` refuses (another scheme, spaces, a bare host with no
 * dotted name). tools/short-course-gates.mjs holds the two to the same answer.
 */
export function linkOf(from: string): string | null {
    const s = String(from ?? '').trim();
    if (!s || s.length > 4096 || /\s/.test(s)) return null;
    if (/^https?:\/\//i.test(s)) return s;
    // "example.com:8080/x" looks like a scheme to a URL parser; a real other
    // scheme ("javascript:", "file:") is not a link at all.
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^/:?#]+\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(s)) return null;
    const link = `https://${s.replace(/^\/\//, '')}`;
    try {
        const x = new URL(link);
        return x.protocol === 'https:' && /\.[a-z]{2,}$/i.test(x.hostname) ? link : null;
    } catch { return null; }
}

/**
 * The course a short-course card already made, so a card read again (a reload,
 * another device) says Created instead of offering Create a second time. The
 * server's own `once` rule (`existingShortCourse`): the same name and the same
 * source, a file by the chat attachment it was (its id and name), a link by
 * `sourcePlace`, the server's twin of which it must agree with. The server
 * stays the judge: a press still sends `once`.
 */
export function shortCourseMade<P extends { name: string; made_from?: string | null }>(
    projects: P[], proposal: Pick<ShortCourseProposal, 'name' | 'from'>, file?: { id: number; name: string } | null,
): P | undefined {
    const place = sourcePlace;
    const wanted = file ? null : place(linkOf(proposal.from) ?? '');
    if (!file && !wanted) return undefined;
    const name = proposal.name.trim();
    return projects.find(p => {
        if (!p.made_from || p.name.trim() !== name) return false;
        let from: { url?: string; file?: string; attachment?: number } | null = null;
        try { from = JSON.parse(p.made_from); } catch { return false; }
        if (!from) return false;
        return file ? !from.url && from.attachment === file.id && from.file === file.name : !!from.url && place(from.url) === wanted;
    });
}

/**
 * A card's remembered Create, while it still holds: once its course has been
 * seen among the projects, the course gone from them (deleted) means the card
 * offers Create again rather than Open on nothing. Marks `seen` on the entry.
 */
export function liveOutcome<O extends { projectId?: number; seen?: boolean }>(made: O | undefined, projects: { id: number }[]): O | undefined {
    if (!made || made.projectId == null) return made;
    const there = projects.some(p => p.id === made.projectId);
    if (there) made.seen = true;
    return there || !made.seen ? made : undefined;
}

/**
 * A file from this conversation, prepared to be saved into the library
 * (server/assistantEdits.js `saveAssistantAttachment`). The description is the
 * model's — written now, because this is where the words outlive the picture.
 */
export interface SaveProposal {
    attachmentId: number;
    to: { kind: 'topic'; projectId: number; nodeId: number } | { kind: 'course'; projectId: number } | { kind: 'inbox' };
    title: string | null;
    description: string;
}

const MAX_PROJECT_EDITS = 2;
const MAX_TOPIC_EDITS = 3;
const MAX_LINKS = 3;
const MAX_COURSES = 1;
const MAX_SAVES = 2;
/** Mirrors `SAVE_DESCRIPTION_MAX` on the server. */
const SAVE_DESCRIPTION_MAX = 8000;
/** A goal is the New course dialog's own field: a few sentences. */
const GOAL_MAX = 2000;

/**
 * The `key: value` lines of a block, each value free to run over several
 * lines until the next KNOWN key. `aliases` maps what a model writes
 * (`colour`, `new cards per day`) onto one key; a line whose key is not known,
 * or is already taken, is text of the field before it.
 */
function fieldsOf(text: string, aliases: Record<string, string>): Record<string, string> {
    const seen: Record<string, string[]> = {};
    let current: string | null = null;
    for (const line of text.split('\n')) {
        const m = line.match(REPORT_LINE_RE);
        const key = m ? aliases[reportKey(m[1])] : undefined;
        if (m && key && !(key in seen)) {
            current = key;
            seen[key] = [m[2]];
        } else if (current) {
            seen[current].push(line);
        }
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(seen)) out[k] = v.join('\n').trim();
    return out;
}

const PROJECT_ALIASES: Record<string, string> = {
    project: 'project', course: 'project',
    name: 'name', title: 'name',
    icon: 'icon',
    colour: 'color', color: 'color',
    description: 'description', goal: 'description',
    status: 'status',
    'new-cards-per-day': 'new_per_day', 'new-per-day': 'new_per_day', 'new-cards-a-day': 'new_per_day',
    'new-cards': 'new_per_day', 'cards-per-day': 'new_per_day',
};

/** Each field's rule, from `server/projectFields.js` — the server's own. */
const PROJECT_RULES: Record<ProjectField, (raw: string) => string | number | null> = {
    name: projectName,
    icon: projectIconName,
    color: projectColour,
    description: projectDescription,
    status: projectStatus,
    new_per_day: newPerDay,
};

function parseProject(text: string): ProjectEditProposal | null {
    const f = fieldsOf(text, PROJECT_ALIASES);
    const projectId = asId(f.project ?? '');
    if (projectId === null) return null;
    const changes: ProjectEditProposal['changes'] = {};
    const refused: ProjectEditProposal['refused'] = [];
    for (const field of PROJECT_FIELDS) {
        if (!(field in f)) continue;
        const raw = f[field];
        // An empty value proposes nothing: "description:" with nothing after
        // it is a model that ran out, not a request to clear the description.
        if (!raw) continue;
        const v = PROJECT_RULES[field](raw);
        if (v === null) refused.push({ field, value: raw.slice(0, 120) });
        else changes[field] = v;
    }
    if (!Object.keys(changes).length && !refused.length) return null;
    return { projectId, changes, refused };
}

/** `P:N`, the topic line every topic-bound block carries. */
const topicIds = (raw: string | undefined) => {
    const m = String(raw ?? '').match(/^(\d+)\s*:\s*(\d+)$/);
    if (!m) return null;
    const projectId = asId(m[1]);
    const nodeId = asId(m[2]);
    return projectId !== null && nodeId !== null ? { projectId, nodeId } : null;
};

function parseTopicEdit(text: string): TopicEditProposal | null {
    const f = fieldsOf(text, { topic: 'topic', title: 'title', name: 'title' });
    const ids = topicIds(f.topic);
    const title = topicTitle(f.title ?? '');
    return ids && title ? { ...ids, title } : null;
}

function parseLink(text: string): LinkProposal | null {
    const f = fieldsOf(text, { topic: 'topic', url: 'url', link: 'url', page: 'url', title: 'title', name: 'title' });
    const ids = topicIds(f.topic);
    const url = (f.url ?? '').trim();
    if (!ids || !url || /\s/.test(url) || url.length > 2000) return null;
    return { ...ids, url, title: (f.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || null };
}

function parseCourse(text: string): CourseDraftProposal | null {
    const f = fieldsOf(text, {
        name: 'name', title: 'name',
        goal: 'goal', description: 'goal',
        language: 'language', 'lessons-in': 'language', 'lessons-written-in': 'language',
        icon: 'icon', colour: 'color', color: 'color',
    });
    const name = projectName(f.name ?? '') ?? '';
    const goal = (f.goal ?? '').slice(0, GOAL_MAX).trim();
    if (!name && !goal) return null;
    return {
        name, goal,
        language: (f.language ?? '').trim().slice(0, 40) || null,
        icon: projectIconName(f.icon ?? ''),
        color: projectColour(f.color ?? ''),
    };
}

function parseShort(text: string): ShortCourseProposal | null {
    const f = fieldsOf(text, { name: 'name', title: 'name', from: 'from', source: 'from', icon: 'icon', topics: 'topics' });
    const name = projectName(f.name ?? '') ?? '';
    const from = (f.from ?? '').trim();
    const topics = (f.topics ?? '').split('\n')
        .map(l => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
        .filter(Boolean)
        .slice(0, 8);
    if (!name || !from || topics.length < 2) return null;
    return { name, from, icon: projectIconName(f.icon ?? ''), topics };
}

function parseSave(text: string): SaveProposal | null {
    const f = fieldsOf(text, {
        file: 'file', attachment: 'file', 'attachment-id': 'file', id: 'file',
        to: 'to', where: 'to', topic: 'to', into: 'to',
        title: 'title', name: 'title',
        description: 'description', 'what-it-shows': 'description',
    });
    const attachmentId = asId((f.file ?? '').replace(/^#/, ''));
    if (attachmentId === null) return null;
    const where = (f.to ?? '').trim();
    const ids = topicIds(where);
    const course = asId(where);
    const to: SaveProposal['to'] | null = /^inbox$/i.test(where) ? { kind: 'inbox' }
        : ids ? { kind: 'topic', ...ids }
            : course !== null ? { kind: 'course', projectId: course } : null;
    if (!to) return null;
    return {
        attachmentId,
        to,
        title: (f.title ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) || null,
        description: (f.description ?? '').trim().slice(0, SAVE_DESCRIPTION_MAX),
    };
}

/**
 * An item on the learner's screen the assistant found wrong, or a report it
 * offers to take back. The ref is one the drawer sent under WHERE THE LEARNER
 * IS RIGHT NOW; the server resolves it again on the press, so a ref of the
 * right shape that names nothing is refused there, and the card says so.
 */
export type WrongProposal =
    | { ref: string; reason: ReportReason; note: string | null; rewrite: boolean }
    | { undo: number };

const MAX_WRONGS = 1;

function parseWrong(text: string): WrongProposal | null {
    const f = fieldsOf(text, {
        item: 'ref', ref: 'ref',
        reason: 'reason',
        note: 'note', why: 'note',
        rewrite: 'rewrite', 'write-a-new-one': 'rewrite',
        undo: 'undo',
    });
    if (f.undo !== undefined) {
        const id = asId(f.undo.replace(/^#/, ''));
        return id === null ? null : { undo: id };
    }
    const ref = (f.ref ?? '').replace(/^\[|\]$/g, '').trim();
    if (!isItemRef(ref)) return null;
    const said = (f.reason ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    // A reason off the list is still a report: the learner presses, and a
    // refused press over one word would be the app's fault, not theirs.
    const reason: ReportReason = !said ? 'wrong' : (REPORT_REASONS as readonly string[]).includes(said) ? said as ReportReason : 'other';
    const note = (f.note ?? '').trim().slice(0, REPORT_NOTE_MAX) || null;
    return { ref, reason, note, rewrite: /^(yes|true|y|1)$/i.test((f.rewrite ?? '').trim()) };
}

/**
 * Split card, capture and report blocks out of an assistant message.
 *
 * Every block comes OUT, valid or not, so no fence source is ever drawn. While
 * streaming, an unclosed block is hidden and proposes nothing yet; once the
 * turn has settled, a block the model forgot to close runs to the end of the
 * message and is read like any other.
 */
export interface WriteBlocks {
    body: string;
    cards: CardProposal[];
    captures: string[];
    reports: ReportProposal[];
    projects: ProjectEditProposal[];
    topics: TopicEditProposal[];
    links: LinkProposal[];
    courses: CourseDraftProposal[];
    shorts: ShortCourseProposal[];
    saves: SaveProposal[];
    wrongs: WrongProposal[];
}

export function splitWriteBlocks(content: string, streaming = false): WriteBlocks {
    const none = { cards: [], captures: [], reports: [], projects: [], topics: [], links: [], courses: [], shorts: [], saves: [], wrongs: [] };
    if (!content.includes('`')) return { body: content, ...none };
    const cards: CardProposal[] = [];
    const captures: string[] = [];
    const reports: ReportProposal[] = [];
    const projects: ProjectEditProposal[] = [];
    const topics: TopicEditProposal[] = [];
    const links: LinkProposal[] = [];
    const courses: CourseDraftProposal[] = [];
    const shorts: ShortCourseProposal[] = [];
    const saves: SaveProposal[] = [];
    const wrongs: WrongProposal[] = [];
    const take = (kind: string, inner: string) => {
        const k = kind.toLowerCase();
        if (k === 'wrong') {
            const w = parseWrong(inner);
            if (w && wrongs.length < MAX_WRONGS) wrongs.push(w);
        } else if (k === 'save') {
            const s = parseSave(inner);
            if (s && saves.length < MAX_SAVES && !saves.some(x => x.attachmentId === s.attachmentId)) saves.push(s);
        } else if (k === 'card') {
            const card = parseCard(inner);
            if (card && cards.length < MAX_CARDS) cards.push(card);
        } else if (k === 'report') {
            const report = parseReport(inner);
            if (report && reports.length < MAX_REPORTS) reports.push(report);
        } else if (k === 'project') {
            // One change per course a message: two blocks for one course would
            // be two Apply buttons racing each other's "before".
            const p = parseProject(inner);
            if (p && projects.length < MAX_PROJECT_EDITS && !projects.some(x => x.projectId === p.projectId)) projects.push(p);
        } else if (k === 'topic') {
            const t = parseTopicEdit(inner);
            if (t && topics.length < MAX_TOPIC_EDITS && !topics.some(x => x.nodeId === t.nodeId)) topics.push(t);
        } else if (k === 'link') {
            const l = parseLink(inner);
            if (l && links.length < MAX_LINKS && !links.some(x => x.nodeId === l.nodeId && x.url === l.url)) links.push(l);
        } else if (k === 'course') {
            const c = parseCourse(inner);
            if (c && courses.length < MAX_COURSES) courses.push(c);
        } else if (k === 'short') {
            const s = parseShort(inner);
            if (s && shorts.length < MAX_COURSES) shorts.push(s);
        } else {
            const note = inner.trim();
            if (note && note.length <= SIDE_MAX && captures.length < MAX_CAPTURES) captures.push(note);
        }
    };
    let body = content.replace(BLOCK_RE, (_m, lead: string, kind: string, inner: string) => { take(kind, inner); return lead; });
    body = body.replace(OPEN_BLOCK_RE, (_m, lead: string, kind: string, inner = '') => {
        if (!streaming) take(kind, inner);
        return lead;
    });
    if (streaming) body = body.replace(PARTIAL_OPENER_RE, '$1');
    // Tidied only where something came out: a blank line inside someone's
    // code block is theirs.
    return { body: body === content ? content : tidy(body), cards, captures, reports, projects, topics, links, courses, shorts, saves, wrongs };
}

const words = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []));

/**
 * The learner's own card closest to a proposed front, when one is close enough
 * to be the same question. The model cannot see the topic's cards, so it
 * rewords one the learner already has ("which frequency changes?" came back as
 * "which frequency changes — the source's or the observed one?"), and the
 * server's exact-front check lets that through. Close = at least three-quarters
 * of the shorter front's words appear in the other; a hint, never a refusal.
 */
export function similarFront(proposed: string, existing: string[]): string | null {
    const mine = words(proposed);
    let best: string | null = null, bestScore = 0;
    for (const front of existing) {
        const theirs = words(front);
        const small = Math.min(mine.size, theirs.size);
        if (small < 3) continue;
        let shared = 0;
        for (const w of mine) if (theirs.has(w)) shared++;
        const score = shared / small;
        if (score >= 0.75 && score > bestScore) { best = front; bestScore = score; }
    }
    return best;
}

/**
 * The blocks as a person would paste them: a card as its two sides, a note as
 * its text, a report as its title and answers under the forms' own questions.
 * The preview shows them, so a Copy of the answer carries them — and the topic
 * line and the field ids are the app's, which mean nothing anywhere else.
 */
export function writeBlocksAsText(content: string): string {
    if (!content.includes('`')) return content;
    const asText = (kind: string, inner: string) => {
        if (kind.toLowerCase() === 'card') {
            const card = parseCard(inner);
            return card ? `Q: ${card.front}\nA: ${card.back}` : '';
        }
        if (kind.toLowerCase() === 'report') {
            const report = parseReport(inner);
            if (!report) return '';
            const form = REPORT_FORMS[report.kind];
            const answers = form.fields
                .filter(f => report.fields[f.id])
                .map(f => `${f.label}\n${report.fields[f.id]}`);
            return [`${form.name}: ${report.title}`.replace(/:\s*$/, ''), ...answers].join('\n\n');
        }
        // A change keeps its new values and loses its ids, which mean nothing
        // outside this app; a value no rule accepted is not carried either.
        if (kind.toLowerCase() === 'project') {
            const p = parseProject(inner);
            if (!p) return '';
            return PROJECT_FIELDS.filter(f => p.changes[f] !== undefined)
                .map(f => `${PROJECT_FIELD_WORDS[f]}: ${p.changes[f]}`).join('\n');
        }
        if (kind.toLowerCase() === 'topic') return parseTopicEdit(inner)?.title ?? '';
        if (kind.toLowerCase() === 'link') {
            const l = parseLink(inner);
            return l ? (l.title ? `${l.title}: ${l.url}` : l.url) : '';
        }
        if (kind.toLowerCase() === 'course') {
            const c = parseCourse(inner);
            return c ? [c.name, c.goal].filter(Boolean).join('\n') : '';
        }
        if (kind.toLowerCase() === 'save') {
            const s = parseSave(inner);
            return s ? [s.title, s.description].filter(Boolean).join('\n') : '';
        }
        // The ref names an item in this library only; the note is what a
        // person would have written. A copy is text with no press behind it,
        // so it says what was suggested, never that a report was filed.
        if (kind.toLowerCase() === 'wrong') {
            const w = parseWrong(inner);
            if (!w) return '';
            if ('undo' in w) return `Suggested: undo report ${w.undo}`;
            const head = `Suggested report (${WRONG_REASON_WORDS[w.reason]})`;
            return w.note ? `${head}: ${w.note}` : head;
        }
        return inner.trim();
    };
    const out = content
        .replace(BLOCK_RE, (_m, lead: string, kind: string, inner: string) => `${lead}${asText(kind, inner)}`)
        .replace(OPEN_BLOCK_RE, (_m, lead: string, kind: string, inner = '') => `${lead}${asText(kind, inner)}`);
    return out === content ? content : tidy(out);
}

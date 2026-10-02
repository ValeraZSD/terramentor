// What a chat turn is told about NOW: the clock in the learner's own time zone,
// when every earlier message in the conversation was sent, and what AI work is
// running on this machine at this moment.
//
// A leaf: no database, no network, no imports. The callers (server/chatTurn.js,
// server/routes/chat.js) read the task registry and the stored rows and hand
// them in, which is what
// lets tools/assistant-context-gates.mjs assert every line of it.
//
// Two rules shape it:
//
//   * It is VOLATILE, so it goes LAST. `chatNowBlock` is appended after the
//     stable system prompt, and the history stamps live in the history, so a
//     provider's prompt cache still covers everything above the changing tail.
//     Nothing here is cached between messages: each turn recomputes it.
//
//   * It is METADATA, never content. The stamp on an earlier message is
//     something the app wrote beside the learner's words, so a model must not
//     be able to write one back into a reply that is then stored. The system
//     text says so, `createStampFilter` keeps a leading stamp off the screen
//     while it streams, and `stripSendStamp` takes it off the stored row.
//
// The learner's time zone is UNTRUSTED input (a request field): it is checked
// against the platform's own zone database and anything else is UTC.

const STAMP_RE = /^\s*\[sent [^\]\n]{1,60}\][ \t]*\r?\n?/;
const STAMP_OPEN = '[sent ';

/**
 * The zone to read the clock in. A string the platform does not know is UTC —
 * never an error and never passed on to Intl unchecked. A missing one is the
 * server's own zone: this is a local app, and the machine that runs it is the
 * learner's.
 */
export function resolveTimeZone(raw) {
    if (raw === undefined || raw === null || raw === '') {
        try { return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
    }
    if (typeof raw !== 'string' || raw.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(raw)) return 'UTC';
    try {
        const resolved = new Intl.DateTimeFormat('en-US', { timeZone: raw }).resolvedOptions().timeZone || 'UTC';
        // The name the page sent stands (Asia/Kolkata, not the platform's older
        // alias for it); only a difference of letter case takes the canonical form.
        return resolved.toLowerCase() === raw.toLowerCase() ? resolved : raw;
    } catch {
        return 'UTC';
    }
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Wall-clock fields of an instant in a zone, and the zone's offset from UTC in minutes at that instant. */
function wallClock(ms, timeZone) {
    const parts = {};
    for (const p of new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ms))) parts[p.type] = p.value;
    const y = Number(parts.year), mo = Number(parts.month), d = Number(parts.day);
    const h = Number(parts.hour) % 24, mi = Number(parts.minute), s = Number(parts.second);
    const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
    const offsetMin = Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
    return { y, mo, d, h, mi, weekday: WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()], offsetMin };
}

const two = n => String(n).padStart(2, '0');

function offsetLabel(offsetMin) {
    const sign = offsetMin < 0 ? '-' : '+';
    const abs = Math.abs(offsetMin);
    return `UTC${sign}${two(Math.floor(abs / 60))}:${two(abs % 60)}`;
}

/** `2026-09-30 21:14` — the compact stamp an earlier message carries. */
export function formatStamp(ms, timeZone) {
    const w = wallClock(ms, timeZone);
    return `${w.y}-${two(w.mo)}-${two(w.d)} ${two(w.h)}:${two(w.mi)}`;
}

/** `2026-09-30 21:14 (Wednesday), Europe/Amsterdam, UTC+02:00` */
export function formatNowLine(ms, timeZone) {
    const w = wallClock(ms, timeZone);
    return `${w.y}-${two(w.mo)}-${two(w.d)} ${two(w.h)}:${two(w.mi)} (${w.weekday}), ${timeZone}, ${offsetLabel(w.offsetMin)}`;
}

/**
 * A stored `created_at` as an instant. SQLite's own default writes
 * `YYYY-MM-DD HH:MM:SS` in UTC with no marker; a row written by JS carries an
 * ISO `Z`. Both are read; anything else is null rather than a guess.
 */
export function parseStoredTime(value) {
    const at = String(value ?? '').trim();
    if (!at) return null;
    const iso = /Z$|[+-]\d\d:?\d\d$/.test(at) ? at : `${at.replace(' ', 'T')}Z`;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
}

/** A leading send-stamp taken off a text, whoever put it there. */
export function stripSendStamp(text) {
    return typeof text === 'string' ? text.replace(STAMP_RE, '') : text;
}

/**
 * The history as the MODEL sees it: each earlier message led by the time it was
 * sent, in the learner's zone. The stored row is untouched — this is built per
 * turn from `{ role, content, created_at }` rows and never written back. A row
 * with no readable time goes through unstamped rather than with an invented one.
 */
export function stampHistory(rows, timeZone) {
    return (Array.isArray(rows) ? rows : []).map(r => {
        const content = stripSendStamp(String(r?.content ?? ''));
        const ms = parseStoredTime(r?.created_at);
        return {
            role: r?.role,
            content: ms == null ? content : `[sent ${formatStamp(ms, timeZone)}]\n${content}`,
        };
    });
}

/**
 * Wrap a turn's `emit` so a reply that STARTS with a send-stamp never shows it.
 * Only the opening characters are ever held, and only while they could still
 * become `[sent …]`: an answer beginning with anything else (almost all of them
 * — including `[[open:…]]`) passes straight through, frame by frame. Frames
 * without a `chunk` are not touched. The stored text is cleaned separately by
 * `stripSendStamp`, so this is only about the screen while it streams.
 */
export function createStampFilter(emit) {
    let state = 'start';   // start → (holding) → pass
    let held = '';
    const out = (frame, chunk) => {
        const { chunk: _drop, ...rest } = frame;
        if (chunk) emit({ ...rest, chunk });
        else if (Object.keys(rest).length) emit(rest);
    };
    return frame => {
        if (state === 'pass' || !frame || typeof frame.chunk !== 'string' || !frame.chunk) return emit(frame);
        if (state === 'newline') {
            // The stamp's own line break arrived in a later chunk.
            state = 'pass';
            return out(frame, frame.chunk.replace(/^\r?\n/, ''));
        }
        held += frame.chunk;
        const lead = held.replace(/^\s+/, '');
        const couldBeStamp = lead.length < STAMP_OPEN.length
            ? STAMP_OPEN.startsWith(lead)
            : lead.startsWith(STAMP_OPEN);
        if (!couldBeStamp) { state = 'pass'; const text = held; held = ''; return out(frame, text); }
        const close = lead.indexOf(']');
        if (close === -1) {
            if (held.length > 90) { state = 'pass'; const text = held; held = ''; return out(frame, text); }
            return out(frame, '');            // still undecided: hold it
        }
        const text = stripSendStamp(held);
        // Stripped with nothing after the `]` yet: its line break is still to come.
        state = /^[ \t]*$/.test(held.slice(held.indexOf(']') + 1)) ? 'newline' : 'pass';
        held = '';
        return out(frame, text);
    };
}

// ---------------------------------------------------------------------------
// Running work
// ---------------------------------------------------------------------------

/** Kind → what it is doing, in words the model can repeat. */
const KIND_WORDS = {
    chat: 'Tutor chat',
    today_chat: 'Assistant chat',
    capture: 'Saving a captured note',
    quiz: 'Writing a quiz',
    mastery_check: 'Writing a mastery check',
    flashcards: 'Writing flashcards',
    visual: 'Drawing or repairing a visual',
    widget: 'Building an interactive widget',
    srs_optimize: 'Tuning spaced repetition',
    insights: 'Writing project insights',
    briefing: 'Writing the daily briefing',
    placement: 'Running a placement test',
    create_project: 'Creating a project with AI',
    bulk: 'Generating study material',
    embed: 'Indexing for search',
    media_describe: 'Describing imported pictures',
    recover: 'Recovering text from a PDF',
    feed: 'Preparing feed lessons',
    atlas: 'Naming atlas regions',
};

/** Kinds whose label is the learner's topic title rather than the app's own sentence. */
const TOPIC_LABEL_KINDS = new Set(['chat', 'quiz', 'mastery_check', 'flashcards']);

/** A creation's phase, and the generic ones a chat or a build reports. */
const PHASE_WORDS = {
    thinking: 'analysing the scope',
    thinking_done: 'analysing the scope',
    init: 'starting',
    summary: 'writing the summary',
    generating_categories: 'outlining the sections',
    categories_generated: 'outlining the sections',
    generating_elements: 'writing the topics',
    elements_generated: 'writing the topics',
    generating_sub_elements: 'writing the sub-topics',
    sub_elements_batched: 'writing the sub-topics',
    sub_elements_generated: 'writing the sub-topics',
    finding_resources: 'finding resources',
    resources_saved: 'finding resources',
    complete: 'finishing',
    loading_model: 'waiting for the model to load',
    generating: 'generating',
    verifying: 'checking what it wrote',
    draw: 'drawing',
};

export const WORK_CAP = 12;

/** One line of someone else's words, made safe to sit in a prompt. */
function clean(value, max) {
    const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[“”"`]/g, "'").replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function durationWords(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 45) return 'under a minute';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${h} h ${rest} min` : `${h} h`;
}

function number(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

/**
 * The tasks registry's summaries (and whatever else the caller found running),
 * as the lines the model reads. Tolerant on purpose: every field is optional,
 * an unknown kind is named by its key, and an item that is not an object is
 * skipped — the shape of a running generation is still being extended, and a
 * chat turn must never fail on a field it did not expect.
 *
 * Running work first, then what is queued, each oldest first; capped at `cap`
 * with the rest counted. Nothing here is logged anywhere: the names are the
 * learner's own titles, which ride to the model and nowhere else.
 */
export function runningWorkLines(items, { nowMs = Date.now(), cap = WORK_CAP } = {}) {
    const live = (Array.isArray(items) ? items : []).filter(t => t && typeof t === 'object'
        && (t.status === 'running' || t.status === 'queued'));
    const since = t => Date.parse(t.startedAt || t.createdAt || '') || nowMs;
    live.sort((a, b) => (a.status === b.status ? since(a) - since(b) : a.status === 'running' ? -1 : 1));

    const lines = live.slice(0, cap).map(t => {
        const kind = String(t.kind || 'task');
        const words = KIND_WORDS[kind] || clean(kind.replace(/_/g, ' '), 40) || 'Background task';
        const about = [];
        if (TOPIC_LABEL_KINDS.has(kind) && t.label) about.push(`topic '${clean(t.label, 60)}'`);
        if (t.projectName) about.push(`project '${clean(t.projectName, 60)}'${number(t.projectId) != null ? ` (id ${t.projectId})` : ''}`);
        else if (number(t.projectId) != null) about.push(`project id ${t.projectId}`);

        const p = t.progress && typeof t.progress === 'object' ? t.progress : {};
        const facts = [];
        if (t.status === 'queued') {
            facts.push(number(t.queuePosition) ? `queued, #${t.queuePosition} in line` : 'queued');
        } else {
            // The job's own message where it has one (counts such as "3/12
            // lessons ready"), else the stage; a creation's message is a key for
            // the client's translation, so its stage is read from the phase.
            const stage = kind !== 'create_project' && typeof p.message === 'string' && p.message.trim()
                ? clean(p.message, 100)
                : (PHASE_WORDS[p.phase] || (typeof p.phase === 'string' && p.phase ? clean(p.phase.replace(/_/g, ' '), 30) : ''));
            facts.push(stage ? `running, ${stage}` : 'running');
        }
        if (t.status === 'running' && number(p.percent) != null) facts.push(`${Math.round(p.percent)}%`);
        if (t.status === 'running' && number(p.etaMs) != null && p.etaMs > 0) facts.push(`about ${durationWords(p.etaMs)} left`);
        const from = t.status === 'queued' ? Date.parse(t.createdAt || '') : Date.parse(t.startedAt || t.createdAt || '');
        if (Number.isFinite(from)) facts.push(`${t.status === 'queued' ? 'waiting' : 'started'} ${durationWords(nowMs - from)} ago`);
        return `- ${words}${about.length ? ` for ${about.join(', ')}` : ''}: ${facts.join(', ')}`;
    });
    if (live.length > cap) lines.push(`- and ${live.length - cap} more`);
    return lines;
}

/**
 * The block appended to a chat turn's system prompt. `work` is the list of
 * registry summaries; `excludeSelf` has already been applied by the caller (the
 * turn being answered is itself a running task and is not news to it).
 */
export function chatNowBlock({ nowMs = Date.now(), timeZone = 'UTC', work = [], withHistoryStamps = true, cap = WORK_CAP } = {}) {
    const lines = runningWorkLines(work, { nowMs, cap });
    return `THE CLOCK AND THE RUNNING WORK — recomputed for every message the learner sends, so trust it over anything earlier in the conversation:
Now: ${formatNowLine(nowMs, timeZone)}. "Today", "tomorrow", "tonight" and "this week" mean this date in this zone.${withHistoryStamps ? `
Each earlier message in this conversation begins with a line like [sent 2026-09-30 21:10] — when it was sent, in the same zone. The app adds it; it is not part of what anyone wrote. Use it to tell how long ago something was said, and never write one yourself or repeat one.` : ''}
AI work running on this machine at this moment (project creations, study-material runs, feed preparation, other chats and builds; it changes from minute to minute):
${lines.length ? lines.join('\n') : 'No AI tasks are running.'}
Mention these only when they bear on what the learner asks — for example that a project they ask about is still being generated, or that something is queued behind a running job. Anything not listed here is not running.`;
}

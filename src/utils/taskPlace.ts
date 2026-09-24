import type { AITaskSummary } from '../types';
import { k } from '../i18n';

/**
 * Where a background task belongs, and how long it has left.
 *
 * EVERY kind the server can start has an answer here, and the answer may be
 * "nowhere": a visual repaired for a feed card carries no project and no node,
 * and a document is indexed because it was uploaded rather than because anyone
 * was on a page. Null is an ANSWER, not a gap — the dock opens the task's own
 * record instead. A switch that simply omits a kind is silent from both sides
 * (the server is right, the dock is right, and the reader presses a chip that
 * does nothing), and a bar with dead chips in it teaches the reader that the
 * whole bar is decoration.
 *
 * The mapping is DATA so that the two things which need it read one table: the
 * store, which performs it, and the detail dialog, which names it on its
 * button.
 */
export interface TaskPlace {
    /** How to get there. `node` and `project` are ids; the rest are routes or
     *  surfaces the store opens on top of wherever the reader already is. */
    go: 'node' | 'project' | 'route' | 'assistant' | 'creation';
    route?: string;
    projectId?: number;
    nodeId?: number;
    /** What the button that goes there says, as a whole sentence rather than a
     *  verb with the place dropped into it — "Open {{place}}" reads as English
     *  grammar imposed on eleven other languages, and the place is a noun that
     *  half of them would decline. */
    openKey: string;
}

/** What KIND of job a task is. Client-side and closed, so `k()` marks it and the
 *  chip reads it through `t()` — the dock said "Feed lessons" in every language. */
export const KIND_LABEL: Record<AITaskSummary['kind'], string> = {
    chat: k("Tutor"),
    today_chat: k("Planner"),
    quiz: k("Quiz"),
    mastery_check: k("Mastery check"),
    flashcards: k("Flashcards"),
    insights: k("Insights"),
    briefing: k("Briefing"),
    create_project: k("New project"),
    widget: k("Widget"),
    visual: k("Visual"),
    feed: k("Feed lessons"),
    embed: k("Indexing"),
    bulk: k("Study material"),
    recover: k("PDF recovery"),
    capture: k("Capture"),
    placement: k("Placement"),
    atlas: k("Atlas"),
    media_describe: k("Image descriptions"),
    srs_optimize: k("Review intervals"),
};

/** Settings' own tab hashes (see SETTINGS_TABS in Settings.tsx). */
const SETTINGS_AI = '/settings#ai';
const SETTINGS_LEARNING = '/settings#learning';

export function taskPlace(task: AITaskSummary): TaskPlace | null {
    const { projectId, nodeId } = task;
    switch (task.kind) {
        // Started on a topic, and the topic is where the result lands: the
        // tutor's answer, the cards, the questions, the captured note.
        case 'chat':
        case 'quiz':
        case 'mastery_check':
        case 'flashcards':
        case 'capture':
        // A visual or a widget is repaired IN a card. When the card is a node's
        // material the node is the place; when it is a feed item the task
        // carries neither id and there is nothing to open.
        case 'widget':
        case 'visual':
            if (projectId != null && nodeId != null) {
                return { go: 'node', projectId, nodeId, openKey: k("Open the topic") };
            }
            if (projectId != null) return { go: 'project', projectId, openKey: k("Open the project") };
            return null;

        // Project-wide work, read on the project's own dashboard — which is
        // also the screen each of these is started from.
        case 'insights':
        case 'bulk':
        case 'placement':
            if (projectId != null) return { go: 'project', projectId, openKey: k("Open the project") };
            return null;

        // The home feed: the briefing is drawn there, and `feed` is the
        // pre-generation that fills it.
        case 'briefing':
        case 'feed':
            return { go: 'route', route: '/', openKey: k("Open the home feed") };

        // The planner IS the assistant drawer — it opens over whatever page the
        // reader is on, so going to it must not navigate anywhere.
        case 'today_chat':
            return { go: 'assistant', openKey: k("Open the assistant") };

        case 'create_project':
            return { go: 'creation', route: '/projects', openKey: k("Open the projects page") };

        // Region naming: the names appear on the map, so the map is the place
        // to see the result, not the setting that switched it on.
        case 'atlas':
            return { go: 'route', route: '/atlas', openKey: k("Open the atlas") };

        // Background jobs with no screen of their own. They are configured,
        // started and reported in Settings → AI & Models ("Model jobs"), which
        // is the nearest thing to where they came from.
        case 'embed':
        case 'recover':
        case 'media_describe':
            return { go: 'route', route: SETTINGS_AI, openKey: k("Open Settings → AI & Models") };

        case 'srs_optimize':
            return { go: 'route', route: SETTINGS_LEARNING, openKey: k("Open Settings → Learning") };

        default:
            return null;
    }
}

/**
 * How long a running task has left, in milliseconds, and whether the number is
 * the job's own measurement or this module's arithmetic.
 *
 * Only bulk generation can time itself — it knows how long a call to THIS
 * machine's model took, for this kind of call, in this run. Everything else
 * reports a percentage, and a percentage with a clock beside it is enough for
 * an estimate: what is left costs what is done cost, scaled by how much of it
 * there is.
 *
 * Deliberately narrow about when it will answer at all. A task at 0% has no
 * evidence behind it, a task that has been running for under five seconds has
 * evidence too thin to divide by (a 2% reading three seconds in predicts two
 * and a half minutes and then changes its mind twice), and a task with no
 * percent at all — a tutor turn measured in characters — has nothing to
 * divide. All three say "no estimate" rather than inventing one; a wrong
 * number here is worse than no number, because the reader plans around it.
 */
const MIN_ELAPSED_MS = 5000;

export function taskEta(task: AITaskSummary, now: number = Date.now()):
    { ms: number; measured: boolean } | null {
    if (task.status !== 'running') return null;
    const own = task.progress.etaMs;
    if (typeof own === 'number' && own > 0) return { ms: own, measured: true };
    const percent = task.progress.percent;
    if (percent == null || percent <= 0 || percent >= 100) return null;
    if (!task.startedAt) return null;
    const started = Date.parse(task.startedAt);
    if (!Number.isFinite(started)) return null;
    const elapsed = now - started;
    if (elapsed < MIN_ELAPSED_MS) return null;
    return { ms: Math.round(elapsed * ((100 - percent) / percent)), measured: false };
}

/**
 * A span of time in words, as a key and its numbers — the caller runs it
 * through `t()`, so it reads in the interface language and not in the device's.
 *
 * No unit is ever plural: "1 minutes" is a bug in eleven locales at once and
 * the only way to avoid it in every one of them is not to inflect at all. The
 * abbreviations are translatable because "min" is not "мин" and is not "分".
 */
export function durationParts(ms: number): { key: string; params: Record<string, number> } {
    const total = Math.max(0, Math.round(ms / 1000));
    if (total < 60) return { key: k("{{n}} s"), params: { n: Math.max(1, total) } };
    const minutes = Math.round(total / 60);
    if (minutes < 60) return { key: k("{{n}} min"), params: { n: minutes } };
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (rest === 0) return { key: k("{{n}} h"), params: { n: hours } };
    return { key: k("{{h}} h {{m}} min"), params: { h: hours, m: rest } };
}

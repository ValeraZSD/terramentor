import type { AITaskOrigin, AITaskSummary } from '../types';
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

/**
 * A task's TITLE in the interface language. The server writes it in English
 * for its logs, and where the title is the app's own sentence it also sends
 * the key (`labelKey`); a title that is the learner's own words (a topic, a
 * document) has no key and is shown as written. Drawn raw, the chip reads
 * "Preparing feed lessons" above a German "Feed-Lektionen".
 */
export function taskTitle(
    task: { label: string; labelKey?: string | null; labelParams?: Record<string, unknown> | null },
    t: (key: string, opts?: Record<string, unknown>) => string,
): string {
    return task.labelKey ? t(task.labelKey, task.labelParams ?? undefined) : task.label;
}

// The server's `labelKey`s: no client call site names them (the chip renders
// t(task.labelKey)), so they are marked here or the extractor would prune them.
// i18n-source-gates asserts every `labelKey` in server/*.js against en.json.
export const SERVER_TASK_LABEL_KEYS = [
    k("Preparing feed lessons"),
    k("Capture"),
    k("Tuning spaced repetition"),
    k("Daily briefing"),
    k("Planning chat"),
    k("Placement for {{projectName}}"),
    k("Repairing a visual"),
    k("Rebuilding a visual"),
    k("Describing {{count}} images", { count: 0 }),
    k("Mapping {{count}} topics", { count: 0 }),
    k("Naming {{count}} regions", { count: 0 }),
    k("Recovering math in “{{title}}”"),
    k("Indexing “{{title}}”"),
    k("Study material · {{project}}"),
    k("Study material"),
];

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

/**
 * A visual block's reading surface (the `surface` prop `Markdown` carries for
 * feedback reports) as the origin a build or repair it starts is recorded
 * under. Unknown surfaces with a topic fall back to that topic; with neither,
 * nothing is sent and the server records no origin rather than a guess.
 */
export function visualOrigin(surface: string | undefined, nodeId?: number, messageId?: number): AITaskOrigin | undefined {
    const withNode = <T extends AITaskOrigin>(o: T): T => (nodeId != null ? { ...o, nodeId } : o);
    switch (surface) {
        case 'assistant': return messageId != null ? { surface: 'assistant', messageId } : { surface: 'assistant' };
        case 'tutor': return withNode({ surface: 'tutor' });
        case 'feed-lesson': return withNode({ surface: 'feed', detail: 'lesson' });
        case 'feed-question': return withNode({ surface: 'feed', detail: 'question' });
        case 'feed-recall': return withNode({ surface: 'feed', detail: 'recall' });
        case 'feed-practice': return withNode({ surface: 'feed', detail: 'practice' });
        case 'paper-solution':
        case 'paper-feedback': return withNode({ surface: 'feed', detail: 'paper' });
        case 'overview': return withNode({ surface: 'topic', detail: 'overview' });
        case 'material': return withNode({ surface: 'topic', detail: 'material' });
        case 'notes': return withNode({ surface: 'topic', detail: 'notes' });
        case 'quiz':
        case 'quiz-review': return withNode({ surface: 'topic', detail: 'quiz' });
        case 'mastery-check':
        case 'mastery-check-review': return withNode({ surface: 'topic', detail: 'mastery_check' });
        case 'placement': return withNode({ surface: 'project', detail: 'placement' });
        default: return nodeId != null ? { surface: 'topic', nodeId } : undefined;
    }
}

/** A topic's own stream of cards — where the feed's work on it is read. */
const studyRoute = (projectId: number, nodeId: number) => `/project/${projectId}/study/${nodeId}`;

/**
 * Where the task was STARTED from, when the server recorded it. This comes
 * before the kind-based guess below because it is known rather than guessed:
 * a widget built under an assistant answer carries no project and no topic, so
 * the kind alone sent it nowhere ("the app started this one by itself") when it
 * had in fact come from the drawer the learner was reading.
 */
export function originPlace(origin: AITaskOrigin | null | undefined): TaskPlace | null {
    if (!origin) return null;
    const { projectId, nodeId } = origin;
    const topic = projectId != null && nodeId != null
        ? { go: 'node' as const, projectId, nodeId, openKey: k("Open the topic") }
        : null;
    const project = projectId != null
        ? { go: 'project' as const, projectId, openKey: k("Open the project") }
        : null;
    switch (origin.surface) {
        case 'assistant':
            return { go: 'assistant', openKey: k("Open the assistant") };
        case 'tutor':
        case 'topic':
        case 'inbox':
            return topic ?? project;
        case 'feed':
            if (projectId != null && nodeId != null) {
                return { go: 'route', route: studyRoute(projectId, nodeId), openKey: k("Open the topic's study feed") };
            }
            return { go: 'route', route: '/', openKey: k("Open the home feed") };
        case 'project':
            return project;
        case 'projects':
            return { go: 'creation', route: '/projects', openKey: k("Open the projects page") };
        case 'settings':
            if (origin.detail === 'learning') return { go: 'route', route: SETTINGS_LEARNING, openKey: k("Open Settings → Learning") };
            if (origin.detail === 'data') return { go: 'route', route: '/settings#data', openKey: k("Open Settings → Data") };
            return { go: 'route', route: SETTINGS_AI, openKey: k("Open Settings → AI & Models") };
        case 'atlas':
            return { go: 'route', route: '/atlas', openKey: k("Open the atlas") };
        case 'app':
            switch (origin.job) {
                case 'feed':
                    if (projectId != null && nodeId != null) {
                        return { go: 'route', route: studyRoute(projectId, nodeId), openKey: k("Open the topic's study feed") };
                    }
                    return { go: 'route', route: '/', openKey: k("Open the home feed") };
                case 'briefing':
                    return { go: 'route', route: '/', openKey: k("Open the home feed") };
                case 'index_document':
                case 'recover_pdf':
                    return topic ?? project ?? { go: 'route', route: SETTINGS_AI, openKey: k("Open Settings → AI & Models") };
                case 'name_regions':
                    return { go: 'route', route: '/atlas', openKey: k("Open the atlas") };
                case 'index_topics':
                case 'describe_media':
                    return { go: 'route', route: SETTINGS_AI, openKey: k("Open Settings → AI & Models") };
                default:
                    return null;
            }
        default:
            return null;
    }
}

/**
 * The sentence that says where a task came from, as a key and its params (the
 * caller runs it through `t()`). `title` is the topic's name when the dialog
 * could resolve the origin's node id; without it the sentence still reads.
 * Null only when the server recorded nothing — the dialog then says so.
 */
export function originSentence(origin: AITaskOrigin | null | undefined, title?: string | null):
    { key: string; params?: Record<string, string> } | null {
    if (!origin) return null;
    const named = (withTitle: string, without: string) => (title
        ? { key: withTitle, params: { title } }
        : { key: without });
    switch (origin.surface) {
        case 'assistant':
            if (origin.detail === 'assistant_capture') return { key: k("Started when you saved a note from the assistant.") };
            return { key: k("Started from the assistant.") };
        case 'tutor':
            return named(k("Started from the tutor on “{{title}}”."), k("Started from the tutor on a topic."));
        case 'feed':
            return named(k("Started from a card in your feed, on “{{title}}”."), k("Started from a card in your feed."));
        case 'topic':
            switch (origin.detail) {
                case 'overview': return named(k("Started from the Overview of “{{title}}”."), k("Started from a topic's Overview."));
                case 'material': return named(k("Started from the Material of “{{title}}”."), k("Started from a topic's Material."));
                case 'notes': return named(k("Started from your notes on “{{title}}”."), k("Started from your notes on a topic."));
                case 'mastery_check': return named(k("Started from the mastery check on “{{title}}”."), k("Started from a topic's mastery check."));
                case 'quiz': return named(k("Started from the practice quiz on “{{title}}”."), k("Started from a topic's practice quiz."));
                case 'flashcards': return named(k("Started from the flashcards of “{{title}}”."), k("Started from a topic's flashcards."));
                default: return named(k("Started from the topic “{{title}}”."), k("Started from a topic's page."));
            }
        case 'inbox':
            return { key: k("Started when you captured a note into your Inbox.") };
        case 'project':
            if (origin.detail === 'bulk') return { key: k("Started from “Generate study material” on the project's page.") };
            if (origin.detail === 'placement') return { key: k("Started from the placement check on the project's page.") };
            if (origin.detail === 'insights') return { key: k("Started from the insights on the project's page.") };
            return { key: k("Started from the project's page.") };
        case 'projects':
            return { key: k("Started from the projects page, when you created a project.") };
        case 'settings':
            if (origin.detail === 'learning') return { key: k("Started from Settings → Learning.") };
            if (origin.detail === 'data') return { key: k("Started from Settings → Data.") };
            return { key: k("Started from Settings → AI & Models.") };
        case 'atlas':
            return { key: k("Started from the atlas.") };
        case 'app':
            switch (origin.job) {
                case 'feed':
                    return named(k("Prepared by the app for your feed: “{{title}}”."), k("Prepared by the app for your feed."));
                case 'index_document': return { key: k("Started by the app to index a document you added.") };
                case 'recover_pdf': return { key: k("Started by the app to recover the maths in a PDF you added.") };
                case 'index_topics': return { key: k("Started by the app to map your topics for search and the atlas.") };
                case 'name_regions': return { key: k("Started by the app to name the regions of your atlas.") };
                case 'describe_media': return { key: k("Started by the app to describe the pictures in your cards.") };
                case 'briefing': return { key: k("Started by the app to write your daily briefing.") };
                default: return { key: k("Started by the app itself.") };
            }
        default:
            return null;
    }
}

export function taskPlace(task: AITaskSummary): TaskPlace | null {
    const fromOrigin = originPlace(task.origin);
    if (fromOrigin) return fromOrigin;
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

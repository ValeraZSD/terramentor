import type { CardMediaRef } from './components/CardMedia';

/** Anki's four card states, which is the vocabulary a deck's owner already
 *  thinks in — and, unlike "0% complete", each is true of a specific card. */
export type DeckCardState = 'new' | 'learning' | 'young' | 'mature';

export interface DeckStage {
    nodeId: number;
    title: string;
    description: string;
    parentTitle: string | null;
    status: 'not_started' | 'in_progress' | 'completed' | 'skipped';
    cards: number;
    seen: number;
    mature: number;
    due: number;
    newCards: number;
    /** This stage's own four-state breakdown. `seen`/`mature` are roll-ups of
     *  it; the breakdown is what a bar can actually be drawn from. */
    states: Record<DeckCardState, number>;
    /** One character per card (`n`/`l`/`y`/`m`) in deck order, present only on
     *  stages small enough to draw a tick per card. Absent means "draw the
     *  stacked bar instead", never "no data". */
    map?: string;
}

export interface DeckData {
    project: { id: number; name: string; color: string; icon: string; kind: string; description: string };
    totals: Record<DeckCardState, number> & { cards: number };
    /** Reviews genuinely owed — never-seen cards are NOT counted here. */
    dueReviews: number;
    /** New cards this deck may still introduce today. */
    newAvailable: number;
    newRemaining: number;
    newPerDay: number;
    introducedToday: number;
    reviewed: number;
    /** Studied cards forgotten at least once. Not "retention": true retention
     *  needs a review log, which this app does not keep. */
    lapsed: number;
    seen: number;
    forecast: { days: number[]; beyond: number };
    stages: DeckStage[];
    matureDays: number;
    currentStageId: number | null;
}

export interface Project {
    id: number;
    /** Portable global identity (RFC-4122 v4). Integer `id` stays the local key;
     *  `uuid` is stable across export / cross-device sync / marketplace import. */
    uuid?: string;
    name: string;
    description: string;
    color: string;
    icon: string;
    position: number;
    ai_generating?: number;
    start_date: string | null;
    deadline: string | null;
    study_days: string;
    baseline_schedule: string | null;
    status?: 'active' | 'completed' | 'archived';
    /** WHERE THIS CAME FROM, and nothing else: `deck` means it arrived as an
     *  Anki import. It no longer selects a screen or a behaviour — what a
     *  project HAS does that (`topic_count`, `card_count`, `teaches`, a
     *  schedule) — because a shape decided by the import door could never be
     *  changed afterwards. See server/nodeRole.js. */
    kind?: 'curriculum' | 'deck';
    /** Declared study language (ISO code from GET /api/languages). '' or absent
     *  = follow the material, which is how every project behaved before the
     *  column existed. Steers AI authoring AND the feed's quality gates. */
    content_language?: string;
    created_at: string;
    updated_at: string;
    node_count?: number;
    completed_count?: number;
    /** Leaves that are things to KNOW rather than slices of an imported deck's
     *  card order (`nodes.role`). Zero means there is no plan to draw. */
    topic_count?: number;
    /** …and how many of those are closed. `completed_count` counts every leaf,
     *  stages included, and is what tools/leaf-invariant.mjs pins. */
    completed_topic_count?: number;
    /** How much of the project is DONE, 0–1: a closed topic counts 1, a topic
     *  whose content is cards counts the share of them met, every topic weighs
     *  the same (`server/progress.js`). This is the ONLY number drawn as a
     *  percentage — the dashboard and pace read the same function. */
    progress_fraction?: number;
    /** May its topics be taught — lessons generated, checkpoints served? Off by
     *  default for an import, on for anything authored here, and the learner's
     *  to change (PUT /api/projects/:id/teaching). */
    teaches?: boolean;
    /** Total cards, and how many have ever been studied. Progress is this ratio
     *  for a project that is not being taught: its nodes are never hand-marked
     *  complete, so the leaf-status counters read 0% forever. */
    card_count?: number;
    seen_card_count?: number;
    schedule?: ScheduleSummary;
    due_flashcard_count?: number;
    insights?: string | null;
    insights_generated_at?: string | null;
}

export interface Node {
    id: number;
    /** Portable global identity (RFC-4122 v4); see Project.uuid. */
    uuid?: string;
    project_id: number;
    parent_id: number | null;
    title: string;
    description: string;
    notes: string;
    status: 'not_started' | 'in_progress' | 'completed' | 'skipped';
    is_note: number;
    /** What this node IS: something to know, or a slice of an imported deck's
     *  card order that holds cards and is never taught, proven or finished
     *  (`server/nodeRole.js`). Absent on rows written before the column. */
    role?: 'topic' | 'pagination';
    /** Cards on this node, and how many have ever been studied. Carried on the
     *  tree payload so the client's rollup can use the same progress rule the
     *  server does (`topicDone` / `server/progress.js`). */
    cards?: number;
    seen?: number;
    position: number;
    scheduled_start: string | null;
    scheduled_end: string | null;
    estimated_weight: number | null;
    completed_at: string | null;
    /** In-progress AI Tutor chat input for this node, persisted so it survives navigation/reload. */
    chat_draft: string | null;
    created_at: string;
    updated_at: string;
}

export interface TreeNode extends Node {
    children: TreeNode[];
    depth: number;
    progress?: {
        total: number;
        completed: number;
        percentage: number;
    };
    effectiveStatus?: 'not_started' | 'in_progress' | 'completed' | 'skipped';
    masteryEstimate?: number;
}

export interface Resource {
    id: number;
    /** Portable global identity (RFC-4122 v4); see Project.uuid. */
    uuid?: string;
    node_id: number;
    title: string;
    url: string;
    type: string;
    completed: number;
    position: number;
    created_at: string;
}

export interface ExportResource {
    /** Portable identity, so a re-import can tell "the same resource" from "another one like it". */
    uuid?: string;
    title: string;
    url?: string;
    type?: string;
    completed?: boolean;
}

export interface ExportNode {
    title: string;
    uuid?: string;
    description?: string;
    notes?: string;
    status?: string;
    is_note?: boolean;
    resources?: ExportResource[];
    children?: ExportNode[];
}

export interface ExportData {
    /**
     * Legacy. A top-level `version: "2.0"` describing the parser, from exports
     * that carried one; nothing reads it and no v1 branch exists, so new
     * exports write none. Still optional here because a user's older file may
     * have one.
     */
    version?: string;
    exported_at: string;
    project: {
        name: string;
        /** Which course this is — stable across machines and re-exports. */
        uuid?: string;
        /** Which EDITION of it, as the author labelled it ("1.2.0", "2026-08"). */
        version?: string;
        description?: string;
        color: string;
        icon: string;
        content_language?: string;
    };
    nodes: ExportNode[];
}

/** What both import endpoints return: the new project, plus any repairs made to the file. */
export type ImportResult = Project & { warnings?: string[] };

export interface Toast {
    id: string;
    type: 'success' | 'error' | 'info';
    message: string;
    details?: string;
    timestamp: number;
    /** How many identical (same type + message) toasts have collapsed into this one. Starts at 1. */
    count: number;
}

export interface SearchResult {
    type: 'project' | 'node';
    projectId: number;
    projectName: string;
    projectColor: string;
    nodeId?: number;
    title: string;
    matchField: 'title' | 'description' | 'notes';
    matchText: string;
    matchStart: number;
    matchEnd: number;
}

export interface ScheduleConfig {
    startDate: string;
    deadline: string;
    studyDays: number[];
}

export interface ScheduleResult {
    success: boolean;
    project?: Project;
    nodes?: Node[];
    warnings?: string[];
    stats?: ScheduleStats;
    error?: string;
    suggestedDeadline?: string;
    unchanged?: boolean;
}

export interface ScheduleStats {
    leafCount?: number;
    incompleteLeaves?: number;
    completedLeaves?: number;
    validDays: number;
    totalWeight?: number;
    topicsPerDay: number;
    recalibratedFrom?: string;
}

export interface ScheduleSummary {
    hasSchedule: boolean;
    startDate?: string;
    deadline?: string;
    paceStatus?: PaceStatus;
    expectedProgress?: number;
    actualProgress?: number;
    message?: string;
}

export type PaceStatus = 'no_schedule' | 'no_tasks' | 'ahead' | 'on_track' | 'falling_behind' | 'critical';

export interface PaceData {
    hasSchedule: boolean;
    onTrack: boolean;
    expectedProgress: number;
    actualProgress: number;
    drift?: number;
    daysBehind: number;
    paceStatus: PaceStatus;
    message: string;
    startDate?: string;
    deadline?: string;
    totalDays?: number;
    elapsedDays?: number;
    completedLeaves?: number;
    totalLeaves?: number;
}

export interface GanttItem {
    id: number;
    title: string;
    depth: number;
    status: Node['status'];
    isNote: boolean;
    scheduledStart: string | null;
    scheduledEnd: string | null;
    hasChildren: boolean;
    parentId: number | null;
    rootPhaseId: number | null;
    rootPhaseTitle: string | null;
    /** Tailwind background class for the bar, derived from status + overdue. */
    colorClass: string;
    isOverdue: boolean;
}

export interface CalendarDay {
    date: string;
    dayOfWeek: number;
    isToday: boolean;
    isStudyDay: boolean;
    isCurrentMonth: boolean;
    tasks: CalendarTask[];
}

export interface CalendarTask {
    nodeId: number;
    title: string;
    status: Node['status'];
    color: string;
    isStart: boolean;
    isEnd: boolean;
}

export type CalendarViewMode = 'month' | 'week' | 'day';
export type WeekStartDay = 0 | 1;

/**
 * One lookup a turn ran before it answered (server/aiTools.js).
 *
 * `state` is what the learner is watching: a row appears the moment the model
 * asks for the lookup and is filled in when it lands, so the wait has a reason
 * on screen rather than a spinner. Stored with the message, because a record
 * that exists only while the answer streams is one they cannot go back to — and
 * for a web search this is the app's disclosure of what left the machine.
 */
export interface AiAction {
    /** Registry name: `search_web`, `find_in_library`. Unknown ones still render. */
    tool: string;
    /** What was looked for — the model's own words, never the learner's verbatim. */
    arg: string;
    state?: 'running' | 'done';
    /** What came back, in the tool's own terms: "4 pages", "3 matches", "nothing".
     *  English, because it is written for the MODEL's second round — the screen
     *  reads `count` instead and writes its own sentence around it. */
    summary?: string;
    /** How many results, for the row the learner reads. */
    count?: number;
}

export interface ChatMessage {
    id: number;
    node_id: number;
    role: 'user' | 'assistant' | 'system';
    content: string;
    /** Persisted reasoning trace of a thinking-capable model (assistant turns
     *  only) — backs the collapsible "Reasoning" panel across reloads. */
    reasoning?: string | null;
    /** What this turn looked up before answering. Null for every turn that
     *  looked nothing up, and for every turn written before the column existed. */
    actions?: AiAction[] | null;
    created_at: string;
}

// BACKGROUND AI TASKS (server/tasks.js registry)

// Every kind the server can put on the dock. `KIND_LABEL` in TaskDock.tsx is
// keyed by this union, so a kind added here fails the build until it is named —
// which is the only thing that catches the gap: a kind the client does not know
// still draws a chip, it just draws it as the generic "AI task".
export type AITaskKind =
    | 'chat' | 'today_chat' | 'quiz' | 'boss_fight'
    | 'flashcards' | 'insights' | 'briefing' | 'create_project' | 'widget' | 'visual' | 'feed' | 'embed'
    | 'bulk' | 'recover' | 'capture' | 'placement' | 'atlas'
    | 'media_describe' | 'srs_optimize';

export type AITaskStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface AITaskProgress {
    /** Reasoning characters emitted so far. */
    thinking: number;
    /** Answer characters emitted so far. */
    content: number;
    /** 0–100 where a real total exists (project creation), else null. */
    percent: number | null;
    phase: string | null;
    message: string | null;
}

/**
 * Why a background task failed, in enough detail to act on.
 *
 * Two layers on purpose: `message` is the sentence shown to the person, the
 * rest is the technical record they can copy into a bug report. Everything
 * after `phase` is absent for a failure that never reached a model.
 */
export interface AITaskFailure {
    message: string;
    name: string;
    at: string;
    kind: string;
    label: string;
    projectId: number | null;
    nodeId: number | null;
    phase: string | null;
    lastMessage: string | null;
    produced: { thinkingChars: number; contentChars: number; percent: number | null };
    queuedAt: string | null;
    startedAt: string | null;
    elapsedMs: number | null;
    provider: string | null;
    model: string | null;
    endpoint: string | null;
    httpStatus: number | null;
    code: string | number | null;
    /** How many times the request was actually sent (the server retries transient failures). */
    attempts?: number | null;
    /** The model was stopped for repeating itself in its reasoning. */
    looped?: boolean | null;
    /** The endpoint answered with no answer in it. */
    emptyReply?: boolean | null;
    /** What the model spent before it stopped, when the endpoint reported it. */
    reasoningTokens?: number | null;
    /** Who ended the reply: 'stop', 'length', 'content_filter', … */
    finishReason?: string | null;
    responseBody: string | null;
    rawResponse: string | null;
    causes: string[];
    stack: string | null;
}

/** One entry in the global AI task queue (the bottom task dock). */
export interface AITaskSummary {
    id: string;
    kind: AITaskKind;
    label: string;
    projectId: number | null;
    nodeId: number | null;
    projectName: string | null;
    projectColor: string | null;
    status: AITaskStatus;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    progress: AITaskProgress;
    /** 1-based position while queued, null once running/finished. */
    queuePosition: number | null;
    error: string | null;
    /** The full record behind `error` — present only when status is 'error'. */
    failure?: AITaskFailure | null;
    meta: { message?: string } | null;
}

/**
 * `boss_fight` is what "quiz" always was: a node's saved questions ARE the pool
 * the mastery gate draws from, so generating them ahead of time is gate prep,
 * not a separate practice artifact.
 */
export type BulkKind = 'boss_fight' | 'flashcards';

/** One topic bulk generation could target, with what it already has. */
export interface BulkCandidate {
    nodeId: number;
    title: string;
    /** Ancestor titles ("Phase 2 › Recursion") — half of all leaves are "Introduction". */
    path: string;
    status: Node['status'];
    scheduledEnd: string | null;
    /** Top-level section title — what the picker groups rows under. */
    section: string;
    /** Saved quiz ROWS (kept for display); coverage is judged on `questions`. */
    quizzes: number;
    /** Non-ghost questions the Boss Fight would actually find on this node. */
    questions: number;
    /** Enough of its own questions to count as a real assessment. */
    gateReady: boolean;
    flashcards: number;
}

/** Measured per-call time, per kind — absent measurements are flagged, not faked. */
export interface BulkEstimates {
    boss_fight: { ms: number; measured: boolean };
    flashcards: { ms: number; measured: boolean };
}

/** The single running bulk job, polled while the dialog is open. */
export interface BulkJobStatus {
    id: string;
    projectId: number;
    kinds: BulkKind[];
    total: number;
    done: number;
    failed: number;
    skipped: number;
    current: { nodeId: number; title: string; kind: BulkKind } | null;
    /** Paused because the learner is using the model right now. */
    waiting: boolean;
    /** Milliseconds left, from this run's own measurements. Null until it has any. */
    etaMs: number | null;
    status: 'running' | 'done' | 'failed' | 'cancelled';
    failures: Array<{ nodeId: number; title: string; kind: BulkKind; error: string }>;
    startedAt: string;
    finishedAt: string | null;
}

export interface QuizQuestion {
    question: string;
    /**
     * The answer FORMAT — how the learner answers, and therefore what
     * `correct_answer` holds: an option's text, "True"/"False", a model
     * answer, a reference solution, an ordering as JSON. The set is the answer
     * format registry (`server/answerFormats.js`, mirrored in
     * `src/components/answer/formats.ts`); every surface renders it through
     * `AnswerInput` rather than switching on it.
     */
    type: 'multiple_choice' | 'true_false' | 'short_answer' | 'fill_in' | 'numeric' | 'code' | 'sequence';
    options?: string[];
    correct_answer: string;
    explanation: string;
    /**
     * `fill_in`: other answers that are equally correct — a synonym, a second
     * admissible spelling, a word order that is also right. Compared the same
     * way the key is (`normalizeTyped`), so a variant that differs only in
     * capitals or punctuation is redundant and is dropped on the way in.
     */
    accept?: string[];
    /**
     * `numeric`: the unit the typed number must be in ("m/s^2", "kg", "%").
     * SHOWN beside the input and never graded — no string comparison can agree
     * that "m/s^2", "m/s²" and "meters per second squared" are one answer.
     */
    unit?: string;
    /**
     * `numeric`: how far the answer may be from the key, as an absolute amount
     * in `unit`. Absent means half a unit in the last place `correct_answer`
     * was written to (`defaultTolerance`), which is what "9.81" already claims.
     */
    tolerance?: number;
    /** `code`: the language the editor highlights and the checker reads ("python", "sql"). */
    language?: string;
    /** `code`: optional scaffolding the editor opens with — a signature, a stub. Never the solution. */
    starter?: string;
    /** `sequence`: the items in the SERVED (shuffled) order; the key is `correct_answer`. */
    items?: string[];
    /**
     * Pictures (or clips) the question is ASKED ABOUT — a road situation, a
     * radiograph, a specimen. Structured for the same three reasons card media
     * is (see CardMedia.tsx): there is no markdown for a sound, question text
     * is not ours to start reparsing, and the blob store has to be able to
     * enumerate what the database still points at.
     *
     * No model writes this — a question writer has no picture to reference — so
     * in practice it arrives only from something importing real material. It
     * lives in the `quizzes.questions` JSON, which is a free-form TEXT column,
     * so carrying it needed no migration.
     */
    media?: CardMediaRef[];
    // "Ghost question" — interleaved review drawn from a previously-mastered topic
    // whose mastery is decaying (the "Remember" loop / cumulative-exam effect).
    isGhost?: boolean;
    ghostNodeId?: number;
    ghostNodeTitle?: string;
}

// Per-decaying-node review result reported back when a quiz containing ghost
// questions is submitted, so each ghost topic's mastery/decay timer is refreshed.
export interface GhostResult {
    nodeId: number;
    score: number;
    total: number;
}

// A consolidated "what to do today" agenda for a project (server/dailyPlan.js).
export interface DailyPlanTask {
    id: number;
    title: string;
    scheduled_start?: string | null;
    scheduled_end?: string | null;
    status?: string;
}

export interface DailyPlan {
    date: string;
    overdueTasks: DailyPlanTask[];
    todayTasks: DailyPlanTask[];
    summary: {
        overdueCount: number;
        todayCount: number;
        decayingCount: number;
        dueFlashcardCount: number;
        untestedCount: number;
    };
}

// Learning feed (server/feed.js, GET /api/feed) — the home page card stream.
// A discriminated union: `kind` selects the card component; `key` is the
// stable identity used for exclude-list paging and consume calls.
export interface FeedCardCommon {
    key: string;
    nodeId: number;
    projectId: number;
    projectName: string;
    projectColor: string;
    nodeTitle: string;
}

export interface FeedLessonCard extends FeedCardCommon {
    kind: 'lesson';
    /** feed_items row id for generated lessons; null for degraded reading cards. */
    feedItemId: number | null;
    partIndex: number;
    partCount: number;
    partTitle: string | null;
    markdown: string;
    /** true = composed from the node's own notes (AI off / not generated yet). */
    degraded: boolean;
    source: 'generated' | 'authored';
}

export interface FeedQuestionCard extends FeedCardCommon {
    kind: 'question';
    feedItemId: number | null;
    question: QuizQuestion;
    source: 'generated' | 'saved';
}

export interface FeedFlashcardCard {
    key: string;
    kind: 'flashcard';
    card: GlobalDueFlashcard;
    /** Never-reviewed card being introduced (capped/day) vs a genuine due review. */
    isNew: boolean;
    /**
     * Epoch ms this card became due again, set only on a copy the CLIENT put
     * back into the stream after an "Again" (see `requeueFeedCard` in store.ts).
     * The server never sends it. Present so the card can say why it is here a
     * second time — meeting the same word twice in one scroll with no
     * explanation reads as a duplicate, not as a repetition.
     */
    requeuedAt?: number;
}

export interface FeedRecallCard extends FeedCardCommon {
    kind: 'recall';
    daysSince: number | null;
    quizId: number;
    question: QuizQuestion;
}

export interface FeedCheckpointCard extends FeedCardCommon {
    kind: 'checkpoint';
    feedCorrect: number;
    feedTotal: number;
    masteryScore: number;
    eligible: boolean;
    /**
     * Part of `masteryScore` was seeded from a proven topic in another project
     * and hasn't been earned here yet, so the BKT clause of the gate is
     * suspended. Without this the card would show a high percentage next to a
     * refusal to complete and look broken.
     */
    borrowedEstimate?: boolean;
    gateMode: 'off' | 'advisory' | 'enforced';
    scheduledEnd: string | null;
    isOverdue: boolean;
    deadline: { daysLeft: number; paceStatus: string | null } | null;
}

export interface PaperRubricPoint {
    id: string;
    point: string;
    weight: number;
}

/**
 * Work-it-on-paper exercise. `mode` drives the client scan pipeline:
 * 'document' flattens written working to black-on-white, 'photo' keeps tone and
 * colour for drawings and constructions (see src/utils/scan/warp.ts).
 *
 * The reference solution is deliberately NOT here — it is the answer key, and
 * it is fetched only after the learner submits or asks to self-mark.
 */
export interface FeedPracticeCard extends FeedCardCommon {
    kind: 'practice';
    feedItemId: number;
    mode: 'document' | 'photo';
    brief: string;
    materials: string;
    rubric: PaperRubricPoint[];
}

export interface PaperRubricResult extends PaperRubricPoint {
    met: boolean;
    comment: string;
}

export interface PaperGrade {
    readable: boolean;
    results: PaperRubricResult[];
    score: number;
    total: number;
    feedback: string;
    nextAction: string;
}

/** Result of POST /api/paper/:id/grade — see gradePaperAttempt in server/paper.js. */
export type PaperGradeResponse =
    | { status: 'graded'; attemptId: number; imageHash: string; transcription: string; grade: PaperGrade; mastery: unknown }
    | { status: 'unreadable'; imageHash?: string; transcription?: string; reason: string }
    | { status: 'no_vision'; reason: string }
    | { status: 'error'; imageHash?: string; transcription?: string; error: string };

/* ---- Placement probe (server/placement.js) --------------------------------
 *
 * A short assessment taken BEFORE studying, whose answers seed the BKT prior on
 * the topics it asked about and the ones those answers vouch for. The client
 * never receives an answer key with a question — `correctAnswer` and
 * `explanation` arrive only in the answer response, which is why they live on
 * `PlacementAnswerResult` and not on `PlacementQuestion`.
 */
export interface PlacementQuestion {
    index: number;
    nodeId: number;
    nodeTitle: string;
    phaseTitle: string;
    type: 'multiple_choice' | 'short_answer';
    question: string;
    options?: string[];
    /** False when the cold-solve verifier could not be reached while authoring. */
    verified: boolean;
    answered: boolean;
    correct: boolean | null;
}

export interface PlacementProbe {
    id: number;
    projectId: number;
    state: 'generating' | 'ready' | 'done' | 'failed';
    error: string | null;
    total: number;
    answeredCount: number;
    questions: PlacementQuestion[];
}

export interface PlacementSummary {
    answered: number;
    correct: number;
    total: number;
    topicsSeeded: number;
    headline: string;
}

/** `available: false` always carries a `reason` — it is an answer, not an error. */
export interface PlacementStatus {
    available: boolean;
    reason?: 'done' | 'in-progress' | 'too-small';
    candidates?: number;
    questions?: number;
    probe: PlacementProbe | null;
    summary: PlacementSummary | null;
}

export interface PlacementAnswerResult {
    correct: boolean;
    explanation: string;
    correctAnswer: string;
    seeding: { seeded: number; considered: number; answers: number };
    probe: PlacementProbe;
}

/* ---- Anki import (server/ankiImport.js) -----------------------------------
 *
 * Two phases: `inspect` parses and reports, `commit` writes. Nothing reaches the
 * library until the learner has seen a preview, which is what makes the one
 * mistake positional field-picking can make — a reversed front/back — catchable
 * before it becomes two thousand backwards cards.
 */
/** Progress of the card-image description sweep (server/mediaDescribe.js). */
export interface MediaDescriptionStatus {
    images: number;
    described: number;
    /** Written by the deck's author (alt text) — never overwritten by a model. */
    byAuthor: number;
    byVision: number;
    pending: number;
    running: boolean;
    total?: number;
    done?: number;
    failed?: number;
    projectId?: number | null;
}

export interface AnkiSample {
    front: string;
    back: string;
    /** The reading / example sentence / translation shown under the answer. */
    extra?: string;
    deck: string;
    cloze: boolean;
    noteType: string;
    /** The real pictures and clips, already in the blob store — a sample card
     *  renders exactly what the imported card will. */
    media: { front: CardMediaRef[]; back: CardMediaRef[] };
}

export interface AnkiStats {
    notes: number;
    cards: number;
    skipped: number;
    withImages: number;
    withSounds: number;
    /** How the deck stored its media index: 'v3' (zstd protobuf), 'legacy'
     *  (a JSON map), 'none', or 'unreadable' — the last of which is the only
     *  one that costs the learner their pictures. */
    mediaFormat?: string;
    /** Distinct FILES stored, and how they split. A file used by forty cards
     *  is stored and counted once. */
    mediaFiles?: number;
    mediaImages?: number;
    mediaSounds?: number;
    mediaBytes?: number;
    /** References resolved onto cards (counts repeats), vs referenced-but-absent. */
    mediaAttached?: number;
    mediaUnresolved?: number;
    mediaSkipped?: number;
    cardsWithMedia?: number;
    /** DISTINCT URLs the deck's own `<a href>`s point at — a Khan Academy unit
     *  linked from every card in it is one link, not thirty. They stay on the
     *  card AND become resources on the topic they were written under. */
    links?: number;
    cardsWithLinks?: number;
    /** `stages` is how many topics this deck will be cut into, computed by the
     *  server with the same function that will do the cutting — the client must
     *  never carry a second copy of that rule. 0 or 1 = the deck stays whole. */
    decks: { name: string; count: number; stages?: number }[];
    noteTypes: { name: string; count: number }[];
    /** reason -> how many notes were dropped for it. Never hidden. */
    skipReasons: Record<string, number>;
}

export interface AnkiPreview {
    stagingId: string;
    stats: AnkiStats;
    warnings: string[];
    samples: AnkiSample[];
    suggestedName: string;
}

export interface AnkiImportResult {
    projectId: number;
    name: string;
    imported: number;
    skipped: number;
    skipReasons: Record<string, number>;
    decks: number;
    /** Stages the deck was cut into, so it has something the engine can teach —
     *  see server/deckStructure.js. 0 means the deck was small enough to stay
     *  whole. */
    stages?: number;
    /** Distinct media files registered to the new project. */
    media?: number;
}

export interface FeedNoticeCard {
    key: string;
    kind: 'notice';
    message: string;
}

export type FeedCard =
    | FeedLessonCard
    | FeedQuestionCard
    | FeedFlashcardCard
    | FeedRecallCard
    | FeedCheckpointCard
    | FeedPracticeCard
    | FeedNoticeCard;

export interface FeedStats {
    itemsDoneToday: number;
    lessonsReadToday: number;
    questionsAnsweredToday: number;
    accuracyToday: number | null;
    cardsReviewedToday: number;
    newCardsIntroducedToday: number;
}

export interface FeedCatchUp {
    active: boolean;
    overdueLeaves: number;
    projects: { projectId: number; name: string; overdue: number }[];
}

export interface FeedDeadline {
    projectId: number;
    name: string;
    color: string;
    deadline: string;
    daysLeft: number;
    paceStatus: string;
    daysBehind: number;
}

/** One thing the learner actually did today (GET /api/today/activity). */
export interface TodayActivityEvent {
    /** ISO-8601, UTC — normalised server-side from two different stored shapes. */
    at: string;
    kind: 'card' | 'question' | 'lesson' | 'topic';
    /** For a question: where it was answered ('feed', or the evidence type). */
    source?: string;
    projectId: number;
    projectName: string;
    projectColor: string | null;
    nodeId: number;
    nodeTitle: string;
    title: string;
    detail: string;
    /** null where the event has no right-or-wrong (a lesson, a closed topic). */
    correct: boolean | null;
}

export interface TodayActivitySummary {
    /** Distinct cards met. `cardAnswers` is ratings given — a card on the
     *  (re)learning ladder is answered more than once, so these differ. */
    cards: number;
    cardAnswers: number;
    againAnswers: number;
    lessonsRead: number;
    topicsClosed: number;
    /** Feed questions only, matching the header chip exactly. */
    questionsAnswered: number;
    questionsCorrect: number;
    accuracy: number | null;
    /** Assessments taken somewhere other than the feed (Boss Fight, paper…). */
    otherAssessments: number;
}

export interface TodayActivity {
    date: string;
    summary: TodayActivitySummary;
    projects: { projectId: number; name: string; color: string | null; events: number }[];
    events: TodayActivityEvent[];
    /** Events beyond the payload cap, so the dialog can say "and N more". */
    truncated: number;
}

export interface FeedHeaderData {
    date: string;
    stats: FeedStats;
    catchUp: FeedCatchUp;
    deadline: FeedDeadline | null;
}

// ---- Atlas (GET /api/atlas — server/atlas.js) --------------------------------

/**
 * What colour MEANS on the atlas map: how much of a region is proven (the
 * default), or which course its topics come from. Lightness carries mastery in
 * both, so choosing `course` adds a dimension rather than trading one away.
 */
export type AtlasColorMode = 'mastery' | 'course';

/**
 * Which surface the atlas is drawn on: the flat map, or Terra — the library as
 * a planet you turn.
 *
 * A preference rather than view state, like `AtlasColorMode`: a reader who
 * prefers the globe should still get the globe tomorrow.
 */
export type AtlasSurface = 'map' | 'globe';

export interface AtlasTopic {
    id: number;
    title: string;
    status: Node['status'];
    projectId: number;
    projectName: string;
    projectColor: string | null;
    mastery: number;
    attempts: number;
    /** This topic's estimate was seeded from a twin elsewhere. */
    transferred: boolean;
    /**
     * The nearest ancestor that is ALSO on the map, or null for a root.
     *
     * Not `parent_id`: a chapter heading can be off the map for three ordinary
     * reasons (it is a note, it is a deck's pagination slice, its vector has
     * not been written yet), and an edge to something with no coordinates
     * cannot be drawn. Walking to the nearest mapped ancestor keeps the course
     * connected through the gap.
     */
    parentId: number | null;
    /** Depth in the DRAWN tree — how many mapped ancestors this topic has. */
    depth: number;
    /** When it was closed (ISO, UTC), or null. The journey's only ordering. */
    completedAt: string | null;
    /** How representative of its region — 1 = the region's most central topic. */
    centrality: number;
    /** Where it sits inside its region's bubble, in the map's coordinates. */
    x: number;
    y: number;
}

export interface AtlasRegionProject {
    id: number;
    name: string;
    color: string | null;
    /**
     * When the course began (ISO, UTC): its scheduled start, or the day it
     * entered the library. The left edge of the journey's timeline — the first
     * finish is a place ON that timeline, never the start of it.
     */
    start: string | null;
    count: number;
}

export interface AtlasRegion {
    id: number;
    /**
     * What the map calls this place. A model-written name where one has been
     * earned, the learner's own where they typed one, and otherwise the most
     * central topic's title with curriculum numbering stripped.
     */
    label: string;
    /** The member the medoid label came from — the name's provenance. */
    labelTopicId: number;
    /** Who named it. Decides what the region card offers to do about it. */
    labelSource: 'medoid' | 'model' | 'user';
    /** What the medoid rule would have said, so a written name is auditable. */
    medoidLabel: string;
    /**
     * The region's stable identity: a hash of its member set. A region has no
     * id of its own (indices renumber on every rebuild), so this is what a
     * rename addresses.
     */
    signature: string;
    size: number;
    projects: AtlasRegionProject[];
    /** Drawn from more than one project: where the library actually overlaps. */
    crossProject: boolean;
    mastery: { proven: number; learning: number; untouched: number; avg: number };
    /** Big enough to carry a label on the map. */
    isLandmark: boolean;
    /** Layout, in [-1, 1]; `radius` is in the same units. */
    x: number;
    y: number;
    radius: number;
    /**
     * Where this region sits on the GLOBE: a unit 3-vector, from a three-
     * component projection of the same centroids the flat layout uses two of
     * (`server/globe.js`).
     *
     * The globe view is a different projection of the material, not the flat
     * map wrapped round a ball — which is why this is its own coordinate and
     * not derived from `x`/`y`.
     */
    u: [number, number, number];
    /**
     * How wide the region is on the globe, as an angular radius in radians —
     * the sphere's `radius`, and derived the same way: from the cap's AREA, so
     * what tracks the topic count is the ink rather than the width.
     */
    cap: number;
    /** Radius of one topic dot inside this bubble, in the same units. */
    topicRadius: number;
    topics: AtlasTopic[];
}

/** A cross-project pair that means the same thing. `a` is the better-known side. */
export interface AtlasBridgeSide {
    id: number;
    title: string;
    projectId: number;
    projectName: string;
    projectColor: string | null;
    status: Node['status'];
    mastery: number;
}

export interface AtlasBridge {
    similarity: number;
    /** `a` is proven — this bridge is a head start waiting to be claimed. */
    proven: boolean;
    a: AtlasBridgeSide;
    b: AtlasBridgeSide;
}

export interface AtlasData {
    /** false when the topic space can't be read — `reason` says why. */
    available: boolean;
    reason: string | null;
    stats: {
        topics: number;
        mapped: number;
        projects: number;
        regions: number;
        crossProjectRegions?: number;
        proven: number;
        learning: number;
        untouched: number;
        regionSimilarity?: number;
        regionCap?: number;
        capped?: boolean;
        regionSizeCap?: number;
        largestRegion?: number;
        /** Mapped topics carrying a usable finish date — the journey's length. */
        dated?: number;
        /** Finished topics with no usable date, which no path can place in time. */
        undated?: number;
    };
    regions: AtlasRegion[];
    bridges: AtlasBridge[];
    builtAt?: string;
    /** The state of region naming itself — computed per request, never cached. */
    naming?: {
        cached: number;
        newest: string | null;
        byUser: number;
        /** Regions the naming model has failed enough times to be left alone. */
        givenUp: number;
        model: string | null;
    };
}

/** One already-proven topic a head start was borrowed from. */
export interface TransferSource {
    node_id: number;
    title: string;
    project_id: number;
    project_name: string;
    project_color: string | null;
    similarity: number;
    mastery: number;
    decayed: number;
    contribution: number;
}

/**
 * "You have studied this before, somewhere else." The seeded BKT prior for a
 * topic, plus the proven twins it came from (see server/masteryTransfer.js).
 *
 * `prior` is capped well below the mastery threshold by construction and can
 * never close a gate on its own — this is a head start on the *teaching*, and
 * the learner still proves the topic here. `spent` marks a head start the
 * learner has already answered past: worth explaining, not worth offering.
 */
export interface TransferInfo {
    prior: number;
    sources: TransferSource[];
    at: string | null;
    spent: boolean;
}

export interface FeedResponse {
    date: string;
    header: FeedHeaderData;
    items: FeedCard[];
    exhausted: boolean;
    /** Set when the stream was scoped to one topic or section ("Study this"). */
    nodeId?: number | null;
    /** Head starts for the topics in `items`, keyed by node id. */
    transfers?: Record<number, TransferInfo>;
}

/** Payload recorded when a lesson/question/recall card is consumed. */
export interface FeedConsumeResult {
    correct?: boolean;
    answer?: string;
    gradedBy?: 'local' | 'ai' | 'fallback';
    read?: boolean;
}

/** Due card from any active project (GET /api/flashcards/due). */
export interface GlobalDueFlashcard extends ProjectFlashcard {
    project_id: number;
    project_name: string;
    project_color: string;
}

// Global calendar feed (GET /api/calendar?from&to).
export interface GlobalCalendarTask {
    nodeId: number;
    projectId: number;
    title: string;
    status: string;
    scheduled_start: string;
    scheduled_end: string;
}

export interface GlobalCalendarData {
    projects: { id: number; name: string; color: string }[];
    tasks: GlobalCalendarTask[];
}

export interface Quiz {
    id: number;
    node_id: number;
    title: string;
    questions: QuizQuestion[];
    created_at: string;
    attempt_count?: number;
    best_score?: number | null;
}

export interface QuizAttempt {
    id: number;
    quiz_id: number;
    score: number;
    total: number;
    answers: Record<number, string>;
    created_at: string;
}

export interface Flashcard {
    id: number;
    node_id: number;
    front: string;
    back: string;
    difficulty: number;
    last_reviewed: string | null;
    next_review: string | null;
    review_count: number;
    /** SM-2 ease factor (>= 1.3). Defaults to 2.5 for new cards. */
    ease_factor?: number;
    /** Last scheduled interval in days (FSRS `scheduled_days`). */
    last_interval?: number;
    /** FSRS-6 memory state. NULL stability = never scheduled by FSRS, which is
     *  what the SM-2 migration path in src/utils/srs.ts keys on. */
    stability?: number | null;
    /** FSRS's own difficulty, 1-10. Distinct from `difficulty` (app 0-5). */
    fsrs_difficulty?: number | null;
    /** FSRS card state: 0 New, 1 Learning, 2 Review, 3 Relearning. */
    state?: number | null;
    lapses?: number | null;
    /** Which rung of the (re)learning ladder the card is on. 0 for anything not
     *  mid-ladder. Persisted because FSRS's next step depends on it. */
    learning_steps?: number | null;
    /** Supporting lines shown under the ANSWER — a reading, an example sentence,
     *  its translation. Newline-separated; never part of the answer itself. */
    extra?: string | null;
    /** Supporting lines the deck's author printed on the QUESTION, beside the
     *  prompt — for a vocabulary deck, the example sentence, which is how Anki
     *  shows it and most of why the sentence is on the card. Read from the card
     *  TEMPLATE at import; NULL when nothing said so (a hand-made or AI-written
     *  card, or an unreadable template), and then `contextSentence` infers one
     *  line instead. */
    extra_front?: string | null;
    /** Pictures/audio for each side, as the JSON string the column holds
     *  (`{front:[{hash,kind,name,alt}],back:[…]}`). Parsed in exactly one place,
     *  `parseCardMedia` in `CardMedia.tsx` — every endpoint `SELECT *`s this
     *  column, so parsing at the render site keeps the query sites untouched. */
    media?: string | null;
    created_at: string;
}

// Practice drills (D-023) — an AI-authored (or flashcard-degraded) mini practice
// game. The model emits ONLY this structured spec in a ```drill fence (data, not
// code), and a native React player renders the loop. That keeps drills reliable
// on any model size (no code to get wrong) and general across every subject: the
// loop is fixed, only the item bank varies.
export type DrillMode = 'choice' | 'type';

export interface DrillItem {
    /** Shown to the learner (the kana, the element symbol, the term, the date). */
    prompt: string;
    /** The correct response. */
    answer: string;
    /** Optional near-miss wrong options for choice mode; sampled from siblings when absent. */
    distractors?: string[];
    /** Optional one-line explanation revealed after answering. */
    note?: string;
}

export interface DrillSpec {
    /** Informational genre tag ("recognition", "recall", …); not behavioural. */
    kind?: string;
    title?: string;
    /** Question stem, e.g. "What sound is this?". */
    promptLabel?: string;
    /** Noun for the answer, e.g. "reading" — used in labels/placeholders. */
    answerLabel?: string;
    /** Response modes offered; the player lets the learner switch when both are present. */
    modes: DrillMode[];
    items: DrillItem[];
    /** Round length + optional per-item countdown (the speed pressure). */
    target?: { count?: number; secondsPerItem?: number | null };
    /** Node this drill practises — set by the launcher so a full round records mastery. */
    nodeId?: number;
    /** Where the spec came from (AI fence vs synthesised from the node's flashcards). */
    source?: 'ai' | 'flashcards';
}

/** Outcome of one completed drill round, reported up for mastery recording. */
export interface DrillRoundResult {
    correct: number;
    total: number;
    /** False for a "only the ones I missed" round (a biased subset — never recorded as evidence). */
    full: boolean;
    /** Wall-clock seconds the round took. */
    seconds: number;
}

export interface Document {
    id: number;
    node_id: number | null;
    project_id: number | null;
    title: string;
    content?: string;
    file_type: string;
    // Vault: original-file metadata (null for text-only docs created via API).
    original_filename?: string | null;
    file_hash?: string | null;
    file_size?: number | null;
    status?: 'ready' | 'failed' | string;
    error?: string | null;
    page_count?: number | null;
    // Semantic-search indexing state: null/'pending' = queued/in-flight,
    // 'indexed' = vectors written, 'unavailable' = no embedding model reachable,
    // 'error' = embedding failed. Drives the Vault indexing badge.
    embedding_status?: 'pending' | 'indexed' | 'unavailable' | 'error' | null;
    // Math-recovery state for PDFs whose text layer dropped their formulas
    // (subsetted fonts, no ToUnicode). null = n/a (clean text layer or not a PDF),
    // 'running' = re-reading pages in the background, 'recovered' = formulas
    // re-read from the render, 'failed' = attempted but nothing gained, 'skipped'
    // = analysed and no recovery needed. See server/pdfRecovery.js.
    recovery_status?: 'running' | 'recovered' | 'failed' | 'skipped' | 'pending' | null;
    // JSON: { method:'vision'|'ocr'|'mixed', recovered:N, degradedPages:[…], perPage:{…} }
    recovery_meta?: string | null;
    // Number of characters extracted for RAG (from LENGTH(content) in the list query).
    char_count?: number | null;
    created_at: string;
}

// Semantic-search (Vault embeddings) config + status, from GET /api/embeddings/status.
export type EmbeddingProvider = 'auto' | 'ollama' | 'openai';
export interface EmbeddingConfig {
    enabled: boolean;
    model: string;
    /** Which endpoint serves embeddings; 'auto' follows the chat provider. */
    provider: EmbeddingProvider;
    dim: number | null;
    vecAvailable: boolean;
}
export interface EmbeddingStatus {
    config: EmbeddingConfig;
    stats: {
        indexed: number;
        pending: number;
        unavailable: number;
        error: number;
        total: number;
        vectors: number;
    };
    probe: { ok: boolean; dim?: number | null; model?: string; reason?: string } | null;
}

// Per-file result returned by POST /api/documents/upload.
export interface UploadedDocument {
    ok: boolean;
    id: number;
    title: string;
    file_type?: string;
    file_hash?: string;
    file_size?: number;
    page_count?: number | null;
    status: 'ready' | 'failed' | string;
    chunks?: number;
    error?: string;
}

export type AIProvider = 'ollama' | 'openai';

export interface AIStatus {
    provider: AIProvider;
    ollamaUrl: string;
    /** OpenAI-compatible API root (llama-swap, llama.cpp, LM Studio, OpenRouter, …) */
    baseUrl: string;
    hasApiKey: boolean;
    model: string;
    enabled: boolean;
    available: boolean;
    models?: { name: string }[];
    error?: string;
}

export interface InsightAction {
  type: 'open_node' | 'generate_flashcards' | 'generate_quiz' | 'recalibrate';
  nodeId?: number;
  label: string;
  variant: 'primary' | 'secondary' | 'outline';
}

export interface LearningInsights {
    stats: {
        completed: number;
        inProgress: number;
        total: number;
        quizAttempts: number;
        flashcards: number;
    };
    insights: string | { message: string; actions: InsightAction[] };
}

export interface ConfirmDialogState {
    isOpen: boolean;
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
    // danger = destructive (delete/remove), warning = reversible-but-notable,
    // info = benign confirmation (e.g. bulk upload) — never red/trash.
    variant: 'danger' | 'warning' | 'info';
    resolvePromise: ((value: boolean) => void) | null;
}

export interface ShowConfirmOptions {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: 'danger' | 'warning' | 'info';
}

// AI Creation Floating State

export interface AICreationProgressInfo {
    phase: string;
    message: string;
    overallProgress: number;
    projectName: string;
}

// Study Dashboard Types

export interface DashboardFlashcardDeck {
    categoryId: number;
    categoryTitle: string;
    totalCards: number;
    dueCount: number;
    weakCount: number;
}

export interface DashboardWeakTopic {
    node_id: number;
    title: string;
    avg_score: number;
    attempt_count: number;
}

export interface DashboardQuizAttempt {
    score: number;
    total: number;
    node_title: string;
    quiz_title: string;
    created_at: string;
}

export interface DashboardTodayTopic {
    id: number;
    title: string;
    status: string;
    scheduled_start: string | null;
    scheduled_end: string | null;
    parent_id: number | null;
}

export interface DashboardOverdueTopic {
    id: number;
    title: string;
    status: string;
    scheduled_end: string;
    parent_id: number | null;
    daysOverdue: number;
}

export interface DashboardMilestoneSegment {
    id: number;
    title: string;
    completed: boolean;
    skipped?: boolean;
}

export interface DashboardReviewTopic {
    id: number;
    title: string;
    masteryScore: number;
    /** Time-faded mastery estimate; the honest "current" score for this card. */
    decayedScore?: number;
    status: string;
    lastReviewed: string | null;
}

export interface DashboardMilestone {
    id: number;
    title: string;
    percentage: number;
    completed: number;
    total: number;
    segments?: DashboardMilestoneSegment[];
}

export interface DashboardData {
    todaySchedule: DashboardTodayTopic[];
    overdueTopics: DashboardOverdueTopic[];
    heroTask: DashboardTodayTopic | DashboardOverdueTopic | null;
    milestones: DashboardMilestone[];
    reviewTopics?: DashboardReviewTopic[];
    /** True when the learner has proven at least one topic (drives the "all fresh" empty state). */
    provenTopics?: boolean;
    flashcardSummary: {
        totalCards: number;
        /** Reviews OWED — never-seen cards are not a debt (server/decks.js). */
        dueCount: number;
        /** Unseen cards today's allowance still permits. */
        newAvailable: number;
        newPerDay: number;
        introducedToday: number;
        weakCount: number;
        retention: number | null;
        decks: DashboardFlashcardDeck[];
    };
    quizSummary: {
        totalQuizzes: number;
        averageScore: number | null;
        weakTopics: DashboardWeakTopic[];
        recentAttempts: DashboardQuizAttempt[];
    };
    insights: string | null;
    pace: PaceData | null;
    stats: {
        totalNodes: number;
        completedNodes: number;
        progressPercent: number;
        daysUntilDeadline: number | null;
    };
}

export interface ProjectFlashcard extends Flashcard {
    node_title?: string;
    parent_id?: number | null;
    categoryTitle?: string;
    categoryId?: number | null;
}

export interface ProjectQuiz extends Quiz {
    node_title?: string;
    attempt_count?: number;
    best_score?: number | null;
    avg_score?: number | null;
}

//
// Unified Search Types
//

export type SearchMatchType = 'exact' | 'contains' | 'wordStart' | 'trigram' | 'levenshtein' | 'fuzzy';

export interface SearchMatchRange {
    start: number;
    end: number;
}

export interface SearchProjectResult {
    type: 'project';
    projectId: number;
    title: string;
    color: string;
    icon: string;
    matchField: string;
    snippet: string;
    matchRanges: SearchMatchRange[];
    score: number;
}

export interface SearchNodeResult {
    type: 'node';
    projectId: number;
    projectName?: string;
    projectColor?: string;
    nodeId: number;
    title: string;
    status: string;
    matchField: string;
    snippet: string;
    matchRanges: SearchMatchRange[];
    score: number;
}

export interface SearchResourceResult {
    type: 'resource';
    projectId: number;
    projectName?: string;
    projectColor?: string;
    nodeId: number;
    nodeTitle?: string;
    title: string;
    url: string;
    resourceType: string;
    matchField: string;
    snippet: string;
    matchRanges: SearchMatchRange[];
    score: number;
}

export interface SearchDocumentResult {
    type: 'document';
    projectId: number;
    projectName?: string;
    projectColor?: string;
    documentId: number;
    nodeId: number | null;
    title: string;
    matchField: string;
    snippet: string;
    matchRanges: SearchMatchRange[];
    score: number;
}

export type SearchResultItem = SearchProjectResult | SearchNodeResult | SearchResourceResult | SearchDocumentResult;

export interface SearchResults {
    projects: SearchProjectResult[];
    nodes: SearchNodeResult[];
    resources: SearchResourceResult[];
    documents: SearchDocumentResult[];
}

export interface SearchSuggestion {
    type: 'node';
    projectId: number;
    projectName?: string;
    projectColor?: string;
    nodeId: number;
    title: string;
    status: string;
}
/**
 * One row of the cross-project schedule board (`GET /api/schedule/overview`).
 *
 * Carries BOTH the declared project window (`start_date`/`deadline`) and the
 * true extent of its scheduled leaves, because the two can disagree and the
 * board's job is to show that rather than hide it behind one tidy bar.
 */
export interface ScheduleOverviewRow {
    id: number;
    uuid?: string;
    name: string;
    color: string;
    icon: string;
    position: number;
    status?: 'active' | 'completed' | 'archived';
    start_date: string | null;
    deadline: string | null;
    study_days: string;
    /** Leaves still open — the number a reschedule would move. */
    openLeaves: number;
    totalLeaves: number;
    scheduledLeaves: number;
    firstScheduledStart: string | null;
    lastScheduledEnd: string | null;
    /** Cards in the project, and how many have been met at least once — the
     *  same pair the Projects grid counts. A collection of cards has no topics
     *  to report, so this is what it reports instead. */
    cardCount: number;
    seenCardCount: number;
    /** May its topics be taught (`projectTeaches`)? With `totalLeaves`, this
     *  decides whether the card is measured in topics or in cards. */
    teaches: boolean;
    /** Where the plan says you should be against where you are. Null when the
     *  project has no window — there is nothing to be behind. The sentence is
     *  built on the client: server-written text stays English. */
    pace: {
        paceStatus: PaceStatus;
        expectedProgress: number;
        actualProgress: number;
        /** expected − actual, in points. Negative is ahead. */
        drift: number;
        totalDays: number;
    } | null;
}

export interface ScheduleOverview {
    projects: ScheduleOverviewRow[];
    today: string;
}

/* --- Authoring a course with an external chat model ----------------------- *
 * Two prompts, because one chat reply cannot hold both a curriculum and its
 * teaching (see server/authoringBrief.js for the measurement). Pass one writes
 * the tree; pass two fills one phase with real material and is merged into the
 * project that already exists.
 * -------------------------------------------------------------------------- */

export interface OutlineBriefFields {
    subject?: string;
    level?: string;
    goal?: string;
    depth?: string;
    language?: string;
}

export interface AuthoringPhase {
    id: number;
    title: string;
    leaves: number;
    withMaterial: number;
}

export interface AuthoringPhases {
    project: { id: number; name: string };
    phases: AuthoringPhase[];
}

export interface MaterialBrief {
    prompt: string;
    phase: { id: number; title: string } | null;
    leaves: number;
}

export interface MaterialMergeResult {
    added: number;
    topics: { title: string; readings: number; replaced: boolean }[];
    unmatched: { title: string; reason: string }[];
    warnings: string[];
}

/** Identity of the running build. Served by `GET /api/version` — one source of
 *  truth, so a bug report and the update check can never disagree about what is
 *  running. `commit` is null on an unpacked copy with no `.git` and no build arg. */
export interface AppVersion {
    version: string;
    commit: string | null;
    commitShort: string | null;
    builtAt: string | null;
    node: string;
    platform: string;
    deployment: 'docker' | 'git' | 'source';
    updateCommand: string | null;
    repoUrl: string;
}

/** A published release, as the update check reports it. */
export interface ReleaseInfo {
    version: string;
    tag: string;
    name: string | null;
    url: string;
    publishedAt: string | null;
}

/** What `GET /api/updates` answers. `available` is false whenever the check
 *  could not tell — "I don't know" must never render as "you are behind". */
export interface UpdateStatus {
    enabled: boolean;
    current: string;
    latest: ReleaseInfo | null;
    available: boolean;
    checkedAt: string | null;
    error: string | null;
    repoUrl: string;
    deployment: 'docker' | 'git' | 'source';
    updateCommand: string | null;
    throttled?: boolean;
}

/**
 * One line of the local activity log (server/activityLog.js).
 *
 * There is no field here for a topic title, a prompt or an answer, and that is
 * the design rather than an omission: the log is what the SOFTWARE did, so the
 * file it exports can be handed to a developer or a coding agent without
 * reading it first. `projectTitle` is resolved on the way to the screen and is
 * never stored — a project deleted since leaves the id and no title, which is
 * itself the answer to "what happened to it".
 */
export interface ActivityEvent {
    id: number;
    at: string;
    level: 'info' | 'warn' | 'error';
    area: string;
    event: string;
    detail: string | null;
    ms: number | null;
    projectId: number | null;
    nodeId: number | null;
    projectTitle: string | null;
}

export interface ActivityStats {
    rows: number;
    problems: number;
    oldest: string | null;
    newest: string | null;
    /** The row cap: the log is a ring buffer, not an archive. */
    max: number;
    enabled: boolean;
}

/**
 * The record of a finished project (`GET /api/projects/:id/completion`).
 *
 * Returned whether or not the project is finished: `complete` is the only field
 * that decides whether anything is shown, and the rest is needed anyway when
 * the summary is reopened from the project's own menu months later.
 *
 * There is no "time spent" here and there cannot be — nothing in the app has
 * ever written a `learning_sessions` row — so the effort axis is days: days
 * from first to last, days with any activity, and the longest run of them.
 */
export interface ProjectCompletion {
    complete: boolean;
    /** Already seen and dismissed. Stops the screen opening itself twice. */
    celebrated: boolean;
    project: {
        id: number;
        name: string;
        icon: string;
        color: string;
        status: 'active' | 'completed' | 'archived';
        deadline: string | null;
        startDate: string | null;
    };
    work: {
        fraction: number;
        /** `completed` was proven; `skipped` was closed without being proven. */
        topics: { total: number; completed: number; skipped: number };
        cards: { total: number; met: number };
    };
    effort: {
        /** Rows in `review_log`, this app's own only — never an imported revlog. */
        reviews: number;
        cardsSeen: number;
        /** Graded questions. Card ratings are reviews, not questions. */
        answers: number;
        correct: number;
        /** Null when nothing was ever asked — which is not the same as 0%. */
        accuracy: number | null;
        sittings: number;
        quizzes: number;
        papers: number;
    };
    mastery: { tracked: number; proven: number; average: number | null; threshold: number };
    span: {
        firstDay: string;
        lastDay: string;
        calendarDays: number;
        studyDays: number;
        longestStreak: number;
        bestDay: { date: string; count: number };
    } | null;
    /** Against the plan, if there was one. Positive `daysEarly` is early. */
    schedule: { deadline: string; daysEarly: number } | null;
    /** Equal-width buckets spanning first → last; null when there is no shape
     *  to see (fewer than three buckets, or no dated activity at all). */
    timeline: { days: number; buckets: { start: string; count: number }[] } | null;
}

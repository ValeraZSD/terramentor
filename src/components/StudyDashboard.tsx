import { useState, useEffect } from 'react';
import { onActivateKey } from '../utils/a11y';
import { useStore } from '../store';
import type { ProjectQuiz } from '../types';
import GlobalFlashcardReview from './GlobalFlashcardReview';
import { paceHeadline } from '../utils/pace';
import CardsPanel from './deck/CardsPanel';
import ProjectQuizzesList from './ProjectQuizzesList';
import QuizView from './QuizView';
import {
    BookOpen, Brain, CheckCircle2, Zap, RefreshCw, Loader2,
    Sparkles, Milestone, BarChart3, Play, RotateCcw,
    ListChecks, AlertTriangle, Clock, Layers, ArrowRight, FileText
} from 'lucide-react';
import { getIconEmoji } from './IconPicker';
import BulkGenerateModal from './BulkGenerateModal';
import Modal from './Modal';
import { MaterialPassPanel } from './ExternalAuthoring';
import PlacementCard from './PlacementCard';
import { todayStr } from '../utils/tree';
import { pretty } from '../utils/scheduleAxis';
import { useTranslation } from 'react-i18next';

export default function StudyDashboard() {
    const { t: tr } = useTranslation();
    const currentProjectId = useStore(s => s.currentProjectId);
    const projects = useStore(s => s.projects);
    const selectNode = useStore(s => s.selectNode);
    const studyProject = useStore(s => s.studyProject);
    const addToast = useStore(s => s.addToast);
    const recalibrateSchedule = useStore(s => s.recalibrateSchedule);
    const dashboard = useStore(s => s.dashboardData);
    const dashboardLoading = useStore(s => s.dashboardLoading);
    const dailyPlan = useStore(s => s.dailyPlan);
    const selectedNodeId = useStore(s => s.selectedNodeId);
    const openAssistant = useStore(s => s.openAssistant);

    const [showFlashcardReview, setShowFlashcardReview] = useState(false);
    const [recalibrating, setRecalibrating] = useState(false);
    const [showAllQuizzes, setShowAllQuizzes] = useState(false);
    const [selectedQuiz, setSelectedQuiz] = useState<ProjectQuiz | null>(null);
    const [quizListKey, setQuizListKey] = useState(0);
    const [showBulk, setShowBulk] = useState(false);
    const [showMaterial, setShowMaterial] = useState(false);

    const project = projects.find(p => p.id === currentProjectId);

    useEffect(() => {
        if (currentProjectId) {
            useStore.getState().loadDashboard(currentProjectId);
        }
    }, [currentProjectId]);

    const handleRefresh = async () => {
        if (!currentProjectId) return;
        const result = await useStore.getState().loadDashboard(currentProjectId);
        if (!result.success) {
            addToast('error', tr("Failed to refresh dashboard"), result.error);
        }
    };

    const handleRecalibrate = async () => {
        if (!currentProjectId) return;
        setRecalibrating(true);
        await recalibrateSchedule(currentProjectId);
        setRecalibrating(false);
        useStore.getState().loadDashboard(currentProjectId);
    };

    // Full-page spinner only on initial load; background refreshes preserve stale data
    if (dashboardLoading && !dashboard) {
        return (
            <div className="flex-1 flex items-center justify-center bg-slate-100 dark:bg-slate-900">
                <div className="text-center">
                    <Loader2 className="w-10 h-10 text-accent-fg animate-spin mx-auto mb-4" />
                    <p className="text-slate-600 dark:text-slate-300 font-medium">{tr("Loading your study hub…")}</p>
                </div>
            </div>
        );
    }

    if (!dashboard || !project) {
        return (
            <div className="flex-1 flex items-center justify-center bg-slate-100 dark:bg-slate-900">
                <div className="text-center text-slate-400">
                    <BarChart3 className="w-12 h-12 mx-auto mb-3 opacity-50" />
                    <p className="text-lg font-medium">{tr("No Data Available")}</p>
                </div>
            </div>
        );
    }

    const { heroTask, milestones, flashcardSummary, quizSummary, pace, stats } = dashboard;
    const hasCards = (project.card_count ?? 0) > 0 || flashcardSummary.totalCards > 0;
    const reviewTopics = dashboard.reviewTopics ?? [];
    const provenTopics = dashboard.provenTopics ?? false;
    const isBehind = pace && (pace.paceStatus === 'falling_behind' || pace.paceStatus === 'critical');

    // The review is an OVERLAY, not a replacement. It takes the whole screen
    // (see GlobalFlashcardReview's SURFACE), and returning an early `return`
    // here would unmount the dashboard behind it — so closing the session would
    // rebuild the page and throw away the scroll position the learner left.
    const flashcardReview = showFlashcardReview && currentProjectId ? (
        <GlobalFlashcardReview
            projectId={currentProjectId}
            onClose={() => setShowFlashcardReview(false)}
            onComplete={() => {
                setShowFlashcardReview(false);
                useStore.getState().loadDashboard(currentProjectId);
            }}
        />
    ) : null;

    if (showAllQuizzes && currentProjectId) {
        if (selectedQuiz) {
            return (
                <QuizView
                    quiz={selectedQuiz}
                    onClose={() => {
                        setSelectedQuiz(null);
                        setQuizListKey(k => k + 1);
                        useStore.getState().loadDashboard(currentProjectId);
                    }}
                />
            );
        }
        return (
            <ProjectQuizzesList
                key={quizListKey}
                projectId={currentProjectId}
                onSelectQuiz={(quiz) => setSelectedQuiz(quiz)}
                onClose={() => {
                    setShowAllQuizzes(false);
                    setSelectedQuiz(null);
                }}
            />
        );
    }

    return (
        <>
        {flashcardReview}
        <div className="flex-1 overflow-auto bg-slate-100 dark:bg-slate-900">
            <div className="max-w-4xl mx-auto p-4 sm:p-6 space-y-6">

                <div className="flex items-center justify-between gap-2">
                    {/* `min-w-0` all the way down, or the truncate below cannot
                        fire: a flex item's default `min-width: auto` refuses to
                        shrink past its content, and a long course name then
                        pushed the whole page into a horizontal scroll. */}
                    <div className="min-w-0">
                        <h2 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-3 min-w-0">
                            <div
                                className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 text-xl leading-none"
                                style={{ backgroundColor: project.color || '#8B5CF6' }}
                                aria-label={tr("{{name}} icon", { name: project.name })}
                            >
                                <span role="img">{getIconEmoji(project.icon)}</span>
                            </div>
                            {/* The project's NAME, not a greeting. This header
                                spent its largest type on "Welcome Back!" — a
                                sentence that is the same on every project, on
                                every visit, and that leaves the one screen
                                devoted to a course unable to say which course
                                it is. */}
                            <span className="min-w-0 truncate">{project.name}</span>
                        </h2>
                        <p className="text-slate-500 dark:text-slate-400 mt-1 ml-[52px]">
                            {tr("{{progressPercent}}% complete •", { progressPercent: stats.progressPercent })}{' '}{paceHeadline(pace?.paceStatus, pace?.daysBehind ?? 0, tr)}
                        </p>
                    </div>
                    <button onClick={handleRefresh} className="shrink-0 p-2 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition" title={tr("Refresh")}>
                        <RefreshCw className="w-5 h-5" />
                    </button>
                </div>

                {/* Placement — BEFORE the hero task, not after it.
                    "Where should we start?" under a card headed "Just start
                    here" is the page answering a question it has already
                    answered, in the wrong order: the probe is what decides
                    where to start, so it has to be read first. It renders
                    nothing once there is nothing to offer
                    (server/placement.js), so the position costs nothing in
                    the ordinary case. */}
                {currentProjectId && (
                    <PlacementCard
                        projectId={currentProjectId}
                        projectName={projects.find(p => p.id === currentProjectId)?.name ?? 'this project'}
                    />
                )}

                {/* Hero task — most urgent learning item */}
                <section className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
                    <div className="flex items-center gap-2 mb-4">
                        <Zap className="w-5 h-5 text-amber-500" />
                        <h3 className="text-sm font-semibold text-slate-900 dark:text-white">{tr("Next up")}</h3>
                    </div>

                    {heroTask ? (
                        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                            <div className="flex-1">
                                <p className="text-lg font-medium text-slate-900 dark:text-white mb-1">
                                    {heroTask.title}
                                </p>
                                <p className="text-sm text-slate-500 dark:text-slate-400">
                                    {heroTask.scheduled_end && heroTask.scheduled_end < todayStr()
                                        ? tr("Overdue — it was due {{when}}.", { when: pretty(heroTask.scheduled_end) })
                                        : tr("Scheduled for today.")}
                                </p>
                            </div>
                            {/* This enters the course's own STREAM, and it
                                begins with this very topic because both read
                                the same urgency order (`getFocusNodes`,
                                server/feed.js) — and, unlike studying the
                                topic alone, it does not stop when the topic
                                does. Not `selectNode`: that opens the detail
                                panel, which is an editor (the overview with
                                its edit strip, status radios, the weight
                                field, private notes), and the biggest button
                                on the screen may not be named for learning
                                and open a form. */}
                            <button
                                onClick={() => currentProjectId != null && studyProject(currentProjectId)}
                                title={tr("Teach me this course, starting here")}
                                className="flex items-center gap-2 px-5 py-2.5 min-h-11 bg-accent text-white rounded-xl transition-all font-medium shadow-sm shrink-0 hover:brightness-90 active:brightness-75"
                            >
                                <Play className="w-4 h-4" />
                                {tr("Start Studying")}
                            </button>
                        </div>
                    ) : (
                        <div className="text-center py-4">
                            <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto mb-2" />
                            <p className="text-slate-600 dark:text-slate-300 font-medium">{tr("All caught up!")}</p>
                            <p className="text-sm text-slate-500 dark:text-slate-400">{tr("Nothing is scheduled or overdue right now.")}</p>
                        </div>
                    )}

                    {isBehind && (
                        <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-700 flex items-center justify-between">
                            <p className="text-sm text-slate-500 dark:text-slate-400">
                                {tr("You are behind the plan. Recalibrating spreads what is left over the days that remain.")}
                            </p>
                            <button
                                onClick={handleRecalibrate}
                                disabled={recalibrating}
                                className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-900/30 transition"
                            >
                                {recalibrating ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                                {tr("Recalibrate Schedule")}
                            </button>
                        </div>
                    )}
                </section>

                {/* Today's Plan — the consolidated agenda (server/dailyPlan.js) */}
                {dailyPlan && (dailyPlan.overdueTasks.length > 0 || dailyPlan.todayTasks.length > 0 ||
                    dailyPlan.summary.decayingCount > 0 || dailyPlan.summary.dueFlashcardCount > 0) && (
                    <section className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
                        <div className="flex items-center gap-2 mb-4">
                            <ListChecks className="w-5 h-5 text-accent-fg" />
                            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">{tr("Today's Plan")}</h3>
                        </div>

                        {(dailyPlan.overdueTasks.length > 0 || dailyPlan.todayTasks.length > 0) ? (
                            <div className="space-y-4 mb-4">
                                {/* Overdue — kept compact; the section label carries the status, not each card */}
                                {dailyPlan.overdueTasks.length > 0 && (
                                    <div>
                                        <div className="flex items-center gap-1.5 mb-2 text-xs font-semibold text-red-500 dark:text-red-400">
                                            <AlertTriangle className="w-3.5 h-3.5" />
                                            {tr("Overdue ({{length}})", { length: dailyPlan.overdueTasks.length })}
                                        </div>
                                        <div className="grid gap-2 grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]">
                                            {dailyPlan.overdueTasks.slice(0, 6).map(t => (
                                                <button
                                                    key={`o-${t.id}`}
                                                    onClick={() => selectNode(t.id)}
                                                    className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-red-100 dark:border-red-900/40 bg-red-50/50 dark:bg-red-900/10 hover:bg-red-50 dark:hover:bg-red-900/20 transition text-left"
                                                >
                                                    <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
                                                    <span className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">{t.title}</span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Divider between overdue and today */}
                                {dailyPlan.overdueTasks.length > 0 && dailyPlan.todayTasks.length > 0 && (
                                    <div className="border-t border-slate-100 dark:border-slate-700" />
                                )}

                                {/* Due today */}
                                {dailyPlan.todayTasks.length > 0 && (
                                    <div>
                                        <div className="flex items-center gap-1.5 mb-2 text-xs font-semibold text-slate-500 dark:text-slate-400">
                                            <Clock className="w-3.5 h-3.5" />
                                            {tr("Due Today ({{length}})", { length: dailyPlan.todayTasks.length })}
                                        </div>
                                        <div className="grid gap-2 grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]">
                                            {dailyPlan.todayTasks.slice(0, 6).map(t => (
                                                <button
                                                    key={`t-${t.id}`}
                                                    onClick={() => selectNode(t.id)}
                                                    className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-slate-100 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700/40 transition text-left"
                                                >
                                                    <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                                                    <span className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">{t.title}</span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
                                {tr("No tasks scheduled for today — a good chance to lock in what you've already learned.")}
                            </p>
                        )}

                        {/* Glanceable counts for the rest of the loop */}
                        <div className="flex flex-wrap gap-2 text-xs">
                            {dailyPlan.summary.decayingCount > 0 && (
                                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300">
                                    <RotateCcw className="w-3 h-3" />
                                    {tr("{{decayingCount}} to review", { decayingCount: dailyPlan.summary.decayingCount })}
                                </span>
                            )}
                            {dailyPlan.summary.dueFlashcardCount > 0 && (
                                <button
                                    onClick={() => setShowFlashcardReview(true)}
                                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-900/50 transition cursor-pointer"
                                >
                                    <BookOpen className="w-3 h-3" />
                                    {tr("{{dueFlashcardCount}} cards due", { count: dailyPlan.summary.dueFlashcardCount, dueFlashcardCount: dailyPlan.summary.dueFlashcardCount })}
                                </button>
                            )}
                            {dailyPlan.summary.untestedCount > 0 && (
                                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                                    <Layers className="w-3 h-3" />
                                    {tr("{{untestedCount}} not yet proven", { untestedCount: dailyPlan.summary.untestedCount })}
                                </span>
                            )}
                        </div>
                    </section>
                )}

                {/* No second AI surface here: the assistant already answers the
                    same question better (it knows the deadline, the days left,
                    the vault, and what is on screen) and costs nothing until
                    asked — so this is a door to it, not a briefing of its own.
                    The question is pre-filled, not sent: the learner still
                    decides. */}
                {/* THREE across when there is room, not two-and-an-orphan. At
                    `sm:grid-cols-2` the third card sat alone on its own row
                    with half the width empty beside it at every desktop size —
                    a ragged edge that reads as a layout fault.
                    `auto-fit`/`minmax` rather than a `lg:` breakpoint because
                    this dashboard is ALSO a panel beside the navigation tree,
                    perhaps 390px wide on a 1200px screen: a viewport
                    breakpoint would have put three 110px cards there, one word
                    per line. The column count follows the space the cards
                    actually have. */}
                <section className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(16rem,1fr))]">
                    <button
                        onClick={() => openAssistant(
                            `How am I doing in "${project.name}"? What should I focus on next, and what should I drop?`
                        )}
                        className="w-full flex items-center gap-3 p-4 rounded-2xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-sm hover:border-accent/50 hover:shadow-md transition text-left group"
                    >
                        <span className="p-2 rounded-xl bg-accent/10 flex-shrink-0">
                            <Sparkles className="w-5 h-5 text-accent-fg" aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold text-slate-900 dark:text-white">
                                {tr("Ask about this project")}
                            </span>
                            <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                                {tr("What to focus on, what to drop, how the deadline is looking")}
                            </span>
                        </span>
                        <ArrowRight className="w-4 h-4 text-slate-400 flex-shrink-0 group-hover:text-accent-fg transition" aria-hidden="true" />
                    </button>
                    {/* The exam-week button. Sits beside "ask about this
                        project" because both answer "I have a deadline and I
                        need to do something about it" — one by talking, one by
                        building the material to drill with. */}
                    <button
                        onClick={() => setShowBulk(true)}
                        className="w-full flex items-center gap-3 p-4 rounded-2xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-sm hover:border-accent/50 hover:shadow-md transition text-left group"
                    >
                        <span className="p-2 rounded-xl bg-accent/10 flex-shrink-0">
                            <Layers className="w-5 h-5 text-accent-fg" aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold text-slate-900 dark:text-white">
                                {tr("Generate study material")}
                            </span>
                            <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                                {tr("Mastery checks and flashcards for many topics at once")}
                            </span>
                        </span>
                        <ArrowRight className="w-4 h-4 text-slate-400 flex-shrink-0 group-hover:text-accent-fg transition" aria-hidden="true" />
                    </button>
                    {/* Pass two of the chat-model authoring route, reachable here
                        as well as the grid's ⋮ menu: the learner decides a topic
                        is thin while looking at the project, not while looking at
                        a list of them. */}
                    <button
                        onClick={() => setShowMaterial(true)}
                        className="w-full flex items-center gap-3 p-4 rounded-2xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-sm hover:border-accent/50 hover:shadow-md transition text-left group"
                    >
                        <span className="p-2 rounded-xl bg-accent/10 flex-shrink-0">
                            <FileText className="w-5 h-5 text-accent-fg" aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold text-slate-900 dark:text-white">
                                {tr("Add teaching material")}
                            </span>
                            <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                                {tr("One phase per reply, written by a chat model you already use")}
                            </span>
                        </span>
                        <ArrowRight className="w-4 h-4 text-slate-400 flex-shrink-0 group-hover:text-accent-fg transition" aria-hidden="true" />
                    </button>
                </section>

                {/* Milestone progress */}
                {milestones && milestones.length > 0 && (
                    <section className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-4 sm:p-6 shadow-sm overflow-hidden">
                        <div className="flex items-center gap-2 mb-4">
                            <Milestone className="w-5 h-5 text-emerald-500" />
                            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">{tr("Phase progress")}</h3>
                        </div>
                        {/* Why nothing here is drawn in `project.color`, and why the
                            unfinished state is not drawn in the accent either.

                            A phase's bar is mostly UNFINISHED for most of the life of a
                            project, so the colour that has to be readable first is the
                            empty one — and both of the old ones were invisible. The
                            unstarted ticks were `${project.color}30` on the active row
                            and `slate-700` everywhere else: measured on a real project
                            (colour #1F4E79 on `slate-800`) that is **1.09:1** and
                            **1.41:1**, i.e. the current phase — the one row a learner
                            is looking for — had the *least* visible bar on the card.
                            Raw `project.color` is the cause and it is a rule this file
                            was breaking: a user-picked colour has no contrast guarantee,
                            which is exactly what `accentSolidTriplet` exists to fix, and
                            `Layout` has already published the clamped result as
                            `--accent-rgb` for the whole workspace. So the active row is
                            marked with `accent`/`accent-fg` classes, and the empty state
                            is a NEUTRAL tint that never varies with the project.

                            The active title was `text-white dark:text-white` — white on a
                            near-white tint in light mode, i.e. the same bug the other way
                            up. It follows the theme now. */}
                        <div className="space-y-3">
                            {(() => {
                                const activeIndex = milestones.findIndex(m => m.percentage < 100);
                                return milestones.map((milestone, idx) => {
                                    const isActive = idx === activeIndex;
                                    return (
                                        <div
                                            key={milestone.id}
                                            className={`relative rounded-xl px-3 py-2.5 transition-all ${isActive
                                                ? 'bg-accent/10 dark:bg-accent/20 ring-1 ring-accent/50'
                                                : ''}`}
                                        >
                                            {isActive && (
                                                <span className="absolute left-0 top-2 bottom-2 w-1 rounded-r-full bg-accent-fg" aria-hidden="true" />
                                            )}
                                            <div className="flex items-center justify-between mb-1.5">
                                                <div className="flex items-center gap-2 min-w-0">
                                                    <span className={`text-sm truncate ${isActive
                                                        ? 'font-semibold text-slate-900 dark:text-white'
                                                        : 'font-medium text-slate-700 dark:text-slate-200'
                                                        }`}>
                                                        {milestone.title}
                                                    </span>
                                                </div>
                                                <span className={`text-xs font-medium tabular-nums shrink-0 ml-2 ${isActive
                                                    ? 'text-slate-700 dark:text-slate-200'
                                                    : 'text-slate-500 dark:text-slate-400'
                                                    }`}>
                                                    {milestone.completed}/{milestone.total} ({milestone.percentage}%)
                                                </span>
                                            </div>
                                            {milestone.segments && milestone.segments.length > 0 ? (
                                                /* One tick per leaf, and a real phase can hold ~100 of
                                                   them. Two things used to force this bar wider than a
                                                   phone: `border-2` (4px of border-box width per tick,
                                                   which flex-basis:0 cannot shrink away) and a fixed
                                                   2px gap. So ~90 ticks demanded ~540px, the bar
                                                   overflowed, and the whole PAGE scrolled sideways.
                                                   Now the outline is drawn with an inset box-shadow —
                                                   zero layout cost — the gap tightens as the count
                                                   grows, `min-w-0` lets a tick shrink to nothing, and
                                                   `overflow-hidden` guarantees that even an absurd
                                                   phase can never push the page wide again. */
                                                <div
                                                    className={`w-full h-3 flex overflow-hidden ${milestone.segments.length > 60 ? 'gap-0'
                                                        : milestone.segments.length > 24 ? 'gap-px' : 'gap-0.5'}`}
                                                >
                                                    {milestone.segments.map((segment, i) => (
                                                        <div
                                                            key={i}
                                                            onClick={() => selectNode(segment.id)}
                                                            onKeyDown={onActivateKey(() => selectNode(segment.id))}
                                                            role="button"
                                                            tabIndex={0}
                                                            aria-label={segment.title}
                                                            title={segment.title}
                                                            /* A tick is a TOPIC, not a slice of a track, and it is
                                                               a focusable control besides — so an unfinished one is
                                                               held near WCAG 1.4.11's 3:1 for a non-text control
                                                               (`slate-400` 2.6:1 on white, `slate-500` 3.1:1 on
                                                               slate-800) instead of the ~1.4:1 track tint the rest
                                                               of the app uses for a plain bar. It stays a neutral
                                                               grey so it still reads as the absence of progress
                                                               beside the emerald of a proven one. */
                                                            className={`h-full flex-1 min-w-0 rounded-sm cursor-pointer ${segment.completed
                                                                ? (segment.skipped
                                                                    /* Skipped is CLOSED, so it must out-ink an
                                                                       unfinished tick while staying out of the
                                                                       emerald that means proven. */
                                                                    ? 'bg-slate-600 dark:bg-slate-300'
                                                                    : 'bg-emerald-500 dark:bg-emerald-500')
                                                                : 'bg-slate-400 dark:bg-slate-500'
                                                                } ${segment.id === selectedNodeId
                                                                    ? 'ring-2 ring-inset ring-slate-700 dark:ring-white'
                                                                    : 'hover:ring-2 hover:ring-inset hover:ring-slate-700 dark:hover:ring-white'
                                                                }`}
                                                        />
                                                    ))}
                                                </div>
                                            ) : (
                                                <div
                                                    onClick={() => selectNode(milestone.id)}
                                                    onKeyDown={onActivateKey(() => selectNode(milestone.id))}
                                                    role="button"
                                                    tabIndex={0}
                                                    aria-label={milestone.title}
                                                    title={milestone.title}
                                                    className="w-full h-3 rounded-full overflow-hidden cursor-pointer hover:opacity-80 bg-slate-300 dark:bg-slate-600">
                                                    {/* An empty track and a 0% fill
                                                        must not be the same invisible
                                                        colour, or a phase with no leaves
                                                        draws nothing at all: the track
                                                        carries the shape and only real
                                                        progress is inked. */}
                                                    <div
                                                        className={`h-full rounded-full transition-all duration-500 ${milestone.percentage === 100 ? 'bg-emerald-500'
                                                            : isActive ? 'bg-accent-fg' : 'bg-sky-500'
                                                            }`}
                                                        style={{ width: `${milestone.percentage}%` }}
                                                    />
                                                </div>
                                            )}
                                        </div>
                                    );
                                });
                            })()}
                        </div>
                    </section>
                )}

                {/* Keep it fresh — proven topics whose mastery has faded below the
                    threshold (the "Remember" loop). When nothing has faded but the
                    learner has proven something, celebrate; otherwise show nothing. */}
                {reviewTopics.length > 0 ? (
                    <section className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
                        <div className="flex items-center gap-2 mb-1">
                            <RotateCcw className="w-5 h-5 text-sky-500" />
                            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">{tr("Keep It Fresh")}</h3>
                        </div>
                        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
                            {tr("You proved these once, but memory fades. A quick review keeps them solid.")}
                        </p>
                        <div className="space-y-2">
                            {reviewTopics.map(t => {
                                const proven = Math.round((t.masteryScore ?? 0) * 100);
                                const now = Math.round((t.decayedScore ?? t.masteryScore ?? 0) * 100);
                                const faded = t.decayedScore != null && now < proven;
                                return (
                                    <button
                                        key={t.id}
                                        onClick={() => selectNode(t.id)}
                                        className="w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl border border-slate-100 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700/40 transition text-left"
                                    >
                                        <span className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">{t.title}</span>
                                        <span className="flex items-center gap-2 shrink-0">
                                            <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                                                {faded ? (
                                                    <>
                                                        <span className="text-amber-600 dark:text-amber-400 font-medium">~{now}%</span>
                                                        <span className="text-slate-500 dark:text-slate-400"> {tr("· was {{proven}}%", { proven })}</span>
                                                    </>
                                                ) : (
                                                    <>{tr("{{now}}% mastery", { now })}</>
                                                )}
                                            </span>
                                            <Play className="w-4 h-4 text-sky-500" />
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    </section>
                ) : provenTopics && (
                    <section className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
                        <div className="flex items-center gap-2 mb-1">
                            <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">{tr("Keep It Fresh")}</h3>
                        </div>
                        <p className="text-sm text-slate-500 dark:text-slate-400">
                            {tr("Everything you’ve proven is still fresh — nothing needs review right now.")}
                        </p>
                    </section>
                )}

                {/* A project with cards gets the same panel the card-only page
                    shows — work owed and new cards allowed counted separately,
                    the four states, the forecast — instead of the one-number
                    tile below it, which said "615 due" about a project whose 615
                    cards had never been seen and opened all of them at once. */}
                {hasCards && currentProjectId != null && (
                    <div className="space-y-4 sm:space-y-6">
                        <CardsPanel projectId={currentProjectId} />
                    </div>
                )}

                {/* Flashcards and Quizzes quick-access */}
                <section className={`grid grid-cols-1 gap-4 ${hasCards ? '' : 'md:grid-cols-2'}`}>
                    {!hasCards && (
                    <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5 shadow-sm">
                        <div className="flex items-center gap-2 mb-3">
                            <BookOpen className="w-5 h-5 text-blue-500" />
                            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">{tr("Flashcards")}</h3>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <div>
                                {/* Two numbers, because they are two kinds of
                                    work: reviews you owe, and how many unseen
                                    cards today's allowance still permits. One
                                    merged number is what told the owner of a
                                    1,501-card import they were 1,483 behind on
                                    day one. */}
                                <p className="text-2xl font-bold text-slate-900 dark:text-white">{flashcardSummary.dueCount}</p>
                                <p className="text-xs text-slate-500 dark:text-slate-400">{tr("cards due for review")}</p>
                                <div className="flex items-center gap-3 mt-2 text-xs text-slate-500 dark:text-slate-400">
                                    {flashcardSummary.newAvailable > 0 && (
                                        <span>
                                            <span className="font-semibold text-sky-600 dark:text-sky-400">
                                                {flashcardSummary.newAvailable}
                                            </span> {tr("new today")}
                                        </span>
                                    )}
                                    <span><span className="font-semibold text-slate-700 dark:text-slate-200">{flashcardSummary.totalCards}</span> {tr("total")}</span>
                                    <span className="flex items-center gap-1">
                                        <span className={`font-semibold ${flashcardSummary.retention == null ? 'text-slate-400'
                                            : flashcardSummary.retention >= 80 ? 'text-emerald-500'
                                                : flashcardSummary.retention >= 60 ? 'text-amber-500' : 'text-red-500'}`}>
                                            {flashcardSummary.retention == null ? '—' : `${flashcardSummary.retention}%`}
                                        </span>
                                        {tr("retention")}
                                    </span>
                                </div>
                            </div>
                            <button
                                onClick={() => setShowFlashcardReview(true)}
                                // Openable while there is EITHER work owed or a
                                // new card allowed today — the session serves
                                // both (server/decks.js `studyQueue`), and
                                // gating on `dueCount` alone locked a project
                                // whose cards had all just been written out of
                                // its own cards.
                                disabled={flashcardSummary.dueCount === 0 && flashcardSummary.newAvailable === 0}
                                className="shrink-0 flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition font-medium text-sm"
                            >
                                {tr("Review")}
                            </button>
                        </div>
                    </div>
                    )}

                    <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5 shadow-sm">
                        <div className="flex items-center gap-2 mb-3">
                            <Brain className="w-5 h-5 text-emerald-500" />
                            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">{tr("Quizzes")}</h3>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <div>
                                <p className="text-2xl font-bold text-slate-900 dark:text-white">
                                    {quizSummary.averageScore !== null ? `${quizSummary.averageScore}%` : '—'}
                                </p>
                                <p className="text-xs text-slate-500 dark:text-slate-400">{tr("average score")}</p>
                                <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                                    <span className="font-semibold text-slate-700 dark:text-slate-200">{quizSummary.totalQuizzes}</span> {tr("quizzes", { count: quizSummary.totalQuizzes })}
                                </p>
                            </div>
                            <button
                                onClick={() => {
                                    if (quizSummary.totalQuizzes === 0) {
                                        addToast('info', tr("No quizzes yet"), tr("Generate a quiz from a topic to get started!"));
                                    } else {
                                        setShowAllQuizzes(true);
                                    }
                                }}
                                className="flex items-center gap-2 px-4 py-2 bg-emerald-700 text-white rounded-xl hover:bg-emerald-600 transition font-medium text-sm"
                            >
                                {quizSummary.totalQuizzes > 0 ? tr("View All Quizzes") : tr("No Quizzes Yet")}
                            </button>
                        </div>
                    </div>
                </section>

            </div>

            {showBulk && currentProjectId && (
                <BulkGenerateModal
                    projectId={currentProjectId}
                    onClose={() => {
                        setShowBulk(false);
                        // Whatever landed is real material — refresh the counts
                        // the dashboard shows rather than leaving stale numbers.
                        void useStore.getState().loadDashboard(currentProjectId);
                    }}
                />
            )}

            {/* Pass two of the chat-model authoring route, reachable from the
                project it belongs to rather than only from the grid's ⋮ menu. */}
            {currentProjectId && (
                <Modal
                    isOpen={showMaterial}
                    onClose={() => {
                        setShowMaterial(false);
                        void useStore.getState().loadDashboard(currentProjectId);
                    }}
                    title={tr("Add material — {{name}}", { name: project.name })}
                    maxWidth="max-w-xl"
                >
                    <MaterialPassPanel projectId={currentProjectId} />
                </Modal>
            )}
        </div>
        </>
    );
}

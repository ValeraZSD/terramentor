import { useState, useEffect } from 'react';
import { onActivateKey } from '../utils/a11y';
import { useStore } from '../store';
import type { ProjectQuiz } from '../types';
import GlobalFlashcardReview from './GlobalFlashcardReview';
import CardsPanel from './deck/CardsPanel';
import ProjectQuizzesList from './ProjectQuizzesList';
import QuizView from './QuizView';
import {
    BookOpen, Brain, CheckCircle2, Zap, RefreshCw, Loader2,
    Sparkles, Milestone, BarChart3, Play, RotateCcw,
    ListChecks, AlertTriangle, Clock, Layers, FileText, LayoutGrid, Wrench
} from 'lucide-react';
import { Button } from './ui/Button';
import { ProjectIcon } from './ProjectIcon';
import BulkGenerateModal from './BulkGenerateModal';
import Modal from './Modal';
import { MaterialPassPanel } from './ExternalAuthoring';
import PlacementCard, { PlacementTool, usePlacementStatus } from './PlacementCard';
import { DashboardSection, ToolRow } from './dashboard/DashboardSection';
import { ProjectStudyTimeSection } from './studyTime/StudyTime';
import { todayStr } from '../utils/tree';
import { pretty } from '../utils/scheduleAxis';
import { useTranslation } from 'react-i18next';

export default function StudyDashboard() {
    const { t: tr } = useTranslation();
    const currentProjectId = useStore(s => s.currentProjectId);
    const projects = useStore(s => s.projects);
    const selectNode = useStore(s => s.selectNode);
    const studyProject = useStore(s => s.studyProject);
    const setWorkspaceView = useStore(s => s.setWorkspaceView);
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
    const placement = usePlacementStatus(currentProjectId);

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
                                // The workspace's accent is this project's colour
                                // made safe for white, so the drawing reads on it.
                                className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 text-xl leading-none bg-accent text-white"
                                role="img"
                                aria-label={tr("{{name}} icon", { name: project.name })}
                            >
                                <ProjectIcon icon={project.icon} className="h-5 w-5" />
                            </div>
                            {/* The project's NAME, not a greeting. This header
                                spent its largest type on "Welcome Back!" — a
                                sentence that is the same on every project, on
                                every visit, and that leaves the one screen
                                devoted to a course unable to say which course
                                it is. */}
                            <span className="min-w-0 truncate">{project.name}</span>
                        </h2>
                        {/* The icon (w-10) plus the gap (gap-3), in rem like them —
                            a px indent drifted off the title under `ui_scale`.
                            Progress only: the pace ("On track", "3 days behind")
                            is the panel in the project's own header, and saying
                            it twice a few centimetres apart was one more line to
                            read on a page that already had too many. */}
                        <p className="text-slate-500 dark:text-slate-400 mt-1 ml-[3.25rem]">
                            {tr("{{progressPercent}}% complete", { progressPercent: stats.progressPercent })}
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
                    the ordinary case, and "Not now" moves it down among the
                    tools at the foot of the page. */}
                {currentProjectId && (
                    <PlacementCard
                        projectId={currentProjectId}
                        projectName={project.name}
                        status={placement.status}
                        onDismiss={() => void placement.setDismissed(true)}
                    />
                )}

                {/* Hero task — most urgent learning item */}
                <DashboardSection icon={Zap} title={tr("Next up")}>
                    {heroTask ? (
                        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                            <div className="flex-1">
                                <p className="text-lg font-medium text-slate-900 dark:text-white mb-1">
                                    {heroTask.title}
                                </p>
                                <p className="text-sm text-slate-500 dark:text-slate-400">
                                    {/* The server falls back to the first unfinished topic when
                                        nothing is overdue or due today, so a hero is not always
                                        scheduled: say which of the three it is. */}
                                    {heroTask.scheduled_end && heroTask.scheduled_end < todayStr()
                                        ? tr("Overdue — it was due {{when}}.", { when: pretty(heroTask.scheduled_end) })
                                        : dashboard.todaySchedule.some(t => t.id === heroTask.id)
                                            ? tr("Scheduled for today.")
                                            : heroTask.scheduled_end
                                                ? tr("Nothing is due today. This is the next topic you have not finished.")
                                                : tr("Nothing is scheduled yet. This is the first topic you have not finished.")}
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
                    ) : stats.totalNodes === 0 ? (
                        // No hero because there is nothing to study yet, not because it is all
                        // done. Categories are added in the Tree, so that is where this goes.
                        <div className="text-center py-4">
                            <LayoutGrid className="w-12 h-12 text-slate-300 dark:text-slate-600 mx-auto mb-2" aria-hidden="true" />
                            <p className="text-slate-600 dark:text-slate-300 font-medium">{tr("No topics yet.")}</p>
                            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">{tr("Add your first category in the Tree to start this course.")}</p>
                            <Button variant="primary" onClick={() => setWorkspaceView('tree')} icon={<LayoutGrid className="w-4 h-4" aria-hidden="true" />}>
                                {tr("Open the Tree")}
                            </Button>
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
                </DashboardSection>

                {/* Today's Plan — the consolidated agenda (server/dailyPlan.js) */}
                {dailyPlan && (dailyPlan.overdueTasks.length > 0 || dailyPlan.todayTasks.length > 0 ||
                    dailyPlan.summary.decayingCount > 0 || dailyPlan.summary.dueFlashcardCount > 0) && (
                    <DashboardSection icon={ListChecks} title={tr("Today's Plan")}>
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
                                    {/* Names its noun: "10 to review" beside "43 cards due"
                                        read as ten more CARDS, and it counts topics. */}
                                    {tr("{{count}} topics to refresh", { count: dailyPlan.summary.decayingCount })}
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
                    </DashboardSection>
                )}

                {/* Milestone progress */}
                {milestones && milestones.length > 0 && (
                    <DashboardSection icon={Milestone} title={tr("Phase progress")}>
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
                                            {/* The count wraps under the title before the
                                                title is cut below 10rem: on a phone the
                                                named count left "Domain B — Waves, …". */}
                                            <div className="flex flex-wrap items-center justify-between gap-x-2 mb-1.5">
                                                <div className="flex items-center gap-2 min-w-[10rem] flex-1">
                                                    <span className={`text-sm truncate ${isActive
                                                        ? 'font-semibold text-slate-900 dark:text-white'
                                                        : 'font-medium text-slate-700 dark:text-slate-200'
                                                        }`}>
                                                        {milestone.title}
                                                    </span>
                                                </div>
                                                <span className={`text-xs font-medium tabular-nums shrink-0 ${isActive
                                                    ? 'text-slate-700 dark:text-slate-200'
                                                    : 'text-slate-500 dark:text-slate-400'
                                                    }`}>
                                                    {/* Two different measures, so each is named:
                                                        the count is topics FINISHED, the percentage
                                                        is progress, which also credits cards met.
                                                        "9/17 (69%)" read as one sum gone wrong. */}
                                                    {tr("{{completed}} of {{total}} finished · {{percentage}}%", {
                                                        completed: milestone.completed,
                                                        total: milestone.total,
                                                        percentage: milestone.percentage,
                                                    })}
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
                                                               a focusable control besides. An unfinished one is the
                                                               PAGE's own colour with a hairline edge, in both modes:
                                                               it reads as a slot cut into the card, and the emerald
                                                               as what fills it. A mid-grey fill took the page's
                                                               tint, and on a green tint it read as already filled. */
                                                            className={`h-full flex-1 min-w-0 rounded-sm cursor-pointer ${segment.completed
                                                                ? (segment.skipped
                                                                    /* Skipped is CLOSED, so it must out-ink an
                                                                       unfinished tick while staying out of the
                                                                       emerald that means proven. */
                                                                    ? 'bg-slate-600 dark:bg-slate-300'
                                                                    : 'bg-emerald-500 dark:bg-emerald-500')
                                                                : 'bg-slate-100 dark:bg-slate-900'
                                                                } ${segment.id === selectedNodeId
                                                                    ? 'ring-2 ring-inset ring-slate-700 dark:ring-white'
                                                                    : `hover:ring-2 hover:ring-inset hover:ring-slate-700 dark:hover:ring-white${segment.completed ? '' : ' ring-1 ring-inset ring-slate-200 dark:ring-black/30'}`
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
                    </DashboardSection>
                )}

                {/* "Keep It Fresh" (proven topics whose estimate had faded) was
                    removed on 2026-10-01: a list the learner had to come here
                    to read is the app's job done by hand. The feed brings a
                    fading topic back by itself, as a recall question. */}

                {/* Time spent on this course, by the study clock: the total,
                    the last fortnight, where it went. Absent until there is
                    some. Refetched with the rest of the page. */}
                {currentProjectId != null && <ProjectStudyTimeSection projectId={currentProjectId} reloadKey={dashboard} />}

                {/* A project with cards gets the same panel the card-only page
                    shows — work owed and new cards allowed counted separately,
                    the four states, the forecast. A project WITHOUT cards gets
                    nothing here: the tile it used to get could only ever say
                    0 due, 0 total. */}
                {hasCards && currentProjectId != null && (
                    <div className="space-y-4 sm:space-y-6">
                        <CardsPanel projectId={currentProjectId} />
                    </div>
                )}

                {/* The saved quizzes, once there are any — before that the
                    section was a dash, "0 quizzes" and a button whose only
                    effect was a toast saying there were none. */}
                {quizSummary.totalQuizzes > 0 && (
                    <DashboardSection icon={Brain} title={tr("Quizzes")}>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                                <p className="text-2xl font-bold text-slate-900 dark:text-white tabular-nums">
                                    {quizSummary.averageScore !== null ? `${quizSummary.averageScore}%` : '—'}
                                </p>
                                <p className="text-xs text-slate-500 dark:text-slate-400">
                                    {tr("average score")} · {quizSummary.totalQuizzes} {tr("quizzes", { count: quizSummary.totalQuizzes })}
                                </p>
                            </div>
                            <Button variant="neutral" onClick={() => setShowAllQuizzes(true)}>
                                {tr("View All Quizzes")}
                            </Button>
                        </div>
                    </DashboardSection>
                )}

                {/* The tools, at the FOOT of the page: things reached for now
                    and then, so they sit below the course rather than between
                    the learner and it. One row each (see `ToolRow`). */}
                <DashboardSection icon={Wrench} title={tr("Tools")}>
                    <div className="-mx-2 -mb-2 divide-y divide-slate-100 dark:divide-slate-700/60">
                        {/* No second AI surface here: the assistant already
                            answers the question better (it knows the deadline,
                            the vault, what is on screen) and costs nothing until
                            asked. The question is pre-filled, not sent. */}
                        <ToolRow
                            icon={Sparkles}
                            title={tr("Ask about this project")}
                            hint={tr("What to focus on, what to drop, how the deadline is looking")}
                            onClick={() => openAssistant(
                                `How am I doing in "${project.name}"? What should I focus on next, and what should I drop?`
                            )}
                        />
                        <ToolRow
                            icon={Layers}
                            title={tr("Generate study material")}
                            hint={tr("Mastery checks and flashcards for many topics at once")}
                            onClick={() => setShowBulk(true)}
                        />
                        <ToolRow
                            icon={FileText}
                            title={tr("Add teaching material")}
                            hint={tr("One phase per reply, written by a chat model you already use")}
                            onClick={() => setShowMaterial(true)}
                        />
                        {currentProjectId != null && (
                            <PlacementTool projectId={currentProjectId} projectName={project.name} status={placement.status} />
                        )}
                    </div>
                </DashboardSection>

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

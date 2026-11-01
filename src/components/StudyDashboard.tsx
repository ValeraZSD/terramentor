import { useState, useEffect, useRef, type ReactNode } from 'react';
import { useStore } from '../store';
import type { ProjectQuiz } from '../types';
import CardsPanel from './deck/CardsPanel';
import ProjectQuizzesList from './ProjectQuizzesList';
import QuizView from './QuizView';
import {
    Brain, CheckCircle2, Zap, RefreshCw, Loader2,
    Sparkles, BarChart3, Play, RotateCcw,
    Layers, FileText, LayoutGrid, Wrench, ShieldCheck, Compass
} from 'lucide-react';
import { useOpenMasteryCheck } from '../hooks/useOpenMasteryCheck';
import { useElementWidth } from '../hooks/useElementWidth';
import { useRootFontSize } from '../hooks/useRootFontSize';
import { Button, IconButton } from './ui/Button';
import { ProjectIcon } from './ProjectIcon';
import BulkGenerateModal from './BulkGenerateModal';
import Modal from './Modal';
import { MaterialPassPanel } from './ExternalAuthoring';
import PlacementCard, { PlacementTool, usePlacementStatus } from './PlacementCard';
import { DashboardSection, ToolGrid, ToolRow } from './dashboard/DashboardSection';
import { TodaysPlan } from './dashboard/TodaysPlan';
import { PhaseProgress } from './dashboard/PhaseProgress';
import { ProjectStudyTimeSection } from './studyTime/StudyTime';
import { todayStr } from '../utils/tree';
import { pretty } from '../utils/scheduleAxis';
import { useTranslation } from 'react-i18next';
import { headStartConsequence } from './feed/HeadStartBanner';

export default function StudyDashboard() {
    const { t: tr } = useTranslation();
    const currentProjectId = useStore(s => s.currentProjectId);
    const projects = useStore(s => s.projects);
    const studyProject = useStore(s => s.studyProject);
    const setWorkspaceView = useStore(s => s.setWorkspaceView);
    const addToast = useStore(s => s.addToast);
    const recalibrateSchedule = useStore(s => s.recalibrateSchedule);
    const dashboard = useStore(s => s.dashboardData);
    const dashboardLoading = useStore(s => s.dashboardLoading);
    const dailyPlan = useStore(s => s.dailyPlan);
    const openAssistant = useStore(s => s.openAssistant);
    const openMasteryCheck = useOpenMasteryCheck();

    const [recalibrating, setRecalibrating] = useState(false);
    const [showAllQuizzes, setShowAllQuizzes] = useState(false);
    const [selectedQuiz, setSelectedQuiz] = useState<ProjectQuiz | null>(null);
    const [quizListKey, setQuizListKey] = useState(0);
    const [showBulk, setShowBulk] = useState(false);
    const [showMaterial, setShowMaterial] = useState(false);

    const project = projects.find(p => p.id === currentProjectId);
    const placement = usePlacementStatus(currentProjectId);

    // The course whose hub this mount has had an answer for. The first render comes
    // before the effect asks, so until the answer is in, an empty store means "coming",
    // not "No Data Available" (it flashed for a frame on every open).
    const [answeredFor, setAnsweredFor] = useState<number | null>(null);
    useEffect(() => {
        if (!currentProjectId) return;
        let live = true;
        void useStore.getState().loadDashboard(currentProjectId).then(() => { if (live) setAnsweredFor(currentProjectId); });
        return () => { live = false; };
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
    if (!dashboard && (dashboardLoading || (currentProjectId != null && answeredFor !== currentProjectId))) {
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

    const { heroTask, milestones, quizSummary, pace, stats } = dashboard;
    const hasCards = (project.card_count ?? 0) > 0 || dashboard.flashcardSummary.totalCards > 0;
    // What the cards panel recounts on: this page's own count of the cards,
    // which moves when they do (a session, a bulk generation), not every
    // refresh of the page.
    const cardSummary = dashboard.flashcardSummary;
    const cardsKey = [cardSummary.totalCards, cardSummary.dueCount, cardSummary.newAvailable, cardSummary.introducedToday].join(':');
    const isBehind = pace && (pace.paceStatus === 'falling_behind' || pace.paceStatus === 'critical');
    const heroReady = !!heroTask && 'readyToProve' in heroTask && !!heroTask.readyToProve;
    // A head start does not move "Next up" (a seed is no proof), it changes what
    // the topic IS: a short review whose check comes first, as the feed's banner
    // says (HeadStartBanner). Same two buttons as a topic ready to prove. Once
    // answered here (`spent`) it is no longer an offer, as in the banner.
    const heroHeadStart = heroTask?.headStart && !heroTask.headStart.spent ? heroTask.headStart : null;
    const offerCheck = heroReady || !!heroHeadStart;
    // A topic finished or a quiz taken: the course is being studied, and
    // "N quick questions … before any of it is taught" is no longer the page's
    // first question. The offer moves to Tools (`PlacementTool`).
    const underWay = stats.completedNodes > 0 || quizSummary.totalQuizzes > 0;

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

    // Hero task — the most urgent learning item, and the page's ONE primary.
    const nextUp = (
        <DashboardSection icon={Zap} title={tr("Next up")}>
            {heroTask ? (
                // The text takes the row and the buttons keep their own width
                // beside it; when they no longer fit they drop under it and
                // fill the card, one per line on a phone. Measured by the
                // CARD (flex-basis), not a viewport breakpoint.
                <div className="flex flex-wrap items-center gap-4">
                    <div className="min-w-0 flex-[999_1_16rem]">
                        <p className="text-lg font-medium text-slate-900 dark:text-white mb-1">
                            {heroTask.title}
                        </p>
                        <p className="text-sm text-slate-500 dark:text-slate-400">
                            {/* The server falls back to the first unfinished topic when
                                nothing is overdue or due today, so a hero is not always
                                scheduled: say which of the three it is. */}
                            {heroReady && heroTask.scheduled_end
                                ? tr("Ready to prove — it was due {{when}}.", { when: pretty(heroTask.scheduled_end) })
                                : heroTask.scheduled_end && heroTask.scheduled_end < todayStr()
                                ? tr("Overdue — it was due {{when}}.", { when: pretty(heroTask.scheduled_end) })
                                : dashboard.todaySchedule.some(t => t.id === heroTask.id)
                                    ? tr("Scheduled for today.")
                                    : heroTask.scheduled_end
                                        ? tr("Nothing is due today. This is the next topic you have not finished.")
                                        : tr("Nothing is scheduled yet. This is the first topic you have not finished.")}
                        </p>
                        {heroHeadStart && !heroReady && (
                            <p data-line="head-start" className="flex items-start gap-1.5 mt-2 text-sm text-slate-600 dark:text-slate-300">
                                {heroHeadStart.source === 'transfer'
                                    ? <Sparkles className="w-4 h-4 shrink-0 mt-0.5 text-accent-fg" aria-hidden="true" />
                                    : <Compass className="w-4 h-4 shrink-0 mt-0.5 text-accent-fg" aria-hidden="true" />}
                                <span className="min-w-0">
                                    <span className="font-medium text-accent-fg">
                                        {heroHeadStart.source === 'transfer' ? tr("You've covered this before") : tr("Placement head start")}
                                    </span>
                                    {' · '}
                                    {headStartConsequence(tr, { review: heroHeadStart.review, transfer: heroHeadStart.source === 'transfer' })}
                                </span>
                            </p>
                        )}
                    </div>
                    {/* Start Studying enters the course's own STREAM, which
                        begins with this very topic (both read the same urgency
                        order, `getFocusNodes` in server/feed.js), serves the
                        cards that are due between lessons, and does not stop
                        when the topic does. Not `selectNode`: that opens the
                        detail panel, an editor, and the biggest button on the
                        screen may not be named for learning and open a form. */}
                    <div className="flex flex-[1_1_auto] flex-wrap justify-end gap-2">
                        <Button
                            variant={offerCheck ? 'neutral' : 'primary'}
                            className="grow"
                            onClick={() => currentProjectId != null && studyProject(currentProjectId)}
                            title={tr("Teach me this course, starting here")}
                            icon={<Play className="w-4 h-4" aria-hidden="true" />}
                        >
                            {tr("Start Studying")}
                        </Button>
                        {/* Past its dates and already known well enough to
                            pass: the check is what closes it, so it is the
                            primary here, the sentence above asks for it and
                            the stream stays one press away beside it
                            (server/readyToProve.js). A head start offers it
                            too: its check comes first. Primary last, as in
                            every group. */}
                        {offerCheck && (
                            <Button
                                variant="primary"
                                className="grow"
                                onClick={() => void openMasteryCheck(heroTask.id, heroTask.title, currentProjectId)}
                                icon={<ShieldCheck className="w-4 h-4" aria-hidden="true" />}
                            >
                                {tr("Take the mastery check")}
                            </Button>
                        )}
                    </div>
                </div>
            ) : stats.totalNodes === 0 ? (
                // No hero because there is nothing to study yet, not because it is all
                // done. Categories are added in the Outline, so that is where this goes.
                <div className="text-center py-4">
                    <LayoutGrid className="w-12 h-12 text-slate-300 dark:text-slate-600 mx-auto mb-2" aria-hidden="true" />
                    <p className="text-slate-600 dark:text-slate-300 font-medium">{tr("No topics yet.")}</p>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">{tr("Add your first category in the Outline to start this course.")}</p>
                    <Button variant="primary" onClick={() => setWorkspaceView('tree')} icon={<LayoutGrid className="w-4 h-4" aria-hidden="true" />}>
                        {tr("Open the Outline")}
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
                // Same rule as the row above: beside the sentence while it
                // fits, under it and full width when it does not. Side by side
                // on a phone the sentence ran to five lines next to the button.
                <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-700 flex flex-wrap items-center gap-x-4 gap-y-3">
                    <p className="min-w-0 flex-[999_1_16rem] text-sm text-slate-500 dark:text-slate-400">
                        {tr("You are behind the plan. Recalibrating spreads what is left over the days that remain.")}
                    </p>
                    <div className="flex flex-[1_1_auto] justify-end">
                        <Button
                            onClick={handleRecalibrate}
                            busy={recalibrating}
                            icon={<RotateCcw className="w-4 h-4" aria-hidden="true" />}
                            className="grow"
                        >
                            {tr("Recalibrate Schedule")}
                        </Button>
                    </div>
                </div>
            )}
        </DashboardSection>
    );

    // The tools: things reached for now and then, so they sit below the course
    // rather than between the learner and it. One tile each (see `ToolGrid`).
    const tools = (
        <DashboardSection icon={Wrench} title={tr("Tools")}>
            <ToolGrid>
                {/* The saved quizzes, once there are any, as a row here rather
                    than a box of their own: one number and one button stretched
                    to the height of the boxes beside it was a big, nearly empty
                    card. Before the first quiz there is nothing to open. */}
                {quizSummary.totalQuizzes > 0 && (
                    <ToolRow
                        icon={Brain}
                        title={tr("Quizzes")}
                        hint={`${quizSummary.averageScore !== null ? `${quizSummary.averageScore}% ` : ''}${tr("average of {{count}} quizzes", { count: quizSummary.totalQuizzes })}`}
                        onClick={() => setShowAllQuizzes(true)}
                    />
                )}
                {/* No second AI surface here: the assistant already answers the
                    question better (it knows the deadline, the vault, what is on
                    screen) and costs nothing until asked. The question is
                    pre-filled, not sent. */}
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
                    <PlacementTool projectId={currentProjectId} projectName={project.name} status={placement.status} underWay={underWay} />
                )}
            </ToolGrid>
        </DashboardSection>
    );

    return (
        <div className="flex-1 overflow-auto bg-slate-100 dark:bg-slate-900">
            <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-6">

                <div className="flex items-start justify-between gap-2">
                    {/* `min-w-0` all the way down, or the name below cannot
                        wrap: a flex item's default `min-width: auto` refuses to
                        shrink past its content, and a long course name then
                        pushed the whole page into a horizontal scroll. */}
                    <div className="min-w-0">
                        <h2 className="text-2xl font-bold text-slate-900 dark:text-white flex items-start gap-3 min-w-0">
                            <div
                                // The workspace's accent is this project's colour
                                // made safe for white, so the drawing reads on it.
                                className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 text-xl leading-none bg-accent text-white"
                                role="img"
                                aria-label={tr("{{name}} icon", { name: project.name })}
                            >
                                <ProjectIcon icon={project.icon} className="h-5 w-5" />
                            </div>
                            {/* The project's NAME, not a greeting: the one screen
                                devoted to a course has to say which course it is.
                                It WRAPS, never truncates: the cut-off part of a
                                long name ("… / CCVX Deficiency Exam") is often
                                the part that tells two courses apart. `py-1`
                                makes one line as tall as the icon, so a
                                one-line name still sits centred beside it. */}
                            <span className="min-w-0 py-1 break-words">{project.name}</span>
                        </h2>
                        {/* The icon (w-10) plus the gap (gap-3), in rem like them —
                            a px indent drifted off the title under `ui_scale`.
                            Progress only: the pace ("On track", "3 days behind")
                            is the panel in the project's own header. */}
                        <p className="text-slate-500 dark:text-slate-400 mt-1 ml-[3.25rem]">
                            {tr("{{progressPercent}}% complete", { progressPercent: stats.progressPercent })}
                        </p>
                    </div>
                    <IconButton onClick={handleRefresh} label={tr("Refresh")} icon={<RefreshCw className="w-5 h-5" />} />
                </div>

                {/* Placement — BEFORE the hero task on a course nobody has
                    started: the probe is what decides where to start, so it has
                    to be read first. Once the course is under way it is a tool
                    (`underWay`), and "Not now" moves it there too. It renders
                    nothing when there is nothing to offer (server/placement.js). */}
                {currentProjectId && (
                    <PlacementCard
                        projectId={currentProjectId}
                        projectName={project.name}
                        status={placement.status}
                        onDismiss={() => void placement.setDismissed(true)}
                        underWay={underWay}
                    />
                )}

                {/* Four bands: the one thing to do; today's work (the plan and
                    the cards, side by side from 40rem, where each keeps ~19rem:
                    a plan row with its date, the counts beside their button);
                    the phases, full width so every bar is one long row; and
                    the time studied beside the tools (the quizzes are a row of
                    the tools), two across from 40rem like the plan and cards. */}
                <DashboardBands bands={[
                    { key: 'next', minRem: 0, slots: [{ key: 'next', node: nextUp }] },
                    { key: 'today', minRem: 40, slots: [
                        // Today's Plan — the consolidated agenda (server/dailyPlan.js),
                        // the hero left out of it.
                        {
                            key: 'plan', node: dailyPlan && currentProjectId != null && (
                                <TodaysPlan plan={dailyPlan} heroId={heroTask?.id ?? null} projectId={currentProjectId} />
                            ),
                        },
                        // A project with cards gets them counted here, with the
                        // rest of today's work; a project WITHOUT cards gets
                        // nothing: a tile could only ever say 0.
                        {
                            key: 'cards', node: hasCards && currentProjectId != null && (
                                <CardsPanel
                                    projectId={currentProjectId}
                                    compact
                                    reloadKey={cardsKey}
                                    // Pace, progress and the plan count cards too.
                                    onSessionEnd={() => void useStore.getState().loadDashboard(currentProjectId)}
                                />
                            ),
                        },
                    ] },
                    { key: 'phases', minRem: 0, slots: [
                        { key: 'phases', node: milestones && milestones.length > 0 && <PhaseProgress milestones={milestones} /> },
                    ] },
                    { key: 'record', minRem: 40, slots: [
                        // Time spent on this course, by the study clock. Absent
                        // until there is some. Refetched with the rest of the page.
                        {
                            key: 'time', node: currentProjectId != null && (
                                <ProjectStudyTimeSection projectId={currentProjectId} reloadKey={dashboard} />
                            ),
                        },
                        // The quizzes are a row of the tools (see `tools`).
                        { key: 'tools', node: tools },
                    ] },
                ]} />

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
    );
}

type Slot = { key: string; node: ReactNode };

/** One band of the page: its sections side by side, in equal columns, once
 *  the page is at least `minRem` wide (in rem so `ui_scale` moves it with the
 *  type); stacked full width below that. */
type Band = { key: string; minRem: number; slots: Slot[] };

/**
 * The course page's sections as BANDS: every band is one row of equal-width
 * cells that share a top and a bottom edge, so the page reads as a grid. Two
 * free-running columns (today on the left, how it is going on the right) ended
 * at different heights and gave every box a different size; the learner read
 * it as "weird sizes, not a grid".
 *
 * A cell with nothing to say renders nothing and takes no column: the band is
 * `grid-auto-flow: column` with no template, so a `display: none` cell is out
 * of the grid and the cells that remain share the width. A band whose cells
 * are all empty is hidden whole, so it adds no second gap.
 *
 * The DOM order is the one-column reading order, so both layouts read, and
 * TAB, the same way. Crossing a band's width changes classes only, never the
 * tree, so no section remounts (the cards panel and the study clock would each
 * ask the server again). Measured by the element, never a viewport breakpoint:
 * the detail panel opening beside the page narrows it on a wide screen. Width
 * 0 (not measured yet) stacks everything.
 *
 * Mounted with the data, so the element exists when `useElementWidth`'s
 * layout effect runs: the page's own first render is the loading spinner.
 */
function DashboardBands({ bands }: { bands: Band[] }) {
    const ref = useRef<HTMLDivElement>(null);
    const width = useElementWidth(ref);
    const rootPx = useRootFontSize();
    return (
        <div ref={ref} className="flex flex-col gap-6">
            {bands.map(band => (
                <div
                    key={band.key}
                    data-band={band.key}
                    className={`${width >= band.minRem * rootPx
                        ? 'grid grid-flow-col auto-cols-[minmax(0,1fr)]'
                        : 'flex flex-col'} gap-6 [&:not(:has(>:not(:empty)))]:hidden`}
                >
                    {band.slots.map(s => (
                        // `empty:hidden`: out of the grid, so it takes no column.
                        <div key={s.key} className="min-w-0 empty:hidden">{s.node}</div>
                    ))}
                </div>
            ))}
        </div>
    );
}

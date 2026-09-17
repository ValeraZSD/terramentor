import { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import {
    FeedCard, FeedCheckpointCard, FeedFlashcardCard, FeedLessonCard,
    FeedNoticeCard, FeedPracticeCard, FeedQuestionCard, FeedRecallCard,
} from '../../types';
import FeedHeader from './FeedHeader';
import ChapterGroup, { ChapterSection } from './ChapterGroup';
import LessonCard from './LessonCard';
import QuestionCard from './QuestionCard';
import FlashcardFeedCard from './FlashcardFeedCard';
import CheckpointCard from './CheckpointCard';
import PracticeCard from './PracticeCard';
import NoticeCard from './NoticeCard';
import OnboardingCard from './OnboardingCard';
import AiSetupCard from './AiSetupCard';
import { ArrowLeft, FolderOpen, Loader2, ListTree } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { findNode, getNodePath } from '../../utils/tree';

/**
 * The home page: a vertical learning feed, read like a book.
 *
 * Consecutive cards for the same topic (lesson parts, their questions, the
 * closing checkpoint) are grouped into one CHAPTER — a single container with
 * one running header — instead of a stack of look-alike cards that each repeat
 * the project and topic name. Cards from elsewhere (a due flashcard, a recall
 * from a decaying topic, a notice) stay standalone: they ARE interruptions, and
 * looking like one is the point.
 *
 * Answering/rating marks an item done in place (items never unmount or reorder
 * — no scroll jumps) and auto-scrolls the next one into view. Paging is
 * exclude-key based: the sentinel near the end fetches the next batch.
 */

/** Cards that belong to a topic's own narrative, so they group into a chapter. */
type ChapterCard = FeedLessonCard | FeedQuestionCard | FeedCheckpointCard | FeedPracticeCard;
type StandaloneCard = FeedFlashcardCard | FeedRecallCard | FeedNoticeCard;

type FeedGroup =
    | { type: 'chapter'; head: ChapterCard; cards: ChapterCard[]; continued: boolean }
    | { type: 'single'; card: StandaloneCard };

const isChapterCard = (card: FeedCard): card is ChapterCard =>
    card.kind === 'lesson' || card.kind === 'question'
    || card.kind === 'checkpoint' || card.kind === 'practice';

/**
 * Fold the flat card list into chapters. Order is never changed — the server's
 * interleave decides what comes when; this only draws a box around the runs
 * that already belong together. A topic the feed returns to later (after a
 * flashcard broke the run) opens a chapter marked "continued" rather than
 * silently repeating its title as if it were new.
 */
function groupCards(cards: FeedCard[]): FeedGroup[] {
    const groups: FeedGroup[] = [];
    const seenNodes = new Set<number>();

    for (const card of cards) {
        if (!isChapterCard(card)) {
            groups.push({ type: 'single', card });
            continue;
        }
        const last = groups[groups.length - 1];
        if (last?.type === 'chapter' && last.head.nodeId === card.nodeId) {
            last.cards.push(card);
            continue;
        }
        groups.push({
            type: 'chapter',
            head: card,
            cards: [card],
            continued: seenNodes.has(card.nodeId),
        });
        seenNodes.add(card.nodeId);
    }
    return groups;
}

/**
 * `studyNodeId` turns the home feed into the STUDY PAGE for one topic or
 * section: the same stream, the same cards, scoped server-side to that node
 * (`GET /api/feed?nodeId=`). The differences are chrome — a topic header
 * with the way back instead of today's activity strip, no first-run cards,
 * and an end state that says the topic is done rather than "come back later".
 */
export default function FeedView({ studyNodeId = null }: { studyNodeId?: number | null } = {}) {
    const { t: tr } = useTranslation();
    const studying = studyNodeId != null;
    const feedScope = useStore(s => s.feedScope);
    const tree = useStore(s => s.tree);
    const currentProjectId = useStore(s => s.currentProjectId);
    const projects = useStore(s => s.projects);
    const studyNode = studying ? findNode(tree, studyNodeId) : null;
    const studyPath = studying ? getNodePath(tree, studyNodeId).slice(0, -1) : [];
    const studyProject = studying ? projects.find(p => p.id === currentProjectId) ?? null : null;
    // A stream loaded for another scope (the home feed, or another topic) must
    // not be drawn under this header while the right one is on its way.
    const scopeMatches = feedScope === studyNodeId;
    const feedCards = useStore(s => s.feedCards);
    const feedHeader = useStore(s => s.feedHeader);
    const feedLoading = useStore(s => s.feedLoading);
    const feedExhausted = useStore(s => s.feedExhausted);
    const feedDone = useStore(s => s.feedDone);
    const feedTransfers = useStore(s => s.feedTransfers);
    const loadFeed = useStore(s => s.loadFeed);
    const extendFeed = useStore(s => s.extendFeed);
    const pullFeedUpdates = useStore(s => s.pullFeedUpdates);
    const setView = useStore(s => s.setView);
    const openProjectNode = useStore(s => s.openProjectNode);
    const setFeedFocusItem = useStore(s => s.setFeedFocusItem);

    // The background lesson generator's state, if it is working right now.
    // Selected as PRIMITIVES on purpose: the task list is replaced ~4×/s while
    // any generation streams, so a selector returning the task object would
    // re-render the whole feed at that rate. `genSignal` changes only when the
    // generator moves to another item — which is exactly when a new card exists.
    const generating = useStore(s => s.aiTasks.some(t => t.kind === 'feed' && t.status === 'running'));
    const generatingPct = useStore(s => s.aiTasks.find(t => t.kind === 'feed')?.progress.percent ?? null);
    const genSignal = useStore(s => {
        const t = s.aiTasks.find(x => x.kind === 'feed');
        return t ? `${t.status}|${t.progress.percent ?? ''}|${t.progress.message ?? ''}` : '';
    });

    const cardRefs = useRef(new Map<string, HTMLElement>());
    const sentinelRef = useRef<HTMLDivElement | null>(null);

    const setCardRef = useCallback((key: string) => (el: HTMLElement | null) => {
        if (el) cardRefs.current.set(key, el);
        else cardRefs.current.delete(key);
    }, []);

    // The feed's own strip is sticky, and so is every chapter header — which has
    // to park directly below it. Its height changes with the viewport (the chip
    // row wraps on a phone), so measure it and publish it as --feed-top rather
    // than guessing an offset that would overlap on one breakpoint or the other.
    const headerWrapRef = useRef<HTMLDivElement | null>(null);
    const [headerHeight, setHeaderHeight] = useState(0);
    useEffect(() => {
        const el = headerWrapRef.current;
        if (!el) return;
        const observer = new ResizeObserver(() => setHeaderHeight(el.offsetHeight));
        observer.observe(el);
        setHeaderHeight(el.offsetHeight);
        return () => observer.disconnect();
    }, [feedHeader]);

    // Advance = smooth-scroll the next item into view and move focus to it
    // (screen readers land on it; sighted keyboard users too).
    const cardsRef = useRef(feedCards);
    cardsRef.current = feedCards;
    const advanceFrom = useCallback((key: string) => {
        const cards = cardsRef.current;
        const idx = cards.findIndex(c => c.key === key);
        if (idx < 0) return;
        const next = cards[idx + 1];
        if (!next) return;
        const el = cardRefs.current.get(next.key);
        if (!el) return;
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
        el.focus({ preventScroll: true });
    }, []);

    const markFeedCardDone = useStore(s => s.markFeedCardDone);
    const handleDone = useCallback((key: string) => {
        markFeedCardDone(key);
        // Let the done-state paint first, then glide to the next item.
        requestAnimationFrame(() => advanceFrom(key));
    }, [markFeedCardDone, advanceFrom]);

    // Infinite extension: fetch the next batch while the reader approaches the
    // end. The store appends only unseen keys, so this is jank-free.
    useEffect(() => {
        const sentinel = sentinelRef.current;
        if (!sentinel || feedExhausted) return;
        const observer = new IntersectionObserver(entries => {
            if (entries.some(e => e.isIntersecting)) void extendFeed();
        }, { rootMargin: '800px 0px' });
        observer.observe(sentinel);
        return () => observer.disconnect();
        // `feedLoading` is a dep so the observer is rebuilt when a fetch settles:
        // extendFeed no-ops while one is in flight, and IntersectionObserver only
        // fires on a CHANGE in intersection — without this, a background pull
        // landing while the sentinel is already on screen would stall paging.
    }, [extendFeed, feedExhausted, feedCards.length, feedLoading]);

    // Which card is the reader actually on? The assistant is reachable from
    // here, and on this page there is no selected node to tell it what "this"
    // means — so track the topmost card that is genuinely on screen and publish
    // its feed_items id. Only the id travels; the server reads the row.
    //
    // Topmost-visible, not most-visible: while scrolling through a long lesson
    // the card under the reader's eyes is the one whose top edge is highest
    // above the fold, and a taller card further down would otherwise win on
    // area alone.
    useEffect(() => {
        const observer = new IntersectionObserver(() => {
            let best: { top: number; id: number } | null = null;
            for (const [key, el] of cardRefs.current) {
                const rect = el.getBoundingClientRect();
                if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
                const card = cardsRef.current.find(c => c.key === key);
                const id = card && 'feedItemId' in card ? card.feedItemId : null;
                if (!id) continue;
                if (!best || rect.top < best.top) best = { top: rect.top, id };
            }
            setFeedFocusItem(best?.id ?? null);
        }, { threshold: [0, 0.25, 0.5] });
        for (const el of cardRefs.current.values()) observer.observe(el);
        return () => observer.disconnect();
    }, [feedCards, setFeedFocusItem]);

    // Leaving the feed clears it — a stale "they are reading X" is worse than
    // nothing, because the assistant would answer confidently about the wrong
    // screen.
    useEffect(() => () => setFeedFocusItem(null), [setFeedFocusItem]);

    // First load (deep-link/refresh straight to '/' before applyRoute fired).
    // On the study page applyRoute loads the scoped stream itself.
    useEffect(() => {
        if (studying) return;
        if (!feedHeader && !feedLoading && feedCards.length === 0) void loadFeed();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Pick up lessons as the generator writes them, instead of making the reader
    // reload the page to discover them. The task's detail line changes when it
    // moves to the next item — which means the previous one just landed — so it
    // doubles as the "something new exists" signal; the status change catches the
    // final item when the burst ends. `pullFeedUpdates` throttles the rest.
    useEffect(() => {
        if (!genSignal) return;
        void pullFeedUpdates();
    }, [genSignal, pullFeedUpdates]);

    const groups = useMemo(() => groupCards(feedCards), [feedCards]);

    const studyHeader = studying ? (
        <div className="sticky top-0 z-10 bg-slate-100/95 dark:bg-slate-900/95 backdrop-blur-sm border-b border-slate-200 dark:border-slate-700">
            <div className="max-w-2xl mx-auto px-3 sm:px-4 py-2.5 flex items-center gap-2">
                <button
                    type="button"
                    onClick={() => openProjectNode(currentProjectId ?? 0, studyNodeId)}
                    className="shrink-0 flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                    title={tr("Back to the project tree")}
                >
                    <ArrowLeft className="w-4 h-4" />
                    <span className="hidden sm:inline">{tr("Back")}</span>
                </button>
                <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400 truncate">
                        {[studyProject?.name, ...studyPath.map(n => n.title)].filter(Boolean).join(' › ')}
                    </p>
                    <h1 className="text-sm sm:text-base font-semibold text-slate-900 dark:text-white truncate">
                        {studyNode?.title ?? tr("Study")}
                    </h1>
                </div>
                <button
                    type="button"
                    onClick={() => openProjectNode(currentProjectId ?? 0, studyNodeId)}
                    className="shrink-0 flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                    title={tr("Open this topic's details, notes and tutor")}
                >
                    <ListTree className="w-4 h-4" />
                    <span className="hidden sm:inline">{tr("Details")}</span>
                </button>
            </div>
        </div>
    ) : null;

    if ((feedLoading && feedCards.length === 0) || (studying && !scopeMatches)) {
        return (
            <div className="h-full flex items-center justify-center bg-slate-100 dark:bg-slate-900">
                <div className="text-center">
                    <Loader2 className="w-10 h-10 text-accent-fg animate-spin mx-auto mb-4" />
                    <p className="text-slate-600 dark:text-slate-300 font-medium">{tr("Building your feed…")}</p>
                </div>
            </div>
        );
    }

    if (studying && feedCards.length === 0) {
        return (
            <div className="h-full flex flex-col bg-slate-100 dark:bg-slate-900">
                {studyHeader}
                <div className="flex-1 flex items-center justify-center">
                    <div className="text-center max-w-sm px-6">
                        <FolderOpen className="w-12 h-12 mx-auto mb-3 text-slate-300 dark:text-slate-600" />
                        <p className="text-lg font-medium text-slate-700 dark:text-slate-200">{tr("Nothing to study here yet")}</p>
                        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 mb-4">
                            {tr("This topic has no overview, notes, saved questions or cards yet. With an AI model on, its lessons are being written now — they appear here as they are ready.")}
                        </p>
                        <button
                            onClick={() => openProjectNode(currentProjectId ?? 0, studyNodeId)}
                            className="px-4 py-2 text-sm font-medium text-accent-fg bg-accent/10 rounded-lg hover:bg-accent/20 transition"
                        >
                            {tr("Open topic details")}
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    if (!feedHeader && feedCards.length === 0) {
        return (
            <div className="h-full flex items-center justify-center bg-slate-100 dark:bg-slate-900">
                <div className="text-center text-slate-400">
                    <FolderOpen className="w-12 h-12 mx-auto mb-3 opacity-50" />
                    <p className="text-lg font-medium text-slate-700 dark:text-slate-200">{tr("Couldn't load your feed")}</p>
                    <button
                        onClick={() => loadFeed()}
                        className="mt-3 px-4 py-2 text-sm font-medium text-accent-fg bg-accent/10 rounded-lg hover:bg-accent/20 transition"
                    >
                        {tr("Try again")}
                    </button>
                </div>
            </div>
        );
    }

    // No cards at all with a healthy header = nothing to study and no projects
    // (composeFeed emits an all-clear notice whenever projects exist).
    if (feedCards.length === 0 && feedHeader) {
        return (
            // The first run is THIS screen. A new library used to arrive with a
            // seeded tutorial project in it, so there were always cards here and
            // this branch was what a returning learner saw after archiving
            // everything. With the seed gone (it could only ever be English,
            // whatever language the interface had already switched itself to)
            // this is the very first thing anyone sees — and centring one button
            // in an empty page put the setup card and the checklist, the two
            // things that say what the app is for, on a screen nobody had
            // reached yet.
            <div className="h-full overflow-y-auto bg-slate-100 dark:bg-slate-900">
                <div className="max-w-2xl mx-auto px-3 sm:px-4 py-4 space-y-5">
                    {!studying && <AiSetupCard />}
                    {!studying && <OnboardingCard cta={false} />}
                    <div className="text-center max-w-sm mx-auto px-6 py-8">
                        <FolderOpen className="w-12 h-12 mx-auto mb-3 text-slate-300 dark:text-slate-600" />
                        <p className="text-lg font-medium text-slate-700 dark:text-slate-200">{tr("No active projects yet")}</p>
                        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 mb-4">
                            {tr("Create a learning project and your feed will fill itself.")}
                        </p>
                        <button
                            onClick={() => setView('projects')}
                            className="px-5 py-2.5 bg-accent text-white rounded-xl font-medium hover:brightness-90 transition"
                        >
                            {tr("Go to Projects")}
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div
            className="h-full overflow-y-auto bg-slate-100 dark:bg-slate-900"
            style={{ '--feed-top': `${headerHeight}px` } as CSSProperties}
        >
            <div ref={headerWrapRef}>
                {studying ? studyHeader : (feedHeader && <FeedHeader header={feedHeader} loading={feedLoading} />)}
            </div>
            {/* `pb-24` was a guess at how tall the task dock is. It floats over
                the last card whenever it is taller than the guess — and the last
                card is usually a lesson being read. `TaskDock` publishes its
                MEASURED height (0px when nothing is running), so reserve that. */}
            <div
                className="max-w-2xl mx-auto px-3 sm:px-4 py-4 space-y-5"
                style={{ paddingBottom: 'calc(3rem + var(--task-dock-h, 0px))' }}
            >
                {/* First-run guidance. Renders nothing once the loop has been run
                    once, or once dismissed — so it costs returning learners a
                    single cheap request and no pixels. */}
                {/* The designed "no model reachable" state: says what still works,
                    what a model adds, and which size to run. Nothing once AI answers
                    or once the learner chooses to go without. */}
                {!studying && <AiSetupCard />}
                {!studying && <OnboardingCard />}
                {groups.map(group => group.type === 'chapter' ? (
                    <ChapterGroup
                        key={group.head.key}
                        projectColor={group.head.projectColor}
                        projectName={group.head.projectName}
                        projectId={group.head.projectId}
                        nodeTitle={group.head.nodeTitle}
                        continued={group.continued}
                        onOpenNode={() => openProjectNode(group.head.projectId, group.head.nodeId)}
                        nodeId={group.head.nodeId}
                        transfer={feedTransfers[group.head.nodeId] ?? null}
                        // The chapter's own checkpoint knows the configured gate
                        // mode; a chapter still mid-teaching has no checkpoint
                        // yet, and advisory is the app default.
                        gateMode={group.cards.find(c => c.kind === 'checkpoint')?.gateMode}
                    >
                        {group.cards.map(card => (
                            <ChapterSection key={card.key} innerRef={setCardRef(card.key)}>
                                {renderChapterCard(card, !!feedDone[card.key], handleDone)}
                            </ChapterSection>
                        ))}
                    </ChapterGroup>
                ) : (
                    <div
                        key={group.card.key}
                        ref={setCardRef(group.card.key)}
                        tabIndex={-1}
                        style={{ scrollMarginTop: 'calc(var(--feed-top, 0px) + 1rem)' }}
                        className="outline-none"
                    >
                        {renderStandalone(group.card, !!feedDone[group.card.key], handleDone)}
                    </div>
                ))}
                <div ref={sentinelRef} aria-hidden="true" />
                {feedLoading && feedCards.length > 0 && (
                    <div className="flex justify-center py-4">
                        <Loader2 className="w-5 h-5 text-slate-400 animate-spin" />
                    </div>
                )}
                {feedExhausted && feedCards.length > 0 && (
                    generating ? (
                        // Reaching the end while the generator is mid-burst is not
                        // a dead end — the next lessons are minutes away and will
                        // append themselves. Say so, rather than "come back later".
                        <p className="flex items-center justify-center gap-2 text-center text-sm text-slate-500 dark:text-slate-400 py-4">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                            {tr("Writing more lessons")}
                            {generatingPct != null && <span className="tabular-nums">· {generatingPct}%</span>}
                            <span className="hidden sm:inline">{tr("— they'll appear here as they're ready.")}</span>
                        </p>
                    ) : studying ? (
                        <div className="text-center py-6 space-y-3">
                            <p className="text-sm text-slate-600 dark:text-slate-300">
                                {tr("That's all of this topic. Its checkpoint above is where you prove it.")}
                            </p>
                            <div className="flex flex-wrap justify-center gap-2">
                                <button
                                    onClick={() => openProjectNode(currentProjectId ?? 0, studyNodeId)}
                                    className="px-4 py-2 text-sm font-medium text-accent-fg bg-accent/10 rounded-lg hover:bg-accent/20 transition"
                                >
                                    {tr("Open topic details")}
                                </button>
                                <button
                                    onClick={() => setView('today')}
                                    className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-200/70 dark:bg-slate-700/70 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition"
                                >
                                    {tr("Back to the feed")}
                                </button>
                            </div>
                        </div>
                    ) : (
                        <p className="text-center text-sm text-slate-500 dark:text-slate-400 py-4">
                            {tr("That's everything for now — come back later or open a project to go deeper.")}
                        </p>
                    )
                )}
            </div>
        </div>
    );
}

function renderChapterCard(card: ChapterCard, done: boolean, onDone: (key: string) => void) {
    switch (card.kind) {
        case 'lesson':
            return <LessonCard card={card} done={done} onDone={onDone} />;
        case 'question':
            return <QuestionCard card={card} done={done} onDone={onDone} inChapter />;
        case 'checkpoint':
            return <CheckpointCard card={card} done={done} onDone={onDone} />;
        case 'practice':
            return <PracticeCard card={card} done={done} onDone={onDone} />;
    }
}

function renderStandalone(card: StandaloneCard, done: boolean, onDone: (key: string) => void) {
    switch (card.kind) {
        case 'flashcard':
            return <FlashcardFeedCard card={card} done={done} onDone={onDone} />;
        case 'recall':
            return <QuestionCard card={card} done={done} onDone={onDone} />;
        case 'notice':
            return <NoticeCard card={card} />;
    }
}

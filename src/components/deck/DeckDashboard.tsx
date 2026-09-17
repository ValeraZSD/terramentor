import { useEffect, useState } from 'react';
import { Layers, Loader2, RefreshCw, GraduationCap } from 'lucide-react';
import { api } from '../../api';
import { useStore } from '../../store';
import type { DeckData } from '../../types';
import CardsPanel from './CardsPanel';
import { fmt } from './deckPalette';
import { useTranslation } from 'react-i18next';

/**
 * The page for a project whose content is CARDS.
 *
 * ## What was wrong with showing it the ordinary one
 *
 * The curriculum dashboard asks a curriculum's questions, and on a real
 * 1,501-card import every one of them came back true and useless: "0% complete"
 * over a denominator of 1, a "Your Journey" bar that could only read 0/1,
 * "No tasks scheduled for today", "No Quizzes Yet", and — the one number a
 * person with a deck actually wants — "1,483 cards due" in a small tile at the
 * bottom of the page, of which 1,465 had never been seen.
 *
 * ## What decides which page you get
 *
 * Not where the project came from. A project is shown this page when it has
 * cards and nothing to teach — no topics of its own, or teaching switched off —
 * and the ordinary dashboard (with the same card panel inside it) when it has
 * both. `projects.kind` used to decide, permanently, at import: one deck's
 * 32 named subdecks are a curriculum and could never be shown as one.
 *
 * The body is `CardsPanel`, shared with the ordinary dashboard so the two
 * screens cannot answer the same question differently.
 */
export default function DeckDashboard() {
    const { t } = useTranslation();
    const currentProjectId = useStore(s => s.currentProjectId);
    const projects = useStore(s => s.projects);
    const loadProjects = useStore(s => s.loadProjects);
    const addToast = useStore(s => s.addToast);

    const [deck, setDeck] = useState<DeckData | null>(null);
    const [loading, setLoading] = useState(true);
    const [reloadKey, setReloadKey] = useState(0);
    const [switching, setSwitching] = useState(false);

    const project = projects.find(p => p.id === currentProjectId);

    useEffect(() => {
        let cancelled = false;
        if (currentProjectId == null) return;
        setLoading(true);
        api.getDeck(currentProjectId)
            .then(data => { if (!cancelled) setDeck(data); })
            .catch(e => addToast('error', t("Could not load this deck"), e.message))
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [currentProjectId, reloadKey, addToast]);

    if (loading && !deck) {
        return (
            <div className="flex flex-1 items-center justify-center bg-slate-100 dark:bg-slate-900">
                <div className="text-center">
                    <Loader2 className="mx-auto mb-4 h-10 w-10 animate-spin text-accent-fg" />
                    <p className="font-medium text-slate-600 dark:text-slate-300">{t("Counting your cards…")}</p>
                </div>
            </div>
        );
    }
    if (!deck || currentProjectId == null) {
        return (
            <div className="flex flex-1 items-center justify-center bg-slate-100 dark:bg-slate-900">
                <div className="text-center text-slate-400">
                    <Layers className="mx-auto mb-3 h-12 w-12 opacity-50" />
                    <p className="text-lg font-medium">{t("No deck data")}</p>
                </div>
            </div>
        );
    }

    // Topics its author NAMED, which this project has and is not using: an
    // import arrives with teaching off, because 32 background lesson plans is a
    // surprise on the evening somebody wanted to study cards. Offered only where
    // there is something to teach — thirty "Stage N" slices are
    // pagination and this never appears for them.
    const canTeach = !project?.teaches && (project?.topic_count ?? 0) > 0;

    const turnTeachingOn = async () => {
        setSwitching(true);
        try {
            await api.setProjectTeaching(currentProjectId, true);
            await loadProjects();
        } catch (e: any) {
            addToast('error', t("Could not switch teaching on"), e.message);
        } finally {
            setSwitching(false);
        }
    };

    return (
        <div className="flex-1 overflow-auto bg-slate-100 dark:bg-slate-900">
            <div className="mx-auto max-w-4xl space-y-4 p-4 sm:space-y-6 sm:p-6">

                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <h2 className="flex items-center gap-3 text-2xl font-bold text-slate-900 dark:text-white">
                            <span
                                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white"
                                style={{ backgroundColor: deck.project.color || '#3B82F6' }}
                                aria-hidden="true"
                            >
                                <Layers className="h-5 w-5" />
                            </span>
                            <span className="truncate">{deck.project.name}</span>
                        </h2>
                        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400 sm:ml-[52px]">
                            {t("{{fmt}} cards", { count: deck.totals.cards, fmt: fmt(deck.totals.cards) })}
                            {/* JSX drops the newline between these, so the space before each
                                separator has to be written: "1 828 cards· 27 sections". */}
                            {deck.stages.length > 1 && <>{' '}{t("· {{fmt}} sections", { count: deck.stages.length, fmt: fmt(deck.stages.length) })}</>}
                            {deck.seen > 0 && <>{' '}{t("· {{fmt}} met so far", { fmt: fmt(deck.seen) })}</>}
                        </p>
                    </div>
                    <button
                        onClick={() => setReloadKey(k => k + 1)}
                        title={t("Refresh")}
                        aria-label={t("Refresh deck statistics")}
                        className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-200 dark:text-slate-400 dark:hover:bg-slate-700"
                    >
                        <RefreshCw className="h-5 w-5" />
                    </button>
                </div>

                <CardsPanel projectId={currentProjectId} showStages />

                {canTeach && (
                    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="min-w-0">
                                <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
                                    <GraduationCap className="h-4 w-4 text-slate-400" aria-hidden="true" />
                                    {t("This collection names its own topics")}
                                </h3>
                                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                                    {t("{{count}} of them. Switch teaching on and they get lessons, questions and a checkpoint like any other course — its cards carry on exactly as they are.", { count: project?.topic_count ?? 0 })}
                                </p>
                            </div>
                            <button
                                onClick={turnTeachingOn}
                                disabled={switching}
                                className="shrink-0 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-accent/90 disabled:opacity-50"
                            >
                                {switching ? t("Switching…") : t("Teach these topics")}
                            </button>
                        </div>
                    </section>
                )}
            </div>
        </div>
    );
}

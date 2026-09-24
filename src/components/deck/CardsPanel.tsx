import { useCallback, useEffect, useState } from 'react';
import {
    Play, Loader2, CheckCircle2, Settings2, CalendarClock, Sparkles,
} from 'lucide-react';
import { api } from '../../api';
import { useStore } from '../../store';
import type { DeckData, DeckStage } from '../../types';
import GlobalFlashcardReview from '../GlobalFlashcardReview';
import { Button } from '../ui/Button';
import DeckBar from './DeckBar';
import DeckForecast from './DeckForecast';
import DeckStages from './DeckStages';
import { fmt } from './deckPalette';
import { useTranslation } from 'react-i18next';

/** How far a "study ahead" session reaches forward. Matches MAX_AHEAD_DAYS on
 *  the server, which clamps it — long enough to make an empty day studiable,
 *  short enough that the learner is still reviewing what they are about to
 *  need rather than being handed the whole deck. */
const AHEAD_DAYS = 14;

/**
 * Everything a project's CARDS need said about them, wherever those cards live.
 *
 * This was the body of the deck dashboard, and it only existed for imports —
 * which is why a course with 615 written cards had none of it: no split between
 * work owed and new cards allowed, no four states, no forecast, just a tile
 * reading "615 due" beside a button that served all 615 at once. A project does
 * not have to have arrived from Anki to deserve an honest answer about its
 * cards, so the panel is the unit and the page it sits on is the caller's
 * business:
 *
 *   * `DeckDashboard` (a project whose content IS cards) shows it with the
 *     stage ladder, as the whole page.
 *   * `StudyDashboard` (a project with topics AND cards) shows it in place of
 *     the old Flashcards tile, under the plan.
 *
 * Both read the same endpoint and are served by the same queue, so the two
 * screens cannot disagree about the same cards — which they did, for as long as
 * "due" meant two different things depending on which one you opened.
 */
export default function CardsPanel({ projectId, showStages = false }: {
    projectId: number;
    /** The ladder of stages/topics. The card-only page wants it; a project with
     *  a plan already draws its structure as a tree and a schedule. */
    showStages?: boolean;
}) {
    const { t } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const selectNode = useStore(s => s.selectNode);

    const [deck, setDeck] = useState<DeckData | null>(null);
    const [loading, setLoading] = useState(true);
    const [session, setSession] = useState<{ stage: DeckStage | null; ahead?: boolean } | null>(null);
    const [editingLimit, setEditingLimit] = useState(false);
    const [limitDraft, setLimitDraft] = useState('20');

    const load = useCallback(async (opts: { silent?: boolean } = {}) => {
        if (projectId == null) return;
        if (!opts.silent) setLoading(true);
        try {
            const data = await api.getDeck(projectId);
            setDeck(data);
            setLimitDraft(String(data.newPerDay));
        } catch (e: any) {
            addToast('error', t("Could not load these cards"), e.message);
        } finally {
            setLoading(false);
        }
    }, [projectId, addToast]);

    useEffect(() => { void load(); }, [load]);

    const saveLimit = async () => {
        const n = Math.max(0, Number.parseInt(limitDraft, 10) || 0);
        try {
            await api.setDeckNewPerDay(projectId, n);
            setEditingLimit(false);
            await load({ silent: true });
        } catch (e: any) {
            addToast('error', t("Could not save"), e.message);
        }
    };

    // The session's cards come from the study queue, never from `/flashcards/due`
    // — see the note on `fetchCards` in GlobalFlashcardReview.
    const fetchQueue = useCallback(async () => {
        const stage = session?.stage;
        // AHEAD_DAYS only applies to a session the learner explicitly asked for.
        const res = await api.getDeckQueue(projectId, {
            ...(stage ? { stage: stage.nodeId } : {}),
            ...(session?.ahead ? { ahead: AHEAD_DAYS } : {}),
        });
        return res.cards as any[];
    }, [projectId, session]);

    if (loading && !deck) {
        return (
            <section className="flex items-center justify-center rounded-2xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-700 dark:bg-slate-800">
                <Loader2 className="h-6 w-6 animate-spin text-accent-fg" />
            </section>
        );
    }
    if (!deck) return null;

    const owed = deck.dueReviews + deck.newAvailable;
    const nothingLeftEver = deck.totals.new === 0 && deck.dueReviews === 0;

    // The same control appears in both branches of the "anything owed?" split
    // below, so the wiring is written once — two copies drifted apart is how
    // one of them ends up saving to nothing.
    const newLimitProps = {
        deck,
        editing: editingLimit,
        draft: limitDraft,
        onDraft: setLimitDraft,
        onEdit: () => setEditingLimit(true),
        onSave: saveLimit,
        onCancel: () => { setEditingLimit(false); setLimitDraft(String(deck.newPerDay)); },
    };

    return (
        <>
            {session && (
                <GlobalFlashcardReview
                    projectId={projectId}
                    fetchCards={fetchQueue}
                    title={session.stage ? session.stage.title : deck.project.name}
                    onClose={() => { setSession(null); void load({ silent: true }); }}
                    onComplete={() => { setSession(null); void load({ silent: true }); }}
                />
            )}

            {/* ---- today: the one thing to do ------------------------ */}
            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800 sm:p-6">
                {owed > 0 ? (
                    <>
                        {/* The counts and the button that clears them share a
                            row, the button at its own width on the right. It
                            was a 582px bar across the card for an 180px label
                            — a control is as wide as what it says. Narrow, the
                            button wraps under the counts and stays right, where
                            the thumb is. */}
                        <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
                            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
                                <Count n={deck.dueReviews} label={t("to review")} tone="accent" />
                                <Count n={deck.newAvailable} label={t("new today")} tone="sky" />
                            </div>
                            <Button
                                variant="primary"
                                size="lg"
                                className="ml-auto"
                                onClick={() => setSession({ stage: null })}
                                icon={<Play className="h-5 w-5" aria-hidden="true" />}
                            >
                                {t("Study {{fmt}} cards", { count: owed, fmt: fmt(owed) })}
                            </Button>
                        </div>
                        {/* The limit is stated where its consequence is,
                            not buried in Settings: "20 new today" is only
                            meaningful next to the number it produced. */}
                        <NewLimit {...newLimitProps} />
                    </>
                ) : (
                    <div className="text-center">
                        <CheckCircle2 className="mx-auto mb-3 h-10 w-10 text-emerald-500" />
                        <p className="text-lg font-semibold text-slate-900 dark:text-white">
                            {nothingLeftEver ? t("Every card is in rotation") : t("Done for today")}
                        </p>
                        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                            {nothingLeftEver
                                ? t("Nothing is due and there are no new cards left to meet. The forecast below says when the deck comes back.")
                                : deck.introducedToday > 0
                                    ? t("{{n}} new cards met today, and nothing else is due. Come back tomorrow.", { count: deck.introducedToday, n: fmt(deck.introducedToday) })
                                    : t("Nothing is due right now.")}
                        </p>
                        {/* Offered whenever the deck still holds ANYTHING — new
                            cards to meet or reviews that have not come round
                            yet. Gating this on `totals.new > 0` alone meant a
                            deck with every card in rotation and nothing due
                            until Thursday could not be opened at all. */}
                        {(deck.totals.new > 0 || deck.totals.cards > 0) && (
                            <button
                                onClick={() => setSession({ stage: null, ahead: true })}
                                className="mt-4 inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
                            >
                                <Sparkles className="h-4 w-4" />
                                {t("Study ahead anyway")}
                            </button>
                        )}
                        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                            {t("Brings forward new cards and anything due in the next {{AHEAD_DAYS}} days. Answering early earns a shorter next interval.", { count: AHEAD_DAYS, AHEAD_DAYS })}
                        </p>
                        <NewLimit {...newLimitProps} />
                    </div>
                )}
            </section>

            {/* ---- the state of the collection ---------------------- */}
            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800 sm:p-6">
                <h3 className="mb-4 text-sm font-semibold text-slate-900 dark:text-white">
                    {t("Your cards")}
                </h3>
                <DeckBar totals={deck.totals} matureDays={deck.matureDays} />
                {deck.reviewed > 0 && (
                    <p className="mt-4 border-t border-slate-100 pt-3 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                        {/* Not "retention". True retention is the share of
                            reviews answered correctly and needs a review
                            log this app does not keep — so this says the
                            thing that IS known, with its denominator. */}
                        {t("Of {{fmt}} cards you have studied,", { count: deck.reviewed, fmt: fmt(deck.reviewed) })}{' '}
                        <span className="font-semibold text-slate-700 dark:text-slate-200">
                            {fmt(deck.reviewed - deck.lapsed)}
                        </span>{' '}
                        {t("have never been forgotten.", { count: deck.reviewed - deck.lapsed })}
                    </p>
                )}
            </section>

            {/* ---- forecast ----------------------------------------- */}
            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800 sm:p-6">
                <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
                    <CalendarClock className="h-4 w-4 text-slate-400" aria-hidden="true" />
                    {t("Coming up")}
                </h3>
                <DeckForecast forecast={deck.forecast} />
            </section>

            {/* ---- the ladder --------------------------------------- */}
            {showStages && deck.stages.length > 0 && (
                <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800 sm:p-6">
                    <h3 className="mb-1 text-sm font-semibold text-slate-900 dark:text-white">
                        {deck.stages.length === 1 ? t("This deck") : t("Sections ({{fmt}})", { fmt: fmt(deck.stages.length) })}
                    </h3>
                    <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
                        {t("In the order the deck introduces them. Studying normally works through these on its own — open one to jump ahead.")}
                    </p>
                    <DeckStages
                        stages={deck.stages}
                        currentStageId={deck.currentStageId}
                        onStudy={stage => setSession({ stage })}
                        onOpen={stage => void selectNode(stage.nodeId)}
                    />
                </section>
            )}
        </>
    );
}

function Count({ n, label, tone }: { n: number; label: string; tone: 'accent' | 'sky' }) {
    return (
        <div>
            <p className={`text-4xl font-bold tabular-nums ${tone === 'accent' ? 'text-accent-fg' : 'text-sky-700 dark:text-sky-300'}`}>
                {fmt(n)}
            </p>
            <p className="text-sm text-slate-500 dark:text-slate-400">{label}</p>
        </div>
    );
}

/**
 * The daily new-card allowance, edited where its effect is visible.
 *
 * This is the mechanic that makes a 1,500-card collection studiable rather than
 * terrifying, so it is not hidden in Settings behind three taps: it sits under
 * the number it produced, states what it did today, and takes one tap to change.
 */
function NewLimit({ deck, editing, draft, onDraft, onEdit, onSave, onCancel }: {
    deck: DeckData;
    editing: boolean;
    draft: string;
    onDraft: (v: string) => void;
    onEdit: () => void;
    onSave: () => void;
    onCancel: () => void;
}) {
    const { t } = useTranslation();
    if (editing) {
        return (
            <div className="mt-4 flex items-center justify-center gap-2 border-t border-slate-100 pt-3 dark:border-slate-700">
                <label htmlFor="deck-new-per-day" className="text-sm text-slate-600 dark:text-slate-300">
                    {t("New cards per day")}
                </label>
                <input
                    id="deck-new-per-day"
                    type="number"
                    min={0}
                    max={9999}
                    value={draft}
                    onChange={e => onDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') onSave(); if (e.key === 'Escape') onCancel(); }}
                    className="w-20 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm tabular-nums text-slate-900 focus:ring-2 focus:ring-accent dark:border-slate-600 dark:bg-slate-700 dark:text-white"
                    autoFocus
                />
                <button onClick={onSave} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90">
                    {t("Save")}
                </button>
                <button onClick={onCancel} className="rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700">
                    {t("Cancel")}
                </button>
            </div>
        );
    }
    // The hairline spans the card; the control under it is as wide as its words.
    // It was the whole 582px strip, so an empty stretch of card either side of
    // the label opened the editor.
    return (
        // The button is the LIMIT, which is what it edits; "met today" is a fact
        // beside it, not part of its name. Glued inside one label they were two
        // keys read as one sentence ("10 new cards a day· 3 met today", no space).
        <div className="mt-4 flex flex-wrap items-center justify-center gap-x-1 border-t border-slate-100 pt-3 dark:border-slate-700">
            <Button
                variant="quiet"
                size="sm"
                onClick={onEdit}
                icon={<Settings2 className="h-3.5 w-3.5" aria-hidden="true" />}
            >
                {t("{{fmt}} new cards a day", { fmt: fmt(deck.newPerDay) })}
            </Button>
            {deck.introducedToday > 0 && (
                <span className="text-sm text-slate-500 dark:text-slate-400">
                    {t("· {{fmt}} met today", { fmt: fmt(deck.introducedToday) })}
                </span>
            )}
        </div>
    );
}

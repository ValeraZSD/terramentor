import { useState, useRef, useEffect, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { MOD_KEY, usePhysicalKeyboard } from '../utils/platform';
import { useStore, type Theme, MIN_UI_SCALE, MAX_UI_SCALE, DEFAULT_UI_SCALE, UI_SCALE_STEP } from '../store';
import { LANGUAGES } from '../i18n';
import Checkbox from './Checkbox';
import { useDesktop } from '../hooks/useDesktop';
import { desktopApi, type DesktopWindowMode, type DesktopAutostartWindow } from '../desktopApi';
import { api, OllamaModel, PullProgress, SrsStatus, SrsFitResult, MasteryModelStatus, BktFitResult, ServingEndpoint } from '../api';
import { configureSrs, retentionVerdict, REQUEST_RETENTION } from '../utils/srs';
import { AIProvider } from '../types';
import {
    Sun, Moon, Download, Upload, RefreshCw, Trash2, X, Check,
    Loader2, BookOpen, Globe, Cpu, Sparkles,
    Database, Lock, Palette, Code2, Layers,
    Image as ImageIcon, Map as MapIcon,
    Bug, ArrowUpCircle, Copy, Terminal, RotateCcw, Gauge, FileText, Power, CircleHelp as HelpCircle,
    MessageSquareWarning} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button, ButtonLink, IconButton } from './ui/Button';
import { Field, TextInput, Select } from './ui/Field';
import SegmentedControl from './ui/SegmentedControl';
import Switch from './ui/Switch';
import Radio from './ui/Radio';
import Stepper from './ui/Stepper';
import Slider from './ui/Slider';
import { SettingGroup, SettingRow, SettingNote, GROUP_CAPTION } from './ui/SettingRow';
import { Explain, ExpandableSection } from './ui/Disclosure';
import ModelPicker from './ModelPicker';
import { MODEL_TIERS, TIER_DOT } from '../utils/modelTiers';
import SearchProvidersPanel from './SearchProvidersPanel';
import ActivityLogPanel from './settings/ActivityLogPanel';
import ReportProblemDialog from './ReportProblemDialog';
import DesktopQuitScreen from './DesktopQuitScreen';
import { diagnosticsBlock } from '../utils/report';
import ColorField, { ACCENT_COLORS, THEME_TINTS } from './ui/ColorField';
import { themeRamp, tintSwatch } from '../utils/themeRamp';
import SecuritySettings from './SecuritySettings';
import VisualKindsPanel from './settings/VisualKindsPanel';
import AppIconPanel from './settings/AppIconPanel';
import FeedSettingsPanel from './settings/FeedSettingsPanel';
import { useTranslation } from 'react-i18next';
import { k } from '../i18n';
import { useNumberFormat } from '../hooks/useNumberFormat';
import { uiLocale } from '../utils/locale';
import { NUMBER_STYLES, AUTO as NUMBER_AUTO, formatNumber } from '../utils/numberFormat';

// About You: hard character cap (mirrored server-side when injecting into AI
// context) and the fill level at which the counter becomes visible.
const PROFILE_MAX = 3000;
const PROFILE_WARN_AT = 2500;

// Settings is organised into five groups; the active one is mirrored into the
// URL hash (#general/#learning/#ai/#search/#data) so a reload lands on the same
// group. There was a sixth, "Quick", holding the settings a new learner changes
// first — but every control on it was the same component the full section
// renders, so it read as the same page twice. Removed 2026-09-21.
type SettingsTab = 'general' | 'learning' | 'ai' | 'search' | 'data';
// How to recover math from PDFs whose text layer drops formulas. One UI control
// over two backend settings (pdf_math_recovery + pdf_recovery_vision).
type RecoveryMode = 'off' | 'ocr' | 'auto' | 'vision';

// The hosted search backends. Their keys are write-only — Settings types a
// replacement and never reads the stored value back.
type SearchProvider = 'tavily' | 'brave' | 'jina';
const SEARCH_PROVIDERS: { id: SearchProvider; label: string }[] = [
    { id: 'tavily', label: 'Tavily' },
    { id: 'brave', label: 'Brave' },
    { id: 'jina', label: 'Jina' },
];
// Where the Corresponding Source lives. Surfaced in Settings → About because
// AGPL-3.0 §13 requires network users be offered it; update this if the repo moves.
const SOURCE_URL = 'https://github.com/ValeraZSD/terramentor';

const SETTINGS_TABS: { id: SettingsTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'general', label: k("General"), icon: Palette },
    { id: 'learning', label: k("Learning"), icon: BookOpen },
    { id: 'ai', label: k("AI & Models"), icon: Sparkles },
    // NOT the web: "Answering with the web" under AI & Models grounds an answer in
    // live pages. This tab is the outward links the app offers you instead.
    { id: 'search', label: k("Search links"), icon: Globe },
    { id: 'data', label: k("Data"), icon: Database },
];

// Quick-fill presets for the OpenAI-compatible provider. Anything speaking the
// /v1 chat-completions protocol works — these are just the common local and
// hosted endpoints so the user doesn't have to remember ports.
const API_PRESETS: { label: string; url: string; hint: string }[] = [
    { label: k("llama-swap"), url: 'http://127.0.0.1:8888/v1', hint: k("llama.cpp model-swapping proxy") },
    { label: 'llama.cpp', url: 'http://127.0.0.1:8080/v1', hint: k("llama-server default port") },
    { label: k("LM Studio"), url: 'http://127.0.0.1:1234/v1', hint: k("LM Studio local server") },
    { label: k("OpenRouter"), url: 'https://openrouter.ai/api/v1', hint: k("hosted, needs API key") },
    { label: k("OpenAI"), url: 'https://api.openai.com/v1', hint: k("hosted, needs API key") },
];

// Theme picker data moved beside ThemeCards (below the Panel component), its
// only consumer since the General and Quick tabs share the one component.


// ---------------------------------------------------------------------------
// Model guidance — deliberately NAMES NO MODEL.
//
// A catalog of specific models with benchmark figures beside them is the wrong
// thing to ship in both halves: model names churn every few weeks, so a
// hardcoded list is stale the month after it is written, and benchmark numbers
// this project did not measure are decoration of the worst kind for an app
// whose pitch is verifiable honesty.
//
// What IS durable is the size class — how much capability a model of a given
// parameter count has when asked to do this app's actual jobs: author a
// curriculum, teach a multi-part segment, write a question whose answer key
// survives the cold-solve verifier. So the guidance is written in parameter
// classes, and the model LIST comes from whatever the configured provider
// reports. Nothing here is installed, recommended or ranked by name.
// ---------------------------------------------------------------------------

// The size classes, the tier badge, the model sort and the model filter now
// live in `src/utils/modelTiers.ts`, because the same knowledge is needed by
// every place a model is chosen — chat, vision, region naming, embeddings —
// and while it sat in this file the other three had nothing to show but a
// text box. See that file for why no model is ever named here.
// ---------------------------------------------------------------------------


// Animated show/hide for the content "owned" by an enable toggle (CSS
// grid-rows trick — no height measuring). While closed the content is made
// `inert` so it drops out of tab order and the accessibility tree.
function Collapse({ open, children }: { open: boolean; children: React.ReactNode }) {
    return (
        <div
            className={`grid transition-[grid-template-rows] duration-300 ease-out ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
            aria-hidden={!open}
        >
            <div
                className="overflow-hidden min-h-0"
                ref={el => {
                    if (!el) return;
                    if (open) el.removeAttribute('inert');
                    else el.setAttribute('inert', '');
                }}
            >
                {children}
            </div>
        </div>
    );
}

/**
 * The two shapes every block on this page is made of.
 *
 * Thirteen sections had been hand-rolling the identical header markup and the
 * identical white card, which is how a page drifts: each new block is copied
 * from whichever neighbour was open at the time, and a small deviation becomes
 * permanent. A reader learns a settings page by its repetition — same heading
 * weight, same explanatory paragraph, same card underneath — so the template is
 * worth more here than any individual block's styling.
 *
 * `description` takes nodes, not a string, because several of these paragraphs
 * carry <code> and inline emphasis.
 */
/**
 * Spaced-repetition tuning: how much review history exists, whether the
 * scheduler runs fitted or default parameters, and the one action that changes
 * it. Kept as its own component so its state lives with it — the Settings page
 * is already a long list of sections sharing one component's hooks.
 *
 * The fit is only ever APPLIED when it beat the defaults on held-out reviews
 * (server/fsrsOptimizer.js); this panel says so in words either way, because
 * "Optimise" that visibly does nothing reads as broken, and "Optimise" that
 * silently makes the schedule worse is worse than broken.
 */

/**
 * How many reviews a prediction band needs before its row is drawn — and the
 * number the panel quotes when it explains why it is showing three rows and not
 * ten. `retentionReport` always cuts predictions into ten fixed bands; a band of
 * three reviews recalled 100% says nothing, so it is left out rather than drawn
 * as a full bar. One constant, because the sentence and the filter disagreeing
 * is how a caption becomes a lie.
 */
const BIN_MIN_REVIEWS = 10;

function SrsTuningPanel({ active }: { active: boolean }) {
    const { t: tr } = useTranslation();
    const num = useNumberFormat();
    const addToast = useStore(s => s.addToast);
    const [status, setStatus] = useState<SrsStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [last, setLast] = useState<SrsFitResult | null>(null);

    const load = useCallback(async () => {
        try { setStatus(await api.getSrsStatus()); } catch { /* the panel just shows nothing */ }
    }, []);
    useEffect(() => { if (active) load(); }, [active, load]);

    const optimise = async () => {
        if (busy) return;
        setBusy(true);
        try {
            const r = await api.optimizeSrs();
            setLast(r);
            if (r.accepted) {
                configureSrs({ w: r.w });
                addToast('success', tr("Spaced repetition tuned"), tr("Your reviews are now scheduled with parameters fitted to your own history."));
            } else {
                addToast('success', tr("Defaults kept"), r.reason || tr("The fit did not beat the defaults."));
            }
            await load();
        } catch (e: any) {
            addToast('error', tr("Could not tune spaced repetition"), e.message);
        } finally {
            setBusy(false);
        }
    };
    const reset = async () => {
        try {
            await api.resetSrsParams();
            configureSrs({ w: null });
            setLast(null);
            await load();
            addToast('success', tr("Back to the published defaults"));
        } catch (e: any) {
            addToast('error', tr("Could not reset"), e.message);
        }
    };

    const enough = !!status && status.predicted >= status.minReviews;
    const fitted = !!status?.params;
    const fmt = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '—' : n.toFixed(3));
    // `uiLocale()`, not the bare call: with no argument this follows the
    // operating system's regional settings, so the one date on this panel
    // disagreed with every other date in the app for anyone whose interface
    // language is not their machine's.
    const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString(uiLocale()) : '—');

    // One block of the "Fit the engine" card, built like the activity log's:
    // name, what it is, the measured facts in a hairline frame, then the action
    // with its precondition beside it. It was a caption, a paragraph and a
    // white card rendered as a FRAGMENT into the parent's `space-y-5`, so each
    // piece took 20px of top margin and the caption drifted off its own
    // paragraph — on a white card that was already the section.
    return (
        <TuningBlock
            title={tr("Spaced repetition")}
            note={tr("Flashcards are scheduled by FSRS-6. It ships with parameters fitted on a large public dataset; once you have a few hundred reviews of your own, they can be fitted to you instead. Every rating is kept in a review log on this machine, and an imported Anki deck brings its history with it.")}
            actions={<>
                {fitted && (
                    <Button onClick={reset} disabled={busy}>{tr("Reset to defaults")}</Button>
                )}
                <Button variant="primary" onClick={optimise} disabled={!enough} busy={busy}>
                    {tr("Fit to my reviews")}
                </Button>
            </>}
            hint={<span data-testid="srs-hint">
                {status
                    ? enough
                        ? tr("{{predicted}} day-level reviews available to fit on.", { predicted: num(status.predicted) })
                        : tr("Needs {{minReviews}} day-level reviews to fit on — you have {{predicted}}. Keep reviewing.", { minReviews: status.minReviews, predicted: num(status.predicted) })
                    : ''}
            </span>}
            result={last && (
                <p data-testid="srs-last-result">
                    {last.accepted
                        ? tr("Accepted: held-out log-loss {{fmt}} → {{fmt2}} over {{valReviews}} reviews ({{steps}} steps, {{value}} s).", { count: last.stats.valReviews, fmt: fmt(last.stats.valDefault), fmt2: fmt(last.stats.valFitted), valReviews: last.stats.valReviews, steps: last.stats.steps, value: (last.stats.ms / 1000).toFixed(1) })
                        : tr("Not applied: {{reason}} (held-out log-loss {{fmt}} vs {{fmt2}}).", { reason: last.reason, fmt: fmt(last.stats.valDefault), fmt2: fmt(last.stats.valFitted) })}
                </p>
            )}
        >
            <FactStrip>
                <Fact
                    label={tr("Reviews logged")}
                    testId="srs-log-count"
                    value={status ? tr("{{rows}} on {{cards}} cards", { count: status.log.cards, rows: num(status.log.rows), cards: num(status.log.cards) }) : '…'}
                    sub={status && status.log.anki > 0
                        ? tr("{{anki}} of them came from Anki", { anki: num(status.log.anki) })
                        : undefined}
                />
                {/* "Published defaults" is the accurate name and tells a
                    learner nothing. What they need to know is whose history
                    the numbers came from — everyone's, or theirs. */}
                <Fact
                    label={tr("Scheduling settings")}
                    testId="srs-params-state"
                    value={fitted ? tr("Fitted to you") : tr("Standard settings")}
                    sub={fitted
                        ? (status?.meta?.stats
                            ? tr("fitted on {{when}} · held-out log-loss {{fmt}} → {{fmt2}}", { when: when(status?.meta?.at), fmt: fmt(status.meta.stats.valDefault), fmt2: fmt(status.meta.stats.valFitted) })
                            : tr("fitted on {{when}}", { when: when(status?.meta?.at) }))
                        : tr("the defaults everyone starts on")}
                />
            </FactStrip>
            {status && status.retention.reviews > 0 && (
                <div className="px-4 py-2.5" data-testid="srs-retention">
                    {/* Three percentages side by side make the reader work
                        out which way is good. The verdict says it in words
                        and keeps both numbers inside the sentence that uses
                        them. */}
                    <Fact
                        label={tr("How much you are remembering")}
                        value={tr("{{round}}% recalled over {{reviews}} reviews", { count: status.retention.reviews, round: Math.round((status.retention.observed ?? 0) * 100), reviews: num(status.retention.reviews) })}
                        sub={(() => {
                            const target = Math.round(REQUEST_RETENTION * 100);
                            const expected = Math.round((status.retention.expected ?? 0) * 100);
                            switch (retentionVerdict(status.retention.observed, status.retention.reviews)) {
                                case 'ahead':
                                    return tr("Better than the {{target}}% the schedule aims for, so your cards are probably coming back sooner than you need them. It expected {{expected}}% here.", { target, expected });
                                case 'behind':
                                    return tr("Below the {{target}}% the schedule aims for, so the gaps between reviews may be too long. It expected {{expected}}% here.", { target, expected });
                                case 'on-track':
                                    return tr("Close to the {{target}}% the schedule aims for. It expected {{expected}}% here.", { target, expected });
                                default:
                                    return tr("Too few reviews to tell yet whether that is high or low. The schedule aims for {{target}}%, and expected {{expected}}% here.", { target, expected });
                            }
                        })()}
                    />
                    {/* The band chart is for someone checking the fit, not for
                        someone tuning it: the verdict above already says whether
                        memory is ahead of or behind the schedule. So the chart
                        closes until asked for. */}
                    {status.retention.bins.filter(b => b.n >= BIN_MIN_REVIEWS).length >= 2 && (
                        <Explain summary={tr("The bands, prediction by prediction")} className="mt-3">
                        <div>
                        {/* Why there are three rows and not ten: the bands are
                            fixed (`retentionReport` cuts predictions into ten),
                            and how many get drawn is a fact about the reader's
                            history, not a choice. Without this sentence the
                            count looks arbitrary — which is exactly how it
                            read. */}
                        <p className="max-w-prose text-sm text-slate-500 dark:text-slate-400">
                            {tr("Each row is a band the schedule was equally sure about, drawn once it has {{min}} reviews behind it. The bar is what you recalled; the notch is what it predicted.", { count: BIN_MIN_REVIEWS, min: num(BIN_MIN_REVIEWS) })}
                        </p>
                        <div className="mt-2 grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                            {/* The three columns are named once, at the top: without a
                                header every row had to carry the words "predicted" and
                                "recalled", and the bare count still read as "· 18".
                                The track takes the card's full width: a shorter one
                                stops at no edge the reader can see, so it reads as cut
                                off — and the longer the track, the further apart the
                                fill and the tick can be drawn, which is the point. */}
                            <div className="contents">
                                <span className="text-right">{tr("predicted")}</span>
                                <span />
                                <span>{tr("recalled · reviews")}</span>
                            </div>
                            {status.retention.bins.filter(b => b.n >= BIN_MIN_REVIEWS).map(b => {
                                const predicted = Math.round(b.predicted * 100);
                                const observed = Math.round(b.observed * 100);
                                return (
                                    <div key={b.lo} className="contents">
                                        {/* The BAND, not the mean inside it: "68%" read as a
                                            threshold the schedule had picked, when it is the
                                            average of the 60–70% group. The notch still sits
                                            at the mean — that is what it predicted. */}
                                        <span className="tabular-nums text-right whitespace-nowrap">
                                            {Math.round(b.lo * 100)}–{Math.round(b.hi * 100)}%
                                        </span>
                                        {/* The bar is what the learner actually recalled; the tick is
                                            what the scheduler expected, drawn on the same scale so the
                                            gap is the picture rather than a subtraction. The tick is
                                            held a hair inside the track so a 0% or 100% bin still
                                            draws one. */}
                                        <span
                                            className="relative h-2.5 self-center rounded bg-slate-100 dark:bg-slate-700 overflow-hidden"
                                            role="img"
                                            aria-label={tr("Predicted {{p}}%, recalled {{o}}% over {{n}} reviews", { count: b.n, p: predicted, o: observed, n: b.n })}
                                        >
                                            <span className="absolute inset-y-0 left-0 bg-accent/60" style={{ width: `${observed}%` }} />
                                            <span
                                                className="absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-white ring-1 ring-slate-400/60 dark:bg-slate-300 dark:ring-0"
                                                style={{ left: `${Math.min(99, Math.max(1, predicted))}%` }}
                                            />
                                        </span>
                                        <span className="tabular-nums">{observed}% · {num(b.n)}</span>
                                    </div>
                                );
                            })}
                        </div>
                        </div>
                        </Explain>
                    )}
                </div>
            )}
        </TuningBlock>
    );
}

/**
 * The learner's own BKT rates (how much one attempt teaches, how often a known
 * thing is still missed). Same contract as the spaced-repetition fit: applied
 * only when it beats the defaults on attempts it never saw.
 */
function MasteryTuningPanel({ active }: { active: boolean }) {
    const { t: tr } = useTranslation();
    const num = useNumberFormat();
    const addToast = useStore(s => s.addToast);
    const [status, setStatus] = useState<MasteryModelStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [last, setLast] = useState<BktFitResult | null>(null);
    const load = useCallback(async () => {
        try { setStatus(await api.getMasteryModel()); } catch { /* quiet */ }
    }, []);
    useEffect(() => { if (active) load(); }, [active, load]);

    const optimise = async () => {
        if (busy) return;
        setBusy(true);
        try {
            const r = await api.optimizeMastery();
            setLast(r);
            addToast('success', r.accepted ? tr("Topic progress tuned") : tr("Defaults kept"), r.accepted
                ? tr("Learning rate {{p_T}}, slip {{p_S}} — fitted to your own attempts.", { p_T: r.params.p_T.toFixed(2), p_S: r.params.p_S.toFixed(2) })
                : (r.reason || ''));
            await load();
        } catch (e: any) {
            addToast('error', tr("Could not update topic progress"), e.message);
        } finally {
            setBusy(false);
        }
    };
    const reset = async () => {
        try {
            await api.resetMasteryParams();
            setLast(null);
            await load();
            addToast('success', tr("Back to the default rates"));
        } catch (e: any) {
            addToast('error', tr("Could not reset"), e.message);
        }
    };
    const enough = !!status && status.attempts >= status.minAttempts;
    const fitted = !!status?.params;
    const pct = (n: number) => `${Math.round(n * 100)}%`;
    const fmt = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '—' : n.toFixed(3));

    return (
        <TuningBlock
            title={tr("Topic progress")}
            note={tr("Every answer updates a per-topic estimate of whether you know the topic. Two rates drive it: how much one attempt teaches, and how often you miss something you do know. They start as sensible defaults and can be fitted to your own record of attempts.")}
            actions={<>
                {fitted && (
                    <Button onClick={reset} disabled={busy}>{tr("Reset to defaults")}</Button>
                )}
                <Button variant="primary" onClick={optimise} disabled={!enough} busy={busy}>
                    {tr("Fit to my attempts")}
                </Button>
            </>}
            hint={<span data-testid="bkt-hint">
                {status
                    ? enough
                        ? tr("{{attempts}} attempts available to fit on.", { count: status.attempts, attempts: num(status.attempts) })
                        : tr("Needs {{minAttempts}} recorded attempts — you have {{attempts}}. Keep answering.", { minAttempts: status.minAttempts, attempts: num(status.attempts) })
                    : ''}
            </span>}
            result={last && (
                <p data-testid="bkt-last-result">
                    {last.accepted
                        ? tr("Accepted: held-out loss {{fmt}} → {{fmt2}} over {{valAttempts}} attempts.", { count: last.stats.valAttempts, fmt: fmt(last.stats.valDefault), fmt2: fmt(last.stats.valFitted), valAttempts: last.stats.valAttempts })
                        : tr("Not applied: {{reason}} (held-out loss {{fmt}} vs {{fmt2}}).", { reason: last.reason, fmt: fmt(last.stats.valDefault), fmt2: fmt(last.stats.valFitted) })}
                </p>
            )}
        >
            {/* Shaped exactly like the spaced-repetition card above it: the
                same two questions in the same order, answered the same way —
                what is on record, and whose numbers are running. */}
            <FactStrip>
                <Fact
                    label={tr("Attempts recorded")}
                    testId="bkt-attempts"
                    value={status ? tr("{{attempts}} on {{topics}} topics", { attempts: num(status.attempts), topics: num(status.topics) }) : '…'}
                />
                {/* "learn 10% per attempt, slip 10%" names the two BKT rates
                    and says nothing about what they DO. Spelled out, they are
                    two sentences a learner can check against their own
                    experience. */}
                <Fact
                    label={tr("Rates in use")}
                    testId="bkt-params-state"
                    value={status ? (fitted ? tr("Fitted to you") : tr("Standard rates")) : "…"}
                    sub={status
                        ? tr("one answer moves a topic about {{pct}} of the way, and {{pct2}} of answers go wrong on a topic you do know", {
                            pct: pct(fitted ? status.params!.p_T : status.defaults.p_T),
                            pct2: pct(fitted ? status.params!.p_S : status.defaults.p_S),
                        })
                        : undefined}
                />
            </FactStrip>
        </TuningBlock>
    );
}

/**
 * One block of the "Fit the engine to your history" card: its name, what it
 * is, the measured facts in a hairline frame, then the action with its
 * precondition on the left — the same foot the activity log has, so the two
 * collapsed diagnostic groups in Settings read the same way.
 *
 * The facts are FRAMED, not carded: the section is already the card, and a
 * white card on a white card is a box in a box that the eye has to decode.
 */
function TuningBlock({ title, note, actions, hint, result, children }: {
    title: React.ReactNode;
    note: React.ReactNode;
    actions: React.ReactNode;
    hint: React.ReactNode;
    result?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <section className="px-4 py-4">
            <h3 className="font-medium text-slate-900 dark:text-white">{title}</h3>
            <SettingNote className="mt-1">{note}</SettingNote>
            <div className="mt-3 rounded-lg border border-slate-200 divide-y divide-slate-100 dark:border-slate-700 dark:divide-slate-700/60">
                {children}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                <p className="min-w-0 flex-1 basis-48 text-sm text-slate-500 dark:text-slate-400">{hint}</p>
                <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>
            </div>
            {result && <div className="mt-2 text-sm text-slate-600 dark:text-slate-300">{result}</div>}
        </section>
    );
}

/**
 * One measured fact: what it is, then what it says, then the fine print.
 *
 * A label pushed to one end of a row and its value to the other stops reading
 * as a PAIR the moment two of them sit side by side: the value ends up nearer
 * the next label than its own, and the row is four things in no stated order
 * ("630 on 495 cards   Parameters in use" — what to what?). Stacking binds the
 * two by proximity at every width, which is also the only arrangement that
 * survives the ~390px workspace panel. The qualifier goes on its own line
 * underneath rather than trailing the value behind a "·", so the headline
 * number is the thing the eye lands on.
 */
function Fact({ label, value, sub, testId }: {
    label: React.ReactNode;
    value: React.ReactNode;
    sub?: React.ReactNode;
    testId?: string;
}) {
    return (
        <div className="min-w-0">
            <div className="text-sm text-slate-500 dark:text-slate-400">{label}</div>
            <div
                className="mt-0.5 text-base font-medium text-slate-900 dark:text-white tabular-nums"
                data-testid={testId}
            >
                {value}
            </div>
            {/* A sentence gets a measure; a number does not. `max-w-prose` is a
                no-op in the narrow panel and stops the explanations running the
                full width of a 1280px card, where a line is too long to track
                back to its own start. */}
            {sub && <div className="mt-0.5 max-w-prose text-sm text-slate-500 dark:text-slate-400 tabular-nums">{sub}</div>}
        </div>
    );
}

/** The strip of facts at the top of a tuning card. Columns come from the
 *  CONTAINER's width (auto-fit), never a breakpoint — this panel is as likely
 *  to be read at 390px as at 900px. */
function FactStrip({ children }: { children: React.ReactNode }) {
    return (
        <div className="px-4 py-2.5 grid gap-x-8 gap-y-3 grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]">
            {children}
        </div>
    );
}

/**
 * The dot-and-word the app says "connected" with. One shape for the model
 * endpoint and for each hosted search key — the second hand-written copy of a
 * control shape becomes a component, and a status dot is a control shape.
 *
 * `idle` is the state that matters: a key saved in an earlier session has never
 * been asked anything, and a grey "Not checked" says that honestly where a
 * green dot would be a guess.
 */
function StatusDot({ tone, title, children }: {
    tone: 'ok' | 'bad' | 'busy' | 'idle';
    title?: string;
    children: React.ReactNode;
}) {
    const text = tone === 'ok' ? 'text-emerald-700 dark:text-emerald-400'
        : tone === 'bad' ? 'text-red-700 dark:text-red-400'
            : tone === 'busy' ? 'text-amber-700 dark:text-amber-400'
                : 'text-slate-500 dark:text-slate-400';
    const dot = tone === 'ok' ? 'bg-emerald-500'
        : tone === 'bad' ? 'bg-red-500'
            : tone === 'busy' ? 'bg-amber-500 animate-pulse'
                : 'bg-slate-300 dark:bg-slate-600';
    return (
        <span className={`flex items-center gap-1.5 text-xs font-medium ${text}`} title={title}>
            <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
            {children}
        </span>
    );
}

/** A figure the endpoint does not publish. A dash reads as "nothing here" to
 *  anyone looking at the column and as nothing at all to a screen reader, so the
 *  words ride along out of sight. */
function NotReported({ label }: { label: string }) {
    return (
        <>
            <span className="sr-only">{label}</span>
            {/* The muted pair that still clears AA on both themes: slate-400 on
                white is 2.56:1 and slate-500 on slate-900 is 3.75:1, which is
                what the contrast audit fails. */}
            <span aria-hidden="true" className="text-slate-500 dark:text-slate-400">—</span>
        </>
    );
}

function SectionHeader({ title, icon: Icon, children }: {
    title: React.ReactNode;
    icon?: LucideIcon;
    children?: React.ReactNode;
}) {
    // The same caption `SettingGroup` draws, so a page built from both reads as
    // one page: a quiet label for the card under it, not a chapter heading. It
    // was `text-lg` semibold in near-black, which on a phone made every section
    // announce itself as loudly as the page's own title.
    return (
        <>
            <h2 className={`${GROUP_CAPTION} flex items-center gap-2`}>
                {Icon && <Icon className="w-4 h-4 text-accent-fg" />}{title}
            </h2>
            {/* The section's paragraph is READ, not demoted. It used to collapse
                behind an unnamed "More" above twenty words, which is how the
                Search links tab came to show two identical chevrons 150px
                apart, the second one inside the card the first was about. */}
            {children && (
                <div className="mb-2 px-1">
                    <SettingNote>{children}</SettingNote>
                </div>
            )}
        </>
    );
}

/** The card every section's controls sit on. `flush` drops the padding so the
 *  card can hold its own divided rows. */
function Panel({ flush = false, className = '', children }: {
    flush?: boolean;
    className?: string;
    children: React.ReactNode;
}) {
    return (
        <div className={`bg-white dark:bg-slate-800 rounded-xl shadow-sm ${flush ? '' : 'p-4'} ${className}`}>
            {children}
        </div>
    );
}

/**
 * The theme pair and the accent picker, as one reusable set. Extracted from the
 * Appearance section so another surface can offer the same controls without a
 * second hand-written copy — one component per control, which is the rule that
 * produced ui/Field and friends. All read their answer from the store, so none
 * carries state of its own.
 *
 * THE FOUR NAMED THEMES ARE GONE. There are two cards, not four, and they are
 * the two answers to the only question a card can ask — light or dark. What
 * COLOUR the app is is the tint below them, a value like the accent rather than
 * a name somebody has to have been told, and the two cards redraw in it as it
 * is chosen. `Warm` and `Black` were the two tints anybody actually wanted, and
 * they are still one press away; every tint between them was unreachable.
 *
 * The previews must be literal hex (not `bg-slate-*`) because one of the two
 * always shows a mode OTHER than the one currently applied, so it cannot ride
 * the live CSS variables. They are generated from the same function the app
 * itself is painted by (`themeRamp`) rather than transcribed, which is what
 * makes a preview a preview instead of a picture of one.
 */
const THEME_META: { id: Theme; label: string; icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }> }[] = [
    { id: 'light', label: k("Light"), icon: Sun },
    { id: 'dark', label: k("Dark"), icon: Moon },
];

/** Which rung each part of the preview is drawn from. `page` is the CANVAS
 *  (slate-100 / slate-900), not the inset one: a canvas and an inset sharing
 *  one value in light mode is exactly the collision the surface ladder in
 *  index.css exists to prevent. */
const PREVIEW_RUNGS = {
    light: { page: '100', surface: 'white', border: '200', text: '900', muted: '500', code: '100' },
    dark: { page: '900', surface: '800', border: '700', text: '50', muted: '400', code: '700' },
} as const;

function themePreview(mode: Theme, tint: string) {
    const ramp = themeRamp(mode, tint);
    const r = PREVIEW_RUNGS[mode];
    return {
        page: ramp[r.page], surface: ramp[r.surface], border: ramp[r.border],
        text: ramp[r.text], muted: ramp[r.muted], code: ramp[r.code],
    };
}

/** The two mode cards. The whole card — preview AND name row — sits on that
 *  mode's own palette at the tint currently chosen, so each box reads as what
 *  pressing it would give you. */
function ThemeCards() {
    const { t: tr } = useTranslation();
    const theme = useStore(s => s.theme);
    const themeTint = useStore(s => s.themeTint);
    const setTheme = useStore(s => s.setTheme);
    return (
        <div className="grid grid-cols-2 gap-3">
            {THEME_META.map(({ id, label, icon: Icon }) => {
                const p = themePreview(id, themeTint);
                const selected = theme === id;
                return (
                    <button
                        key={id}
                        type="button"
                        onClick={() => setTheme(id)}
                        aria-pressed={selected}
                        aria-label={tr("{{label}} theme", { label: tr(label) })}
                        // The selected card is always the CURRENT mode's, so its mark
                        // is the accent as solved for this page (`accent-fg`), never
                        // the solid: the solid is only ever darkened, and a near-black
                        // accent drew the Dark card's border and tick black on black.
                        className={`text-left rounded-xl border-2 overflow-hidden transition ${selected
                            ? 'border-accent-fg ring-2 ring-accent-fg/30'
                            : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'}`}
                    >
                        {/* Sized for a card that spans half the row: at 10px
                            type a card that wide is mostly empty paper. */}
                        <div className="p-3 space-y-2.5" style={{ backgroundColor: p.page }}>
                            {/* Rendered example — the same content in both, styled per mode. */}
                            <div className="rounded-lg border p-3 space-y-2" style={{ backgroundColor: p.surface, borderColor: p.border }}>
                                <div className="flex items-center gap-2">
                                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: 'rgb(var(--accent-rgb))' }} />
                                    <span className="text-sm font-semibold leading-none" style={{ color: p.text }}>{tr("Cell biology")}</span>
                                </div>
                                <p className="text-xs leading-snug" style={{ color: p.muted }}>{tr("How lessons & notes look.")}</p>
                                <div className="text-xs leading-snug" style={{ color: p.text }}>
                                    {tr("• Mitochondria make")}{' '}
                                    <span className="px-1 py-px rounded font-mono" style={{ backgroundColor: p.code, color: p.text }}>{tr("ATP")}</span>
                                </div>
                                <span className="inline-block text-[11px] font-medium px-2 py-0.5 rounded-full text-white" style={{ backgroundColor: 'rgb(var(--accent-rgb))' }}>{tr("Mastered")}</span>
                            </div>
                            {/* Name row — themed to match its card. */}
                            <div className="flex items-center justify-between px-0.5">
                                <span className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: p.text }}>
                                    <Icon className="w-4 h-4" style={{ color: p.muted }} /> {tr(label)}
                                </span>
                                {selected && <Check className="w-4 h-4 text-accent-fg" />}
                            </div>
                        </div>
                    </button>
                );
            })}
        </div>
    );
}

/**
 * The tint palette alone; the row it sits in supplies its name and its line.
 *
 * THE CHIPS ARE DRESSED FOR THE MODE YOU ARE IN. The sixteen tints are stored
 * as pastels because a pastel is the LIGHT register — they are generated at one
 * lightness for exactly that reason (`THEME_TINTS`) — so in light mode the chip
 * is the value itself and always has been. In dark mode it was too, and there a
 * row of pastels offers sixteen colours the app will never show you: the same
 * rose is a deep maroon.
 *
 * So a dark chip is that tint's own `700` — the rung the app paints its panels
 * and borders at, which is a surface a dark page really does carry. NOT the
 * page itself, and the reason is measured: the sixteen page colours in dark
 * mode sit 5 RGB units apart at their closest (`temp/tint-swatch-probe.mjs`,
 * Rose against Red), so a palette of pages is sixteen near-identical squares —
 * the one thing a picker may not be. What the PAGE looks like is the question
 * the two mode cards directly above answer, in full, for the tint chosen.
 */
function ThemeTintField() {
    const { t: tr } = useTranslation();
    const theme = useStore(s => s.theme);
    const themeTint = useStore(s => s.themeTint);
    const setThemeTint = useStore(s => s.setThemeTint);
    // `tintSwatch` (themeRamp.ts) — and the hue-less pair, Ink and Paper, are
    // painted at the LIGHT panel rung in light mode: their stored value is the
    // depth end, and a true-black chip for a page that comes out light grey
    // was "not that black" (2026-09-23).
    const pageOf = useCallback((hex: string) => tintSwatch(theme, hex), [theme]);
    return (
        <ColorField
            value={themeTint}
            onChange={setThemeTint}
            colors={THEME_TINTS}
            swatch={pageOf}
            hint={tr("White is no tint at all. Hex, rgb() or hsl().")}
        />
    );
}

/** The accent picker row: the label, its one-line help, and the one ColorField. */
/** The accent palette alone — its name and its one line come from the
 *  `SettingRow` that holds it, like every other setting on the page. */
function AccentField() {
    const accentColor = useStore(s => s.accentColor);
    const setAccentColor = useStore(s => s.setAccentColor);
    return <ColorField value={accentColor} onChange={setAccentColor} colors={ACCENT_COLORS} />;
}

/** The interface-language select alone; the row supplies the label it points at. */
function LanguageRow({ id = 'ui-language' }: { id?: string }) {
    const { t: tr } = useTranslation();
    const uiLanguage = useStore(s => s.uiLanguage);
    const setUiLanguage = useStore(s => s.setUiLanguage);
    return (
        <Select
            id={id}
            fit
            value={uiLanguage}
            onChange={e => void setUiLanguage(e.target.value)}
        >
            <option value="auto">{tr("Same as the browser")}</option>
            {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
        </Select>
    );
}

/** The three ways a finished topic can be checked, as radio cards. Shared by
 *  the Learning tab (with the numbers behind a disclosure below) and the Quick
 *  tab (which shows only the choice itself). */
function ProvingModeCards({ gateMode, onChange }: {
    gateMode: 'off' | 'advisory' | 'enforced';
    onChange: (mode: 'off' | 'advisory' | 'enforced') => void;
}) {
    const { t: tr } = useTranslation();
    return (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {([
                { value: 'off', label: tr("Just track"), desc: tr("Mark topics done. Nothing is checked.") },
                { value: 'advisory', label: tr("Ask me"), desc: tr("Offers the quiz. You can always mark a topic done anyway."), tag: tr("Recommended") },
                { value: 'enforced', label: tr("Require proof"), desc: tr("A topic counts as done only once you pass the quiz.") },
            ] as const).map(opt => (
                <label
                    key={opt.value}
                    className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition ${gateMode === opt.value
                        ? 'border-accent bg-accent/10'
                        : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700/40'
                        }`}
                >
                    <Radio
                        name="gate_mode"
                        value={String(opt.value)}
                        className="mt-0.5"
                        checked={gateMode === opt.value}
                        onChange={() => onChange(opt.value)}
                    />
                    <span className="min-w-0">
                        <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">
                            {opt.label}
                            {'tag' in opt && opt.tag && (
                                <span className="ml-2 align-middle text-xs font-medium px-1.5 py-0.5 rounded bg-accent/10 text-accent-fg">{opt.tag}</span>
                            )}
                        </span>
                        <span className="block text-sm text-slate-500 dark:text-slate-400">{opt.desc}</span>
                    </span>
                </label>
            ))}
        </div>
    );
}

/**
 * Long prose steps aside here: one line of what a thing decides on the
 * surface, the reasoning behind a disclosure — but only where the reasoning is
 * genuinely optional reading, and only behind a NAME. `Explain` is that one
 * shape, shared with every other panel (see ui/Disclosure.tsx). This file used
 * to carry its own bordered version of it plus two hand-written near-copies in
 * the AI tab that differed by a tint and a missing marker reset.
 */

/**
 * HOW HARD THE MODEL THINKS — a slider, because the answer is a QUANTITY.
 *
 * It was a four-way `SegmentedControl`, and four segments do not fit across a
 * phone: "Automatic / Brief / Balanced" takes the first row and "Thorough"
 * sits alone on a second (measured at 412px), which reads as two unrelated
 * controls rather than one scale. A slider is width-flexible by
 * construction, so it is one row at every width this app is read at, and it
 * says the thing the segments could not: these four are ORDERED, and moving
 * right costs more time and more money.
 *
 * Each stop's sentence is shown under the slider instead of hidden in a
 * `title` tooltip. A phone has no hover, so all four of those explanations
 * were unreachable on the device most of this page is read on.
 *
 * `Automatic` is stop zero because it is the least the app asks for, not
 * because it is the least thinking: it means "send no budget at all", which
 * for a lesson resolves to brief and in chat leaves the model's own default
 * alone. See `effortFor` in server/ai.js.
 */
const THINKING_STOPS = [
    { value: '', label: k("Automatic"), detail: k("Brief for lessons, questions and visuals, where nobody reads the reasoning; whatever the model does by default in chat, where you can.") },
    { value: 'low', label: k("Brief"), detail: k("The fastest and cheapest answers. Good for chat and summaries.") },
    { value: 'medium', label: k("Balanced"), detail: k("A middle budget.") },
    { value: 'high', label: k("Thorough"), detail: k("For writing curricula and checking answer keys, where being right matters more than being quick.") },
] as const;

function ThinkingSlider({ value, onChange }: { value: string; onChange: (next: string) => void }) {
    const { t: tr } = useTranslation();
    const label = tr("How much should the model think before answering?");
    const at = Math.max(0, THINKING_STOPS.findIndex(s => s.value === value));
    const stop = THINKING_STOPS[at];
    return (
        <Field
            label={label}
            hint={tr("Thinking models write out their reasoning before they answer, often several times the length of the answer itself. In chat you can open it under \"Reasoning\"; for lessons, questions and visuals it is written, paid for and thrown away — and a model that spends its whole budget thinking returns no lesson at all, which is why Automatic asks those jobs for brief. Ask for more when lessons arrive thin. Endpoints that cannot do this ignore it.")}
        >
            {id => (
                <>
                    <Slider
                        id={id}
                        label={label}
                        min={0}
                        max={THINKING_STOPS.length - 1}
                        value={at}
                        onChange={next => onChange(THINKING_STOPS[next]?.value ?? '')}
                        valueText={tr(stop.label)}
                    />
                    {/* The ends align with the ends of the track and the two in
                        the middle land close enough to their stops; a grid of
                        four equal columns would centre "Automatic" a third of
                        the way in, away from the stop it names. */}
                    <div className="mt-1 flex justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                        {THINKING_STOPS.map((s, i) => (
                            <span key={s.value || 'auto'} className={i === at ? 'font-semibold text-accent-fg' : ''}>
                                {tr(s.label)}
                            </span>
                        ))}
                    </div>
                    <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{tr(stop.detail)}</p>
                </>
            )}
        </Field>
    );
}

/**
 * One row of the Model-jobs panel: a background job that uses a model. It is
 * the shared `ExpandableSection` in its `row` variant and nothing else — the
 * open tint, the accent rule, the narrow-screen handling of the state line and
 * the indented body all live there now, because "Fit the engine to your
 * history", "Records & diagnostics" and "Background, sign-in and quitting"
 * were three hand-written copies of this same shape that each got one detail
 * different.
 *
 * `aside` is the read-only answer on the summary line — each body carries the
 * control that sets it — so a closed row still says whether the job is on.
 */
function ModelJobRow({ icon, title, desc, aside, children }: {
    icon: LucideIcon;
    title: React.ReactNode;
    desc: React.ReactNode;
    aside?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <ExpandableSection variant="row" icon={icon} title={title} desc={desc} aside={aside}>
            {children}
        </ExpandableSection>
    );
}

export default function Settings() {
    const { t: tr } = useTranslation();
    const num = useNumberFormat();
    const openAnkiImport = useStore(s => s.openAnkiImport);
    // Theme, accent and UI language come from the extracted components above
    // (ThemeCards / AccentField / LanguageRow) — General and Quick share them.
    const uiScale = useStore(s => s.uiScale);
    const setUiScale = useStore(s => s.setUiScale);
    const weekStartDay = useStore(s => s.weekStartDay);
    const setWeekStartDay = useStore(s => s.setWeekStartDay);
    const numberFormat = useStore(s => s.numberFormat);
    const setNumberFormat = useStore(s => s.setNumberFormat);
    // A desktop install (the launcher) exposes where its data lives and how it
    // stops; every other deployment answers `desktop:false` and the panel is absent.
    const { status: desktop, refresh: refreshDesktop } = useDesktop();
    const [desktopBusy, setDesktopBusy] = useState(false);
    // Quit has been pressed and the window is on its way out: the screen waits
    // for the server to be gone before it says so, and hands the app back if it
    // is still serving.
    const [quitting, setQuitting] = useState(false);
    // What the login-item switch was last asked for. The Windows shortcut is
    // written by a spawned PowerShell, so the status read that follows the
    // request can still show the old answer — and a switch that flicks back for
    // half a second reads as a failure. Cleared once the status agrees.
    const [loginAsked, setLoginAsked] = useState<boolean | null>(null);
    const startsAtLogin = loginAsked ?? !!desktop?.startAtLogin;
    useEffect(() => {
        if (loginAsked !== null && desktop?.startAtLogin === loginAsked) setLoginAsked(null);
    }, [desktop?.startAtLogin, loginAsked]);
    const addToast = useStore(s => s.addToast);
    const projects = useStore(s => s.projects);
    const loadProjects = useStore(s => s.loadProjects);
    const showConfirm = useStore(s => s.showConfirm);
    // The quit screen's way back: it is still serving, so there is an app to
    // hand back to. Declared here rather than beside `quitting` because it
    // needs the toast, and stable because the screen watches it.
    const quitFailed = useCallback(() => {
        setQuitting(false);
        addToast('error', tr("Could not stop the app"));
    }, [addToast, tr]);
    const hasKeyboard = usePhysicalKeyboard();

    // Active settings group (see SETTINGS_TABS). Sections stay mounted and are
    // toggled via `hidden` so autosave effects and connection state survive
    // switching groups.
    const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
        const h = window.location.hash.replace('#', '');
        return SETTINGS_TABS.some(t => t.id === h) ? (h as SettingsTab) : 'general';
    });
    const selectTab = (t: SettingsTab) => {
        setActiveTab(t);
        try { window.history.replaceState(null, '', `#${t}`); } catch { /* non-fatal */ }
    };
    // A LATER arrival at /settings#<tab> must land on that tab too. The state
    // above only reads the hash once, at mount, which is right for a cold load
    // and wrong for everything that navigates here from inside the app: a task
    // dock chip for a background job sends the reader to Settings → AI & Models,
    // and from any other settings tab that was a navigation to the page they
    // were already on, which changed nothing at all.
    //
    // Keyed on the navigation, not on the hash string: `selectTab` rewrites the
    // URL with `replaceState`, which the router never sees, so its remembered
    // hash drifts from the real one and the same destination twice in a row
    // would otherwise be read as no change.
    const routerLocation = useLocation();
    useEffect(() => {
        const h = routerLocation.hash.replace('#', '');
        if (SETTINGS_TABS.some(t => t.id === h)) setActiveTab(h as SettingsTab);
    }, [routerLocation.key]);  // eslint-disable-line react-hooks/exhaustive-deps

    // AI Settings
    const [provider, setProvider] = useState<AIProvider>('ollama');
    const [ollamaUrl, setOllamaUrl] = useState('http://127.0.0.1:11434');
    // OpenAI-compatible provider (llama-swap / llama.cpp / LM Studio / OpenRouter / OpenAI)
    const [apiBaseUrl, setApiBaseUrl] = useState('http://127.0.0.1:8888/v1');
    const [apiKey, setApiKey] = useState('');
    // Write-only from here on: the settings dump no longer carries the key back
    // to any client, so "is one saved" comes from /api/ai/status instead.
    const [apiKeySaved, setApiKeySaved] = useState(false);
    const [openaiModel, setOpenaiModel] = useState('');

    // How hard the model thinks, and who serves it. Both ship empty — "whatever
    // the endpoint would do anyway" — so an install that never opens this panel
    // behaves exactly as it did before these existed.
    const [reasoningEffort, setReasoningEffort] = useState('');
    const [providerSort, setProviderSort] = useState('');
    const [providerOrder, setProviderOrder] = useState<string[]>([]);
    // null = not asked yet. The list costs a round trip to the endpoint, so it
    // is fetched when the panel is opened, never when Settings is.
    const [servingEndpoints, setServingEndpoints] = useState<ServingEndpoint[] | null>(null);
    const [endpointsLoading, setEndpointsLoading] = useState(false);
    const savedApiKeyRef = useRef('');
    const [searxngUrl, setSearxngUrl] = useState('');
    // The hosted search backends: one write-only key each. The server reports
    // only whether a key is saved, never its value.
    const [searchKeyInputs, setSearchKeyInputs] = useState<Record<SearchProvider, string>>({ tavily: '', brave: '', jina: '' });
    const [searchKeySaved, setSearchKeySaved] = useState<Record<SearchProvider, boolean>>({ tavily: false, brave: false, jina: false });
    const savedSearchKeysRef = useRef<Record<SearchProvider, string>>({ tavily: '', brave: '', jina: '' });
    // Whether each key WORKS, which is a different question from whether one is
    // saved and can only be answered by spending a search. `unknown` is the
    // honest state for a key that was saved in an earlier session and has not
    // been asked anything since — the panel says "Not checked", never green.
    const [searchKeyStatus, setSearchKeyStatus] = useState<Record<SearchProvider, { state: 'none' | 'unknown' | 'checking' | 'ok' | 'failed'; detail?: string }>>(
        { tavily: { state: 'none' }, brave: { state: 'none' }, jina: { state: 'none' } },
    );
    const [selectedModel, setSelectedModel] = useState(() => {
        try {
            // No built-in default: `server/ai.js` deliberately has none either, and
            // seeding a model name here is what left real installs pointing at a
            // model that was never pulled ("model 'llama3.2' not found" on every
            // AI call). Empty means "not chosen yet", which the UI can say honestly.
            return localStorage.getItem('study-app-selected-model') || '';
        } catch {
            return '';
        }
    });
    const [aiEnabled, setAiEnabled] = useState(true);
    const [models, setModels] = useState<OllamaModel[]>([]);
    // Finding a model in the list is `ModelPicker`'s problem now — filter, sort
    // and the free-typed id all live there, so every place that picks a model
    // gets them, not just this one.
    const [modelsLoading, setModelsLoading] = useState(false);
    const [connectionStatus, setConnectionStatus] = useState<'checking' | 'connected' | 'disconnected' | null>(null);
    const [connectionError, setConnectionError] = useState<string | null>(null);
    // Tracks whether the backend settings have been fetched at least once.
    // The model validation effect waits on this so it never overrides the
    // user's saved selection with a default before settings are loaded.
    const [settingsLoaded, setSettingsLoaded] = useState(false);

    // Mastery & gating
    const [gateMode, setGateMode] = useState<'off' | 'advisory' | 'enforced'>('advisory');
    // Whether the model is offered the two hardest visual kinds (p5 simulations,
    // interactive widgets). 'auto' reads the size out of the model name, which
    // fails for hosted/aliased models — hence the manual override.
    // Whether project creation curates web resources for every leaf topic — by
    // far its most expensive phase (a search + a model call per topic).
    const [findResources, setFindResources] = useState(true);
    // Whether an ANSWER may reach the web, and who decides each time. Off by
    // default and always droppable per question — the only thing in the app
    // that sends what the learner typed.
    const [webSearch, setWebSearch] = useState(false);
    const [recoveryMode, setRecoveryMode] = useState<RecoveryMode>('auto');
    // Optional dedicated vision model for PDF recovery ('' = use the chat model).
    const [recoveryVisionModel, setRecoveryVisionModel] = useState('');
    // Optional dedicated model for naming atlas regions ('' = use the chat model).
    const [atlasNamingModel, setAtlasNamingModel] = useState('');
    const [masteryThreshold, setMasteryThreshold] = useState('85');
    const [checkPass, setCheckPass] = useState('80');
    const [checkSize, setCheckSize] = useState('10');
    const [decayDays, setDecayDays] = useState('14');

    // About: identity, the update check, and the bug-report door. State is local
    // to the panel; the facts themselves live in the store so the banner and the
    // report builder read the same answer.
    const appVersion = useStore(st => st.appVersion);
    // The store's mirrored AI facts, not this panel's own draft state: a report
    // must describe what the app is RUNNING, not an unsaved edit in a form.
    const reportAiProvider = useStore(st => st.aiProvider);
    const reportAiModel = useStore(st => st.aiModel);
    const updateStatus = useStore(st => st.updateStatus);
    const checkForUpdates = useStore(st => st.checkForUpdates);
    const setAutoUpdateCheck = useStore(st => st.setAutoUpdateCheck);
    const [checkingUpdate, setCheckingUpdate] = useState(false);
    const [copiedVersion, setCopiedVersion] = useState(false);
    // "Your data" row: the path is behind a disclosure, and the copy button
    // confirms itself the same way the version's copy does.
    const [copiedPath, setCopiedPath] = useState(false);
    const [reportOpen, setReportOpen] = useState(false);

    // About You (learner profile). Injected into the AI context of every project
    // (server/ai.js buildNodeContext). Blurred while unfocused so it can't be
    // shoulder-surfed; autosaved on blur.
    const [userProfile, setUserProfile] = useState('');
    const [profileFocused, setProfileFocused] = useState(false);
    const savedProfileRef = useRef('');

    // Model install
    const [newModelName, setNewModelName] = useState('');
    const [installing, setInstalling] = useState(false);
    const [installProgress, setInstallProgress] = useState<PullProgress | null>(null);
    const [installError, setInstallError] = useState<string | null>(null);
    const [installingModelId, setInstallingModelId] = useState<string | null>(null);

    // The model lists are long; collapse them by default so the Settings page
    // isn't dominated by them.

    // Import / Export
    const [importFile, setImportFile] = useState<File | null>(null);
    const [importing, setImporting] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [selectedExportProject, setSelectedExportProject] = useState<number | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Refs for autosave
    const isFirstRender = useRef(true);
    const prevOllamaUrl = useRef('');
    const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const prevApiBaseUrl = useRef('');
    const apiUrlTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const openaiModelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const searxngInputRef = useRef<HTMLInputElement>(null);
    const searxngSkipBlurRef = useRef(false);

    // Semantic search (Vault embeddings)
    const [embStatus, setEmbStatus] = useState<import('../types').EmbeddingStatus | null>(null);
    const [embModelInput, setEmbModelInput] = useState('');
    const [embReindexing, setEmbReindexing] = useState(false);

    // Card-image descriptions. Polled while a sweep runs — it is a background
    // chain with no stream of its own, and a progress bar that only moves on a
    // reload is worse than no progress bar.
    const [mediaStats, setMediaStats] = useState<import('../types').MediaDescriptionStatus | null>(null);
    const loadMediaStats = async () => {
        try { setMediaStats(await api.getMediaDescriptionStatus()); }
        catch { /* older backend — the section simply shows nothing */ }
    };
    useEffect(() => {
        if (!mediaStats?.running) return;
        const t = setInterval(loadMediaStats, 2000);
        return () => clearInterval(t);
    }, [mediaStats?.running]);

    const loadEmbStatus = async (opts: { force?: boolean; probe?: boolean } = {}) => {
        try {
            const s = await api.getEmbeddingStatus(opts);
            setEmbStatus(s);
            setEmbModelInput(s.config.model);
        } catch (e) { /* backend older / offline — section just shows nothing */ }
    };

    // Initial load
    //
    // The embedding status is asked for TWICE on purpose. Its probe is a real
    // request to the model server — 1.7 s on this machine, because opening
    // Settings can make llama-swap swap a model in — and it was the first thing
    // the screen waited on, so the whole page arrived a second and a half late
    // for one line of text. The first call skips the probe and paints the
    // config and counts immediately; the second fills the probe in behind it.
    useEffect(() => {
        loadAISettings();
        loadEmbStatus({ probe: false }).then(() => loadEmbStatus());
        loadMediaStats();
    }, []);

    useEffect(() => {
        if (projects.length > 0 && !selectedExportProject) {
            setSelectedExportProject(projects[0].id);
        }
    }, [projects, selectedExportProject]);

    // Autosave: AI enabled toggle

    useEffect(() => {
        if (isFirstRender.current) return;
        api.setSetting('ai_enabled', String(aiEnabled)).catch(e => {
            console.error('Autosave ai_enabled failed:', e);
        });
    }, [aiEnabled]);

    // Autosave: selected model

    useEffect(() => {
        if (isFirstRender.current) return;
        try { localStorage.setItem('study-app-selected-model', selectedModel); } catch { }
        api.setSetting('ai_model', selectedModel).catch(e => {
            console.error('Autosave ai_model failed:', e);
        });
    }, [selectedModel]);

    // Provider switch: save immediately + reconnect (each provider keeps its
    // own saved model, so flipping back and forth is lossless).
    const handleProviderChange = async (next: AIProvider) => {
        if (next === provider) return;
        setProvider(next);
        setModels([]);
        try {
            await api.setSetting('ai_provider', next);
            handleCheckConnection();
            // In 'auto' embedding mode the probe target follows the chat
            // provider, so the semantic-search panel must re-probe too.
            loadEmbStatus({ force: true });
        } catch (e) {
            console.error('Autosave ai_provider failed:', e);
        }
    };

    // Autosave: OpenAI-compatible base URL (debounced + reconnect)

    useEffect(() => {
        if (isFirstRender.current) return;
        if (apiUrlTimerRef.current) clearTimeout(apiUrlTimerRef.current);
        apiUrlTimerRef.current = setTimeout(async () => {
            try {
                await api.setSetting('ai_openai_base_url', apiBaseUrl);
                if (prevApiBaseUrl.current !== apiBaseUrl) {
                    prevApiBaseUrl.current = apiBaseUrl;
                    if (provider === 'openai') handleCheckConnection();
                }
            } catch (e) {
                console.error('Autosave ai_openai_base_url failed:', e);
            }
        }, 800);
        return () => {
            if (apiUrlTimerRef.current) clearTimeout(apiUrlTimerRef.current);
        };
    }, [apiBaseUrl]);

    // Autosave: OpenAI-compatible model (debounced — it's free-typed for
    // providers like OpenRouter whose catalogue is too big to list)

    useEffect(() => {
        if (isFirstRender.current) return;
        if (openaiModelTimerRef.current) clearTimeout(openaiModelTimerRef.current);
        openaiModelTimerRef.current = setTimeout(() => {
            api.setSetting('ai_openai_model', openaiModel).catch(e => {
                console.error('Autosave ai_openai_model failed:', e);
            });
        }, 600);
        return () => {
            if (openaiModelTimerRef.current) clearTimeout(openaiModelTimerRef.current);
        };
    }, [openaiModel]);

    // Routing: saved on the press, not debounced — these are clicks, and a
    // learner who changes one and closes Settings has already changed it.

    // A slider drag writes once per stop; chained, the writes land in order and
    // the last stop is what the server keeps.
    const effortWritesRef = useRef<Promise<unknown>>(Promise.resolve());
    const chooseReasoningEffort = (value: string) => {
        setReasoningEffort(value);
        effortWritesRef.current = effortWritesRef.current
            .then(() => api.setSetting('ai_reasoning_effort', value))
            .catch(e => console.error('Saving ai_reasoning_effort failed:', e));
    };

    const chooseProviderSort = (value: string) => {
        setProviderSort(value);
        api.setSetting('ai_provider_sort', value).catch(e => console.error('Saving ai_provider_sort failed:', e));
    };

    // Ticking a provider APPENDS it, so the order on screen is the order the
    // request asks for and the learner built it by clicking in that order.
    const toggleProvider = (slug: string) => {
        const next = providerOrder.includes(slug)
            ? providerOrder.filter(s => s !== slug)
            : [...providerOrder, slug];
        setProviderOrder(next);
        api.setSetting('ai_provider_order', JSON.stringify(next)).catch(e => console.error('Saving ai_provider_order failed:', e));
    };

    const loadServingEndpoints = async () => {
        if (endpointsLoading) return;
        setEndpointsLoading(true);
        try {
            const result = await api.getServingEndpoints();
            setServingEndpoints(result.available ? result.endpoints : []);
        } catch {
            setServingEndpoints([]);   // an endpoint that will not say is the same as one with nothing to say
        } finally {
            setEndpointsLoading(false);
        }
    };

    // API key: autosave on blur (only when changed)

    const handleApiKeyBlur = async () => {
        // An empty field blurring out is the common case (tabbing through) and
        // would otherwise WIPE the stored key — clearing is the Clear button's
        // one deliberate job.
        if (!apiKey || apiKey === savedApiKeyRef.current) return;
        try {
            await api.setAIKey(apiKey);
            savedApiKeyRef.current = apiKey;
            setApiKeySaved(true);
            addToast('success', tr("API key saved"));
            if (provider === 'openai') handleCheckConnection();
        } catch (e: any) {
            addToast('error', tr("Failed to save API key"), e?.message);
        }
    };

    // The visual-feedback log: how many drawings the learner has reported, and
    // how big the file is. Loaded when the Data tab is looked at, not at mount —
    // it is a filesystem read for a panel most sessions never open.
    const [visualFeedback, setVisualFeedback] = useState<{ count: number; bytes: number; path: string; lastAt: string | null } | null>(null);
    useEffect(() => {
        if (activeTab !== 'data') return;
        api.visualFeedbackSummary().then(setVisualFeedback).catch(() => { });
    }, [activeTab]);

    /** Remove the stored provider key and say so. See the Clear button. */
    const clearApiKey = async () => {
        setApiKey('');
        try {
            await api.clearAIKey();
            savedApiKeyRef.current = '';
            setApiKeySaved(false);
            addToast('success', tr("API key removed"));
            if (provider === 'openai') handleCheckConnection();
        } catch (e: any) {
            addToast('error', tr("Failed to remove API key"), e?.message);
        }
    };

    // Hosted search backends: save on blur (an empty field blurring out does
    // nothing — clearing is the Clear button's job), the same semantics as the
    // provider key above.
    const handleSearchKeyBlur = async (p: SearchProvider) => {
        const value = searchKeyInputs[p].trim();
        if (!value || value === savedSearchKeysRef.current[p]) return;
        try {
            await api.setSearchKey(p, value);
            savedSearchKeysRef.current = { ...savedSearchKeysRef.current, [p]: value };
            setSearchKeySaved(s => ({ ...s, [p]: true }));
            addToast('success', tr("Search key saved"));
            // Saving is the moment the answer is wanted, and a key is typed
            // once — so the one request a test costs is spent here rather than
            // leaving a green-looking row that has never been asked anything.
            testSearchKey(p);
        } catch (e: any) {
            addToast('error', tr("Failed to save search key"), e?.message);
        }
    };

    /** Ask the service whether the saved key works. One real search, so it runs
     *  only on a save and on the Test button — never on load. */
    const testSearchKey = async (p: SearchProvider) => {
        setSearchKeyStatus(s => ({ ...s, [p]: { state: 'checking' } }));
        try {
            const r = await api.testSearchKey(p);
            setSearchKeyStatus(s => ({
                ...s,
                [p]: r.ok ? { state: 'ok' }
                    : r.configured ? { state: 'failed', detail: r.error }
                        : { state: 'none' },
            }));
        } catch (e: any) {
            setSearchKeyStatus(s => ({ ...s, [p]: { state: 'failed', detail: e?.message } }));
        }
    };

    const clearSearchKey = async (p: SearchProvider) => {
        try {
            await api.clearSearchKey(p);
            savedSearchKeysRef.current = { ...savedSearchKeysRef.current, [p]: '' };
            setSearchKeyInputs(s => ({ ...s, [p]: '' }));
            setSearchKeySaved(s => ({ ...s, [p]: false }));
            setSearchKeyStatus(s => ({ ...s, [p]: { state: 'none' } }));
            addToast('success', tr("Search key removed"));
        } catch (e: any) {
            addToast('error', tr("Failed to remove search key"), e?.message);
        }
    };

    // Autosave: Ollama URL (debounced + reconnect)

    useEffect(() => {
        if (isFirstRender.current) {
            isFirstRender.current = false;
            prevOllamaUrl.current = ollamaUrl;
            return;
        }

        if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);

        autosaveTimerRef.current = setTimeout(async () => {
            try {
                await api.setSetting('ai_ollama_url', ollamaUrl);
                if (prevOllamaUrl.current !== ollamaUrl) {
                    prevOllamaUrl.current = ollamaUrl;
                    handleCheckConnection();
                }
            } catch (e) {
                console.error('Autosave ai_ollama_url failed:', e);
            }
        }, 800);

        return () => {
            if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
        };
    }, [ollamaUrl]);

    // About You: autosave on blur (only when actually changed)

    const handleProfileBlur = async () => {
        setProfileFocused(false);
        if (userProfile === savedProfileRef.current) return;
        try {
            await api.setSetting('user_profile', userProfile);
            savedProfileRef.current = userProfile;
            addToast('success', tr("Learner profile updated"), tr("The AI tutor will use it from your next message."));
        } catch (e: any) {
            addToast('error', tr("Failed to save learner profile"), e?.message);
        }
    };

    // Save SearXNG URL (triggered on blur or Enter)

    const handleSearxngSave = async () => {
        if (searxngSkipBlurRef.current) return;
        searxngSkipBlurRef.current = true;
        try {
            await api.setSetting('searxng_url', searxngUrl);
            addToast('success', tr("SearXNG URL saved"));
        } catch (e) {
            console.error('Autosave searxng_url failed:', e);
            addToast('error', tr("Failed to save SearXNG URL"));
        }
        // Force blur the input to remove focus
        searxngInputRef.current?.blur();
    };

    const handleTestSearxng = async () => {
        if (!searxngUrl.trim()) {
            addToast('error', tr("Please enter a SearXNG URL first"));
            return;
        }
        try {
            const result = await api.testSearxng(searxngUrl);
            if (result.ok) {
                addToast('success', tr("SearXNG is reachable"));
            } else {
                addToast('error', result.error || tr("Cannot reach SearXNG"));
            }
        } catch {
            addToast('error', tr("Cannot reach SearXNG at this URL"));
        }
    };

    const SEARXNG_DEFAULT_URL = 'http://localhost:8080';

    const handleSetDefaultSearxng = async () => {
        setSearxngUrl(SEARXNG_DEFAULT_URL);
        try {
            await api.setSetting('searxng_url', SEARXNG_DEFAULT_URL);
            addToast('success', tr("SearXNG URL set to default"));
        } catch (e) {
            console.error('Failed to set default searxng_url:', e);
            addToast('error', tr("Failed to set default SearXNG URL"));
        }
    };

    // Validate selectedModel when models list changes
    // Ensures selectedModel always points to an actually installed model.
    // Handles :latest mismatches, deleted models, and auto-selection.

    useEffect(() => {
        // Ollama-only: :latest tag reconciliation makes no sense for
        // OpenAI-compatible model ids (and the id may be a llama-swap alias
        // that the /v1/models list doesn't contain).
        if (provider !== 'ollama') return;
        // Wait for both backend settings and the installed models list before
        // validating the current selection. This prevents the validation from
        // overwriting a freshly-restored (localStorage / backend) selection
        // with `models[0].name` just because models finished loading first.
        if (!settingsLoaded || models.length === 0) return;

        setSelectedModel(prev => {
            if (!prev) return models[0].name;

            // Exact match — all good
            if (models.some(m => m.name === prev)) return prev;

            // Try adding :latest (only if prev has no colon, e.g. "gemma4" → "gemma4:latest")
            if (!prev.includes(':')) {
                const latestMatch = models.find(m => m.name === `${prev}:latest`);
                if (latestMatch) return latestMatch.name;
            }

            // Try stripping :latest from the model name in the installed list
            // (handles case where saved model is "qwen3.5:9b:latest" but Ollama returns "qwen3.5:9b")
            const withoutLatestFromInstalled = models.find(m => m.name.replace(':latest', '') === prev);
            if (withoutLatestFromInstalled) return withoutLatestFromInstalled.name;

            // Try stripping :latest from the saved model name
            // (handles case where saved model is "qwen3.5:9b" but Ollama returns "qwen3.5:9b:latest")
            if (prev.includes(':latest')) {
                const strippedPrev = prev.replace(':latest', '');
                const match = models.find(m => m.name === strippedPrev || m.name.replace(':latest', '') === strippedPrev);
                if (match) return match.name;
            }

            // Not found — keep the saved model name. The backend / user is
            // the source of truth; silently switching to `models[0]` here
            // would clobber a valid selection during the brief window where
            // Ollama returns a partial model list at startup.
            return prev;
        });
    }, [settingsLoaded, models, provider]);

    // Data loaders

    const loadAISettings = async () => {
        try {
            const settings = await api.getSettings();
            if (settings.ai_provider === 'openai') setProvider('openai');
            if (settings.ai_ollama_url) setOllamaUrl(settings.ai_ollama_url);
            if (settings.ai_openai_base_url) {
                setApiBaseUrl(settings.ai_openai_base_url);
                prevApiBaseUrl.current = settings.ai_openai_base_url;
            }
            api.getAIStatus().then(s => setApiKeySaved(!!s.hasApiKey)).catch(() => { });
            api.getSearchKeys().then(status => {
                setSearchKeySaved({
                    tavily: !!status.tavily, brave: !!status.brave, jina: !!status.jina,
                });
                // A key from an earlier session is UNKNOWN, not connected. Only
                // a request can turn that green, and one is not spent to draw a
                // panel the learner may only be passing through.
                setSearchKeyStatus(s => {
                    const next = { ...s };
                    for (const { id } of SEARCH_PROVIDERS) {
                        next[id] = { state: status[id] ? 'unknown' : 'none' };
                    }
                    return next;
                });
            }).catch(() => { });
            if (settings.ai_openai_model !== undefined) setOpenaiModel(settings.ai_openai_model);
            if (settings.ai_reasoning_effort !== undefined) setReasoningEffort(settings.ai_reasoning_effort);
            if (settings.ai_provider_sort !== undefined) setProviderSort(settings.ai_provider_sort);
            if (settings.ai_provider_order !== undefined) {
                try {
                    const saved = JSON.parse(settings.ai_provider_order);
                    if (Array.isArray(saved)) setProviderOrder(saved.filter((s: unknown): s is string => typeof s === 'string'));
                } catch { /* a malformed row means no preference, not a broken panel */ }
            }
            if (settings.ai_model) {
                setSelectedModel(settings.ai_model);
                try { localStorage.setItem('study-app-selected-model', settings.ai_model); } catch { }
            }
            if (settings.ai_enabled !== undefined) setAiEnabled(settings.ai_enabled === 'true');
            if (settings.searxng_url) setSearxngUrl(settings.searxng_url);
            if (settings.mastery_gate_mode && ['off', 'advisory', 'enforced'].includes(settings.mastery_gate_mode)) {
                setGateMode(settings.mastery_gate_mode as 'off' | 'advisory' | 'enforced');
            }
            if (settings.creation_find_resources !== undefined) {
                setFindResources(settings.creation_find_resources !== 'false');
            }
            setWebSearch(settings.ai_web_search === 'on');
            // Derive the single recovery control from the two backend settings.
            {
                const rec = settings.pdf_math_recovery ?? 'auto';
                const vis = settings.pdf_recovery_vision ?? 'auto';
                setRecoveryMode(
                    rec === 'off' ? 'off'
                        : vis === 'never' ? 'ocr'
                            : vis === 'always' ? 'vision'
                                : 'auto'
                );
            }
            if (settings.pdf_recovery_vision_model !== undefined) setRecoveryVisionModel(settings.pdf_recovery_vision_model);
            if (settings.atlas_naming_model !== undefined) setAtlasNamingModel(settings.atlas_naming_model);
            if (settings.mastery_threshold) setMasteryThreshold(String(Math.round(parseFloat(settings.mastery_threshold) * 100)));
            if (settings.mastery_check_pass) setCheckPass(String(Math.round(parseFloat(settings.mastery_check_pass) * 100)));
            if (settings.mastery_check_size) setCheckSize(String(parseInt(settings.mastery_check_size, 10)));
            if (settings.decay_days) setDecayDays(String(parseInt(settings.decay_days, 10)));
            if (settings.user_profile !== undefined) {
                setUserProfile(settings.user_profile);
                savedProfileRef.current = settings.user_profile;
            }
            setSettingsLoaded(true);
            await handleCheckConnection();
        } catch (e) {
            console.error('Failed to load AI settings:', e);
            // Still mark settings as loaded so the validation effect can run;
            // otherwise it would hang forever on the first failed load.
            setSettingsLoaded(true);
        }
    };

    const loadModels = async () => {
        setModelsLoading(true);
        try {
            const result = await api.getModels();
            if (result.success) {
                setModels(result.models);
                setConnectionStatus('connected');
                setConnectionError(null);
            } else {
                setModels([]);
                setConnectionStatus('disconnected');
                setConnectionError(result.error || 'Failed to load models');
            }
        } catch (e: any) {
            setModels([]);
            setConnectionStatus('disconnected');
            setConnectionError(e.message);
        } finally {
            setModelsLoading(false);
        }
    };

    const handleCheckConnection = async () => {
        setConnectionStatus('checking');
        setConnectionError(null);
        try {
            const status = await api.getAIStatus();
            if (status.available) {
                setConnectionStatus('connected');
                setConnectionError(null);
                await loadModels();
            } else {
                setConnectionStatus('disconnected');
                setConnectionError(status.error || 'Cannot connect to the AI provider');
                setModels([]);
            }
        } catch (e: any) {
            setConnectionStatus('disconnected');
            setConnectionError(e.message);
            setModels([]);
        }
    };

    const handleToggleAI = async () => {
        setAiEnabled(prev => !prev);
    };

    // The models list doubles as the picker for both providers; each provider
    // has its own persisted selection.
    const currentModel = provider === 'openai' ? openaiModel : selectedModel;

    const chooseModel = (name: string) => {
        if (provider === 'openai') setOpenaiModel(name);
        else setSelectedModel(name);
    };

    // Model install / delete

    const handleInstallModel = async (modelId?: string) => {
        const modelToInstall = modelId || newModelName.trim();
        if (!modelToInstall) {
            addToast('error', tr("Please enter a model name"));
            return;
        }

        setInstalling(true);
        setInstallingModelId(modelId || null);
        setInstallError(null);
        setInstallProgress({ status: 'Starting download...' });

        try {
            for await (const progress of api.pullModel(modelToInstall)) {
                setInstallProgress(progress);
                if (progress.error) {
                    setInstallError(progress.error);
                    break;
                }
                if (progress.done) {
                    addToast('success', tr("Model \"{{modelToInstall}}\" installed successfully", { modelToInstall }));
                    if (!modelId) setNewModelName('');

                    // Fetch models directly to get the updated list synchronously
                    // and avoid stale closure issues with the `models` state variable.
                    const result = await api.getModels();
                    if (result.success) {
                        setModels(result.models);
                        // Explicitly auto-select the newly installed model
                        const justInstalled = result.models.find(m =>
                            m.name === modelToInstall || m.name === `${modelToInstall}:latest`
                        );
                        if (justInstalled) {
                            setSelectedModel(justInstalled.name);
                        }
                    }
                    break;
                }
            }
        } catch (e: any) {
            setInstallError(e.message);
            addToast('error', tr("Failed to install model"), e.message);
        } finally {
            setInstalling(false);
            setInstallingModelId(null);
            setInstallProgress(null);
        }
    };

    const handleDeleteModel = async (modelName: string) => {
        const confirmed = await showConfirm({
            title: tr("Delete Model"),
            message: tr("Delete model \"{{modelName}}\"? This will remove it from your system and free up disk space. This cannot be undone.", { modelName }),
            confirmLabel: tr("Delete Model"),
            variant: 'danger',
        });
        if (!confirmed) return;

        try {
            await api.deleteModel(modelName);
            addToast('success', tr("Model \"{{modelName}}\" deleted", { modelName }));
            // Refresh the models list; validation effect handles selecting
            // a valid model if the deleted one was active.
            await loadModels();
        } catch (e: any) {
            addToast('error', tr("Failed to delete model"), e.message);
        }
    };

    // Mastery & gating

    // Mirrored into the store as well as the database: this is the only thing
    // that decides whether a chat turn carries a web lookup, so the line under
    // both composers reads it straight back and says which kind of answer the
    // learner is about to get.
    const saveWebSearch = async (enabled: boolean) => {
        const previous = webSearch;
        setWebSearch(enabled);
        try {
            await api.setSetting('ai_web_search', enabled ? 'on' : 'off');
            useStore.setState({ aiWebSearch: enabled });
            addToast('success', tr("Saved"), enabled
                ? tr("The tutor and the assistant will look things up when they judge it is needed. Each answer says what it searched for.")
                : tr("Answers stay local. Nothing is sent to a search engine."));
        } catch (e: any) {
            setWebSearch(previous);
            addToast('error', tr("Failed to save"), e.message);
        }
    };

    const saveFindResources = async (enabled: boolean) => {
        setFindResources(enabled);
        try {
            await api.setSetting('creation_find_resources', enabled ? 'true' : 'false');
            addToast('success', tr("Saved"), enabled
                ? tr("New projects will collect links for every topic.")
                : tr("New projects will skip link collection — fetch links per topic instead."));
        } catch (e: any) {
            addToast('error', tr("Failed to save"), e.message);
        }
    };

    // One UI control → two backend settings (feature on/off, and how vision is used).
    const saveRecoveryMode = async (mode: RecoveryMode) => {
        setRecoveryMode(mode);
        const recovery = mode === 'off' ? 'off' : 'auto';
        const vision = mode === 'ocr' ? 'never' : mode === 'vision' ? 'always' : 'auto';
        try {
            await Promise.all([
                api.setSetting('pdf_math_recovery', recovery),
                api.setSetting('pdf_recovery_vision', vision),
            ]);
            addToast('success', tr("Saved"), tr("PDF math recovery updated."));
        } catch (e: any) {
            addToast('error', tr("Failed to save"), e.message);
        }
    };

    const saveRecoveryVisionModel = async (model: string) => {
        setRecoveryVisionModel(model);
        try {
            await api.setSetting('pdf_recovery_vision_model', model);
            addToast('success', tr("Saved"), model ? tr("Recovery will use {{model}} for vision.", { model }) : tr("Recovery vision uses the chat model."));
        } catch (e: any) {
            addToast('error', tr("Failed to save"), e.message);
        }
    };

    const saveAtlasNamingModel = async (model: string) => {
        setAtlasNamingModel(model);
        try {
            await api.setSetting('atlas_naming_model', model);
            addToast('success', tr("Saved"), model
                ? tr("Regions will be named by {{model}}.", { model })
                : tr("Regions will be named by the chat model."));
        } catch (e: any) {
            addToast('error', tr("Failed to save"), e.message);
        }
    };

    const saveGateMode = async (mode: 'off' | 'advisory' | 'enforced') => {
        setGateMode(mode);
        try {
            await api.setSetting('mastery_gate_mode', mode);
            addToast('success', tr("Saved"), tr("Mastery gating updated."));
        } catch (e: any) {
            addToast('error', tr("Failed to save"), e.message);
        }
    };

    const saveGateNumber = async (key: 'mastery_threshold' | 'mastery_check_pass' | 'mastery_check_size' | 'decay_days', raw: string) => {
        let value: string;
        if (key === 'decay_days') {
            const n = Math.max(1, Math.min(365, parseInt(raw, 10) || 14));
            value = String(n);
        } else if (key === 'mastery_check_size') {
            const n = Math.max(4, Math.min(30, parseInt(raw, 10) || 10));
            value = String(n);
            setCheckSize(value);
        } else {
            const pct = Math.max(0, Math.min(100, parseInt(raw, 10) || 0));
            value = String(pct / 100);
        }
        try {
            await api.setSetting(key, value);
        } catch (e: any) {
            addToast('error', tr("Failed to save"), e.message);
        }
    };

    // Import / Export

    const handleExportProject = async () => {
        if (!selectedExportProject) {
            addToast('error', tr("Please select a project to export"));
            return;
        }
        setExporting(true);
        try {
            const data = await api.exportProject(selectedExportProject, {
                includeNotes: true,
                includeResources: true,
                includeProgress: true,
            });
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const safeName = data.project.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
            a.download = `${safeName}-${new Date().toISOString().split('T')[0]}.json`;
            a.click();
            URL.revokeObjectURL(url);
            addToast('success', tr("Project exported successfully"));
        } catch (e: any) {
            addToast('error', tr("Export failed"), e.message);
        } finally {
            setExporting(false);
        }
    };

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) setImportFile(file);
    };

    const handleClearFile = () => {
        setImportFile(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const handleImportProject = async () => {
        if (!importFile) return;
        setImporting(true);
        try {
            const text = await importFile.text();
            const data = JSON.parse(text);
            if (!data.project || !data.nodes) throw new Error('Invalid project file format');
            await api.importProject(data);
            await loadProjects();
            addToast('success', tr("Project \"{{name}}\" imported successfully", { name: data.project.name }));
            setImportFile(null);
            if (fileInputRef.current) fileInputRef.current.value = '';
        } catch (e: any) {
            addToast('error', tr("Import failed"), e.message);
        } finally {
            setImporting(false);
        }
    };

    // Helpers

    const getInstallProgressPercent = () => {
        if (!installProgress || !installProgress.total || !installProgress.completed) return 0;
        return Math.round((installProgress.completed / installProgress.total) * 100);
    };

    // Render

    return (
        <div className="h-full overflow-auto bg-slate-100 dark:bg-slate-900">
            <div className="max-w-5xl mx-auto p-4 sm:p-6 pb-12">
                <div className="mb-6">
                    <h1 className="text-2xl font-bold text-slate-900 dark:text-white">{tr("Settings")}</h1>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{tr("Every change saves automatically.")}</p>
                </div>

                <div className="flex flex-col md:flex-row md:items-start gap-4 md:gap-8">
                    {/* Group navigation: sidebar on desktop, scrollable chip row on mobile */}
                    <nav aria-label={tr("Settings sections")} className="flex md:flex-col gap-1 md:w-44 shrink-0 md:sticky md:top-2 overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0 pb-2 md:pb-0">
                        {SETTINGS_TABS.map(t => {
                            const active = activeTab === t.id;
                            const Icon = t.icon;
                            return (
                                <button
                                    key={t.id}
                                    onClick={() => selectTab(t.id)}
                                    aria-current={active ? 'true' : undefined}
                                    className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap text-left transition shrink-0 ${active
                                        ? 'bg-accent/10 text-accent-fg'
                                        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                                >
                                    <Icon className="w-4 h-4 shrink-0" />
                                    {tr(t.label)}
                                </button>
                            );
                        })}
                    </nav>

                    <div className="flex-1 min-w-0">

                        {/* PROVING A TOPIC (the mastery gate).

                            This used to open with three dense radio cards and a
                            row of three percentage fields, every one of which
                            named an internal ("rolling mastery estimate", "mastery
                            check pass", "review decay") before the reader knew
                            what any of it decided. New learners read it as a
                            page of dials they might set wrong. What the setting
                            actually decides is ONE thing — whether finishing a
                            topic is checked — so that is the question asked, in
                            the learner's words, and the three numbers live in a
                            closed disclosure under a sentence that states what
                            they currently mean. The defaults are right for
                            almost everyone; the sentence is what makes changing
                            one of them safe, because it shows the consequence. */}
                        <section className={activeTab === 'learning' ? '' : 'hidden'}>
                            <SettingGroup
                                title={tr("Proving a topic")}
                                intro={tr("When you finish a topic, the app can check that you really know it with a short quiz — a mastery check. Choose how strict it is. Skipping a topic is always allowed.")}
                            >
                            <div className="p-4 space-y-4">
                                <ProvingModeCards gateMode={gateMode} onChange={saveGateMode} />

                                {gateMode !== 'off' && (
                                    /* THE SENTENCE IS THE ANSWER, NOT THE DOOR HANDLE.
                                        A three-line statement of what the app currently does
                                        is something to read, not something to press. As a
                                        summary it was the one disclosure on this page whose
                                        name was a paragraph, which is enough on its own to
                                        stop a reader learning what a chevron means here. So
                                        the sentence is read and the three numbers behind it
                                        close, under their own short name. */
                                    <div className="rounded-lg border border-slate-200 px-3 py-2.5 dark:border-slate-700">
                                        <p className="text-sm text-slate-700 dark:text-slate-200">
                                            {tr("A topic counts as proven at {{threshold}}% estimated mastery, or {{pass}}% on one mastery check. A proven topic starts fading after {{days}} days.", { count: Number(decayDays || 14),
                                                threshold: masteryThreshold || '85', pass: checkPass || '80', days: decayDays || '14',
                                            })}
                                        </p>
                                        <Explain summary={tr("Fine-tune these numbers")} className="mt-1">
                                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                            {/* THREE FIELDS FROM THE VOCABULARY, not three
                                                hand-sized inputs. These were `px-3 py-2 border
                                                border-slate-300 rounded-lg text-sm` written out
                                                at each call site: a fourth control height on a
                                                page that has exactly three, and the only fields
                                                in Settings that did not come from `ui/Field`. */}
                                            <label className="block">
                                                <span className="block text-sm font-medium text-slate-600 dark:text-slate-400 mb-1 mt-2">{tr("Mastery estimate to pass (%)")}</span>
                                                <TextInput
                                                    type="number" min={0} max={100}
                                                    value={masteryThreshold}
                                                    onChange={(e) => setMasteryThreshold(e.target.value)}
                                                    onBlur={() => saveGateNumber('mastery_threshold', masteryThreshold)}
                                                />
                                                <SettingNote>
                                                    {tr("The app keeps a running estimate of how well you know each topic from every answer you give. Reaching this clears the check without a fresh quiz.")}
                                                </SettingNote>
                                            </label>
                                            <label className="block">
                                                <span className="block text-sm font-medium text-slate-600 dark:text-slate-400 mb-1 mt-2">{tr("Mastery check score to pass (%)")}</span>
                                                <TextInput
                                                    type="number" min={0} max={100}
                                                    value={checkPass}
                                                    onChange={(e) => setCheckPass(e.target.value)}
                                                    onBlur={() => saveGateNumber('mastery_check_pass', checkPass)}
                                                />
                                                <span className="block text-sm text-slate-500 dark:text-slate-400 mt-1">
                                                    {tr("One quiz at this score proves the topic on the spot, whatever the estimate says.")}
                                                </span>
                                            </label>
                                            <label className="block">
                                                <span className="block text-sm font-medium text-slate-600 dark:text-slate-400 mb-1 mt-2">{tr("Questions in a mastery check")}</span>
                                                <TextInput
                                                    type="number" min={4} max={30}
                                                    value={checkSize}
                                                    onChange={(e) => setCheckSize(e.target.value)}
                                                    onBlur={() => saveGateNumber('mastery_check_size', checkSize)}
                                                />
                                                <SettingNote>
                                                    {tr("Drawn from the topic's question bank, the ones you have not been asked first. A topic with a bigger bank is asked the rest next time.")}
                                                </SettingNote>
                                            </label>
                                            <label className="block">
                                                <span className="block text-sm font-medium text-slate-600 dark:text-slate-400 mb-1 mt-2">{tr("Days before a proven topic fades")}</span>
                                                <TextInput
                                                    type="number" min={1} max={365}
                                                    value={decayDays}
                                                    onChange={(e) => setDecayDays(e.target.value)}
                                                    onBlur={() => saveGateNumber('decay_days', decayDays)}
                                                />
                                                <SettingNote>
                                                    {tr("After this long without practice, the estimate starts dropping and the feed brings the topic back as a quick recall question.")}
                                                </SettingNote>
                                            </label>
                                        </div>
                                    </Explain>
                                    </div>
                                )}
                            </div>
                            </SettingGroup>
                        </section>

                        {/* YOUR FEED — the home stream's dials (src/components/settings/FeedSettingsPanel.tsx). */}
                        <section className={activeTab === 'learning' ? 'mb-8' : 'hidden'}>
                            <FeedSettingsPanel active={activeTab === 'learning'} />
                        </section>

                        {/* SPACED REPETITION + THE PROGRESS MODEL — tuning and
                            diagnostics. Both panels are measured engines for
                            someone tuning them (retention bands, BKT rates, the
                            fit buttons), and both ship with fitted defaults a
                            new learner should not touch. So both live in ONE
                            collapsed group off the skim path; the panels stay
                            mounted and their `active` prop still fires on the
                            Learning tab, so the numbers are there the moment the
                            group is opened. Open, it is ONE card with a hairline
                            between the two engines (`TuningBlock`). */}
                        <section className={activeTab === 'learning' ? 'mb-8' : 'hidden'}>
                            <ExpandableSection
                                icon={Gauge}
                                title={tr("Fit the engine to your history")}
                                desc={tr("How review scheduling and topic progress adapt to you. The defaults already work — this is measured tuning, and it stays harmless until you choose to run it.")}
                                flushBody
                            >
                                <div className="divide-y divide-slate-100 dark:divide-slate-700/60">
                                    <SrsTuningPanel active={activeTab === 'learning'} />
                                    <MasteryTuningPanel active={activeTab === 'learning'} />
                                </div>
                            </ExpandableSection>
                        </section>

                        {/* ABOUT YOU */}
                        <section className={activeTab === 'learning' ? '' : 'hidden'}>
                            <SettingGroup
                                title={tr("Learner profile")}
                                intro={tr("Your background, education and self-assessed experience. Added to the AI’s context in every project so the tutor pitches explanations and examples at your level. Stays on your machine, like everything else.")}
                            >
                            <div className="p-4">
                                <div className="relative rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 focus-within:ring-2 focus-within:ring-accent/60 focus-within:border-accent transition overflow-hidden">
                                    <textarea
                                        value={userProfile}
                                        maxLength={PROFILE_MAX}
                                        rows={12}
                                        onChange={(e) => setUserProfile(e.target.value.slice(0, PROFILE_MAX))}
                                        onFocus={() => setProfileFocused(true)}
                                        onBlur={handleProfileBlur}
                                        placeholder={tr("e.g. Self-taught web developer, ~3 years of JavaScript, comfortable with React but new to systems programming. Weak on math notation, prefer concrete examples over formal theory.")}
                                        aria-label={tr("Learner profile — background shared with the AI tutor")}
                                        className={`block w-full min-h-32 max-h-96 px-3 py-2 bg-transparent text-sm text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 resize-y outline-none transition duration-200 ${!profileFocused && userProfile ? 'blur-[5px] select-none' : ''}`}
                                    />
                                    {/* Privacy veil: purely visual (blur + hint pill); clicks pass
                                through to the textarea, which unblurs on focus. */}
                                    {!profileFocused && userProfile && (
                                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                            <span className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/85 dark:bg-slate-800/85 text-xs font-medium text-slate-600 dark:text-slate-300 shadow-sm">
                                                <Lock className="w-3 h-3" /> {tr("Private — click to view or edit")}
                                            </span>
                                        </div>
                                    )}
                                </div>
                                <div className="flex items-center justify-between gap-3 mt-1.5">
                                    <p className="text-sm text-slate-500 dark:text-slate-400">{tr("Saves automatically when you click away.")}</p>
                                    {userProfile.length >= PROFILE_WARN_AT && (
                                        <span className={`text-xs font-medium tabular-nums shrink-0 ${userProfile.length >= PROFILE_MAX ? 'text-red-500' : 'text-amber-600 dark:text-amber-400'}`}>
                                            {num(userProfile.length)}/{num(PROFILE_MAX)}
                                        </span>
                                    )}
                                </div>
                            </div>
                            </SettingGroup>
                        </section>

                        {/* APPEARANCE — four settings, four rows, no paragraphs.
                            What each control does is visible the moment it is
                            used: the theme repaints the page, the accent
                            repaints this card, the size resizes the words you
                            are reading. A sentence explaining any of that is a
                            sentence describing what the reader can already see.
                            The app icon is the exception, because it is the one
                            appearance choice whose effect is somewhere else —
                            so it keeps its line, and its caveats sit closed
                            inside its own disclosure (AppIconPanel). */}
                        <section className={activeTab === 'general' ? '' : 'hidden'}>
                            <SettingGroup title={tr("Appearance")}>
                                <SettingRow label={tr("Theme")} block control={<ThemeCards />} />
                                {/* …and what colour it is. The card above
                                    answers light or dark; this answers the
                                    other half, which a fixed set of themes can
                                    only ever answer for you. */}
                                <SettingRow
                                    label={tr("Page colour")}
                                    hint={tr("Tints every surface. Both themes above show it.")}
                                    block
                                    control={<ThemeTintField />}
                                />
                                <SettingRow
                                    label={tr("Accent colour")}
                                    hint={tr("Projects keep their own colour.")}
                                    block
                                    control={<AccentField />}
                                />
                                {/* THE APP'S OWN ICON — the tab, and what an install
                                    puts on a home screen. It sits with the theme and
                                    the accent because it is the same question, and it
                                    is a disclosure because it is three controls and a
                                    caveat for a picture most readers never change. */}
                                <AppIconPanel />
                                {/* UI SCALE. Not a font-size preference — it moves the
                                    root font size, and this app's sizes are `rem`, so
                                    the interface grows as a piece instead of becoming
                                    large text in boxes built for small text. Three
                                    controls over one number on one 40px line: drag it,
                                    nudge it, or put it back. The stepper steps by 5
                                    because the SLIDER does — at ±10 a value reached
                                    with one could not be nudged back to itself with
                                    the other. Reset is disabled at 100%, not hidden: a
                                    control that appears and disappears moves
                                    everything beside it. */}
                                <SettingRow
                                    label={tr("Text & interface size")}
                                    block
                                    control={
                                        // The slider is the one control here whose width IS its
                                        // precision, so it takes the row and the stepper and reset
                                        // keep their own size beside it.
                                        <div className="flex flex-wrap items-center gap-3 w-full">
                                            <Slider
                                                min={MIN_UI_SCALE}
                                                max={MAX_UI_SCALE}
                                                step={UI_SCALE_STEP}
                                                value={uiScale}
                                                onChange={v => void setUiScale(v)}
                                                label={tr("Interface size")}
                                                valueText={`${uiScale}%`}
                                                className="flex-1 min-w-[8rem]"
                                            />
                                            <Stepper
                                                value={uiScale}
                                                min={MIN_UI_SCALE}
                                                max={MAX_UI_SCALE}
                                                step={UI_SCALE_STEP}
                                                onChange={v => void setUiScale(v)}
                                                label={tr("Interface size")}
                                                suffix="%"
                                            />
                                            <IconButton
                                                variant="neutral"
                                                onClick={() => void setUiScale(DEFAULT_UI_SCALE)}
                                                disabled={uiScale === DEFAULT_UI_SCALE}
                                                label={tr("Reset to {{DEFAULT_UI_SCALE}}%", { DEFAULT_UI_SCALE })}
                                                icon={<RotateCcw className="w-4 h-4" aria-hidden="true" />}
                                            />
                                        </div>
                                    }
                                />
                            </SettingGroup>
                        </section>

                        {/* LANGUAGE & REGION — the interface language, how numbers
                            are written, and which day a week starts on. These were
                            two sections ("Language" and a "Calendar" section holding
                            one control), which is a heading and a card spent on a
                            single two-way choice. They are one group for the same
                            reason every desktop OS groups them: they are all "how
                            this app should read where I live".

                            The language here is the CHROME, never the content — a
                            Dutch course stays Dutch under an English interface and
                            the reverse. 'auto' follows the browser's language list,
                            and the choice is applied before the round trip, like the
                            theme. */}
                        <section className={activeTab === 'general' ? '' : 'hidden'}>
                            <SettingGroup title={tr("Language & region")}>
                                <SettingRow
                                    label={tr("Interface language")}
                                    hint={tr("Lessons and questions follow each project's own language.")}
                                    htmlFor="ui-language"
                                    control={<LanguageRow id="ui-language" />}
                                    more={
                                        <Explain summary={tr("About the translations")}>
                                            {/* What is TRUE here is that English is the
                                                source the other eleven were made from.
                                                It said "the only language written by a
                                                person", which claims an authorship the
                                                English text does not have either. */}
                                            {tr("English is the app’s original language. The rest were translated from it by machine and then corrected by hand where mistakes were found, so a sentence here and there may read oddly. If you spot one, corrections are welcome: each language is a single file in the app’s source.")}
                                        </Explain>
                                    }
                                />
                                {/* The options carry NO labels, in any language: the
                                    example IS the option. "1.234,5" says what it does to
                                    anyone who reads a number, where "point group, comma
                                    decimal" has to be decoded — and it needs no
                                    translating, so the twelve locale files do not grow a
                                    row of near-identical sentences. */}
                                <SettingRow
                                    label={tr("Numbers")}
                                    hint={tr("A comma and a point are always both accepted when you type.")}
                                    htmlFor="number-format"
                                    control={
                                        <Select
                                            id="number-format"
                                            fit
                                            value={numberFormat}
                                            onChange={e => void setNumberFormat(e.target.value)}
                                            className="tabular-nums"
                                        >
                                            <option value={NUMBER_AUTO}>{tr("Same as the language")} ({formatNumber(1234.5, NUMBER_AUTO)})</option>
                                            {NUMBER_STYLES.map(style => (
                                                <option key={style.id} value={style.id}>{style.id}</option>
                                            ))}
                                        </Select>
                                    }
                                />
                                {/* Was a Mon-Sun / Sun-Sat toggle living in the
                                    calendar's own toolbar as component state: it reset
                                    to Monday on every navigation, the global calendar
                                    ignored it, and on a phone it spent 100px of a
                                    toolbar that also carries the month, the view mode
                                    and the arrows. Nobody sets it twice. */}
                                <SettingRow
                                    label={tr("Week starts on")}
                                    control={
                                        <SegmentedControl
                                            label={tr("Week starts on")}
                                            value={weekStartDay}
                                            onChange={d => void setWeekStartDay(d as 0 | 1)}
                                            options={[
                                                { value: 1, label: tr("Monday") },
                                                { value: 0, label: tr("Sunday") },
                                            ]}
                                        />
                                    }
                                />
                            </SettingGroup>
                        </section>

                        {/* THIS COMPUTER — only under the desktop launcher. The one
                            thing a reader wants at arm's length is WHERE THE DATA IS
                            (the one thing to back up); everything else here is
                            lifecycle — background, sign-in, window shape, quitting —
                            which is read once, when it misbehaves. So the folder row
                            stays open and the lifecycle rows close behind one
                            disclosure. See server/desktop.js. */}
                        {desktop?.desktop && desktop.dataDir && (
                            <section className={activeTab === 'general' ? '' : 'hidden'}>
                                {/* The intro paragraph that stood here said what the two
                                    rows under it already say. */}
                                <h2 className={GROUP_CAPTION}>{tr("This computer")}</h2>
                                <div className="mb-6 bg-white dark:bg-slate-800 rounded-xl shadow-sm divide-y divide-slate-100 dark:divide-slate-700/60">
                                    <div className="p-4 flex flex-col gap-3 sm:flex-row sm:items-start">
                                        <div className="min-w-0 flex-1">
                                            <p className="font-medium text-slate-900 dark:text-white">{tr("Your data")}</p>
                                            {/* The folder NAME is the readable fact; the whole
                                                path is for support threads and opens on
                                                demand rather than running break-all across
                                                the card. */}
                                            <p className="text-sm text-slate-500 dark:text-slate-400">
                                                <code className="text-xs">{desktop.dataDir.split(/[\\/]+/).filter(Boolean).pop()}</code>
                                            </p>
                                            <Explain summary={tr("Show the full path")} className="mt-1">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <code className="text-xs break-all font-mono text-slate-500 dark:text-slate-400">{desktop.dataDir}</code>
                                                    <Button
                                                        size="sm"
                                                        onClick={async () => {
                                                            const dir = desktop.dataDir;
                                                            if (!dir) return;
                                                            try {
                                                                await navigator.clipboard?.writeText(dir);
                                                                setCopiedPath(true);
                                                                setTimeout(() => setCopiedPath(false), 1500);
                                                            } catch { /* http origin: no clipboard, the path is on screen */ }
                                                        }}
                                                        icon={copiedPath
                                                            ? <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                                                            : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
                                                    >
                                                        {copiedPath ? tr("Copied") : tr("Copy path")}
                                                    </Button>
                                                </div>
                                            </Explain>
                                            {/* The one sentence a reader needs at arm's
                                                length; that a new version never touches
                                                the folder is reassurance, not a fact
                                                anyone acts on, so it went. */}
                                            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                                                {tr("Back this folder up and you have backed up everything.")}
                                            </p>
                                        </div>
                                        <Button
                                            onClick={() => void desktopApi.openDataDir().catch(() => addToast('error', tr("Could not open the folder")))}
                                            className="self-start shrink-0"
                                        >
                                            {tr("Open folder")}
                                        </Button>
                                    </div>
                                    {/* The lifecycle rows: read once, when needed, closed
                                        until then. Their dividers come from THIS wrapper —
                                        the card's own divide-y only sees the two children
                                        it has left. */}
                                    {/* WHETHER it keeps serving is a question only without a
                                        tray icon. With one the answer is fixed, so the summary
                                        states it instead of promising a setting that is not
                                        inside. */}
                                    <ExpandableSection
                                        variant="row"
                                        icon={Power}
                                        title={tr("Background, sign-in and quitting")}
                                        desc={desktop.trayHosted
                                            ? tr("Closing the window leaves the app serving behind its notification icon — for your phone, or to open it again instantly. Whether it starts with the computer, and how to stop it for good.")
                                            : tr("Whether the app keeps serving when you close it, starts with the computer, and how to stop it for good.")}
                                        flushBody
                                    >
                                        <div className="divide-y divide-slate-100 dark:divide-slate-700/60">
                                    {/* KEEP RUNNING — a row only where it is a CHOICE. Under a
                                        tray icon it is not one: the icon IS the app's presence,
                                        so the server outliving its window is what makes the icon
                                        mean anything, and there is nothing to switch. The row
                                        stayed anyway, carrying a paragraph that began "On, and
                                        not a choice here" — a setting-shaped row, in a list of
                                        settings, with the control column empty, which reads as a
                                        switch that failed to draw. The fact it was carrying is
                                        true and worth saying, so it moved UP to the section's own
                                        summary, where a statement belongs. */}
                                    {!desktop.trayHosted && (
                                        <div className="p-4 flex flex-col gap-3 sm:flex-row sm:items-start">
                                            <div className="min-w-0 flex-1">
                                                <p className="font-medium text-slate-900 dark:text-white">{tr("Keep running in the background")}</p>
                                                <p className="text-sm text-slate-500 dark:text-slate-400">
                                                    {tr("Off: closing the last window stops the app. On: it keeps serving — for your phone, or to open the window again instantly — until you quit it here.")}
                                                </p>
                                            </div>
                                            <Switch
                                                label={tr("Keep the server running")}
                                                checked={!!desktop.keepRunning}
                                                disabled={desktopBusy}
                                                className="self-start"
                                                onChange={async next => {
                                                    setDesktopBusy(true);
                                                    try { await desktopApi.keepRunning(next); await refreshDesktop(); }
                                                    catch { addToast('error', tr("Could not change the setting")); }
                                                    finally { setDesktopBusy(false); }
                                                }}
                                            />
                                        </div>
                                    )}
                                    {/* START AT LOGIN — drawn only where it can actually
                                        work. A copy the launcher did not start (a dev
                                        checkout run some other way) cannot know the command
                                        line a login item would need, and a switch that does
                                        nothing is worse than no switch. */}
                                    {desktop.canStartAtLogin && (
                                        <div className="p-4 flex flex-col gap-3 sm:flex-row sm:items-start">
                                            <div className="min-w-0 flex-1">
                                                <p className="font-medium text-slate-900 dark:text-white">{tr("Start when I sign in")}</p>
                                                <p className="text-sm text-slate-500 dark:text-slate-400">
                                                    {/* Only point at "keep running" where the reader
                                                        can see it. Behind a tray icon that row is not
                                                        drawn, so naming it sent them looking for a
                                                        switch that is not on the screen. */}
                                                    {desktop.trayHosted
                                                        ? tr("Opens the app as the computer finishes starting, so it is simply always there — including for your phone.")
                                                        : tr("Opens the app as the computer finishes starting. With \"keep running\" on as well, it is simply always there — including for your phone.")}
                                                </p>
                                            </div>
                                            <Switch
                                                label={tr("Start when I sign in")}
                                                checked={startsAtLogin}
                                                disabled={desktopBusy}
                                                className="self-start"
                                                onChange={async next => {
                                                    setDesktopBusy(true);
                                                    setLoginAsked(next);
                                                    try { await desktopApi.startAtLogin(next); await refreshDesktop(); }
                                                    catch { setLoginAsked(null); addToast('error', tr("Could not change the setting")); }
                                                    finally { setDesktopBusy(false); }
                                                }}
                                            />
                                        </div>
                                    )}
                                    {/* WHAT A SIGN-IN START DOES — drawn only where it can be
                                        honoured. Coming up with no window needs somewhere to
                                        come up TO, and the tray icon is the only such place;
                                        without one the launcher opens a window whatever this
                                        says (desktop/lib.js `shouldOpenWindow`), so the control
                                        would be describing something that does not happen. */}
                                    {desktop.canStartAtLogin && desktop.trayHosted && (
                                        <div className="p-4 flex flex-col gap-3 sm:flex-row sm:items-start">
                                            <div className="min-w-0 flex-1">
                                                <p className="font-medium text-slate-900 dark:text-white">{tr("When it starts with the computer")}</p>
                                                <p className="text-sm text-slate-500 dark:text-slate-400">
                                                    {tr("Come up quietly behind the icon, or open a window. This is only about that first start at sign-in — opening the app yourself always opens a window.")}
                                                </p>
                                            </div>
                                            <SegmentedControl
                                                className="self-start"
                                                label={tr("When it starts with the computer")}
                                                value={desktop.autostartWindow || 'hidden'}
                                                onChange={async mode => {
                                                    setDesktopBusy(true);
                                                    try { await desktopApi.autostartWindow(mode as DesktopAutostartWindow); await refreshDesktop(); }
                                                    catch { addToast('error', tr("Could not change the setting")); }
                                                    finally { setDesktopBusy(false); }
                                                }}
                                                options={[
                                                    // NOT the existing "Background" key: that one is the
                                                    // visual sense and is already translated as Фон, 背景,
                                                    // Tło, Fondo — the colour behind a thing, not the place
                                                    // a program runs. One English word, two meanings, and
                                                    // sharing the key would mistranslate this in six locales.
                                                    { value: 'hidden', label: tr("In the background") },
                                                    { value: 'show', label: tr("Window") },
                                                ]}
                                            />
                                        </div>
                                    )}
                                    {/* HOW THE WINDOW OPENS — applied by the launcher at the
                                        next start, because a window cannot be maximised from
                                        inside the page it is showing. */}
                                    <div className="p-4 flex flex-col gap-3 sm:flex-row sm:items-start">
                                        <div className="min-w-0 flex-1">
                                            <p className="font-medium text-slate-900 dark:text-white">{tr("How the window opens")}</p>
                                            <p className="text-sm text-slate-500 dark:text-slate-400">
                                                {tr("Takes effect the next time the app starts — a window cannot resize itself once it is open.")}
                                            </p>
                                        </div>
                                        <SegmentedControl
                                            // `self-start`: the control is an `inline-flex` and
                                            // sizes to its labels, but a flex COLUMN stretches its
                                            // children — which drew a full-width track with the
                                            // three chips huddled in its left third.
                                            //
                                            // And no `shrink-0`, which the Button rows beside it
                                            // carry: this one is allowed to lose width and wrap
                                            // rather than push the sentence it belongs to narrow.
                                            className="self-start"
                                            label={tr("How the window opens")}
                                            value={desktop.windowMode || 'window'}
                                            onChange={async mode => {
                                                setDesktopBusy(true);
                                                try { await desktopApi.windowMode(mode as DesktopWindowMode); await refreshDesktop(); }
                                                catch { addToast('error', tr("Could not change the setting")); }
                                                finally { setDesktopBusy(false); }
                                            }}
                                            options={[
                                                { value: 'window', label: tr("Window") },
                                                { value: 'maximized', label: tr("Maximised") },
                                                { value: 'fullscreen', label: tr("Full screen") },
                                            ]}
                                        />
                                    </div>
                                    <div className="p-4 flex flex-col gap-3 sm:flex-row sm:items-start">
                                        <div className="min-w-0 flex-1">
                                            <p className="font-medium text-slate-900 dark:text-white">{tr("Quit")}</p>
                                            <p className="text-sm text-slate-500 dark:text-slate-400">
                                                {/* The other way out, said where quitting is the
                                                    subject: the tray menu quits it too, and that is
                                                    the one reachable with no window open. */}
                                                {desktop.trayHosted
                                                    ? tr("Stops the app on this computer — the notification icon's own menu does the same. Version {{version}}, port {{port}}.", { version: desktop.version, port: desktop.port })
                                                    : tr("Stops the app on this computer. Version {{version}}, port {{port}}.", { version: desktop.version, port: desktop.port })}
                                            </p>
                                        </div>
                                        <Button
                                            onClick={async () => {
                                                const yes = await showConfirm({ title: tr("Quit the app?"), message: tr("Every open window loses its connection. Your data is saved."), confirmLabel: tr("Quit"), variant: 'danger' });
                                                if (!yes) return;
                                                try { await desktopApi.quit(); } catch { /* it is going away */ }
                                                // The response means "stopping", and the window
                                                // outlives the process either way — the screen
                                                // waits for the server to be gone, then closes it.
                                                setQuitting(true);
                                            }}
                                            variant="danger"
                                            className="self-start shrink-0"
                                        >
                                            {tr("Quit")}
                                        </Button>
                                    </div>
                                        </div>
                                    </ExpandableSection>
                                </div>
                            </section>
                        )}

                        {/* ABOUT / SOURCE — AGPL-3.0 §13 obligation, not decoration.
                            This app is served over a network (the PWA on a phone reaches the
                            desktop over Tailscale), which makes every remote user a "user
                            interacting remotely through a computer network". The licence
                            requires they be offered the Corresponding Source, and the GPL's own
                            "How to Apply" section names a Source link in the interface as the
                            way a web application does it. */}
                        <section className={activeTab === 'general' ? 'mb-8' : 'hidden'}>
                            <SectionHeader
                                icon={Code2}
                                title={tr("About")}
                            >
                                {tr("What you are running, where to get it, and how to tell us when it is wrong.")}
                            </SectionHeader>
                            {/* `flush` + the divider classes, matching the model-tier
                                card: four rows with nothing between them read as one
                                continuous block, and "Updates" and "Found a problem?"
                                are separate concerns that happen to share a card. */}
                            <Panel flush className="divide-y divide-slate-100 dark:divide-slate-700/60">
                                {/* WHICH BUILD IS THIS. Until this row existed a bug
                                    report said "latest", which could mean a
                                    three-week-old clone or this morning's pull — and
                                    an update check has nothing to compare against. */}
                                <div className="p-4 flex flex-col gap-3 sm:flex-row sm:items-start">
                                    <div className="min-w-0 flex-1">
                                        <p className="font-medium text-slate-900 dark:text-white">
                                            {appVersion ? tr("Version {{version}}", { version: appVersion.version }) : tr("Version unavailable")}
                                        </p>
                                        <p className="text-sm text-slate-500 dark:text-slate-400 break-words">
                                            {appVersion
                                                ? [
                                                    appVersion.commitShort && `commit ${appVersion.commitShort}`,
                                                    `${appVersion.deployment} install`,
                                                    `Node ${appVersion.node}`,
                                                ].filter(Boolean).join(' \u00b7 ')
                                                : tr("This server is too old to report its version.")}
                                        </p>
                                    </div>
                                    {appVersion && (
                                        <Button
                                            onClick={async () => {
                                                try {
                                                    await navigator.clipboard?.writeText(
                                                        diagnosticsBlock({ version: appVersion, aiProvider: reportAiProvider, aiModel: reportAiModel }));
                                                    setCopiedVersion(true);
                                                    setTimeout(() => setCopiedVersion(false), 1500);
                                                } catch { /* http origin: no clipboard, the text is on screen */ }
                                            }}
                                            className="self-start shrink-0"
                                            icon={copiedVersion
                                                ? <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                                                : <Copy className="w-4 h-4" aria-hidden="true" />}
                                        >
                                            {copiedVersion ? tr("Copied") : tr("Copy details")}
                                        </Button>
                                    )}
                                </div>

                                {/* UPDATES. The button is user-initiated and therefore
                                    allowed to reach the network; the toggle below is the
                                    only thing that makes the app do it unattended, and it
                                    ships off so SECURITY.md's idle-and-capture procedure
                                    stays true on a default install. */}
                                <div className="p-4">
                                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                                        <div className="min-w-0 flex-1">
                                            <p className="font-medium text-slate-900 dark:text-white">{tr("Updates")}</p>
                                            <p className="text-sm text-slate-500 dark:text-slate-400">
                                                {updateStatus?.available && updateStatus.latest
                                                    ? tr("Version {{version}} is available.", { version: updateStatus.latest.version })
                                                    : updateStatus?.checkedAt
                                                        ? tr("Up to date as of {{value}}.", { value: new Date(updateStatus.checkedAt).toLocaleString(uiLocale()) })
                                                        : tr("Not checked yet.")}
                                                {updateStatus?.error && (
                                                    <span className="text-amber-600 dark:text-amber-400"> {tr("The last check failed: {{error}}", { error: updateStatus.error })}</span>
                                                )}
                                            </p>
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0 self-start">
                                            {updateStatus?.available && updateStatus.latest && (
                                                <ButtonLink
                                                    href={updateStatus.latest.url}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    variant="quiet"
                                                    className="text-accent-fg"
                                                    icon={<ArrowUpCircle className="w-4 h-4" aria-hidden="true" />}
                                                >
                                                    {tr("What's new")}
                                                </ButtonLink>
                                            )}
                                            <Button
                                                onClick={async () => {
                                                    setCheckingUpdate(true);
                                                    try { await checkForUpdates(); } finally { setCheckingUpdate(false); }
                                                }}
                                                busy={checkingUpdate}
                                                icon={<RefreshCw className="w-4 h-4" aria-hidden="true" />}
                                            >
                                                {tr("Check now")}
                                            </Button>
                                        </div>
                                    </div>

                                    {updateStatus?.updateCommand && updateStatus.available && (
                                        <div className="mt-3">
                                            <p className="mb-1.5 flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400">
                                                <Terminal className="w-3.5 h-3.5" aria-hidden="true" />
                                                {tr("To update this {{deployment}} install, run:", { deployment: updateStatus.deployment })}
                                            </p>
                                            <code className="block overflow-x-auto rounded-lg bg-slate-900 px-3 py-2 font-mono text-xs whitespace-pre text-slate-100">
                                                {updateStatus.updateCommand}
                                            </code>
                                        </div>
                                    )}

                                    <div className="mt-4 flex items-center justify-between gap-3">
                                        <div className="min-w-0">
                                            <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{tr("Check daily")}</p>
                                            {/* Six lines of it stood open on a phone, under a
                                                switch whose label already says what it does.
                                                The sentence is unchanged, so its eleven
                                                translations come with it. */}
                                            <SettingNote>
                                                {tr("One request a day to GitHub's public release list, from this server. It sends the version and nothing else. Off by default — this is the app's only unattended outbound call.")}
                                            </SettingNote>
                                        </div>
                                        <Switch
                                            label={tr("Check for updates daily")}
                                            checked={!!updateStatus?.enabled}
                                            onChange={next => setAutoUpdateCheck(next)}
                                        />
                                    </div>
                                </div>

                                {/* REPORTING. The details a maintainer needs are exactly
                                    the ones a non-programmer cannot look up, so the app
                                    fills them in and the person writes the rest. */}
                                {/* Two rows, one shape. Both are "here is a thing
                                    you might do next", so both are a sentence on
                                    the left and a button on the right, centred
                                    against it — the licence paragraph used to
                                    carry its Source link as prose in the middle
                                    of the text, which made the one control the
                                    AGPL actually requires the hardest to find on
                                    the page. `sm:items-center` rather than
                                    `items-start`: against two lines of copy a
                                    top-aligned button reads as attached to the
                                    heading rather than to the row. */}
                                <div className="p-4 flex flex-col gap-3 sm:flex-row sm:items-center">
                                    <div className="min-w-0 flex-1">
                                        <p className="font-medium text-slate-900 dark:text-white">{tr("Found a problem?")}</p>
                                        <SettingNote>
                                            {tr("Including a lesson or an answer the AI got wrong. Nothing is sent from here — you see the details first and submit it yourself.")}
                                        </SettingNote>
                                    </div>
                                    <Button
                                        onClick={() => setReportOpen(true)}
                                        className="self-start sm:self-auto shrink-0"
                                        icon={<Bug className="w-4 h-4" aria-hidden="true" />}
                                    >
                                        {tr("Report a problem")}
                                    </Button>
                                </div>

                                {/* AGPL-3.0 section 13, not decoration. This app is served
                                    over a network (the PWA on a phone reaches the desktop
                                    over Tailscale), which makes every remote user a "user
                                    interacting remotely through a computer network". The
                                    licence requires they be offered the Corresponding
                                    Source, and the GPL's own "How to Apply" section names a
                                    Source link in the interface as the way a web
                                    application does it. */}
                                <div className="p-4 flex flex-col gap-3 sm:flex-row sm:items-center">
                                    <div className="min-w-0 flex-1 text-sm text-slate-600 dark:text-slate-300">
                                        <p className="font-medium text-slate-900 dark:text-white">{tr("Source code")}</p>
                                        <p className="text-sm text-slate-500 dark:text-slate-400">
                                            {tr("Free software under the")}{' '}
                                            <a
                                                href="https://www.gnu.org/licenses/agpl-3.0.html"
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-accent-fg hover:underline"
                                            >
                                                {tr("GNU Affero General Public License v3")}
                                            </a>
                                            {' '}{tr("or later. You may run, study, change and share it.")}
                                        </p>
                                    </div>
                                    <ButtonLink
                                        href={appVersion?.repoUrl || SOURCE_URL}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="self-start sm:self-auto shrink-0"
                                        icon={<Code2 className="w-4 h-4" aria-hidden="true" />}
                                    >
                                        {tr("Get the source code")}
                                    </ButtonLink>
                                </div>
                            </Panel>
                            <ReportProblemDialog open={reportOpen} onClose={() => setReportOpen(false)} />
                            {quitting && <DesktopQuitScreen onStillRunning={quitFailed} />}
                        </section>

                        {/* KEYBOARD SHORTCUTS — only where there are keys to press.
                            Input capability is not a width breakpoint: this is a
                            whole section of unusable instructions on a phone. */}
                        {hasKeyboard && (
                        <section className={activeTab === 'general' ? 'mb-8' : 'hidden'}>
                            <h2 className={GROUP_CAPTION}>{tr("Keyboard shortcuts")}</h2>
                            <div className="bg-white dark:bg-slate-800 rounded-xl p-4 shadow-sm">
                                {/* Keycaps follow the platform (⌘ on Apple, Ctrl elsewhere) — the
                                    handlers always accepted both. Listed in full: the capture and
                                    assistant keys existed but were documented nowhere. */}
                                <ul className="space-y-2.5 text-sm text-slate-600 dark:text-slate-400">
                                    {[
                                        [tr("Open search"), `${MOD_KEY} + K`],
                                        [tr("Capture something to study later"), 'C'],
                                        [tr("Open the assistant"), 'A'],
                                        [tr("Save notes while editing"), `${MOD_KEY} + Enter`],
                                        [tr("Close panels and modals"), 'Esc'],
                                    ].map(([label, combo]) => (
                                        <li key={label} className="flex items-center justify-between gap-3">
                                            <span>{label}</span>
                                            <kbd className="bg-slate-100 dark:bg-slate-700 px-1.5 py-0.5 rounded text-xs whitespace-nowrap">{combo}</kbd>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        </section>
                        )}

                        {/* SEARCH LINKS */}
                        <section className={activeTab === 'search' ? 'mb-8' : 'hidden'}>
                            <h2 className={GROUP_CAPTION}>{tr("Search links")}</h2>
                            <div className="mb-2 px-1">
                                <SettingNote>
                                    {tr("Where the app offers to send you to research a topic yourself — a link you click, not something the AI reads. Enabled providers appear on topics and on answers you got wrong.")}
                                </SettingNote>
                            </div>
                            <SearchProvidersPanel />
                        </section>

                        <section className={activeTab === 'data' ? 'mb-8' : 'hidden'}>
                            <h2 className={GROUP_CAPTION}>{tr("Import & Export")}</h2>
                            <div className="mb-2 px-1">
                                <SettingNote>
                                    {tr("Move projects between machines as portable JSON files — structure, notes, resources and progress included.")}
                                </SettingNote>
                            </div>
                            {/* Two ROWS of one card, each shaped like the Anki row
                                below: what it is on the left, its controls at
                                their own width on the right. They were two tinted
                                cards inside this card, split by a viewport
                                breakpoint (`sm:grid-cols-2`), each ending in a
                                full-width button — "Choose File" was a 326px bar
                                for a 105px label. Narrow, a row's controls wrap
                                under its text and stay right. */}
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".json"
                                onChange={handleFileSelect}
                                className="hidden"
                            />
                            <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm divide-y divide-slate-100 dark:divide-slate-700/60">
                                <div className="p-4 flex flex-wrap items-center gap-x-4 gap-y-3">
                                    <div className="flex min-w-[12rem] flex-1 items-center gap-4">
                                        <div className="p-2 bg-emerald-500 rounded-lg shrink-0">
                                            <Download className="w-5 h-5 text-white" aria-hidden="true" />
                                        </div>
                                        <div className="min-w-0">
                                            <p className="font-semibold text-slate-900 dark:text-white">{tr("Import Project")}</p>
                                            <p className="text-sm text-slate-500 dark:text-slate-400">{tr("Load from JSON file")}</p>
                                        </div>
                                    </div>
                                    <div className="ml-auto flex min-w-0 max-w-full items-center gap-2">
                                        {importFile ? (
                                            <>
                                                {/* The chosen file is named where it will
                                                    be acted on, and can be dropped there. */}
                                                <span className="min-w-0 truncate text-sm text-slate-700 dark:text-slate-300" title={importFile.name}>
                                                    {importFile.name}
                                                </span>
                                                <IconButton
                                                    size="sm"
                                                    onClick={handleClearFile}
                                                    label={tr("Remove selected file")}
                                                    icon={<X className="w-4 h-4" aria-hidden="true" />}
                                                />
                                                <Button
                                                    variant="primary"
                                                    className="shrink-0"
                                                    busy={importing}
                                                    onClick={handleImportProject}
                                                >
                                                    {tr("Import Project")}
                                                </Button>
                                            </>
                                        ) : (
                                            <Button className="shrink-0" onClick={() => fileInputRef.current?.click()}>
                                                {tr("Choose File")}
                                            </Button>
                                        )}
                                    </div>
                                </div>

                                <div className="p-4 flex flex-wrap items-center gap-x-4 gap-y-3">
                                    <div className="flex min-w-[12rem] flex-1 items-center gap-4">
                                        <div className="p-2 bg-accent rounded-lg shrink-0">
                                            <Upload className="w-5 h-5 text-white" aria-hidden="true" />
                                        </div>
                                        <div className="min-w-0">
                                            <p className="font-semibold text-slate-900 dark:text-white">{tr("Export Project")}</p>
                                            <p className="text-sm text-slate-500 dark:text-slate-400">{tr("Save to JSON file")}</p>
                                        </div>
                                    </div>
                                    {projects.length > 0 ? (
                                        <div className="ml-auto flex min-w-0 max-w-full items-center gap-2">
                                            {/* Sized to the longest project name like
                                                every select that is a row's control,
                                                up to 20rem: one long name in a real
                                                library ("VWO Mathematics B — Boswell-
                                                Beta / CCVX Deficiency Exam") made it
                                                580px and pushed the row onto two
                                                lines. The open list still shows every
                                                name whole. */}
                                            <Select
                                                fit
                                                className="max-w-[20rem]"
                                                value={selectedExportProject || ''}
                                                onChange={(e) => setSelectedExportProject(Number(e.target.value))}
                                                aria-label={tr("Which project to export")}
                                            >
                                                {projects.map(p => (
                                                    <option key={p.id} value={p.id}>{p.name}</option>
                                                ))}
                                            </Select>
                                            <Button
                                                className="shrink-0"
                                                busy={exporting}
                                                disabled={!selectedExportProject}
                                                onClick={handleExportProject}
                                            >
                                                {tr("Export")}
                                            </Button>
                                        </div>
                                    ) : (
                                        <p className="ml-auto text-sm text-slate-500 dark:text-slate-400">
                                            {tr("No projects to export")}
                                        </p>
                                    )}
                                </div>
                            </div>
                        </section>

                        {/* Anki import gets its own section rather than a third
                            card in the grid above: it is the front door for
                            people arriving with an existing collection, and
                            burying it next to "export as JSON" would hide the
                            one thing that gives a new user content on day one. */}
                        <section className={activeTab === 'data' ? 'mb-8' : 'hidden'}>
                            <h2 className={GROUP_CAPTION}>{tr("Coming from Anki?")}</h2>
                            <div className="mb-2 px-1">
                                <SettingNote>
                                    {tr("Bring a deck across with its review history intact. Your decks become topics, and everything here — lessons, questions, mastery — works on them from then on.")}
                                </SettingNote>
                            </div>
                            <div className="bg-white dark:bg-slate-800 rounded-xl p-4 shadow-sm flex items-center gap-4">
                                <div className="p-2 bg-accent rounded-lg shrink-0">
                                    <Layers className="w-5 h-5 text-white" />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <p className="font-semibold text-slate-900 dark:text-white">{tr("Import an Anki deck")}</p>
                                    <p className="text-sm text-slate-500 dark:text-slate-400">
                                        {tr(".apkg file · you see a preview before anything is added")}
                                    </p>
                                </div>
                                <Button
                                    onClick={() => openAnkiImport()}
                                    variant="primary"
                                    className="shrink-0"
                                >
                                    {tr("Choose file")}
                                </Button>
                            </div>
                        </section>

                        <div className={activeTab === 'data' ? '' : 'hidden'}>
                            <SecuritySettings />
                        </div>

                        {/* RECORDS & DIAGNOSTICS: the two local records of what the
                            app did, collapsed because they are read when something
                            needs checking, not on a skim. Open, it is ONE card with
                            a hairline between the records, each laid out as name
                            (+ switch), what it is, then count left and actions
                            right. No card nested in a card. */}
                        <div className={activeTab === 'data' ? 'mb-8' : 'hidden'}>
                            <ExpandableSection
                                icon={Terminal}
                                title={tr("Records & diagnostics")}
                                // The only place this section says nothing leaves
                                // the machine; the notes below do not repeat it.
                                desc={tr("What the app has done, and the reports you wrote about visuals. Both are kept on this computer and never sent anywhere.")}
                                flushBody
                            >
                                <div className="divide-y divide-slate-100 dark:divide-slate-700/60">
                                    <ActivityLogPanel />

                                    {/* VISUAL FEEDBACK.

                                        A diagram that renders and is WRONG is the one
                                        failure this app cannot detect: nothing throws, every
                                        gate has already passed it, and the only detector is
                                        a person who knows what they were meant to be looking
                                        at. The "Fix this" button on every visual writes what
                                        they said, the drawing they said it about, and what
                                        the model produced afterwards, into one local file.

                                        The panel exists so that file is not a secret. It is
                                        the learner's, it never leaves the machine on its
                                        own, and the whole point of keeping it is that they
                                        can choose to attach it to an issue — so the two
                                        things to offer are the file and a way to delete it. */}
                                    <section className="px-4 py-4">
                                        <h3 className="flex items-center gap-2 font-medium text-slate-900 dark:text-white">
                                            <MessageSquareWarning className="w-4 h-4 shrink-0 text-accent-fg" aria-hidden="true" />
                                            {tr("Visual feedback")}
                                        </h3>
                                        {/* ONE key, the button's name a placeholder:
                                            the sentence was three keys around a bold
                                            "Fix this", and each language translated
                                            its fragments in English order —
                                            Japanese read 使用するたびに + これを修正 +
                                            図、チャート…上で. */}
                                        <SettingNote className="mt-1">
                                            {tr("Each time you press “{{fix}}” on a diagram, chart, animation or widget, your note and what the AI drew next are added to this file. Share it to get a bad drawing fixed for everyone.", { fix: tr("Fix this") })}
                                        </SettingNote>
                                        {/* The same foot as the log's: what is in the
                                            file on the left, what you can do with it
                                            on the right. */}
                                        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                                            <div className="min-w-0 flex-1 basis-48 text-sm text-slate-500 dark:text-slate-400">
                                                {visualFeedback && visualFeedback.count > 0 ? (
                                                    <>
                                                        {/* A path is a place, not a fact to read:
                                                            the file name and the size are the
                                                            line; the whole path opens on demand
                                                            instead of running `break-all` across
                                                            the card. */}
                                                        <p>
                                                            <span className="font-medium text-slate-700 dark:text-slate-200">{tr("{{count}} reports", { count: visualFeedback.count })}</span>{' · '}
                                                            <code className="text-xs">{visualFeedback.path.split(/[\\/]+/).filter(Boolean).pop()}</code>{' '}
                                                            <span className="whitespace-nowrap">{tr("· {{value}} KB", { value: (visualFeedback.bytes / 1024).toFixed(1) })}</span>
                                                        </p>
                                                        <Explain summary={tr("Show the full path")} className="mt-0.5">
                                                            <p className="break-all">{visualFeedback.path}</p>
                                                        </Explain>
                                                    </>
                                                ) : (
                                                    // The note above already says how a report
                                                    // gets here; the empty state only says there
                                                    // is none yet.
                                                    <p>
                                                        {visualFeedback === null
                                                            ? tr("Checking…")
                                                            : tr("Nothing reported yet")}
                                                    </p>
                                                )}
                                            </div>
                                            <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
                                                <ButtonLink
                                                    href="/api/visual-feedback/export"
                                                    download="visual-feedback.jsonl"
                                                    className={!visualFeedback?.count ? 'pointer-events-none opacity-45' : undefined}
                                                    aria-disabled={!visualFeedback?.count}
                                                    icon={<Download className="w-4 h-4" aria-hidden="true" />}
                                                >
                                                    {tr("Download")}
                                                </ButtonLink>
                                                <Button
                                                    variant="danger"
                                                    disabled={!visualFeedback?.count}
                                                    onClick={async () => {
                                                        if (!(await showConfirm({
                                                            title: tr("Delete the visual feedback file?"),
                                                            message: tr("Every report you have written is removed from this machine. Download it first if you meant to share it."),
                                                            confirmLabel: tr("Delete"),
                                                            variant: 'danger',
                                                        }))) return;
                                                        try {
                                                            await api.clearVisualFeedback();
                                                            setVisualFeedback(await api.visualFeedbackSummary());
                                                            addToast('success', tr("Visual feedback deleted"));
                                                        } catch (e: any) {
                                                            addToast('error', tr("Could not delete the file"), e?.message);
                                                        }
                                                    }}
                                                    icon={<Trash2 className="w-4 h-4" aria-hidden="true" />}
                                                >
                                                    {tr("Delete")}
                                                </Button>
                                            </div>
                                        </div>
                                    </section>
                                </div>
                            </ExpandableSection>
                        </div>


                        {/* AI CONNECTION (provider-agnostic) */}
                        <section className={activeTab === 'ai' ? 'mb-8' : 'hidden'}>
                            {/* "AI Provider" named the setting, not the section: what
                                is chosen here is the MODEL, and the provider is one of
                                four fields under it. */}
                            <SectionHeader title={tr("The model")} icon={Cpu}>
                                {tr("Connect a model — it powers tutoring, generated lessons, quizzes and flashcards.")}
                            </SectionHeader>
                            {/* The body answers the SUMMARY's question and nothing
                                else. It used to open with "What powers tutoring,
                                generated lessons, quizzes and flashcards." — the same
                                four features the section header above it and the
                                switch below it both already name, and not an answer
                                to "where does my data go", which is what someone
                                opens this to read. */}
                            <Explain summary={tr("Where your data goes")} className="mb-4">
                                {tr("Whatever you connect here is the only place this app sends your studying. With Ollama the model runs on this machine and nothing leaves it; with a hosted API, the text a lesson or a chat turn needs goes to that company under your own key — and nowhere else.")}
                            </Explain>
                            <div className="bg-white dark:bg-slate-800 rounded-xl p-4 shadow-sm space-y-4">
                                {/* Enable AI. Everything below it is configuration for
                                    something that is off, so the switch owns it. */}
                                <div className="flex items-center justify-between gap-4">
                                    <div className="min-w-0">
                                        <p className="font-medium text-slate-900 dark:text-white">{tr("Use AI features")}</p>
                                        <p className="text-sm text-slate-500 dark:text-slate-400">
                                            {tr("Tutoring, generated lessons, quizzes and flashcards. Everything else in the app works without it.")}
                                        </p>
                                    </div>
                                    <Switch checked={aiEnabled} onChange={handleToggleAI} label={tr("Use AI features")} />
                                </div>

                                {/* Everything below configures the AI — pointless while
                                    it's off, so the toggle collapses it away. */}
                                <Collapse open={aiEnabled}>
                                <div className="pt-4 space-y-4">
                                {/* PROVIDER — a two-way choice, so a segmented
                                    control and one line of prose, not two 90px
                                    cards. The cards spent a fifth of the panel
                                    restating what the endpoint field below them
                                    already asks for. */}
                                <Field
                                    label={tr("Where the model runs")}
                                    help={provider === 'ollama'
                                        ? tr("Ollama on this machine: install, delete and run models from here.")
                                        : tr("Anything speaking the /v1 chat-completions protocol — llama-swap, llama.cpp, LM Studio, OpenRouter, OpenAI.")}
                                >
                                    {() => (
                                        <SegmentedControl
                                            label={tr("AI provider")}
                                            value={provider}
                                            onChange={v => void handleProviderChange(v as AIProvider)}
                                            options={[
                                                { value: 'ollama', label: tr("Ollama") },
                                                { value: 'openai', label: tr("OpenAI-compatible API") },
                                            ]}
                                        />
                                    )}
                                </Field>

                                {/* ENDPOINT — one field and one Test button for both
                                    providers; only the label and the presets differ.
                                    Two separate branches is how the same setting ended
                                    up two different shapes. */}
                                <Field
                                    label={provider === 'ollama' ? tr("Ollama URL") : tr("API base URL")}
                                >
                                    {id => (
                                        <div className="flex gap-2">
                                            <TextInput
                                                id={id}
                                                value={provider === 'ollama' ? ollamaUrl : apiBaseUrl}
                                                onChange={e => provider === 'ollama' ? setOllamaUrl(e.target.value) : setApiBaseUrl(e.target.value)}
                                                placeholder={provider === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:8888/v1'}
                                                spellCheck={false}
                                                autoComplete="off"
                                            />
                                            <Button
                                                variant="neutral"
                                                onClick={handleCheckConnection}
                                                busy={connectionStatus === 'checking'}
                                                className="shrink-0"
                                            >
                                                {tr("Test")}
                                            </Button>
                                        </div>
                                    )}
                                </Field>

                                {provider === 'openai' && (
                                    <div>
                                        {/* The caption belongs to the buttons UNDER it, so
                                            it sits tight to them and a full gap below the
                                            field above. As the field's hint it read as a
                                            note about the field it was nearest. */}
                                        <p className="mb-1.5 text-sm text-slate-500 dark:text-slate-400">
                                            {tr("Common endpoints, if you would rather not remember the port:")}
                                        </p>
                                        <div className="flex flex-wrap gap-1.5">
                                        {/* Shortcuts, not a selection: the one that
                                            matches is ticked, never filled. A solid
                                            accent chip here read as the most important
                                            button on the panel, which it is not.

                                            The tick is always in the layout and only
                                            sometimes visible. Adding it on selection
                                            grew that chip by 20px (measured: llama-swap
                                            82→102, llama.cpp 72→92), which in a
                                            `flex-wrap` row is paid by the chip at the
                                            end of the line — at 412px, choosing the
                                            first preset pushed the fourth onto a second
                                            row. Pressing one shortcut must not move the
                                            others. */}
                                        {API_PRESETS.map(preset => {
                                            const on = apiBaseUrl === preset.url;
                                            return (
                                                <Button
                                                    key={preset.label}
                                                    size="sm"
                                                    variant="subtle"
                                                    aria-pressed={on}
                                                    icon={<Check className={`w-3.5 h-3.5 text-accent-fg ${on ? '' : 'invisible'}`} aria-hidden="true" />}
                                                    title={`${tr(preset.hint)} — ${preset.url}`}
                                                    onClick={() => setApiBaseUrl(preset.url)}
                                                    className={on ? 'ring-1 ring-accent/50 text-accent-fg' : undefined}
                                                >
                                                    {preset.label}
                                                </Button>
                                            );
                                        })}
                                        </div>
                                    </div>
                                )}

                                {provider === 'openai' && (
                                    <Field
                                        label={tr("API key")}
                                        help={apiKeySaved && !apiKey ? tr("A key is saved — type a replacement, or press Clear.") : tr("Optional for a local server.")}
                                        hint={<>
                                            {tr("Stored locally in your database, sent only to the base URL above. You can also set")}{' '}
                                            <code className="bg-slate-100 dark:bg-slate-700 px-1 rounded">OPENAI_API_KEY</code> {tr("in")}{' '}<code className="bg-slate-100 dark:bg-slate-700 px-1 rounded">.env</code> {tr("instead.")}
                                        </>}
                                    >
                                        {id => (
                                            <div className="flex gap-2">
                                                <TextInput
                                                    id={id}
                                                    type="password"
                                                    value={apiKey}
                                                    onChange={e => setApiKey(e.target.value)}
                                                    onBlur={handleApiKeyBlur}
                                                    autoComplete="off"
                                                    placeholder={tr("sk-...")}
                                                />
                                                {/* A stored credential needs a way OUT, not
                                                    only a way in: clearing the field and
                                                    clicking away did remove it, silently. */}
                                                {apiKeySaved && (
                                                    <Button
                                                        variant="neutral"
                                                        onClick={clearApiKey}
                                                        icon={<Trash2 className="w-4 h-4" aria-hidden="true" />}
                                                        className="shrink-0"
                                                    >
                                                        {tr("Clear")}
                                                    </Button>
                                                )}
                                            </div>
                                        )}
                                    </Field>
                                )}

                                {/* MODEL — one picker for both providers, and the same
                                    one the four other model settings use. */}
                                <Field
                                    label={tr("Model")}
                                    aside={connectionStatus ? (
                                        <StatusDot tone={connectionStatus === 'connected' ? 'ok' : connectionStatus === 'disconnected' ? 'bad' : 'busy'}>
                                            {connectionStatus === 'checking' && tr("Checking…")}
                                            {connectionStatus === 'connected' && tr("Connected")}
                                            {connectionStatus === 'disconnected' && (connectionError || tr("Not connected"))}
                                        </StatusDot>
                                    ) : undefined}
                                    hint={tr("Browse what the endpoint reports, or type any id it accepts — an llama-swap alias works.")}
                                >
                                    {id => (
                                        <ModelPicker
                                            id={id}
                                            label={tr("Model")}
                                            value={currentModel}
                                            onChange={chooseModel}
                                            models={models}
                                            loading={modelsLoading}
                                            onRefresh={loadModels}
                                            onDelete={provider === 'ollama' ? handleDeleteModel : undefined}
                                            placeholder={tr("Choose or type a model id")}
                                        />
                                    )}
                                </Field>

                                {/* SIZE GUIDANCE — folded in beside the picker and
                                    closed, because it is read once: advice on how
                                    to choose belongs next to the choosing, not in
                                    its own section after it. */}
                                <Explain summary={tr("What size of model does this app need?")}>
                                    <div className="space-y-3">
                                        <p className="text-sm text-slate-500 dark:text-slate-400">
                                            {tr("This app asks a model to write a curriculum, teach a topic across several parts and author questions whose answer key survives a second, independent check. That is a harder job than chatting, and size is what decides whether it holds up. No model is named here on purpose — names change every few weeks, size classes do not.")}
                                        </p>
                                        {MODEL_TIERS.map(t => (
                                            <div key={t.id} className="flex gap-2.5">
                                                <span className={`mt-1.5 w-1.5 h-1.5 shrink-0 rounded-full ${TIER_DOT[t.tone]}`} aria-hidden="true" />
                                                <div className="min-w-0">
                                                    <p className="text-sm font-medium text-slate-900 dark:text-white">
                                                        {tr(t.label)} <span className="font-normal text-sm text-slate-500 dark:text-slate-400">{t.range}</span>
                                                    </p>
                                                    <p className="text-sm text-slate-500 dark:text-slate-400">{tr(t.detail)}</p>
                                                </div>
                                            </div>
                                        ))}
                                        <p className="text-sm text-slate-500 dark:text-slate-400">
                                            {tr("Age counts for as much as size. Models released in the last few months regularly beat models several times their size from a year before, so a recent small model is usually the better bet over an old large one — and a recent model in the size class above is better still.")}
                                        </p>
                                        <p className="text-sm text-slate-500 dark:text-slate-400">
                                            {tr("No GPU, or you would rather rent one: point the provider above at an OpenAI-compatible endpoint and paste your own key. The same size classes apply there — renting a model does not make it a bigger one.")}
                                        </p>
                                    </div>
                                </Explain>

                                {/* HOW HARD IT THINKS, AND WHO SERVES IT — both are
                                    hosted-endpoint concerns, so neither is drawn for a
                                    local Ollama, which understands neither field.

                                    Thinking comes first because it is the bigger lever
                                    and it works on every endpoint: on the model
                                    configured here it was ~8 seconds of the wait and
                                    ~85% of the bill. The provider list is second,
                                    collapsed, and costs a request to open — a router is
                                    the only kind of endpoint that has one. */}
                                {provider === 'openai' && (
                                    <>
                                        <ThinkingSlider value={reasoningEffort} onChange={chooseReasoningEffort} />

                                        <Explain
                                            summary={<>
                                                {tr("Which machine serves this model")}
                                                {providerOrder.length > 0 && (
                                                    <span className="ml-2 font-normal text-slate-500 dark:text-slate-400">
                                                        {tr("{{fmt}} preferred providers", { count: providerOrder.length, fmt: num(providerOrder.length) })}
                                                    </span>
                                                )}
                                            </>}
                                            onToggle={e => { if ((e.currentTarget as HTMLDetailsElement).open && servingEndpoints === null) loadServingEndpoints(); }}
                                        >
                                            <div className="space-y-3">
                                                <p className="text-sm text-slate-500 dark:text-slate-400">
                                                    {tr("A model id on a router is not one machine. Several companies run the same model, and they differ in speed, in price, in how precisely they run it — and in how much the model thinks. Left alone the router picks for you, usually by price.")}
                                                </p>

                                                <Field label={tr("When you have no preference, pick by")}>
                                                    {() => (
                                                        <SegmentedControl
                                                            label={tr("When you have no preference, pick by")}
                                                            value={providerSort}
                                                            onChange={chooseProviderSort}
                                                            options={[
                                                                { value: '', label: tr("Router's choice") },
                                                                { value: 'price', label: tr("Price") },
                                                                { value: 'throughput', label: tr("Speed") },
                                                                { value: 'latency', label: tr("First word") },
                                                            ]}
                                                        />
                                                    )}
                                                </Field>

                                                {endpointsLoading && (
                                                    <p className="text-sm text-slate-500 dark:text-slate-400">{tr("Asking the endpoint who can serve it…")}</p>
                                                )}

                                                {!endpointsLoading && servingEndpoints !== null && servingEndpoints.length === 0 && (
                                                    <p className="text-sm text-slate-500 dark:text-slate-400">
                                                        {tr("This endpoint does not publish a list of the machines behind it, so there is nothing to choose between. The setting above is all that applies.")}
                                                    </p>
                                                )}

                                                {!endpointsLoading && servingEndpoints !== null && servingEndpoints.length > 0 && (
                                                    <>
                                                        <p className="text-sm text-slate-500 dark:text-slate-400">
                                                            {tr("Tick the ones you would rather have, in the order you would rather have them. They are a preference, not a rule: if the first is busy the next is tried, because a slower answer beats a failed lesson.")}
                                                        </p>
                                                        {/* A TABLE, because the four things that
                                                            decide between these machines are four
                                                            numbers and a reader compares numbers
                                                            down a column. As a list of sentences
                                                            ("$0.25 per million tokens out · 99% up")
                                                            the same figures sat at a different
                                                            horizontal position in every row, and
                                                            the price that was NOT shown — what the
                                                            model reads, which a long lesson prompt
                                                            makes the bigger half of the bill — had
                                                            nowhere to go.

                                                            Ticked ones still float to the top in
                                                            the order they were ticked ("2." above
                                                            "1." made a sentence about order into a
                                                            puzzle). The rest are sorted by IN plus
                                                            OUT, since a cheap read and a dear write
                                                            is not a cheap machine; anything
                                                            reporting no price at all goes last
                                                            rather than leading the table as free. */}
                                                        <div className="overflow-x-auto">
                                                            <table className="w-full border-collapse">
                                                                <thead>
                                                                    <tr className="border-b border-slate-200 dark:border-slate-700 text-left text-xs font-medium text-slate-500 dark:text-slate-400">
                                                                        <th scope="col" className="w-0 py-1.5 pr-2.5">
                                                                            <span className="sr-only">{tr("Preferred")}</span>
                                                                        </th>
                                                                        <th scope="col" className="w-full py-1.5 pr-2">{tr("Provider")}</th>
                                                                        <th scope="col" className="py-1.5 px-1.5 text-right whitespace-nowrap">{tr("In")}</th>
                                                                        <th scope="col" className="py-1.5 px-1.5 text-right whitespace-nowrap">{tr("Out")}</th>
                                                                        <th scope="col" className="py-1.5 pl-1.5 text-right whitespace-nowrap">{tr("Uptime")}</th>
                                                                    </tr>
                                                                </thead>
                                                                <tbody>
                                                                    {[...servingEndpoints].sort((a, b) => {
                                                                        const ra = providerOrder.indexOf(a.slug), rb = providerOrder.indexOf(b.slug);
                                                                        if (ra >= 0 && rb >= 0) return ra - rb;
                                                                        if (ra >= 0) return -1;
                                                                        if (rb >= 0) return 1;
                                                                        const pa = a.promptPrice + a.completionPrice;
                                                                        const pb = b.promptPrice + b.completionPrice;
                                                                        if ((pa > 0) !== (pb > 0)) return pa > 0 ? -1 : 1;
                                                                        if (pa !== pb) return pa - pb;
                                                                        // Two machines can carry the same name
                                                                        // (one endpoint lists "Sail Research"
                                                                        // twice), so the slug settles it.
                                                                        if (a.name !== b.name) return a.name < b.name ? -1 : 1;
                                                                        return a.slug < b.slug ? -1 : 1;
                                                                    }).map(ep => {
                                                                        const rank = providerOrder.indexOf(ep.slug);
                                                                        const boxId = `serving-${ep.slug}`;
                                                                        return (
                                                                            <tr key={ep.slug} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                                                                                <td className="py-2 touch:py-3 pr-2.5 align-middle">
                                                                                    <Checkbox
                                                                                        id={boxId}
                                                                                        checked={rank >= 0}
                                                                                        onChange={() => toggleProvider(ep.slug)}
                                                                                        aria-label={ep.name}
                                                                                    />
                                                                                </td>
                                                                                <th scope="row" className="py-2 touch:py-3 pr-2 align-middle font-normal">
                                                                                    {/* The name is the checkbox's label, so the
                                                                                        whole cell is part of the target. */}
                                                                                    <label htmlFor={boxId} className="flex items-baseline gap-1.5 flex-wrap cursor-pointer text-left">
                                                                                        {rank >= 0 && (
                                                                                            <span className="text-sm font-semibold text-accent-fg tabular-nums">{num(rank + 1)}.</span>
                                                                                        )}
                                                                                        <span className="text-sm font-medium text-slate-900 dark:text-white">{ep.name}</span>
                                                                                        {ep.quantization && (
                                                                                            <span className="text-xs text-slate-500 dark:text-slate-400">{ep.quantization}</span>
                                                                                        )}
                                                                                    </label>
                                                                                </th>
                                                                                <td className="py-2 touch:py-3 px-1.5 text-right align-middle text-sm tabular-nums whitespace-nowrap text-slate-600 dark:text-slate-300">
                                                                                    {ep.promptPrice > 0 ? `$${num(ep.promptPrice, { decimals: 2 })}` : <NotReported label={tr("Not reported")} />}
                                                                                </td>
                                                                                <td className="py-2 touch:py-3 px-1.5 text-right align-middle text-sm tabular-nums whitespace-nowrap text-slate-600 dark:text-slate-300">
                                                                                    {ep.completionPrice > 0 ? `$${num(ep.completionPrice, { decimals: 2 })}` : <NotReported label={tr("Not reported")} />}
                                                                                </td>
                                                                                <td className="py-2 touch:py-3 pl-1.5 text-right align-middle text-sm tabular-nums whitespace-nowrap text-slate-600 dark:text-slate-300">
                                                                                    {ep.uptime !== null ? `${num(Math.round(ep.uptime))}%` : <NotReported label={tr("Not reported")} />}
                                                                                </td>
                                                                            </tr>
                                                                        );
                                                                    })}
                                                                </tbody>
                                                            </table>
                                                        </div>
                                                        <p className="text-sm text-slate-500 dark:text-slate-400">
                                                            {tr("In and Out are dollars per million tokens — what the model reads, and what it writes. Uptime is the last half hour.")}
                                                        </p>
                                                    </>
                                                )}
                                            </div>
                                        </Explain>
                                    </>
                                )}

                                {/* PULL A MODEL — Ollama only; an API endpoint manages
                                    its own models server-side. */}
                                {provider === 'ollama' && (
                                    <Field
                                        label={tr("Install another model")}
                                        hint={<>
                                            {tr("Browse models at")}{' '}
                                            <a href="https://ollama.com/library" target="_blank" rel="noopener noreferrer" className="text-accent-fg hover:underline">
                                                ollama.com/library
                                            </a>
                                        </>}
                                    >
                                        {id => (
                                            <>
                                                <div className="flex flex-col sm:flex-row gap-2">
                                                    <TextInput
                                                        id={id}
                                                        value={newModelName}
                                                        onChange={e => setNewModelName(e.target.value)}
                                                        disabled={installing}
                                                        placeholder={tr("model:tag from your provider's library")}
                                                        onKeyDown={e => {
                                                            if (e.key === 'Enter' && !installing && newModelName.trim()) handleInstallModel();
                                                        }}
                                                    />
                                                    <Button
                                                        variant="primary"
                                                        onClick={() => handleInstallModel()}
                                                        disabled={!newModelName.trim()}
                                                        busy={installing && !installingModelId}
                                                        className="shrink-0"
                                                    >
                                                        {tr("Install")}
                                                    </Button>
                                                </div>
                                                {installing && !installingModelId && installProgress && (
                                                    <div className="mt-3">
                                                        <div className="flex items-center justify-between text-sm text-slate-600 dark:text-slate-300 mb-1">
                                                            <span className="truncate">{installProgress.status}</span>
                                                            {installProgress.total && installProgress.completed && (
                                                                <span className="ml-2 tabular-nums">{getInstallProgressPercent()}%</span>
                                                            )}
                                                        </div>
                                                        {installProgress.total && installProgress.completed && (
                                                            <div className="w-full h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                                                                <div className="h-full bg-accent transition-all duration-300" style={{ width: `${getInstallProgressPercent()}%` }} />
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                                {installError && !installingModelId && (
                                                    <p className="mt-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-sm text-red-700 dark:text-red-300">
                                                        {installError}
                                                    </p>
                                                )}
                                            </>
                                        )}
                                    </Field>
                                )}
                                </div>
                                </Collapse>
                            </div>
                        </section>


                        {/* ANSWERING WITH THE WEB — the switch and the engine it
                            searches, in one section, so no cross-reference between
                            peers is needed. Off until asked for, because a typed
                            question is a far more personal thing to hand a search
                            engine than a topic title (see SECURITY.md's
                            packet-capture claim). */}
                        <section className={activeTab === 'ai' ? 'mb-8' : 'hidden'}>
                            <SectionHeader title={tr("Answering with the web")} icon={Globe}>
                                {tr("Lets the tutor and the assistant look something up while answering, and cite the pages they used.")}
                            </SectionHeader>
                            <Explain summary={tr("What is sent, and why it ships off")} className="mb-4">
                                {tr("This is the one feature that sends anything you typed, so it ships off. With it on, what goes out is the search terms the tutor writes — not your question verbatim — and every answer ends with the ones it used.")}
                            </Explain>
                            <Panel flush className="divide-y divide-slate-100 dark:divide-slate-700/60">
                                {/* ONE SWITCH. It was three states — never, ask
                                    each question, whenever it helps — and two of
                                    them described the same wire: the model decides
                                    mid-answer whether it needs a lookup, so "ask"
                                    and "whenever it helps" both mean the tool is
                                    there. A choice whose options cannot be told
                                    apart by what happens is not a choice, and the
                                    per-question switch beside the composer asked
                                    the same permission a second time. What replaced
                                    it is a line under the composer saying the
                                    answer CAN search — state, not a control. */}
                                <div className="p-4">
                                    <div className="flex items-center justify-between gap-4">
                                        <div className="min-w-0">
                                            <p className="font-medium text-slate-900 dark:text-white">{tr("Let answers use the web")}</p>
                                            <p className="text-sm text-slate-500 dark:text-slate-400">
                                                {tr("The tutor and the assistant decide for themselves whether a question needs looking up, and write their own search terms — so an answer can check this year’s rule without you having to know it had to. Each answer shows what it searched for, and links every page it used.")}
                                            </p>
                                        </div>
                                        <Switch checked={webSearch} onChange={saveWebSearch} label={tr("Let answers use the web")} />
                                    </div>
                                </div>
                                <div className="p-4">
                                    <Field
                                        label={<>{tr("Search engine")}{' '}<span className="font-normal text-slate-500 dark:text-slate-400">{tr("(optional)")}</span></>}
                                        help={tr("A self-hosted SearXNG instance. Its results are added on top of the built-in Wikipedia, DuckDuckGo and GitHub sources — both when the AI curates learning resources and when it answers with the web.")}
                                        hint={<>{tr("Self-hosted meta-search engine. Run")}{' '}<code className="bg-slate-100 dark:bg-slate-700 px-1 rounded">docker run -d -p 8080:8080 searxng/searxng</code> {tr("to get started.")}</>}
                                    >
                                        {id => (
                                            <div className="flex flex-col sm:flex-row gap-2">
                                                <TextInput
                                                    id={id}
                                                    ref={searxngInputRef}
                                                    value={searxngUrl}
                                                    onChange={e => {
                                                        searxngSkipBlurRef.current = false;
                                                        setSearxngUrl(e.target.value);
                                                    }}
                                                    onFocus={() => { searxngSkipBlurRef.current = false; }}
                                                    onBlur={handleSearxngSave}
                                                    onKeyDown={e => {
                                                        if (e.key === 'Enter') {
                                                            e.preventDefault();
                                                            handleSearxngSave();
                                                        }
                                                    }}
                                                    spellCheck={false}
                                                    autoComplete="off"
                                                    placeholder="http://localhost:8080"
                                                />
                                                {/* Two buttons BESIDE each other at every width.
                                                    They were `w-full` below `sm`, which on a
                                                    phone drew the field and both actions as
                                                    three stacked full-width bars — a shape that
                                                    says "three equal things to do" about one
                                                    field and two small actions on it. They are
                                                    short words; they fit a 390px row with room
                                                    to spare. */}
                                                <div className="flex gap-2 shrink-0">
                                                    <Button onClick={handleTestSearxng}>{tr("Test")}</Button>
                                                    <Button onClick={handleSetDefaultSearxng}>{tr("Use the default")}</Button>
                                                </div>
                                            </div>
                                        )}
                                    </Field>
                                </div>
                                <div className="p-4">
                                    {/* One line at the surface, the why behind the
                                        disclosure: the paragraph that rode on the
                                        first field was the longest text left in the
                                        open page, and it was about all three keys,
                                        not Tavily's. */}
                                    {/* Stays a LINE, not a "More": this block has no label
                                        of its own, and a named disclosure ("Why add a key")
                                        sits directly under it. Two chevrons stacked, one of
                                        them unnamed, is worse than the sentence. */}
                                    <p className="mb-3 max-w-prose text-sm text-slate-500 dark:text-slate-400">
                                        {tr("A key joins that engine to every search, on top of the built-in ones — stored in your database, sent only to its own service.")}
                                    </p>
                                    <Explain summary={tr("Why add a key")} className="mb-4">
                                        {tr("Steadier when DuckDuckGo throttles, and some engines return the page text with their results, so an answer can read more than a snippet. Without a key, that engine simply doesn’t connect.")}
                                    </Explain>
                                    {/* THREE CARDS ACROSS, not three stacked rows. They
                                        are the same control three times over — one
                                        field, one optional pair of buttons — and stacked
                                        they read as three separate settings and cost
                                        three screenfuls of scroll on a phone to say one
                                        thing. The grid is CONTAINER-driven
                                        (`auto-fit` + a minimum), never a breakpoint: this
                                        panel is also drawn in a ~390px workspace column
                                        on a wide screen, where `sm:` would promise room
                                        that is not there. Three across on a desktop
                                        panel, two in a narrow one, one on a phone, and
                                        nothing in the markup knows which.

                                        `auto-rows-fr` + `mt-auto` keeps the buttons on a
                                        line when only one card has a key saved — the
                                        Projects grid's device, and never a reserved
                                        invisible row. */}
                                    <div className="grid gap-3 auto-rows-fr grid-cols-[repeat(auto-fit,minmax(13rem,1fr))]">
                                        {SEARCH_PROVIDERS.map(({ id: pid, label }) => {
                                            const status = searchKeyStatus[pid];
                                            // A key that is saved but was never asked
                                            // anything is grey, not green: only a real
                                            // request can say "connected", and this panel
                                            // does not spend one to draw itself.
                                            const badge = status.state === 'checking' ? <StatusDot tone="busy">{tr("Checking…")}</StatusDot>
                                                : status.state === 'ok' ? <StatusDot tone="ok">{tr("Connected")}</StatusDot>
                                                    : status.state === 'failed' ? <StatusDot tone="bad" title={status.detail}>{tr("Not connected")}</StatusDot>
                                                        : status.state === 'unknown' ? <StatusDot tone="idle">{tr("Not checked")}</StatusDot>
                                                            : undefined;
                                            return (
                                                <div key={pid} className="flex flex-col rounded-lg border border-slate-200 dark:border-slate-700 p-3">
                                                    <Field label={label} aside={badge}>
                                                        {id => (
                                                            <TextInput
                                                                id={id}
                                                                type="password"
                                                                value={searchKeyInputs[pid]}
                                                                onChange={e => setSearchKeyInputs(s => ({ ...s, [pid]: e.target.value }))}
                                                                onBlur={() => handleSearchKeyBlur(pid)}
                                                                autoComplete="off"
                                                                spellCheck={false}
                                                                placeholder={searchKeySaved[pid] ? tr("A key is saved — type a replacement") : tr("API key")}
                                                            />
                                                        )}
                                                    </Field>
                                                    {/* Why it is not connected, in the service's
                                                        own words: "declined with 401" is a
                                                        mistyped key and "declined with 429" is a
                                                        quota, and the two want opposite actions. */}
                                                    {status.state === 'failed' && status.detail && (
                                                        <p className="mt-1.5 text-xs text-red-700 dark:text-red-400 break-words">{status.detail}</p>
                                                    )}
                                                    {searchKeySaved[pid] && (
                                                        <div className="mt-auto flex gap-2 pt-3">
                                                            <Button
                                                                size="sm"
                                                                variant="neutral"
                                                                onClick={() => testSearchKey(pid)}
                                                                busy={status.state === 'checking'}
                                                            >
                                                                {tr("Test")}
                                                            </Button>
                                                            <Button
                                                                size="sm"
                                                                variant="neutral"
                                                                onClick={() => clearSearchKey(pid)}
                                                                icon={<Trash2 className="w-4 h-4" aria-hidden="true" />}
                                                            >
                                                                {tr("Clear")}
                                                            </Button>
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            </Panel>
                        </section>

                        {/* VISUALS — every kind the tutor may draw, as a gallery with a switch each
                            (src/components/settings/VisualKindsPanel.tsx). */}
                        <section className={activeTab === 'ai' ? 'mb-8' : 'hidden'}>
                            <VisualKindsPanel active={activeTab === 'ai'} />
                        </section>

                        {/* MODEL JOBS — the five background jobs that can spend model
                            calls. Each was its own section with its own heading and
                            its own paragraph; together they were a wall of five
                            headings between the model setup and Setup help, and
                            answering "what uses my model while I am not looking"
                            meant reading all five. They are one panel now: one row
                            per job — name, one line on what it does, its current
                            state on the CLOSED row — and the job's own controls in
                            the opened body, unchanged. The state on the closed row
                            is the read-only answer and each body carries the
                            control that sets it, so nothing a reader would act on
                            hides behind a closed row. The long paragraphs keep
                            their keys by moving verbatim into the disclosure. */}
                        <section className={activeTab === 'ai' ? 'mb-8' : 'hidden'}>
                            <SectionHeader title={tr("Model jobs")} icon={Sparkles}>
                                {tr("Background jobs that use the model while you are away. None runs without your setting — most ship off.")}
                            </SectionHeader>
                            {/* A full-strength divider, not the hairline the other lists
                                use: these rows OPEN, and two open neighbours are two grey
                                bodies that a `slate-100` line could not part. */}
                            <Panel flush className="divide-y divide-slate-200 dark:divide-slate-700">
                                <ModelJobRow
                                    icon={Sparkles}
                                    title={tr("Resource hunting")}
                                    desc={tr("While a project is generated, the AI can search the web and pick links for every topic in it.")}
                                    aside={findResources ? tr("On") : tr("Off")}
                                >
                                    <label className="flex items-start gap-3 cursor-pointer">
                                        <Checkbox checked={findResources} onChange={saveFindResources} className="mt-1" />
                                        <span className="min-w-0">
                                            <span className="block font-medium text-slate-900 dark:text-white">
                                                {tr("Find resources for every topic during creation")}
                                            </span>
                                            <span className="block text-sm text-slate-500 dark:text-slate-400">
                                                {tr("Turn this off for large projects. Existing projects are unaffected, and you can always use “Find resources” on a topic to fetch links on demand.")}
                                            </span>
                                        </span>
                                    </label>
                                    <Explain summary={tr("What it costs on a big project")} className="mt-3">
                                        <p>
                                            {tr("While generating a project, the AI can search the web and pick 2–4 links for")}
                                            <em> {tr("every single topic")}</em>{tr(". It is by a wide margin the largest part of creation — a 700-topic curriculum means 700 searches and 700 model calls, before you’ve read a word. With it off, creation skips every one of them and you fetch links from a topic’s Resources list when you actually open it.")}
                                        </p>
                                    </Explain>
                                </ModelJobRow>

                                <ModelJobRow
                                    icon={FileText}
                                    title={tr("PDF math recovery")}
                                    desc={tr("When a vault PDF has lost its formulas to the text layer, those pages are re-read from the rendered image in the background.")}
                                    aside={recoveryMode === 'auto' ? tr("Auto (recommended)")
                                        : recoveryMode === 'vision' ? tr("Prefer vision model")
                                            : recoveryMode === 'ocr' ? tr("OCR only")
                                                : tr("Off")}
                                >
                                    <div className="space-y-2">
                                        {([
                                            { value: 'auto', label: tr("Auto (recommended)"), desc: tr("Use a vision model when the app can confirm the model supports images (Ollama); otherwise OCR.") },
                                            { value: 'vision', label: tr("Prefer vision model"), desc: tr("Always send pages to your model as images. Choose this only if your API endpoint serves a vision model — a text-only model will invent formulas.") },
                                            { value: 'ocr', label: tr("OCR only"), desc: tr("Never use the model; recover with local OCR. Fully offline, but mangles some notation.") },
                                            { value: 'off', label: tr("Off"), desc: tr("Don't recover — keep the raw text layer even when formulas are missing.") },
                                        ] as const).map(opt => (
                                            <label
                                                key={opt.value}
                                                className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition ${recoveryMode === opt.value
                                                    ? 'border-accent bg-accent/5'
                                                    : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700/50'}`}
                                            >
                                                <Radio
                                                    name="recovery-mode"
                                                    value={opt.value}
                                                    checked={recoveryMode === opt.value}
                                                    onChange={() => saveRecoveryMode(opt.value)}
                                                    className="mt-0.5"
                                                />
                                                <span className="min-w-0">
                                                    <span className="block font-medium text-slate-900 dark:text-white">{opt.label}</span>
                                                    <span className="block text-sm text-slate-500 dark:text-slate-400">{opt.desc}</span>
                                                </span>
                                            </label>
                                        ))}

                                        {/* Dedicated vision model — so chat can stay on a text-only
                                            model while pages are transcribed by a vision model on the
                                            same provider. Only relevant when vision may run. */}
                                        {(recoveryMode === 'auto' || recoveryMode === 'vision') && (
                                            <div className="pt-2 mt-1 border-t border-slate-100 dark:border-slate-700/60">
                                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1">
                                                    {tr("Vision model")}
                                                </label>
                                                <p className="text-sm text-slate-500 dark:text-slate-400 mb-2">
                                                    {tr("Which model transcribes the pages. Leave as the chat model, or pick a vision-capable one (e.g. run tutoring on a text model and recovery on a vision model).")}
                                                </p>
                                                <ModelPicker
                                                    label={tr("Vision model")}
                                                    value={recoveryVisionModel}
                                                    onChange={saveRecoveryVisionModel}
                                                    models={models}
                                                    loading={modelsLoading}
                                                    onRefresh={loadModels}
                                                    inherit={{ label: tr("Same as the chat model"), detail: currentModel || undefined }}
                                                />
                                            </div>
                                        )}
                                    </div>
                                    <Explain summary={tr("Which PDFs are affected")} className="mt-3">
                                        <p>
                                            {tr("Some PDFs (Word/LaTeX exports of exams & worksheets) store their formulas in fonts with no text mapping, so an equation like")}{' '}<code>x(t) = 1 − t²</code> {tr("is extracted as an empty")}
                                            <code> ( )</code>{tr(". When a vault PDF is detected like this, the affected pages are re-read from the rendered image in the background — a vision model transcribes them to clean Markdown + LaTeX, and OCR is the offline fallback. Clean PDFs are untouched.")}
                                        </p>
                                    </Explain>
                                </ModelJobRow>

                                <ModelJobRow
                                    icon={MapIcon}
                                    title={tr("Atlas region names")}
                                    desc={tr("The atlas names each region of your map by reading the topics in it. Without a model it borrows the most central topic’s own title.")}
                                    aside={atlasNamingModel || tr("Same as the chat model")}
                                >
                                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1">
                                        {tr("Naming model")}
                                    </label>
                                    <p className="text-sm text-slate-500 dark:text-slate-400 mb-2">
                                        {tr("Leave as the chat model, or pick a smaller one so naming never waits on the model you talk to.")}
                                    </p>
                                    <ModelPicker
                                        label={tr("Naming model")}
                                        value={atlasNamingModel}
                                        onChange={saveAtlasNamingModel}
                                        models={models}
                                        loading={modelsLoading}
                                        onRefresh={loadModels}
                                        inherit={{ label: tr("Same as the chat model"), detail: currentModel || undefined }}
                                    />
                                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-2">
                                        {tr("Names are kept per region and survive a model change — switching this only affects regions that have no name yet. You can rename any region by hand on the Atlas page.")}
                                    </p>
                                    <Explain summary={tr("Why a small model is better")} className="mt-3">
                                        <p>
                                            {tr("The atlas groups your topics into regions and names each one. Without a model it uses the most central topic’s own title, which names a whole discipline after one lesson inside it — “Force and Motion” printed across all of physics. A model reads every title in the region and writes a name that covers them. This is a short noun phrase, not a conversation: a small, fast instruct model does it better than a large reasoning one, which spends its budget deliberating and times out.")}
                                        </p>
                                    </Explain>
                                </ModelJobRow>

                                <ModelJobRow
                                    icon={ImageIcon}
                                    title={tr("Describe card pictures")}
                                    desc={tr("Cards whose question is a photograph get a description your vision model writes, so the AI can read them and a screen reader can say them.")}
                                    aside={mediaStats
                                        ? (mediaStats.images > 0
                                            ? tr("{{described}} of {{images}}", { described: num(mediaStats.described), images: num(mediaStats.images) })
                                            : tr("No pictures yet"))
                                        : '…'}
                                >
                                    {!mediaStats || mediaStats.images === 0 ? (
                                        <p className="text-sm text-slate-600 dark:text-slate-300">
                                            {tr("No cards in your library have pictures yet. Importing an Anki deck is the usual way they arrive.")}
                                        </p>
                                    ) : (
                                        <>
                                            <div className="flex items-baseline justify-between gap-3 flex-wrap">
                                                <p className="text-sm text-slate-700 dark:text-slate-200">
                                                    <span className="font-semibold text-slate-900 dark:text-white">
                                                        {tr("{{described}} of {{images}}", { described: num(mediaStats.described), images: num(mediaStats.images) })}
                                                    </span>{' '}{tr("pictures described.")}
                                                </p>
                                                <p className="text-sm text-slate-500 dark:text-slate-400">
                                                    {tr("{{byAuthor}} by the deck author", { byAuthor: num(mediaStats.byAuthor) })}
                                                    {mediaStats.byVision > 0 && tr(", {{byVision}} by your model", { byVision: num(mediaStats.byVision) })}
                                                </p>
                                            </div>
                                            <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-700 overflow-hidden">
                                                <div
                                                    className="h-full bg-accent transition-all"
                                                    style={{ width: `${mediaStats.images ? (mediaStats.described / mediaStats.images) * 100 : 0}%` }}
                                                />
                                            </div>
                                            {mediaStats.running ? (
                                                <div className="flex items-center justify-between gap-3">
                                                    <p className="text-sm text-slate-600 dark:text-slate-300 flex items-center gap-2">
                                                        <Loader2 className="w-4 h-4 animate-spin" />
                                                        {mediaStats.done ?? 0} {tr("done,")}{' '}{mediaStats.failed ?? 0} {tr("failed of")}{' '}{mediaStats.total ?? 0}
                                                    </p>
                                                    <Button
                                                        onClick={async () => { await api.cancelMediaDescriptions().catch(() => { }); loadMediaStats(); }}
                                                    >
                                                        {tr("Stop")}
                                                    </Button>
                                                </div>
                                            ) : mediaStats.pending > 0 ? (
                                                <div className="flex items-center justify-between gap-3 flex-wrap">
                                                    <p className="text-sm text-slate-500 dark:text-slate-400">
                                                        {tr("{{pending}} still to describe — one call to your vision model per picture. You can stop it at any point and what is done stays done.", { pending: num(mediaStats.pending) })}
                                                    </p>
                                                    <Button
                                                        variant="primary"
                                                        onClick={async () => {
                                                            const r = await api.runMediaDescriptions().catch((e: any) => ({ started: false, reason: e.message }));
                                                            if (!r.started) addToast('error', tr("Could not start"), r.reason);
                                                            loadMediaStats();
                                                        }}
                                                    >
                                                        {tr("Describe {{pending}} pictures", { count: mediaStats.pending, pending: num(mediaStats.pending) })}
                                                    </Button>
                                                </div>
                                            ) : (
                                                <p className="text-sm text-emerald-700 dark:text-emerald-300">
                                                    {tr("Every picture has a description.")}
                                                </p>
                                            )}
                                        </>
                                    )}
                                    <Explain summary={tr("Descriptions already in the deck")} className="mt-3">
                                        <p>
                                            {tr("A card whose question is a photograph reads to the AI as a card with no question, and to a screen reader as a filename. One description fixes both. Pictures that arrived with a description written by the deck’s own author keep it — a model never overwrites those. The rest need a vision model, and this runs in the background at your pace.")}
                                        </p>
                                    </Explain>
                                </ModelJobRow>

                                <ModelJobRow
                                    icon={Database}
                                    title={tr("Vault semantic search")}
                                    desc={tr("Finds vault content by meaning, not just keywords, using a small local embedding model. Optional — keyword search always works.")}
                                    aside={embStatus ? (embStatus.config.enabled ? tr("On") : tr("Off")) : '…'}
                                >
                                    {embStatus && !embStatus.config.vecAvailable ? (
                                        <p className="text-sm text-amber-600 dark:text-amber-400">
                                            {tr("The vector extension (sqlite-vec) isn’t available on this build, so semantic search is disabled. Keyword search still works.")}
                                        </p>
                                    ) : (
                                        <>
                                            {/* Enable toggle */}
                                            <div className="flex items-center justify-between">
                                                <div>
                                                    <p className="font-medium text-slate-900 dark:text-white">{tr("Enable semantic search")}</p>
                                                    <p className="text-sm text-slate-500 dark:text-slate-400">{tr("Embed and vector-search your vault files.")}</p>
                                                </div>
                                                <Switch
                                                    checked={!!embStatus?.config.enabled}
                                                    label={tr("Enable semantic search")}
                                                    onChange={async next => {
                                                        await api.setEmbeddingSettings({ enabled: next }).catch(() => { });
                                                        loadEmbStatus({ force: true });
                                                    }}
                                                />
                                            </div>

                                            {/* Provider/model/status only matter while the feature
                                                is on — the toggle collapses them away. */}
                                            <Collapse open={!!(embStatus?.config.enabled ?? true)}>
                                            <div className="mt-4 space-y-4">
                                            {/* Embedding provider — may differ from the chat provider */}
                                            <div className="pt-4 border-t border-slate-100 dark:border-slate-700">
                                                <label className="block font-medium text-slate-900 dark:text-white mb-1">{tr("Embedding provider")}</label>
                                                <p className="text-sm text-slate-500 dark:text-slate-400 mb-2">
                                                    {tr("Embeddings don’t have to run where chat runs — e.g. chat on an API endpoint, embeddings on Ollama. “Same as chat” follows the provider above.")}
                                                </p>
                                                <SegmentedControl
                                                    label={tr("Embedding provider")}
                                                    value={embStatus?.config.provider ?? 'auto'}
                                                    onChange={async next => {
                                                        await api.setEmbeddingSettings({ provider: next as 'auto' | 'ollama' | 'openai' }).catch(() => { });
                                                        loadEmbStatus({ force: true });
                                                    }}
                                                    options={[
                                                        { value: 'auto', label: tr("Same as chat") },
                                                        { value: 'ollama', label: tr("Ollama") },
                                                        { value: 'openai', label: tr("OpenAI-compatible API") },
                                                    ]}
                                                    className="max-w-full"
                                                />
                                            </div>

                                            {/* Embedding model */}
                                            <div className="pt-4 border-t border-slate-100 dark:border-slate-700">
                                                <div className="flex flex-wrap items-baseline gap-x-1.5 mb-1">
                                                    <label className="font-medium text-slate-900 dark:text-white">{tr("Embedding model")}</label>
                                                    {embStatus?.probe?.ok && (
                                                        <span className="text-sm text-emerald-600 dark:text-emerald-400">
                                                            <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1 align-middle" />
                                                            {tr("connected")}{embStatus.probe.dim ? tr("({{dim}}-dim)", { dim: embStatus.probe.dim }) : ''}{tr(". Vault files will be indexed automatically.")}
                                                        </span>
                                                    )}
                                                </div>
                                                <p className="text-sm text-slate-500 dark:text-slate-400 mb-2">
                                                    {tr("Name of the embedding model on the embedding provider above (e.g.")}{' '}<code className="text-xs">nomic-embed-text</code>{tr("). For Ollama, pull it first:")}{' '}<code className="text-xs">ollama pull nomic-embed-text</code>.
                                                </p>
                                                {/* The list is the CHAT provider's, which is
                                                    not always where embeddings run — so it is
                                                    a suggestion here, and typing an id the
                                                    list does not carry stays first-class. */}
                                                <ModelPicker
                                                    label={tr("Embedding model")}
                                                    value={embModelInput}
                                                    onChange={async next => {
                                                        setEmbModelInput(next);
                                                        if (next.trim() && next.trim() !== embStatus?.config.model) {
                                                            await api.setEmbeddingSettings({ model: next.trim() }).catch(() => { });
                                                            loadEmbStatus({ force: true });
                                                        }
                                                    }}
                                                    models={models}
                                                    loading={modelsLoading}
                                                    onRefresh={loadModels}
                                                    placeholder={tr("nomic-embed-text")}
                                                />
                                            </div>

                                            {/* Connection / index status */}
                                            <div className="pt-4 border-t border-slate-100 dark:border-slate-700 space-y-2">
                                                {embStatus?.probe && !embStatus.probe.ok && (
                                                    <p className="text-sm text-amber-600 dark:text-amber-400">
                                                        {tr("No embedding model reachable — using keyword search only.")}
                                                        {embStatus.probe.reason ? <span className="block text-sm text-slate-500 dark:text-slate-400 mt-0.5 break-words">{embStatus.probe.reason}</span> : null}
                                                    </p>
                                                )}
                                                {/* `flex-wrap` below: the count is a sentence whose
                                                    length is the language's business, and the button
                                                    beside it is `shrink-0`, so at 375px in ru the
                                                    pair was 34px wider than the panel and
                                                    "Переиндексировать всё" was cut by it. A row that
                                                    cannot fit both puts the button on its own line. */}
                                                {embStatus?.stats && (
                                                    <div className="flex flex-wrap items-center justify-between gap-3">
                                                        <p className="text-sm text-slate-600 dark:text-slate-300 tabular-nums">
                                                            <span className="font-medium">{embStatus.stats.indexed}</span> {tr("/ {{total}} files indexed", { count: embStatus.stats.total, total: embStatus.stats.total })}
                                                            <span className="text-slate-500 dark:text-slate-400"> {tr("· {{vectors}} vectors", { count: embStatus.stats.vectors, vectors: num(embStatus.stats.vectors) })}</span>
                                                            {embStatus.stats.error > 0 && <span className="text-red-500"> {tr("· {{error}} failed", { error: embStatus.stats.error })}</span>}
                                                        </p>
                                                        <Button
                                                            onClick={async () => {
                                                                setEmbReindexing(true);
                                                                try {
                                                                    const r = await api.reindexEmbeddings();
                                                                    addToast('success', tr("Re-indexing started"), tr("{{queued}} file(s) queued for embedding.", { queued: r.queued }));
                                                                } catch (e: any) {
                                                                    addToast('error', tr("Re-index failed"), e?.message);
                                                                } finally {
                                                                    setEmbReindexing(false);
                                                                    setTimeout(() => loadEmbStatus(), 1500);
                                                                }
                                                            }}
                                                            disabled={!embStatus.config.enabled}
                                                            busy={embReindexing}
                                                            variant="subtle"
                                                            className="shrink-0"
                                                            icon={<RefreshCw className="w-4 h-4" aria-hidden="true" />}
                                                        >
                                                            {tr("Re-index all")}
                                                        </Button>
                                                    </div>
                                                )}
                                            </div>
                                            </div>
                                            </Collapse>
                                        </>
                                    )}
                                </ModelJobRow>
                            </Panel>
                        </section>

                        {/* HELP — a section like the ones above it, always open. It
                            was a closed disclosure at the foot of the page, "one row
                            for the skim" — and a row reading "Setup help" under five
                            job rows was a sixth job to most eyes. The page ends
                            here, so there is nothing below it to keep short for. */}
                        <section className={activeTab === 'ai' ? 'mb-8' : 'hidden'}>
                            <SectionHeader title={tr("Setup help")} icon={HelpCircle} />
                            <Panel>
                                <div className="space-y-3 text-sm text-slate-600 dark:text-slate-300">
                                    <p>
                                        <strong className="text-slate-900 dark:text-white">{tr("Getting started with local AI:")}</strong>
                                    </p>
                                    <ol className="list-decimal list-inside pl-2 space-y-1">
                                        <li>
                                            {tr("Install Ollama from")}{' '}
                                            <a href="https://ollama.com/download" target="_blank" rel="noopener noreferrer" className="text-accent-fg hover:underline">
                                                ollama.com
                                            </a>{' '}{tr("and launch it.")}
                                        </li>
                                        <li>
                                            {tr("In")}{' '}<strong>{tr("AI Provider")}</strong> {tr("at the top of this page, select Ollama and press the")}{' '}
                                            <strong>{tr("Test")}</strong> {tr("button next to the URL — the status dot turns green when connected.")}
                                        </li>
                                        <li>
                                            {tr("Paste any name from your provider's library into")}{' '}<strong>{tr("Install Custom Model")}</strong>{tr(". See")}{' '}<strong>{tr("Choosing a model")}</strong> {tr("below for what size to pick.")}
                                        </li>
                                    </ol>
                                    <p className="pt-2 border-t border-slate-200 dark:border-slate-700">
                                        <strong className="text-slate-900 dark:text-white">{tr("Model Selection Guide:")}</strong>
                                    </p>
                                    <ul className="list-disc list-inside pl-2 space-y-1">
                                        <li><strong>{tr("~6 GB VRAM:")}</strong> {tr("fits a 9B at 4-bit — the smallest size worth teaching from.")}</li>
                                        <li><strong>{tr("~10 GB VRAM:")}</strong> {tr("fits a 14B, or a sparse ~30B mixture-of-experts with most of it offloaded to system RAM.")}</li>
                                        <li><strong>{tr("16 GB and up:")}</strong> {tr("a dense model in the recommended class fits comfortably.")}</li>
                                        <li><strong>{tr("No GPU?")}</strong> {tr("Any OpenAI-compatible endpoint with your own API key.")}</li>
                                    </ul>
                                    <p className="pt-2 border-t border-slate-200 dark:border-slate-700">
                                        <strong className="text-slate-900 dark:text-white">{tr("About Benchmarks:")}</strong>
                                    </p>
                                    <p className="pl-2">
                                        {tr("MMLU-Pro tests broad academic knowledge (STEM, humanities, law, medicine) at a graduate level. Higher % = better general knowledge. This is the most relevant benchmark for learning applications.")}
                                    </p>
                                </div>
                            </Panel>
                        </section>
                    </div>
                </div>
            </div>
        </div>
    );
}
import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { onActivateKey } from '../utils/a11y';
import { MOD_KEY, usePhysicalKeyboard } from '../utils/platform';
import { useStore, type Theme, type WebSearchMode, MIN_UI_SCALE, MAX_UI_SCALE, DEFAULT_UI_SCALE, UI_SCALE_STEP } from '../store';
import { LANGUAGES } from '../i18n';
import Checkbox from './Checkbox';
import { useDesktop } from '../hooks/useDesktop';
import { desktopApi, type DesktopWindowMode, type DesktopAutostartWindow } from '../desktopApi';
import { api, OllamaModel, PullProgress, SrsStatus, SrsFitResult, MasteryModelStatus, BktFitResult, ServingEndpoint } from '../api';
import { configureSrs, retentionVerdict, REQUEST_RETENTION } from '../utils/srs';
import { AIProvider } from '../types';
import {
    Sun, Moon, Download, Upload, RefreshCw, Trash2, X, Check,
    Loader2, Zap, Brain, BookOpen, Globe, Cpu, Sparkles,
    Code, Eye, Wrench, Database, ChevronDown, Lock, Palette, Code2, Layers,
    Image as ImageIcon, Search, Cloud, Map as MapIcon, ChevronRight,
    Bug, ArrowUpCircle, Copy, Terminal, RotateCcw} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button, ButtonLink, IconButton } from './ui/Button';
import { Field, TextInput, Select } from './ui/Field';
import SegmentedControl from './ui/SegmentedControl';
import Switch from './ui/Switch';
import Radio from './ui/Radio';
import Stepper from './ui/Stepper';
import Slider from './ui/Slider';
import { FOCUS_RING } from './ui/vocabulary';
import ModelPicker from './ModelPicker';
import { MODEL_TIERS, TIER_DOT, TIER_TONE, tierForModel, formatModelSize } from '../utils/modelTiers';
import SearchProvidersPanel from './SearchProvidersPanel';
import ActivityLogPanel from './settings/ActivityLogPanel';
import ReportProblemDialog from './ReportProblemDialog';
import DesktopQuitScreen from './DesktopQuitScreen';
import { diagnosticsBlock } from '../utils/report';
import ColorField, { ACCENT_COLORS } from './ui/ColorField';
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
// URL hash (#general/#learning/#ai/#search/#data) so a reload lands on the same group.
type SettingsTab = 'general' | 'learning' | 'ai' | 'search' | 'data';
// How to recover math from PDFs whose text layer drops formulas. One UI control
// over two backend settings (pdf_math_recovery + pdf_recovery_vision).
type RecoveryMode = 'off' | 'ocr' | 'auto' | 'vision';
// Where the Corresponding Source lives. Surfaced in Settings → About because
// AGPL-3.0 §13 requires network users be offered it; update this if the repo moves.
const SOURCE_URL = 'https://github.com/ValeraZSD/terramentor';

const SETTINGS_TABS: { id: SettingsTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'general', label: k("General"), icon: Palette },
    { id: 'learning', label: k("Learning"), icon: BookOpen },
    { id: 'ai', label: k("AI & Models"), icon: Sparkles },
    // NOT "Web search": AI & Models now holds a setting by that name (letting an
    // answer be grounded in live pages). This tab is the outward links.
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

// Theme picker: the 4 selectable themes and a hardcoded swatch palette for each.
// The swatches must be literal hex (not `bg-slate-*`) because each preview shows
// a DIFFERENT theme than the one currently applied — they can't ride the live CSS
// vars. Values mirror the token overrides in index.css.
const THEME_META: { id: Theme; label: string; icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }> }[] = [
    { id: 'light', label: k("Light"), icon: Sun },
    { id: 'warm', label: k("Warm"), icon: Sun },
    { id: 'dark', label: k("Dark"), icon: Moon },
    { id: 'black', label: k("Black"), icon: Moon },
];
const THEME_PREVIEWS: Record<Theme, { page: string; surface: string; border: string; text: string; muted: string; code: string }> = {
    // `page` is the CANVAS token (slate-100), not the inset one — the two used
    // to be the same value in light, which is exactly the collision the surface
    // ladder in index.css exists to prevent.
    light: { page: '#f1f5f9', surface: '#ffffff', border: '#e2e8f0', text: '#0f172a', muted: '#64748b', code: '#f1f5f9' },
    warm: { page: '#eee6d9', surface: '#faf6ef', border: '#e2d6c3', text: '#211a14', muted: '#786855', code: '#f4eee4' },
    dark: { page: '#0f172a', surface: '#1e293b', border: '#334155', text: '#f8fafc', muted: '#94a3b8', code: '#334155' },
    black: { page: '#000000', surface: '#0d0d10', border: '#202026', text: '#f8fafc', muted: '#8b8b95', code: '#202026' },
};

// COLOR SYSTEM
const COLOR_MAP: Record<string, { bg: string; border: string; text: string; iconBg: string; button: string; badge: string; ring: string }> = {
    indigo: { bg: 'bg-indigo-50 dark:bg-indigo-900/20', border: 'border-indigo-200 dark:border-indigo-800', text: 'text-indigo-700 dark:text-indigo-400', iconBg: 'bg-indigo-500', button: 'bg-indigo-500 hover:bg-indigo-600', badge: 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300', ring: 'ring-indigo-400 dark:ring-indigo-500' },
    blue: { bg: 'bg-blue-50 dark:bg-blue-900/20', border: 'border-blue-200 dark:border-blue-800', text: 'text-blue-700 dark:text-blue-400', iconBg: 'bg-blue-500', button: 'bg-blue-500 hover:bg-blue-600', badge: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300', ring: 'ring-blue-400 dark:ring-blue-500' },
    sky: { bg: 'bg-sky-50 dark:bg-sky-900/20', border: 'border-sky-200 dark:border-sky-800', text: 'text-sky-700 dark:text-sky-400', iconBg: 'bg-sky-500', button: 'bg-sky-500 hover:bg-sky-600', badge: 'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300', ring: 'ring-sky-400 dark:ring-sky-500' },
    cyan: { bg: 'bg-cyan-50 dark:bg-cyan-900/20', border: 'border-cyan-200 dark:border-cyan-800', text: 'text-cyan-700 dark:text-cyan-400', iconBg: 'bg-cyan-500', button: 'bg-cyan-500 hover:bg-cyan-600', badge: 'bg-cyan-100 dark:bg-cyan-900/40 text-cyan-700 dark:text-cyan-300', ring: 'ring-cyan-400 dark:ring-cyan-500' },
    teal: { bg: 'bg-teal-50 dark:bg-teal-900/20', border: 'border-teal-200 dark:border-teal-800', text: 'text-teal-700 dark:text-teal-400', iconBg: 'bg-teal-500', button: 'bg-teal-500 hover:bg-teal-600', badge: 'bg-teal-100 dark:bg-teal-900/40 text-teal-700 dark:text-teal-300', ring: 'ring-teal-400 dark:ring-teal-500' },
    emerald: { bg: 'bg-emerald-50 dark:bg-emerald-900/20', border: 'border-emerald-200 dark:border-emerald-800', text: 'text-emerald-700 dark:text-emerald-400', iconBg: 'bg-emerald-500', button: 'bg-emerald-500 hover:bg-emerald-600', badge: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300', ring: 'ring-emerald-400 dark:ring-emerald-500' },
    green: { bg: 'bg-green-50 dark:bg-green-900/20', border: 'border-green-200 dark:border-green-800', text: 'text-green-700 dark:text-green-400', iconBg: 'bg-green-500', button: 'bg-green-500 hover:bg-green-600', badge: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300', ring: 'ring-green-400 dark:ring-green-500' },
    lime: { bg: 'bg-lime-50 dark:bg-lime-900/20', border: 'border-lime-200 dark:border-lime-800', text: 'text-lime-700 dark:text-lime-400', iconBg: 'bg-lime-500', button: 'bg-lime-500 hover:bg-lime-600', badge: 'bg-lime-100 dark:bg-lime-900/40 text-lime-700 dark:text-lime-300', ring: 'ring-lime-400 dark:ring-lime-500' },
    amber: { bg: 'bg-amber-50 dark:bg-amber-900/20', border: 'border-amber-200 dark:border-amber-800', text: 'text-amber-700 dark:text-amber-400', iconBg: 'bg-amber-500', button: 'bg-amber-500 hover:bg-amber-600', badge: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300', ring: 'ring-amber-400 dark:ring-amber-500' },
    orange: { bg: 'bg-orange-50 dark:bg-orange-900/20', border: 'border-orange-200 dark:border-orange-800', text: 'text-orange-700 dark:text-orange-400', iconBg: 'bg-orange-500', button: 'bg-orange-500 hover:bg-orange-600', badge: 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300', ring: 'ring-orange-400 dark:ring-orange-500' },
    red: { bg: 'bg-red-50 dark:bg-red-900/20', border: 'border-red-200 dark:border-red-800', text: 'text-red-700 dark:text-red-400', iconBg: 'bg-red-500', button: 'bg-red-500 hover:bg-red-600', badge: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300', ring: 'ring-red-400 dark:ring-red-500' },
    pink: { bg: 'bg-pink-50 dark:bg-pink-900/20', border: 'border-pink-200 dark:border-pink-800', text: 'text-pink-700 dark:text-pink-400', iconBg: 'bg-pink-500', button: 'bg-pink-500 hover:bg-pink-600', badge: 'bg-pink-100 dark:bg-pink-900/40 text-pink-700 dark:text-pink-300', ring: 'ring-pink-400 dark:ring-pink-500' },
    rose: { bg: 'bg-rose-50 dark:bg-rose-900/20', border: 'border-rose-200 dark:border-rose-800', text: 'text-rose-700 dark:text-rose-400', iconBg: 'bg-rose-500', button: 'bg-rose-500 hover:bg-rose-600', badge: 'bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300', ring: 'ring-rose-400 dark:ring-rose-500' },
    fuchsia: { bg: 'bg-fuchsia-50 dark:bg-fuchsia-900/20', border: 'border-fuchsia-200 dark:border-fuchsia-800', text: 'text-fuchsia-700 dark:text-fuchsia-400', iconBg: 'bg-fuchsia-500', button: 'bg-fuchsia-500 hover:bg-fuchsia-600', badge: 'bg-fuchsia-100 dark:bg-fuchsia-900/40 text-fuchsia-700 dark:text-fuchsia-300', ring: 'ring-fuchsia-400 dark:ring-fuchsia-500' },
    purple: { bg: 'bg-purple-50 dark:bg-purple-900/20', border: 'border-purple-200 dark:border-purple-800', text: 'text-purple-700 dark:text-purple-400', iconBg: 'bg-purple-500', button: 'bg-purple-500 hover:bg-purple-600', badge: 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300', ring: 'ring-purple-400 dark:ring-purple-500' },
    violet: { bg: 'bg-violet-50 dark:bg-violet-900/20', border: 'border-violet-200 dark:border-violet-800', text: 'text-violet-700 dark:text-violet-400', iconBg: 'bg-violet-500', button: 'bg-violet-500 hover:bg-violet-600', badge: 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300', ring: 'ring-violet-400 dark:ring-violet-500' },
    slate: { bg: 'bg-slate-100 dark:bg-slate-700/30', border: 'border-slate-200 dark:border-slate-600', text: 'text-slate-600 dark:text-slate-400', iconBg: 'bg-slate-500', button: 'bg-slate-500 hover:bg-slate-600', badge: 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300', ring: 'ring-slate-400 dark:ring-slate-500' },
};

// ---------------------------------------------------------------------------
// Model guidance — deliberately NAMES NO MODEL.
//
// This file used to carry a catalog of fourteen specific models with benchmark
// figures beside them. Both halves were wrong to ship: model names churn every
// few weeks, so a hardcoded list is stale the month after it is written, and
// the benchmark numbers were not measured by this project, which for an app
// whose pitch is verifiable honesty is the worst kind of decoration.
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
    const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString() : '—');

    return (
        <>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-1">{tr("Spaced repetition")}</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
                {tr("Flashcards are scheduled by FSRS-6. It ships with parameters fitted on a large public dataset; once you have a few hundred reviews of your own, they can be fitted to you instead. Every rating is kept in a review log on this machine, and an imported Anki deck brings its history with it.")}
            </p>
            <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm divide-y divide-slate-100 dark:divide-slate-700">
                <FactStrip>
                    <Fact
                        label={tr("Reviews logged")}
                        testId="srs-log-count"
                        value={status ? tr("{{rows}} on {{cards}} cards", { rows: num(status.log.rows), cards: num(status.log.cards) }) : '…'}
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
                    <div className="px-4 py-3" data-testid="srs-retention">
                        {/* The three percentages used to sit side by side and the
                            reader had to work out which way was good. The verdict
                            says it in words and keeps both numbers inside the
                            sentence that uses them. */}
                        <Fact
                            label={tr("How much you are remembering")}
                            value={tr("{{round}}% recalled over {{reviews}} reviews", { round: Math.round((status.retention.observed ?? 0) * 100), reviews: num(status.retention.reviews) })}
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
                        {status.retention.bins.filter(b => b.n >= BIN_MIN_REVIEWS).length >= 2 && (
                            <div className="mt-3">
                            {/* Why there are three rows and not ten: the bands are
                                fixed (`retentionReport` cuts predictions into ten),
                                and how many get drawn is a fact about the reader's
                                history, not a choice. Without this sentence the
                                count looks arbitrary — which is exactly how it
                                read. */}
                            <p className="max-w-prose text-sm text-slate-500 dark:text-slate-400">
                                {tr("Each row is a band the schedule was equally sure about, drawn once it has {{min}} reviews behind it. The bar is what you recalled; the notch is what it predicted.", { min: num(BIN_MIN_REVIEWS) })}
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
                                                aria-label={tr("Predicted {{p}}%, recalled {{o}}% over {{n}} reviews", { p: predicted, o: observed, n: b.n })}
                                            >
                                                <span className="absolute inset-y-0 left-0 bg-accent/60" style={{ width: `${observed}%` }} />
                                                <span
                                                    className="absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-slate-500 dark:bg-slate-300"
                                                    style={{ left: `${Math.min(99, Math.max(1, predicted))}%` }}
                                                />
                                            </span>
                                            <span className="tabular-nums">{observed}% · {num(b.n)}</span>
                                        </div>
                                    );
                                })}
                            </div>
                            </div>
                        )}
                    </div>
                )}
                <div className="px-4 py-3 flex flex-wrap items-center gap-2">
                    <Button variant="primary" onClick={optimise} disabled={!enough} busy={busy}>
                        {tr("Fit to my reviews")}
                    </Button>
                    {fitted && (
                        <Button onClick={reset} disabled={busy}>{tr("Reset to defaults")}</Button>
                    )}
                    <span className="text-sm text-slate-500 dark:text-slate-400" data-testid="srs-hint">
                        {status
                            ? enough
                                ? tr("{{predicted}} day-level reviews available to fit on.", { predicted: num(status.predicted) })
                                : tr("Needs {{minReviews}} day-level reviews to fit on — you have {{predicted}}. Keep reviewing.", { minReviews: status.minReviews, predicted: num(status.predicted) })
                            : ''}
                    </span>
                </div>
                {last && (
                    <div className="px-4 py-3 text-sm text-slate-600 dark:text-slate-300" data-testid="srs-last-result">
                        {last.accepted
                            ? tr("Accepted: held-out log-loss {{fmt}} → {{fmt2}} over {{valReviews}} reviews ({{steps}} steps, {{value}} s).", { fmt: fmt(last.stats.valDefault), fmt2: fmt(last.stats.valFitted), valReviews: last.stats.valReviews, steps: last.stats.steps, value: (last.stats.ms / 1000).toFixed(1) })
                            : tr("Not applied: {{reason}} (held-out log-loss {{fmt}} vs {{fmt2}}).", { reason: last.reason, fmt: fmt(last.stats.valDefault), fmt2: fmt(last.stats.valFitted) })}
                    </div>
                )}
            </div>
        </>
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
            addToast('success', r.accepted ? tr("Mastery model tuned") : tr("Defaults kept"), r.accepted
                ? tr("Learning rate {{p_T}}, slip {{p_S}} — fitted to your own attempts.", { p_T: r.params.p_T.toFixed(2), p_S: r.params.p_S.toFixed(2) })
                : (r.reason || ''));
            await load();
        } catch (e: any) {
            addToast('error', tr("Could not tune the mastery model"), e.message);
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
        <>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-1">{tr("Mastery model")}</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
                {tr("Every answer updates a per-topic estimate of whether you know the topic. Two rates drive it: how much one attempt teaches, and how often you miss something you do know. They start as sensible defaults and can be fitted to your own record of attempts.")}
            </p>
            <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm divide-y divide-slate-100 dark:divide-slate-700">
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
                <div className="px-4 py-3 flex flex-wrap items-center gap-2">
                    <Button variant="primary" onClick={optimise} disabled={!enough} busy={busy}>
                        {tr("Fit to my attempts")}
                    </Button>
                    {fitted && (
                        <Button onClick={reset} disabled={busy}>{tr("Reset to defaults")}</Button>
                    )}
                    <span className="text-sm text-slate-500 dark:text-slate-400" data-testid="bkt-hint">
                        {status
                            ? enough
                                ? tr("{{attempts}} attempts available to fit on.", { attempts: num(status.attempts) })
                                : tr("Needs {{minAttempts}} recorded attempts — you have {{attempts}}. Keep answering.", { minAttempts: status.minAttempts, attempts: num(status.attempts) })
                            : ''}
                    </span>
                </div>
                {last && (
                    <div className="px-4 py-3 text-sm text-slate-600 dark:text-slate-300" data-testid="bkt-last-result">
                        {last.accepted
                            ? tr("Accepted: held-out loss {{fmt}} → {{fmt2}} over {{valAttempts}} attempts.", { fmt: fmt(last.stats.valDefault), fmt2: fmt(last.stats.valFitted), valAttempts: last.stats.valAttempts })
                            : tr("Not applied: {{reason}} (held-out loss {{fmt}} vs {{fmt2}}).", { reason: last.reason, fmt: fmt(last.stats.valDefault), fmt2: fmt(last.stats.valFitted) })}
                    </div>
                )}
            </div>
        </>
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
        <div className="px-4 py-3 grid gap-x-8 gap-y-4 grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]">
            {children}
        </div>
    );
}

function SectionHeader({ title, icon: Icon, children }: {
    title: React.ReactNode;
    icon?: LucideIcon;
    children?: React.ReactNode;
}) {
    return (
        <>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-1 flex items-center gap-2">
                {Icon && <Icon className="w-5 h-5 text-accent-fg" />}{title}
            </h2>
            {children && (
                <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">{children}</p>
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

export default function Settings() {
    const { t: tr } = useTranslation();
    const num = useNumberFormat();
    const openAnkiImport = useStore(s => s.openAnkiImport);
    const theme = useStore(s => s.theme);
    const setTheme = useStore(s => s.setTheme);
    const accentColor = useStore(s => s.accentColor);
    const setAccentColor = useStore(s => s.setAccentColor);
    const uiScale = useStore(s => s.uiScale);
    const setUiScale = useStore(s => s.setUiScale);
    const weekStartDay = useStore(s => s.weekStartDay);
    const setWeekStartDay = useStore(s => s.setWeekStartDay);
    const uiLanguage = useStore(s => s.uiLanguage);
    const setUiLanguage = useStore(s => s.setUiLanguage);
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
    const [webSearch, setWebSearch] = useState<WebSearchMode>('off');
    const [recoveryMode, setRecoveryMode] = useState<RecoveryMode>('auto');
    // Optional dedicated vision model for PDF recovery ('' = use the chat model).
    const [recoveryVisionModel, setRecoveryVisionModel] = useState('');
    // Optional dedicated model for naming atlas regions ('' = use the chat model).
    const [atlasNamingModel, setAtlasNamingModel] = useState('');
    const [masteryThreshold, setMasteryThreshold] = useState('85');
    const [bossPass, setBossPass] = useState('80');
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

    const chooseReasoningEffort = (value: string) => {
        setReasoningEffort(value);
        api.setSetting('ai_reasoning_effort', value).catch(e => console.error('Saving ai_reasoning_effort failed:', e));
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
            setWebSearch(settings.ai_web_search === 'auto' ? 'auto'
                : (settings.ai_web_search === 'ask' || settings.ai_web_search === 'true') ? 'ask' : 'off');
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
            if (settings.boss_fight_pass) setBossPass(String(Math.round(parseFloat(settings.boss_fight_pass) * 100)));
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

    // Mirrored into the store as well as the database: the tutor and the
    // assistant HIDE their per-question switch when this is off, rather than
    // offering a control that would do nothing.
    const saveWebSearch = async (mode: WebSearchMode) => {
        const previous = webSearch;
        setWebSearch(mode);
        try {
            await api.setSetting('ai_web_search', mode);
            useStore.setState({ aiWebSearchMode: mode });
            addToast('success', tr("Saved"), mode === 'off'
                ? tr("Answers stay local. Nothing is sent to a search engine.")
                : mode === 'ask'
                    ? tr("A “Search web” switch appears beside the tutor and the assistant, off until you turn it on.")
                    : tr("The tutor and the assistant will look things up when they judge it is needed. Each answer says what it searched for."));
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

    const saveGateNumber = async (key: 'mastery_threshold' | 'boss_fight_pass' | 'decay_days', raw: string) => {
        let value: string;
        if (key === 'decay_days') {
            const n = Math.max(1, Math.min(365, parseInt(raw, 10) || 14));
            value = String(n);
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

    const formatBytes = (bytes: number) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    const getInstallProgressPercent = () => {
        if (!installProgress || !installProgress.total || !installProgress.completed) return 0;
        return Math.round((installProgress.completed / installProgress.total) * 100);
    };



    const colors = (c: string) => COLOR_MAP[c] || COLOR_MAP.slate;

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
                            named an internal ("rolling mastery estimate", "Boss
                            Fight pass", "review decay") before the reader knew
                            what any of it decided. New learners read it as a
                            page of dials they might set wrong. What the setting
                            actually decides is ONE thing — whether finishing a
                            topic is checked — so that is the question asked, in
                            the learner's words, and the three numbers live in a
                            closed disclosure under a sentence that states what
                            they currently mean. The defaults are right for
                            almost everyone; the sentence is what makes changing
                            one of them safe, because it shows the consequence. */}
                        <section className={activeTab === 'learning' ? 'mb-8' : 'hidden'}>
                            <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-1">{tr("Proving a topic")}</h2>
                            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
                                {tr("When you finish a topic, the app can check that you really know it with a short quiz — a Boss Fight. Choose how strict that check is. Skipping a topic is always allowed.")}
                            </p>
                            <div className="bg-white dark:bg-slate-800 rounded-xl p-4 shadow-sm space-y-4">
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
                                                onChange={() => saveGateMode(opt.value)}
                                            />
                                            <span className="min-w-0">
                                                <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">
                                                    {opt.label}
                                                    {'tag' in opt && opt.tag && (
                                                        <span className="ml-2 align-middle text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-accent/15 text-accent-fg">{opt.tag}</span>
                                                    )}
                                                </span>
                                                <span className="block text-sm text-slate-500 dark:text-slate-400">{opt.desc}</span>
                                            </span>
                                        </label>
                                    ))}
                                </div>

                                {gateMode !== 'off' && (
                                    <details className="group rounded-lg border border-slate-200 dark:border-slate-700">
                                        <summary className="cursor-pointer list-none px-3 py-2.5 text-sm text-slate-700 dark:text-slate-200 flex items-start gap-2 [&::-webkit-details-marker]:hidden">
                                            <span className="mt-0.5 shrink-0 text-slate-500 dark:text-slate-400 transition-transform group-open:rotate-90">▸</span>
                                            <span className="min-w-0">
                                                {tr("A topic counts as proven at {{threshold}}% estimated mastery, or {{pass}}% on one Boss Fight. A proven topic starts fading after {{days}} days.", {
                                                    threshold: masteryThreshold || '85', pass: bossPass || '80', days: decayDays || '14',
                                                })}
                                                <span className="block text-sm text-slate-500 dark:text-slate-400">{tr("Fine-tune these numbers")}</span>
                                            </span>
                                        </summary>
                                        <div className="px-3 pb-3 pt-1 grid grid-cols-1 sm:grid-cols-3 gap-4 border-t border-slate-100 dark:border-slate-700/70">
                                            <label className="block">
                                                <span className="block text-sm font-medium text-slate-600 dark:text-slate-400 mb-1 mt-2">{tr("Mastery estimate to pass (%)")}</span>
                                                <input
                                                    type="number" min={0} max={100}
                                                    value={masteryThreshold}
                                                    onChange={(e) => setMasteryThreshold(e.target.value)}
                                                    onBlur={() => saveGateNumber('mastery_threshold', masteryThreshold)}
                                                    className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white text-sm"
                                                />
                                                <span className="block text-sm text-slate-500 dark:text-slate-400 mt-1">
                                                    {tr("The app keeps a running estimate of how well you know each topic from every answer you give. Reaching this clears the check without a fresh quiz.")}
                                                </span>
                                            </label>
                                            <label className="block">
                                                <span className="block text-sm font-medium text-slate-600 dark:text-slate-400 mb-1 mt-2">{tr("Boss Fight score to pass (%)")}</span>
                                                <input
                                                    type="number" min={0} max={100}
                                                    value={bossPass}
                                                    onChange={(e) => setBossPass(e.target.value)}
                                                    onBlur={() => saveGateNumber('boss_fight_pass', bossPass)}
                                                    className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white text-sm"
                                                />
                                                <span className="block text-sm text-slate-500 dark:text-slate-400 mt-1">
                                                    {tr("One quiz at this score proves the topic on the spot, whatever the estimate says.")}
                                                </span>
                                            </label>
                                            <label className="block">
                                                <span className="block text-sm font-medium text-slate-600 dark:text-slate-400 mb-1 mt-2">{tr("Days before a proven topic fades")}</span>
                                                <input
                                                    type="number" min={1} max={365}
                                                    value={decayDays}
                                                    onChange={(e) => setDecayDays(e.target.value)}
                                                    onBlur={() => saveGateNumber('decay_days', decayDays)}
                                                    className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white text-sm"
                                                />
                                                <span className="block text-sm text-slate-500 dark:text-slate-400 mt-1">
                                                    {tr("After this long without practice, the estimate starts dropping and the feed brings the topic back as a quick recall question.")}
                                                </span>
                                            </label>
                                        </div>
                                    </details>
                                )}
                            </div>
                        </section>

                        {/* YOUR FEED — the home stream's dials (src/components/settings/FeedSettingsPanel.tsx). */}
                        <section className={activeTab === 'learning' ? 'mb-8' : 'hidden'}>
                            <FeedSettingsPanel active={activeTab === 'learning'} />
                        </section>

                        {/* SPACED REPETITION */}
                        <section className={activeTab === 'learning' ? 'mb-8' : 'hidden'}>
                            <SrsTuningPanel active={activeTab === 'learning'} />
                        </section>

                        {/* MASTERY MODEL */}
                        <section className={activeTab === 'learning' ? 'mb-8' : 'hidden'}>
                            <MasteryTuningPanel active={activeTab === 'learning'} />
                        </section>

                        {/* ABOUT YOU */}
                        <section className={activeTab === 'learning' ? 'mb-8' : 'hidden'}>
                            <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-1">{tr("Learner profile")}</h2>
                            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
                                {tr("Your background, education and self-assessed experience. Added to the AI’s context in every project so the tutor pitches explanations and examples at your level. Stays on your machine, like everything else.")}
                            </p>
                            <div className="bg-white dark:bg-slate-800 rounded-xl p-4 shadow-sm">
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
                        </section>

                        {/* APPEARANCE */}
                        <section className={activeTab === 'general' ? 'mb-8' : 'hidden'}>
                            <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-4">{tr("Appearance")}</h2>
                            <div className="bg-white dark:bg-slate-800 rounded-xl p-4 shadow-sm">
                                <p className="font-medium text-slate-900 dark:text-white">{tr("Theme")}</p>
                                <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
                                    {tr("Pick how the whole app looks. The selected one is outlined in your accent colour.")}
                                </p>
                                <div className="grid grid-cols-2 gap-3">
                                    {THEME_META.map(({ id, label, icon: Icon }) => {
                                        const p = THEME_PREVIEWS[id];
                                        const selected = theme === id;
                                        return (
                                            <button
                                                key={id}
                                                type="button"
                                                onClick={() => setTheme(id)}
                                                aria-pressed={selected}
                                                aria-label={tr("{{label}} theme", { label: tr(label) })}
                                                className={`text-left rounded-xl border-2 overflow-hidden transition ${selected
                                                    ? 'border-accent ring-2 ring-accent/30'
                                                    : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'}`}
                                            >
                                                {/* The whole card — preview AND name row — sits on the theme's
                                                    own palette, so each box fully reads as that theme. */}
                                                <div className="p-2.5 space-y-2" style={{ backgroundColor: p.page }}>
                                                    {/* Rendered example — same content in all four, styled per theme. */}
                                                    <div className="rounded-md border p-2 space-y-1.5" style={{ backgroundColor: p.surface, borderColor: p.border }}>
                                                        <div className="flex items-center gap-1.5">
                                                            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: 'rgb(var(--accent-rgb))' }} />
                                                            <span className="text-[11px] font-semibold leading-none" style={{ color: p.text }}>{tr("Cell biology")}</span>
                                                        </div>
                                                        <p className="text-[10px] leading-snug" style={{ color: p.muted }}>{tr("How lessons & notes look.")}</p>
                                                        <div className="text-[10px] leading-snug" style={{ color: p.text }}>
                                                            {tr("• Mitochondria make")}{' '}
                                                            <span className="px-1 py-px rounded font-mono" style={{ backgroundColor: p.code, color: p.text }}>{tr("ATP")}</span>
                                                        </div>
                                                        <span className="inline-block text-[9px] font-medium px-1.5 py-0.5 rounded-full text-white" style={{ backgroundColor: 'rgb(var(--accent-rgb))' }}>{tr("Mastered")}</span>
                                                    </div>
                                                    {/* Name row — themed to match its card. */}
                                                    <div className="flex items-center justify-between px-0.5">
                                                        <span className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: p.text }}>
                                                            <Icon className="w-3.5 h-3.5" style={{ color: p.muted }} /> {tr(label)}
                                                        </span>
                                                        {selected && <Check className="w-4 h-4 text-accent" />}
                                                    </div>
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>

                                <div className="mt-5 pt-5 border-t border-slate-100 dark:border-slate-700">
                                    <p className="font-medium text-slate-900 dark:text-white">{tr("Accent colour")}</p>
                                    <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
                                        {tr("Used across the app outside a project (projects use their own colour).")}
                                    </p>
                                    <ColorField value={accentColor} onChange={setAccentColor} colors={ACCENT_COLORS} />
                                </div>

                                {/* THE APP'S OWN ICON — the tab, and what an
                                    install puts on a home screen
                                    (src/components/settings/AppIconPanel.tsx).
                                    It sits with the theme and the accent because
                                    it is the same question — what this app looks
                                    like — and because the icon is the one piece
                                    of that which is also seen with the app
                                    closed. */}
                                <AppIconPanel />

                                {/* UI SCALE.
                                    Not a font-size preference — it moves the root font
                                    size, and this app's sizes are `rem`, so the interface
                                    grows as a piece instead of becoming large text in
                                    boxes built for small text. It earns its place because
                                    the same build is read on a phone at arm's length and
                                    on a desktop across a desk, and because a flashcard's
                                    furigana is a fraction of a fraction of the body size:
                                    no set of constants is right for both, so the size is
                                    the reader's to set.

                                    No separate preview: this page is the preview. The
                                    whole app resizes as the value changes, which is more
                                    honest than a swatch that grows on its own. */}
                                <div className="mt-5 pt-5 border-t border-slate-100 dark:border-slate-700">
                                    <p className="font-medium text-slate-900 dark:text-white">{tr("Text & interface size")}</p>
                                    <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
                                        {tr("Scales the entire interface — text, spacing and controls together. Everything on this page resizes as you change it.")}
                                    </p>
                                    {/* ONE ROW: the slider takes the space, the
                                        stepper and the reset sit at the end of it.
                                        Stacked, three controls that all set one
                                        number spent three lines and read as three
                                        settings. The buttons step by 5 because the
                                        SLIDER steps by 5 — at ±10 the two controls
                                        disagreed about what one increment is, so a
                                        value reached with the slider could not be
                                        nudged back to itself with the buttons.
                                        Reset is a circular arrow rather than a
                                        word: it is inert at 100% (disabled, not
                                        hidden — a control that appears and
                                        disappears moves everything beside it). */}
                                    {/* Three controls over one number, so all three
                                        are on one 40px line: drag it, nudge it, or put
                                        it back. They used to be 44, 48 and 40px tall in
                                        that order, which read as three settings. */}
                                    <div className="flex flex-wrap items-center gap-3">
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
                                </div>
                            </div>
                        </section>

                        {/* LANGUAGE — the interface, not the content. Content is per
                            project (a Dutch course stays Dutch under an English
                            interface and the reverse); this is the chrome. 'auto'
                            follows the browser's language list. Applied on change,
                            before the round trip, like the theme. */}
                        <section className={activeTab === 'general' ? 'mb-8' : 'hidden'}>
                            <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-4">{tr("Language")}</h2>
                            <div className="bg-white dark:bg-slate-800 rounded-xl p-4 shadow-sm">
                                {/* Words left, control right — the Calendar row's shape.
                                    Stacked, this one preference spent four lines. */}
                                <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
                                    {/* `basis-64` lets the sentence WRAP rather than
                                        push the select onto its own line: without it
                                        the row was still two lines on a laptop. */}
                                    <div className="min-w-0 flex-1 basis-64">
                                        <label htmlFor="ui-language" className="font-medium text-slate-900 dark:text-white">{tr("Interface language")}</label>
                                        <p className="text-sm text-slate-500 dark:text-slate-400">
                                            {tr("Menus, buttons and messages. Lessons and questions follow each project's own language.")}
                                        </p>
                                    </div>
                                    <Select
                                        id="ui-language"
                                        value={uiLanguage}
                                        onChange={e => void setUiLanguage(e.target.value)}
                                        className="w-full sm:w-56 shrink-0"
                                    >
                                        <option value="auto">{tr("Same as the browser")}</option>
                                        {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
                                    </Select>
                                </div>
                                <p className="text-sm text-slate-500 dark:text-slate-400 mt-3">
                                    {tr("Translations other than English are a first pass by a model. Corrections are welcome — each language is one file in the source.")}
                                </p>
                                <div className="mt-4 border-t border-slate-100 dark:border-slate-700 pt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
                                    <div className="min-w-0 flex-1 basis-64">
                                        <label htmlFor="number-format" className="font-medium text-slate-900 dark:text-white">{tr("Numbers")}</label>
                                        <p className="text-sm text-slate-500 dark:text-slate-400">
                                            {tr("How counts and answers are written. What you type into an answer is not affected: a comma and a point are always both accepted.")}
                                        </p>
                                    </div>
                                    {/* The options carry NO labels, in any language: the
                                        example IS the option. "1.234,5" says what it does
                                        to anyone who reads a number, where "point group,
                                        comma decimal" has to be decoded — and it needs no
                                        translating, so the twelve locale files do not
                                        grow a row of near-identical sentences. */}
                                    <Select
                                        id="number-format"
                                        value={numberFormat}
                                        onChange={e => void setNumberFormat(e.target.value)}
                                        // Wider than the language select above it: the
                                        // default option carries a worked example, and at
                                        // w-56 it was clipped to "Same as the language (1,234…".
                                        className="w-full sm:w-64 shrink-0 tabular-nums"
                                    >
                                        <option value={NUMBER_AUTO}>{tr("Same as the language")} ({formatNumber(1234.5, NUMBER_AUTO)})</option>
                                        {NUMBER_STYLES.map(style => (
                                            <option key={style.id} value={style.id}>{style.id}</option>
                                        ))}
                                    </Select>
                                </div>

                            </div>
                        </section>

                        {/* CALENDAR — one preference, set once.
                            This was a Mon-Sun / Sun-Sat toggle living in the calendar's
                            own toolbar as component state: it reset to Monday on every
                            navigation, it was duplicated (the global calendar simply
                            hardcoded Monday and ignored it), and on a phone it spent
                            100px of a toolbar that also has to carry the month, the
                            view mode and the arrows. Nobody changes which day their
                            week starts on twice. */}
                        <section className={activeTab === 'general' ? 'mb-8' : 'hidden'}>
                            <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-4">{tr("Calendar")}</h2>
                            {/* One preference, one row: the words on the left, the
                                control on the right. It wraps under the words only when
                                the row is genuinely too narrow (a phone), not on a desktop
                                where a two-line stack read as a form. */}
                            <div className="bg-white dark:bg-slate-800 rounded-xl p-4 shadow-sm flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
                                <div className="min-w-0">
                                    <p className="font-medium text-slate-900 dark:text-white">{tr("Week starts on")}</p>
                                    <p className="text-sm text-slate-500 dark:text-slate-400">
                                        {tr("Used by every calendar and week view in the app.")}
                                    </p>
                                </div>
                                <SegmentedControl
                                    label={tr("Week starts on")}
                                    value={weekStartDay}
                                    onChange={d => void setWeekStartDay(d as 0 | 1)}
                                    options={[
                                        { value: 1, label: tr("Monday") },
                                        { value: 0, label: tr("Sunday") },
                                    ]}
                                />
                            </div>
                        </section>

                        {/* THIS COMPUTER — only under the desktop launcher. Where the
                            library lives (the one thing to back up), whether the server
                            outlives its window, and a way to stop it that is not Task
                            Manager. See server/desktop.js. */}
                        {desktop?.desktop && (
                            <section className={activeTab === 'general' ? 'mb-8' : 'hidden'}>
                                <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-4">{tr("This computer")}</h2>
                                <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm divide-y divide-slate-100 dark:divide-slate-700/60">
                                    <div className="p-4 flex flex-col gap-3 sm:flex-row sm:items-start">
                                        <div className="min-w-0 flex-1">
                                            <p className="font-medium text-slate-900 dark:text-white">{tr("Your data")}</p>
                                            <p className="text-sm text-slate-500 dark:text-slate-400 break-all font-mono">{desktop.dataDir}</p>
                                            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                                                {tr("The library and every uploaded file are in this folder. Back it up and you have backed up everything; a new version of the app never touches it.")}
                                            </p>
                                        </div>
                                        <Button
                                            onClick={() => void desktopApi.openDataDir().catch(() => addToast('error', tr("Could not open the folder")))}
                                            className="self-start shrink-0"
                                        >
                                            {tr("Open folder")}
                                        </Button>
                                    </div>
                                    <div className="p-4 flex flex-col gap-3 sm:flex-row sm:items-start">
                                        <div className="min-w-0 flex-1">
                                            <p className="font-medium text-slate-900 dark:text-white">{tr("Keep running in the background")}</p>
                                            <p className="text-sm text-slate-500 dark:text-slate-400">
                                                {/* Under a tray icon this is not a preference: the icon
                                                    IS the app's presence, so the server outliving its
                                                    window is what makes the icon mean anything. A switch
                                                    that cannot change the answer is worse than a
                                                    sentence saying what the answer is. */}
                                                {desktop.trayHosted
                                                    ? tr("On, and not a choice here: the icon in the notification area is the app. Closing the window leaves it serving — for your phone, or to open it again instantly — and that icon's own menu is where you quit it.")
                                                    : tr("Off: closing the last window stops the app. On: it keeps serving — for your phone, or to open the window again instantly — until you quit it here.")}
                                            </p>
                                        </div>
                                        {!desktop.trayHosted && (
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
                                        )}
                                    </div>
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
                                                    {tr("Opens the app as the computer finishes starting. With \"keep running\" on as well, it is simply always there — including for your phone.")}
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
                                                {tr("Stops the app on this computer. Version {{version}}, port {{port}}.", { version: desktop.version, port: desktop.port })}
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
                                            <p className="text-sm text-slate-500 dark:text-slate-400">
                                                {tr("One request a day to GitHub's public release list, from this server. It sends the version and nothing else. Off by default — this is the app's only unattended outbound call.")}
                                            </p>
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
                                        <p className="text-sm text-slate-500 dark:text-slate-400">
                                            {tr("Including a lesson or an answer the AI got wrong. Nothing is sent from here — you see the details first and submit it yourself.")}
                                        </p>
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
                            <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-4">{tr("Keyboard shortcuts")}</h2>
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
                            <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-1">{tr("Search links")}</h2>
                            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
                                {tr("Where the app offers to send you to research a topic yourself — a link you click, not something the AI reads. Enabled providers appear on topics and on answers you got wrong.")}
                            </p>
                            <SearchProvidersPanel />
                        </section>

                        <section className={activeTab === 'data' ? 'mb-8' : 'hidden'}>
                            <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-1">{tr("Import & Export")}</h2>
                            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
                                {tr("Move projects between machines as portable JSON files — structure, notes, resources and progress included.")}
                            </p>
                            <div className="bg-white dark:bg-slate-800 rounded-xl p-4 shadow-sm">
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    {/* Import */}
                                    <div className="p-4 bg-slate-50 dark:bg-slate-700/30 rounded-xl border border-slate-200 dark:border-slate-600 flex flex-col">
                                        <div className="flex items-center gap-3 mb-3">
                                            <div className="p-2 bg-emerald-500 rounded-lg">
                                                <Download className="w-5 h-5 text-white" />
                                            </div>
                                            <div>
                                                <p className="font-semibold text-slate-900 dark:text-white">{tr("Import Project")}</p>
                                                <p className="text-sm text-slate-500 dark:text-slate-400">{tr("Load from JSON file")}</p>
                                            </div>
                                        </div>

                                        <input
                                            ref={fileInputRef}
                                            type="file"
                                            accept=".json"
                                            onChange={handleFileSelect}
                                            className="hidden"
                                        />

                                        {importFile && (
                                            <div className="mb-3 flex items-center gap-2 p-2 bg-white dark:bg-slate-700 rounded-lg">
                                                <span className="flex-1 text-sm text-slate-700 dark:text-slate-300 truncate">
                                                    {importFile.name}
                                                </span>
                                                <IconButton
                                                    size="sm"
                                                    onClick={handleClearFile}
                                                    label={tr("Remove selected file")}
                                                    icon={<X className="w-4 h-4" aria-hidden="true" />}
                                                />
                                            </div>
                                        )}

                                        <div className="mt-auto space-y-2">
                                            {importFile ? (
                                                <Button
                                                    variant="primary"
                                                    size="lg"
                                                    block
                                                    busy={importing}
                                                    onClick={handleImportProject}
                                                >
                                                    {tr("Import Project")}
                                                </Button>
                                            ) : (
                                                <Button
                                                    variant="primary"
                                                    size="lg"
                                                    block
                                                    onClick={() => fileInputRef.current?.click()}
                                                >
                                                    {tr("Choose File")}
                                                </Button>
                                            )}
                                        </div>
                                    </div>

                                    {/* Export */}
                                    <div className="p-4 bg-slate-50 dark:bg-slate-700/30 rounded-xl border border-slate-200 dark:border-slate-600 flex flex-col">
                                        <div className="flex items-center gap-3 mb-3">
                                            <div className="p-2 bg-accent rounded-lg">
                                                <Upload className="w-5 h-5 text-white" />
                                            </div>
                                            <div>
                                                <p className="font-semibold text-slate-900 dark:text-white">{tr("Export Project")}</p>
                                                <p className="text-sm text-slate-500 dark:text-slate-400">{tr("Save to JSON file")}</p>
                                            </div>
                                        </div>

                                        {projects.length > 0 ? (
                                            <div className="mt-auto space-y-2">
                                                <select
                                                    value={selectedExportProject || ''}
                                                    onChange={(e) => setSelectedExportProject(Number(e.target.value))}
                                                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-white text-sm"
                                                >
                                                    {projects.map(p => (
                                                        <option key={p.id} value={p.id}>{p.name}</option>
                                                    ))}
                                                </select>
                                                <Button
                                                    variant="primary"
                                                    size="lg"
                                                    block
                                                    busy={exporting}
                                                    disabled={!selectedExportProject}
                                                    onClick={handleExportProject}
                                                >
                                                    {tr("Export Project")}
                                                </Button>
                                            </div>
                                        ) : (
                                            <p className="text-sm text-slate-500 dark:text-slate-400 text-center py-4 mt-auto">
                                                {tr("No projects to export")}
                                            </p>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </section>

                        {/* Anki import gets its own section rather than a third
                            card in the grid above: it is the front door for
                            people arriving with an existing collection, and
                            burying it next to "export as JSON" would hide the
                            one thing that gives a new user content on day one. */}
                        <section className={activeTab === 'data' ? 'mb-8' : 'hidden'}>
                            <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-1">{tr("Coming from Anki?")}</h2>
                            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
                                {tr("Bring a deck across with its review history intact. Your decks become topics, and everything here — lessons, questions, mastery — works on them from then on.")}
                            </p>
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

                        {/* The log lives under Data because that is what it is —
                            something kept on this machine that the person can
                            read, take away or delete, like every other row on
                            this tab. */}
                        <section className={activeTab === 'data' ? 'mb-8' : 'hidden'}>
                            <ActivityLogPanel />
                        </section>

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
                        <section className={activeTab === 'data' ? 'mb-8' : 'hidden'}>
                            <SectionHeader title={tr("Visual feedback")}>
                                {tr("Every time you use")}{' '}<strong>{tr("Fix this")}</strong> {tr("on a diagram, chart, animation or widget, what you wrote and what the AI drew next are appended to a file here. Nothing is sent anywhere. Share it if you want a bad drawing fixed for everyone.")}
                            </SectionHeader>
                            <Panel>
                                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                                    <div className="min-w-0 flex-1">
                                        <p className="font-medium text-slate-900 dark:text-white">
                                            {visualFeedback === null
                                                ? tr("Checking…")
                                                : visualFeedback.count === 0
                                                    ? tr("Nothing reported yet")
                                                    : tr("{{count}} reports", { count: visualFeedback.count })}
                                        </p>
                                        <p className="text-sm text-slate-500 dark:text-slate-400 break-all">
                                            {visualFeedback && visualFeedback.count > 0
                                                ? <><code className="text-xs">{visualFeedback.path}</code> {tr("· {{value}} KB", { value: (visualFeedback.bytes / 1024).toFixed(1) })}</>
                                                : tr("Reports appear here once you use “Fix this” on a visual.")}
                                        </p>
                                    </div>
                                    <div className="flex shrink-0 flex-wrap items-center gap-2">
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
                            </Panel>
                        </section>


                        {/* AI CONNECTION (provider-agnostic) */}
                        <section className={activeTab === 'ai' ? 'mb-8' : 'hidden'}>
                            {/* "AI Provider" named the setting, not the section: what
                                is chosen here is the MODEL, and the provider is one of
                                four fields under it. */}
                            <SectionHeader title={tr("The model")} icon={Cpu}>
                                {tr("What powers tutoring, generated lessons, quizzes and flashcards. It talks to your endpoint and nobody else's — nothing leaves this machine unless you point it at a hosted API.")}
                            </SectionHeader>
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
                                        <span className={`flex items-center gap-1.5 text-xs font-medium ${connectionStatus === 'connected' ? 'text-emerald-700 dark:text-emerald-400' : connectionStatus === 'disconnected' ? 'text-red-700 dark:text-red-400' : 'text-amber-700 dark:text-amber-400'}`}>
                                            <span className={`w-1.5 h-1.5 rounded-full ${connectionStatus === 'connected' ? 'bg-emerald-500' : connectionStatus === 'disconnected' ? 'bg-red-500' : 'bg-amber-500 animate-pulse'}`} />
                                            {connectionStatus === 'checking' && tr("Checking…")}
                                            {connectionStatus === 'connected' && tr("Connected")}
                                            {connectionStatus === 'disconnected' && (connectionError || tr("Not connected"))}
                                        </span>
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

                                {/* SIZE GUIDANCE — it used to be its own section BELOW
                                    the picker, i.e. the advice on how to choose came
                                    after the choosing. Folded in here, closed, because
                                    it is read once. */}
                                <details className="group rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40">
                                    <summary className={`flex items-center gap-2 px-3 h-10 touch:min-h-11 cursor-pointer list-none text-sm font-medium text-slate-700 dark:text-slate-200 rounded-lg ${FOCUS_RING}`}>
                                        <ChevronRight className="w-4 h-4 shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
                                        {tr("What size of model does this app need?")}
                                    </summary>
                                    <div className="px-3 pb-3 pt-1 space-y-3 border-t border-slate-200 dark:border-slate-700">
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
                                            {tr("No GPU, or you would rather rent one: point the provider above at an OpenAI-compatible endpoint and paste your own key. The same size classes apply there — renting a model does not make it a bigger one.")}
                                        </p>
                                    </div>
                                </details>

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
                                        <Field
                                            label={tr("How much should the model think before answering?")}
                                            hint={tr("Thinking models write out their reasoning before they answer, often several times the length of the answer itself. In chat you can open it under \"Reasoning\"; for lessons, questions and visuals it is written, paid for and thrown away — and a model that spends its whole budget thinking returns no lesson at all, which is why Automatic asks those jobs for brief. Ask for more when lessons arrive thin. Endpoints that cannot do this ignore it.")}
                                        >
                                            {id => (
                                                <SegmentedControl
                                                    label={tr("How much should the model think before answering?")}
                                                    value={reasoningEffort}
                                                    onChange={chooseReasoningEffort}
                                                    options={[
                                                        { value: '', label: tr("Automatic"), title: tr("Brief for lessons, questions and visuals, where nobody reads the reasoning; whatever the model does by default in chat, where you can.") },
                                                        { value: 'low', label: tr("Brief"), title: tr("The fastest and cheapest answers. Good for chat and summaries.") },
                                                        { value: 'medium', label: tr("Balanced"), title: tr("A middle budget.") },
                                                        { value: 'high', label: tr("Thorough"), title: tr("For writing curricula and checking answer keys, where being right matters more than being quick.") },
                                                    ]}
                                                />
                                            )}
                                        </Field>

                                        <details
                                            className="group rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40"
                                            onToggle={e => { if ((e.currentTarget as HTMLDetailsElement).open && servingEndpoints === null) loadServingEndpoints(); }}
                                        >
                                            <summary className={`flex items-center gap-2 px-3 h-10 touch:min-h-11 cursor-pointer list-none text-sm font-medium text-slate-700 dark:text-slate-200 rounded-lg ${FOCUS_RING}`}>
                                                <ChevronRight className="w-4 h-4 shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
                                                {tr("Which machine serves this model")}
                                                {providerOrder.length > 0 && (
                                                    <span className="ml-auto text-sm font-normal text-slate-500 dark:text-slate-400">
                                                        {providerOrder.length === 1 ? tr("1 preferred") : tr("{{n}} preferred", { n: num(providerOrder.length) })}
                                                    </span>
                                                )}
                                            </summary>
                                            <div className="px-3 pb-3 pt-1 space-y-3 border-t border-slate-200 dark:border-slate-700">
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
                                                        {/* Ticked ones float to the top, in the
                                                            order they were ticked. The list arrives
                                                            sorted by price, so leaving it alone put
                                                            "2." above "1." and made a sentence
                                                            about order into a puzzle. */}
                                                        <ul className="space-y-1">
                                                            {[...servingEndpoints].sort((a, b) => {
                                                                const ra = providerOrder.indexOf(a.slug), rb = providerOrder.indexOf(b.slug);
                                                                if (ra >= 0 && rb >= 0) return ra - rb;
                                                                if (ra >= 0) return -1;
                                                                if (rb >= 0) return 1;
                                                                return 0;
                                                            }).map(ep => {
                                                                const rank = providerOrder.indexOf(ep.slug);
                                                                return (
                                                                    <li key={ep.slug}>
                                                                        <label className="flex items-start gap-2.5 py-1.5 cursor-pointer">
                                                                            <Checkbox
                                                                                checked={rank >= 0}
                                                                                onChange={() => toggleProvider(ep.slug)}
                                                                                aria-label={ep.name}
                                                                                className="mt-0.5"
                                                                            />
                                                                            <span className="min-w-0 flex-1">
                                                                                <span className="flex items-baseline gap-2 flex-wrap">
                                                                                    {rank >= 0 && (
                                                                                        <span className="text-sm font-semibold text-accent-fg tabular-nums">{num(rank + 1)}.</span>
                                                                                    )}
                                                                                    <span className="text-sm font-medium text-slate-900 dark:text-white">{ep.name}</span>
                                                                                    {ep.quantization && (
                                                                                        <span className="text-xs text-slate-500 dark:text-slate-400">{ep.quantization}</span>
                                                                                    )}
                                                                                </span>
                                                                                <span className="block text-sm text-slate-500 dark:text-slate-400">
                                                                                    {ep.completionPrice > 0
                                                                                        ? tr("${{out}} per million tokens out", { out: num(ep.completionPrice, { decimals: 2 }) })
                                                                                        : tr("Price not reported")}
                                                                                    {ep.uptime !== null && ` · ${tr("{{pct}}% up", { pct: num(Math.round(ep.uptime)) })}`}
                                                                                </span>
                                                                            </span>
                                                                        </label>
                                                                    </li>
                                                                );
                                                            })}
                                                        </ul>
                                                    </>
                                                )}
                                            </div>
                                        </details>
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
                            searches, in one section. They used to be two peers, so
                            the first had to end with "a SearXNG instance set below
                            is used too" to point at the second. Off until asked
                            for, because a typed question is a far more personal
                            thing to hand a search engine than a topic title (see
                            SECURITY.md's packet-capture claim). */}
                        <section className={activeTab === 'ai' ? 'mb-8' : 'hidden'}>
                            <SectionHeader title={tr("Answering with the web")} icon={Globe}>
                                {tr("Lets the tutor and the assistant look something up while answering, and cite the pages they used. This is the one feature that sends anything you typed, so it ships off — and however you set it, any single question can still be kept to yourself.")}
                            </SectionHeader>
                            <Panel flush className="divide-y divide-slate-100 dark:divide-slate-700/60">
                                <div className="p-4">
                                    <Field
                                        label={tr("Let answers use the web")}
                                        help={tr("The tutor and the assistant decide for themselves whether a question needs looking up, and write their own search terms — so an answer can check this year’s rule without you having to know it had to. Each answer ends with what it searched for and a link to every page it used.")}
                                    >
                                        {id => (
                                            <SegmentedControl
                                                label={tr("Let answers use the web")}
                                                value={webSearch}
                                                onChange={saveWebSearch}
                                                options={[
                                                    { value: 'off', label: tr("Never"), title: tr("Nothing you type is ever sent to a search engine.") },
                                                    { value: 'ask', label: tr("Ask each question"), title: tr("A switch appears beside the tutor and the assistant, off until you turn it on for that question.") },
                                                    { value: 'auto', label: tr("Whenever it helps"), title: tr("They look things up when they judge it is needed. The switch stays, so you can still keep one question to yourself.") },
                                                ]}
                                            />
                                        )}
                                    </Field>
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
                                                <div className="flex gap-2 shrink-0">
                                                    <Button onClick={handleTestSearxng} className="flex-1 sm:flex-none">{tr("Test")}</Button>
                                                    <Button onClick={handleSetDefaultSearxng} className="flex-1 sm:flex-none whitespace-nowrap">{tr("Use the default")}</Button>
                                                </div>
                                            </div>
                                        )}
                                    </Field>
                                </div>
                            </Panel>
                        </section>

                        {/* VISUALS — every kind the tutor may draw, as a gallery with a switch each
                            (src/components/settings/VisualKindsPanel.tsx). */}
                        <section className={activeTab === 'ai' ? 'mb-8' : 'hidden'}>
                            <VisualKindsPanel active={activeTab === 'ai'} />
                        </section>

                        {/* RESOURCE CURATION DURING PROJECT CREATION */}
                        <section className={activeTab === 'ai' ? 'mb-8' : 'hidden'}>
                            <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-1 flex items-center gap-2">
                                <Sparkles className="w-5 h-5 text-accent-fg" /> {tr("Resource hunting")}
                            </h2>
                            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
                                {tr("While generating a project, the AI can search the web and pick 2–4 links for")}
                                <em> {tr("every single topic")}</em>{tr(". It is by a wide margin the largest part of creation — a 700-topic curriculum means 700 searches and 700 model calls, before you’ve read a word. With it off, creation skips every one of them and you fetch links from a topic’s Resources list when you actually open it.")}
                            </p>
                            <div className="bg-white dark:bg-slate-800 rounded-xl p-4 shadow-sm">
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
                            </div>
                        </section>

                        {/* PDF MATH RECOVERY */}
                        <section className={activeTab === 'ai' ? 'mb-8' : 'hidden'}>
                            <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-1 flex items-center gap-2">
                                <Sparkles className="w-5 h-5 text-accent-fg" /> {tr("PDF math recovery")}
                            </h2>
                            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
                                {tr("Some PDFs (Word/LaTeX exports of exams & worksheets) store their formulas in fonts with no text mapping, so an equation like")}{' '}<code>x(t) = 1 − t²</code> {tr("is extracted as an empty")}
                                <code> ( )</code>{tr(". When a vault PDF is detected like this, the affected pages are re-read from the rendered image in the background — a vision model transcribes them to clean Markdown + LaTeX, and OCR is the offline fallback. Clean PDFs are untouched.")}
                            </p>
                            <div className="bg-white dark:bg-slate-800 rounded-xl p-4 shadow-sm space-y-2">
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
                        </section>

                        {/* ATLAS REGION NAMES */}
                        <section className={activeTab === 'ai' ? 'mb-8' : 'hidden'}>
                            <SectionHeader title={tr("Atlas region names")} icon={MapIcon}>
                                <>
                                    {tr("The atlas groups your topics into regions and names each one. Without a model it uses the most central topic’s own title, which names a whole discipline after one lesson inside it — “Force and Motion” printed across all of physics. A model reads every title in the region and writes a name that covers them. This is a short noun phrase, not a conversation: a small, fast instruct model does it better than a large reasoning one, which spends its budget deliberating and times out.")}
                                </>
                            </SectionHeader>
                            <Panel>
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
                            </Panel>
                        </section>

                        {/* CARD IMAGE DESCRIPTIONS */}
                        <section className={activeTab === 'ai' ? 'mb-8' : 'hidden'}>
                            <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-1 flex items-center gap-2">
                                <ImageIcon className="w-5 h-5 text-accent-fg" /> {tr("Describe card pictures")}
                            </h2>
                            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
                                {tr("A card whose question is a photograph reads to the AI as a card with no question, and to a screen reader as a filename. One description fixes both. Pictures that arrived with a description written by the deck’s own author keep it — a model never overwrites those. The rest need a vision model, and this runs in the background at your pace.")}
                            </p>
                            <div className="bg-white dark:bg-slate-800 rounded-xl p-4 shadow-sm space-y-3">
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
                            </div>
                        </section>

                        {/* SEMANTIC SEARCH (VAULT EMBEDDINGS) */}
                        <section className={activeTab === 'ai' ? 'mb-8' : 'hidden'}>
                            <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-1 flex items-center gap-2">
                                <Sparkles className="w-5 h-5 text-accent-fg" /> {tr("Vault semantic search")}
                            </h2>
                            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
                                {tr("Lets the tutor find vault content by")}{' '}<em>{tr("meaning")}</em>{tr(", not just keywords. Runs a small local embedding model over your files and blends the results with keyword search. Entirely optional: without an embedding model the vault falls back to keyword search.")}
                            </p>
                            <div className="bg-white dark:bg-slate-800 rounded-xl p-4 shadow-sm">
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
                                                        <span className="font-medium">{embStatus.stats.indexed}</span> {tr("/ {{total}} files indexed", { total: embStatus.stats.total })}
                                                        <span className="text-slate-500 dark:text-slate-400"> {tr("· {{vectors}} vectors", { vectors: num(embStatus.stats.vectors) })}</span>
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
                            </div>
                        </section>

                        {/* HELP */}
                        <section className={activeTab === 'ai' ? 'mb-8' : 'hidden'}>
                            <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-4">{tr("Setup help")}</h2>
                            <div className="bg-white dark:bg-slate-800 rounded-xl p-4 shadow-sm">
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
                            </div>
                        </section>
                    </div>
                </div>
            </div>
        </div>
    );
}
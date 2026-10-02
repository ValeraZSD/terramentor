import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store';
import { api, OllamaModel } from '../../api';
import {
    RefreshCw, Loader2, Sparkles, Database,
    Image as ImageIcon, Map as MapIcon, FileText,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Checkbox from '../Checkbox';
import { Button } from '../ui/Button';
import SegmentedControl from '../ui/SegmentedControl';
import Switch from '../ui/Switch';
import Radio from '../ui/Radio';
import { Explain, ExpandableSection } from '../ui/Disclosure';
import ModelPicker from '../ModelPicker';
import { useNumberFormat } from '../../hooks/useNumberFormat';
import { SectionHeader, Panel, Collapse } from './SettingsParts';
import type { SettingsSnapshot } from './settingsSnapshot';
import type { EmbeddingStatusHandle } from './useEmbeddingStatus';
import { settingTargetId } from '../../utils/settingTarget';

// How to recover math from PDFs whose text layer drops formulas. One UI control
// over two backend settings (pdf_math_recovery + pdf_recovery_vision).
type RecoveryMode = 'off' | 'ocr' | 'auto' | 'vision';

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
function ModelJobRow({ icon, title, desc, aside, children, id }: {
    icon: LucideIcon;
    title: React.ReactNode;
    desc: React.ReactNode;
    aside?: React.ReactNode;
    children: React.ReactNode;
    /** A link target (`/settings#ai/<target>`), as `settingTargetId` builds it. */
    id?: string;
}) {
    return (
        <ExpandableSection id={id} variant="row" icon={icon} title={title} desc={desc} aside={aside}>
            {children}
        </ExpandableSection>
    );
}

/** Settings → AI & Models → Model jobs. The model list, the chat model and the
 *  embedding status are the model section's, handed down. */
export default function ModelJobsSection({ active, snapshot, models, modelsLoading, loadModels, currentModel, emb }: {
    active: boolean;
    snapshot: SettingsSnapshot | null;
    models: OllamaModel[];
    modelsLoading: boolean;
    loadModels: () => void;
    currentModel: string;
    emb: EmbeddingStatusHandle;
}) {
    const { t: tr } = useTranslation();
    const num = useNumberFormat();
    const addToast = useStore(s => s.addToast);
    // Whether project creation curates web resources for every leaf topic — by
    // far its most expensive phase (a search + a model call per topic).
    const [findResources, setFindResources] = useState(true);
    const [recoveryMode, setRecoveryMode] = useState<RecoveryMode>('auto');
    // Optional dedicated vision model for PDF recovery ('' = use the chat model).
    const [recoveryVisionModel, setRecoveryVisionModel] = useState('');
    // Optional dedicated model for naming atlas regions ('' = use the chat model).
    const [atlasNamingModel, setAtlasNamingModel] = useState('');
    const { embStatus, embModelInput, setEmbModelInput, loadEmbStatus } = emb;
    const [embReindexing, setEmbReindexing] = useState(false);
    // What the endpoint serving embeddings lists as embedding models — asked
    // again whenever which endpoint that is could have changed.
    const [embList, setEmbList] = useState<{ provider: string; available: boolean; models: string[] } | null>(null);
    const loadEmbList = () => { api.getEmbeddingModels().then(setEmbList).catch(() => setEmbList(null)); };
    useEffect(loadEmbList, [embStatus?.config.provider, currentModel]);  // eslint-disable-line react-hooks/exhaustive-deps
    const embPickerModels = useMemo<OllamaModel[]>(
        () => (embList?.models ?? []).map(name => ({ name, size: 0, modified_at: '', digest: '' })),
        [embList],
    );

    // Card-image descriptions. Polled while a sweep runs — it is a background
    // chain with no stream of its own, and a progress bar that only moves on a
    // reload is worse than no progress bar.
    const [mediaStats, setMediaStats] = useState<import('../../types').MediaDescriptionStatus | null>(null);
    const loadMediaStats = async () => {
        try { setMediaStats(await api.getMediaDescriptionStatus()); }
        catch { /* older backend — the section simply shows nothing */ }
    };
    useEffect(() => {
        if (!mediaStats?.running) return;
        const t = setInterval(loadMediaStats, 2000);
        return () => clearInterval(t);
    }, [mediaStats?.running]);
    useEffect(() => { loadMediaStats(); }, []);

    // This panel's half of the one settings read (see settingsSnapshot.ts).
    useEffect(() => {
        if (!snapshot?.ok) return;
        const settings = snapshot.values;
        if (settings.creation_find_resources !== undefined) {
            setFindResources(settings.creation_find_resources !== 'false');
        }
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
    }, [snapshot]);

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

    return (
        <>
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
            <section className={active ? 'mb-8' : 'hidden'}>
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
                                        : 'border-slate-300 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800'}`}
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
                                        <span className="block text-sm text-slate-600 dark:text-slate-300">{opt.desc}</span>
                                    </span>
                                </label>
                            ))}

                            {/* Dedicated vision model — so chat can stay on a text-only
                                model while pages are transcribed by a vision model on the
                                same provider. Only relevant when vision may run. */}
                            {(recoveryMode === 'auto' || recoveryMode === 'vision') && (
                                <div className="pt-2 mt-1 border-t border-slate-200 dark:border-slate-700">
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
                            {tr("Leave as the chat model, or pick a smaller, faster one for these short names.")}
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
                                ? tr("{{described}} of {{images}} described", { described: num(mediaStats.described), images: num(mediaStats.images) })
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
                        id={settingTargetId('embeddings')}
                        icon={Database}
                        title={tr("Vault semantic search")}
                        desc={tr("Draws the atlas and finds vault content by meaning, using an embedding model. Optional — everything else, keyword search included, works without one.")}
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
                                <div className="pt-4 border-t border-slate-200 dark:border-slate-700">
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
                                <div className="pt-4 border-t border-slate-200 dark:border-slate-700">
                                    <div className="flex flex-wrap items-baseline gap-x-1.5 mb-1">
                                        <label className="font-medium text-slate-900 dark:text-white">{tr("Embedding model")}</label>
                                        {embStatus?.probe?.ok && (
                                            <span className="text-sm text-emerald-600 dark:text-emerald-400">
                                                <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1 align-middle" />
                                                {tr("connected")}{embStatus.probe.dim ? tr("({{dim}}-dim)", { dim: embStatus.probe.dim }) : ''}{tr(". Vault files will be indexed automatically.")}
                                            </span>
                                        )}
                                    </div>
                                    {embList?.available ? (
                                        <p className="text-sm text-slate-500 dark:text-slate-400 mb-2">
                                            {/* Nothing chosen yet, and the server's
                                                default for this endpoint is on its
                                                list: say the app picked it, so the
                                                field is not mistaken for a choice. */}
                                            {embStatus?.config.modelIsDefault && embList.models.includes(embStatus.config.model)
                                                ? tr("The app picked this one for your endpoint. Choose another from the list to change it.")
                                                : tr("Pick one of the embedding models your endpoint offers.")}
                                        </p>
                                    ) : (
                                        <p className="text-sm text-slate-500 dark:text-slate-400 mb-2">
                                            {tr("Name of the embedding model on the embedding provider above (e.g.")}{' '}<code className="text-xs">nomic-embed-text</code>{tr("). For Ollama, pull it first:")}{' '}<code className="text-xs">ollama pull nomic-embed-text</code>.
                                        </p>
                                    )}
                                    {/* The endpoint's own EMBEDDING list when it
                                        publishes one; otherwise the chat
                                        provider's list, which is not always
                                        where embeddings run — a suggestion then,
                                        and typing an id the list does not carry
                                        stays first-class either way. */}
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
                                        models={embList?.available ? embPickerModels : models}
                                        loading={modelsLoading}
                                        onRefresh={() => { loadModels(); loadEmbList(); }}
                                        placeholder={tr("nomic-embed-text")}
                                        sizeTiers={false}
                                    />
                                    {/* The built-in default is an Ollama name; on
                                        a hosted endpoint it is simply not there,
                                        and the probe's error alone does not say
                                        what to do about it. */}
                                    {embList?.available && embStatus?.config.model
                                        && !embList.models.includes(embStatus.config.model) && (
                                        <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
                                            {tr("Your endpoint does not offer “{{model}}”. Pick one of its embedding models from the list.", { model: embStatus.config.model })}
                                        </p>
                                    )}
                                </div>

                                {/* Connection / index status */}
                                <div className="pt-4 border-t border-slate-200 dark:border-slate-700 space-y-2">
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
        </>
    );
}

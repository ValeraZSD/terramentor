import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store';
import { api, OllamaModel, PullProgress, SavedConnection, ServingEndpoint } from '../../api';
import { AIProvider } from '../../types';
import { Cpu } from 'lucide-react';
import { Button } from '../ui/Button';
import { Field, TextInput } from '../ui/Field';
import Switch from '../ui/Switch';
import { Explain } from '../ui/Disclosure';
import ModelPicker from '../ModelPicker';
import { MODEL_TIERS, TIER_DOT } from '../../utils/modelTiers';
import ConnectionsPanel from './connections/ConnectionsPanel';
import { providerOf } from './connections/providers';
import VisualKindsPanel from './VisualKindsPanel';
import { SectionHeader, Collapse, StatusDot } from './SettingsParts';
import ThinkingSlider from './ThinkingSlider';
import ServingEndpointsPicker from './ServingEndpointsPicker';
import WebAnswersSection from './WebAnswersSection';
import ModelJobsSection from './ModelJobsSection';
import SetupHelpSection from './SetupHelpSection';
import { useEmbeddingStatus } from './useEmbeddingStatus';
import type { SettingsSnapshot } from './settingsSnapshot';

const hostOfUrl = (url: string) => { try { return new URL(url).host; } catch { return url; } };

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

/** The saved Ollama model as the INSTALLED list names it: the same model
 *  with or without its `:latest` tag. Anything not found is kept as saved —
 *  the backend / user is the source of truth, and silently switching to
 *  `models[0]` would clobber a valid selection during the brief window where
 *  Ollama returns a partial model list at startup. */
function installedName(saved: string, models: OllamaModel[]): string {
    // Nothing chosen stays nothing chosen. Picking the first installed model
    // here would be saved, so merely OPENING Settings loaded a model and
    // started background lessons for a learner who had skipped the model step.
    if (!saved) return saved;
    if (models.some(m => m.name === saved)) return saved;
    // "gemma4" → "gemma4:latest" (only when the saved name has no tag)
    if (!saved.includes(':')) {
        const latestMatch = models.find(m => m.name === `${saved}:latest`);
        if (latestMatch) return latestMatch.name;
    }
    // saved "qwen3.5:9b", installed "qwen3.5:9b:latest"
    const withoutLatestFromInstalled = models.find(m => m.name.replace(':latest', '') === saved);
    if (withoutLatestFromInstalled) return withoutLatestFromInstalled.name;
    // saved "qwen3.5:9b:latest", installed "qwen3.5:9b"
    if (saved.includes(':latest')) {
        const stripped = saved.replace(':latest', '');
        const match = models.find(m => m.name === stripped || m.name.replace(':latest', '') === stripped);
        if (match) return match.name;
    }
    return saved;
}

/** Settings → AI & Models. Owns the saved connections (connections/), the
 *  model of the one in use and how hard it thinks; the web, visuals, model
 *  jobs and help sections sit under it. */
export default function AISettings({ active, snapshot }: { active: boolean; snapshot: SettingsSnapshot | null }) {
    const { t: tr } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const showConfirm = useStore(s => s.showConfirm);

    // Which protocol the connection in use speaks: Ollama keeps its own model
    // row and its install/delete controls; everything else is the OpenAI-
    // compatible row. Read from /api/ai/status after every change.
    const [provider, setProvider] = useState<AIProvider>('ollama');
    // The saved connection in use (ConnectionsPanel reports it), or null.
    const [activeConnection, setActiveConnection] = useState<SavedConnection | null>(null);
    const [openaiModel, setOpenaiModel] = useState('');
    // The thinking levels the chosen model offers (null: its provider says nothing).
    const [effortLevels, setEffortLevels] = useState<string[] | null>(null);

    /** A write that changes what answers has LANDED: update the store's mirror
     *  and bump `aiConfigRev`, which every open chat surface watches to re-ask
     *  the server who is on the other end. Called after the write resolves,
     *  never before, or the re-ask could still read the old row. */
    const announceAI = (patch: { provider?: AIProvider; model?: string } = {}) =>
        useStore.setState(s => ({
            ...(patch.provider ? { aiProvider: patch.provider } : {}),
            ...(patch.model !== undefined ? { aiModel: patch.model || null } : {}),
            aiConfigRev: s.aiConfigRev + 1,
        }));

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
    const aiEnabledRef = useRef(true);
    const [models, setModels] = useState<OllamaModel[]>([]);
    // false when the provider publishes no model list (a lab): the model is typed.
    const [modelsListed, setModelsListed] = useState(true);
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

    // Model install
    const [newModelName, setNewModelName] = useState('');
    const [installing, setInstalling] = useState(false);
    const [installProgress, setInstallProgress] = useState<PullProgress | null>(null);
    const [installError, setInstallError] = useState<string | null>(null);
    const [installingModelId, setInstallingModelId] = useState<string | null>(null);

    // SAVING. Every setting in this panel is written by the HANDLER that
    // changed it, never by an effect watching the state. The effects that used
    // to do it ran a second time under StrictMode with the first render's
    // DEFAULTS, so in dev merely opening Settings wrote `ai_enabled = true`
    // over a saved false and `ai_model = ""` / `ai_openai_model = ""` over the
    // saved models (measured on a scratch library, 2026-10-01:
    // temp/settings-open-writes.mjs); in a production build the same effects
    // re-wrote every loaded value on each open. A handler only runs when the
    // learner did something.
    //
    // Writes to one key are CHAINED, so two quick presses land in order and
    // the last one is what the server keeps; a failed write does not block the
    // next one.
    const writeChains = useRef(new Map<string, Promise<unknown>>());
    const writeSetting = (key: string, value: string) => {
        const write = (writeChains.current.get(key) ?? Promise.resolve())
            .catch(() => { })
            .then(() => api.setSetting(key, value));
        writeChains.current.set(key, write);
        return write;
    };
    // Addresses and keys are no longer typed here: a connection's address and
    // key are saved by the Connect dialog, tested first (connections/).

    // Shared with the Model jobs panel: a provider change re-probes it.
    const emb = useEmbeddingStatus();
    const { loadEmbStatus } = emb;

    // Initial load
    //
    // The embedding status is asked for TWICE on purpose. Its probe is a real
    // request to the model server — 1.7 s on this machine, because opening
    // Settings can make llama-swap swap a model in — and it was the first thing
    // the screen waited on, so the whole page arrived a second and a half late
    // for one line of text. The first call skips the probe and paints the
    // config and counts immediately; the second fills the probe in behind it.
    useEffect(() => {
        loadEmbStatus({ probe: false }).then(() => loadEmbStatus());
    }, []);

    // The one settings read lives in the shell (settingsSnapshot.ts); this
    // section applies its half once it lands. A failed read still marks the
    // settings loaded, as it always did, so the model check below can run.
    useEffect(() => {
        if (!snapshot) return;
        if (!snapshot.ok) { setSettingsLoaded(true); return; }
        loadAISettings(snapshot.values);
    }, [snapshot]);

    /** The Ollama model: chosen in the picker, auto-selected after an install,
     *  or corrected to the installed tag by the reconcile effect below. */
    const saveSelectedModel = (model: string) => {
        try { localStorage.setItem('study-app-selected-model', model); } catch { }
        writeSetting('ai_model', model)
            .then(() => { if (provider === 'ollama') announceAI({ model }); })
            .catch(e => console.error('Saving ai_model failed:', e));
    };

    /** A connection was added, switched, changed or removed: read who answers
     *  now, tell the open chat surfaces, and re-probe embeddings (in 'auto'
     *  mode they follow the connection in use). */
    const connectionChanged = async () => {
        setModels([]);
        await handleCheckConnection();
        announceAI();
        loadEmbStatus({ force: true });
    };

    // The OpenAI-compatible model, saved on the PICK with no debounce:
    // `ModelPicker` calls back only on a commit (a row picked, or a typed id
    // confirmed), and the 600 ms wait inherited from the free-text field it
    // replaced only made the open Assistant name the old model for longer.
    const saveOpenaiModel = (model: string) => {
        writeSetting('ai_openai_model', model)
            .then(() => announceAI({ model }))
            .catch(e => console.error('Saving ai_openai_model failed:', e));
    };

    // Routing: saved on the press, not debounced — these are clicks, and a
    // learner who changes one and closes Settings has already changed it.

    // A slider drag writes once per stop; `writeSetting` chains them, so the
    // last stop is what the server keeps.
    const chooseReasoningEffort = (value: string) => {
        setReasoningEffort(value);
        writeSetting('ai_reasoning_effort', value).catch(e => console.error('Saving ai_reasoning_effort failed:', e));
    };

    const chooseProviderSort = (value: string) => {
        setProviderSort(value);
        writeSetting('ai_provider_sort', value).catch(e => console.error('Saving ai_provider_sort failed:', e));
    };

    // Ticking a provider APPENDS it, so the order on screen is the order the
    // request asks for and the learner built it by clicking in that order.
    const toggleProvider = (slug: string) => {
        const next = providerOrder.includes(slug)
            ? providerOrder.filter(s => s !== slug)
            : [...providerOrder, slug];
        setProviderOrder(next);
        writeSetting('ai_provider_order', JSON.stringify(next)).catch(e => console.error('Saving ai_provider_order failed:', e));
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

    // The levels the thinking control may offer follow the MODEL (and so the
    // connection): asked whenever either changes, never on opening Settings
    // before a model is known.
    const currentModelForLevels = provider === 'openai' ? openaiModel : selectedModel;
    useEffect(() => {
        if (!currentModelForLevels || provider !== 'openai') { setEffortLevels(null); return; }
        let live = true;
        api.getEfforts(currentModelForLevels)
            .then(r => { if (live) setEffortLevels(r.levels); })
            .catch(() => { if (live) setEffortLevels(null); });
        return () => { live = false; };
    }, [currentModelForLevels, provider, activeConnection?.id]);

    // Validate selectedModel when models list changes
    // Ensures selectedModel always points to an actually installed model.
    // Handles :latest mismatches, deleted models, and auto-selection.
    //
    // The one save that stays in an effect, because no press causes it: it
    // writes only a CORRECTION derived from loaded settings and the installed
    // list, so a second StrictMode run writes the same name again, never a
    // default.

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

        const fixed = installedName(selectedModel, models);
        if (fixed === selectedModel) return;
        setSelectedModel(fixed);
        saveSelectedModel(fixed);
    }, [settingsLoaded, models, provider, selectedModel]);

    // Data loaders

    const loadAISettings = async (settings: Record<string, string>) => {
        try {
            if (settings.ai_provider === 'openai') setProvider('openai');
            if (settings.ai_openai_model !== undefined) setOpenaiModel(settings.ai_openai_model);
            if (settings.ai_reasoning_effort !== undefined) setReasoningEffort(settings.ai_reasoning_effort);
            if (settings.ai_provider_sort !== undefined) setProviderSort(settings.ai_provider_sort);
            if (settings.ai_provider_order !== undefined) {
                try {
                    const saved = JSON.parse(settings.ai_provider_order);
                    if (Array.isArray(saved)) setProviderOrder(saved.filter((s: unknown): s is string => typeof s === 'string'));
                } catch { /* a malformed row means no preference, not a broken panel */ }
            }
            // The server's row is what answers, so it is what the field shows —
            // including NO row. The device's remembered name only covers the
            // first paint; kept past the load, it showed a model the server
            // did not have (another device's, or one cleared since).
            const savedModel = settings.ai_model || '';
            setSelectedModel(savedModel);
            try { localStorage.setItem('study-app-selected-model', savedModel); } catch { }
            if (settings.ai_enabled !== undefined) {
                aiEnabledRef.current = settings.ai_enabled === 'true';
                setAiEnabled(aiEnabledRef.current);
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
            setModelsListed(result.listed !== false);
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
            // A switch of connection changes the protocol and the model at once.
            setProvider(status.provider);
            if (status.provider === 'openai') setOpenaiModel(status.model || '');
            else setSelectedModel(status.model || '');
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

    // The switch flips the value it last WROTE, not the render's: presses
    // faster than a render each read the same `aiEnabled`, and three of them
    // saved on, on, on.
    const handleToggleAI = () => {
        const next = !aiEnabledRef.current;
        aiEnabledRef.current = next;
        setAiEnabled(next);
        writeSetting('ai_enabled', String(next))
            .then(() => announceAI())
            .catch(e => console.error('Saving ai_enabled failed:', e));
    };

    // The models list doubles as the picker for both providers; each provider
    // has its own persisted selection.
    const currentModel = provider === 'openai' ? openaiModel : selectedModel;

    const chooseModel = (name: string) => {
        if (provider === 'openai') { setOpenaiModel(name); saveOpenaiModel(name); }
        else { setSelectedModel(name); saveSelectedModel(name); }
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
                            saveSelectedModel(justInstalled.name);
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

    // Helpers

    const getInstallProgressPercent = () => {
        if (!installProgress || !installProgress.total || !installProgress.completed) return 0;
        return Math.round((installProgress.completed / installProgress.total) * 100);
    };

    return (
        <>
            {/* AI CONNECTION (provider-agnostic) */}
            <section className={active ? 'mb-8' : 'hidden'}>
                {/* "AI Provider" named the setting, not the section: what
                    is chosen here is the MODEL, and the provider is one of
                    four fields under it. */}
                <SectionHeader title={tr("The model")} icon={Cpu}>
                    {tr("The model does the teaching: lessons, questions, visuals and the tutor all come from it.")}
                </SectionHeader>
                {/* The body answers the SUMMARY's question and nothing
                    else. It used to open with "What powers tutoring,
                    generated lessons, quizzes and flashcards." — the same
                    four features the section header above it and the
                    switch below it both already name, and not an answer
                    to "where does my data go", which is what someone
                    opens this to read. */}
                <Explain summary={tr("Where your data goes")} className="mb-4">
                    {tr("Whatever you connect here is the only place this app sends your studying. With a hosted model, the text a lesson or a chat turn needs (your learner profile included) goes to that company under your own key, and nowhere else; with a model on this machine, nothing leaves it.")}
                </Explain>
                <div className="bg-white dark:bg-slate-800 rounded-xl p-4 shadow-sm space-y-4">
                    {/* Enable AI. Everything below it is configuration for
                        something that is off, so the switch owns it. */}
                    <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0">
                            <p className="font-medium text-slate-900 dark:text-white">{tr("Use AI features")}</p>
                            <p className="text-sm text-slate-500 dark:text-slate-400">
                                {tr("Lessons, questions, visuals and the tutor. Switched off, the app still opens your saved courses, notes and flashcards.")}
                            </p>
                        </div>
                        <Switch checked={aiEnabled} onChange={handleToggleAI} label={tr("Use AI features")} />
                    </div>

                    {/* Everything below configures the AI — pointless while
                        it's off, so the toggle collapses it away. */}
                    <Collapse open={aiEnabled}>
                    <div className="pt-4 space-y-4">
                    {/* CONNECTIONS — every way this library has connected a
                        model, one in use. Address, key and sign-in live in
                        the Connect dialog, tested before anything is saved;
                        what remains below is the model of the one in use. */}
                    <div>
                        <p className="mb-2 font-medium text-slate-900 dark:text-white">{tr("Connections")}</p>
                        <ConnectionsPanel onChanged={() => void connectionChanged()} onActive={setActiveConnection} />
                    </div>

                    {/* Everything below is about the connection IN USE, so it
                        waits for one. */}
                    {activeConnection && (<>
                    {/* MODEL — one picker for every connection, and the same
                        one the four other model settings use. */}
                    <Field
                        label={tr("Model from {{name}}", { name: activeConnection.kind === 'custom' ? hostOfUrl(activeConnection.baseUrl) : providerOf(activeConnection.kind).name })}
                        // "Connected" said again what the connection's own row
                        // says; the dot is for checking and for trouble.
                        // No model yet is a next step, not a fault: said calmly.
                        aside={!currentModel ? (
                            <StatusDot tone="idle">{tr("Choose a model to start.")}</StatusDot>
                        ) : connectionStatus && connectionStatus !== 'connected' ? (
                            // The provider's own error is a status line and a body of
                            // JSON; the words for it are the connection's Test, so
                            // the line says where to look and keeps the raw text in
                            // its tooltip.
                            <StatusDot
                                tone={connectionStatus === 'disconnected' ? 'bad' : 'busy'}
                                title={connectionStatus === 'disconnected' ? (connectionError || undefined) : undefined}
                            >
                                {connectionStatus === 'checking' && tr("Checking…")}
                                {connectionStatus === 'disconnected' && tr("No model list. Press Test on the connection to see why.")}
                            </StatusDot>
                        ) : undefined}
                        hint={activeConnection.kind === 'ollama' || activeConnection.kind === 'custom'
                            ? tr("Choose one of the models this server lists, or type any id it accepts.")
                            : !modelsListed
                            ? tr("{{name}} publishes no list of its models, so type the model's name as its documentation writes it.", { name: providerOf(activeConnection.kind).name })
                            : tr("Choose from the models {{name}} offers, or type an id.", { name: providerOf(activeConnection.kind).name })}
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
                    <Explain summary={tr("Which model should I use?")}>
                        <div className="space-y-3">
                            <p className="text-sm text-slate-500 dark:text-slate-400">
                                {tr("This app asks a model to write a curriculum, teach a topic across several parts and author questions whose answer key survives a second, independent check. That is a harder job than chatting. The easiest way to a model that does it well is a recent hosted one from a major lab: fast, capable, and cheap per lesson, because a lesson is written once and kept. No model is named here on purpose, because names change every few weeks.")}
                            </p>
                            <p className="text-sm text-slate-500 dark:text-slate-400">
                                {tr("On your own hardware, size decides whether it holds up:")}
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
                                {tr("A model that fits a typical 8 GB graphics card sits near the floor and writes slowly. The recommended size wants 24 GB or more of video memory, or a large amount of system memory for a mixture-of-experts model, which is why a hosted model is the better start for most people.")}
                            </p>
                        </div>
                    </Explain>

                    {/* HOW HARD IT THINKS, AND WHO SERVES IT. The thinking
                        control offers the levels THIS model has, and is not
                        drawn when its provider publishes none (a local
                        Ollama, OpenAI, Gemini, a ChatGPT plan). The serving
                        providers are a router's alone: OpenRouter only. */}
                    {provider === 'openai' && (
                        <ThinkingSlider value={reasoningEffort} onChange={chooseReasoningEffort} levels={effortLevels} />
                    )}
                    {activeConnection.kind === 'openrouter' && (
                        <>
                            <ServingEndpointsPicker
                                providerOrder={providerOrder}
                                providerSort={providerSort}
                                servingEndpoints={servingEndpoints}
                                endpointsLoading={endpointsLoading}
                                loadServingEndpoints={loadServingEndpoints}
                                chooseProviderSort={chooseProviderSort}
                                toggleProvider={toggleProvider}
                            />
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
                    </>)}
                    </div>
                    </Collapse>
                </div>
            </section>

            <WebAnswersSection active={active} snapshot={snapshot} />

            {/* VISUALS — every kind the tutor may draw, as a gallery with a switch each
                (src/components/settings/VisualKindsPanel.tsx). */}
            <section className={active ? 'mb-8' : 'hidden'}>
                <VisualKindsPanel active={active} />
            </section>

            <ModelJobsSection
                active={active}
                snapshot={snapshot}
                models={models}
                modelsLoading={modelsLoading}
                loadModels={loadModels}
                currentModel={currentModel}
                emb={emb}
            />

            <SetupHelpSection active={active} />
        </>
    );
}

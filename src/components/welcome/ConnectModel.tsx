import { useCallback, useEffect, useState } from 'react';
import { Check, ExternalLink, KeyRound, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, type OllamaModel } from '../../api';
import type { AIStatus } from '../../types';
import { connectOpenRouter } from '../../utils/openRouterConnect';
import { Button } from '../ui/Button';
import { Field, TextInput } from '../ui/Field';
import Radio from '../ui/Radio';
import SegmentedControl from '../ui/SegmentedControl';
import ModelPicker from '../ModelPicker';
import { DEFAULT_OLLAMA_URL } from '../settings/aiDefaults';
import PrivacyNote from './PrivacyNote';

/**
 * The welcome screen's model step: which model teaches, and how it is reached.
 *
 * Three answers, in the order a new learner should weigh them. A HOSTED model
 * is first because it is what teaches well for most people: the models a
 * typical 8 GB graphics card can run write weaker lessons and write them
 * slowly, and a lesson is written once and kept, so a strong hosted model
 * costs little per lesson. OpenRouter leads the hosted answers because it is
 * one account for every major lab's models and the only one that can hand the
 * app a key without the learner copying one (utils/openRouterConnect.ts).
 *
 * Nothing is written until the learner acts — choosing a card changes what is
 * shown, not what the app uses — so pressing Back leaves the library as it was.
 * The full set of controls (thinking budget, which machine serves the model,
 * installing an Ollama model) stays in Settings → AI & Models.
 */
type Way = 'openrouter' | 'key' | 'local';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1';
const HOSTED_PRESETS = [
    { label: 'OpenRouter', url: OPENROUTER_URL },
    { label: 'OpenAI', url: 'https://api.openai.com/v1' },
];
// Ollama's address is the one the server falls back to (aiDefaults.ts mirrors
// server/ai.js); tools/settings-defaults-gates.mjs fails on a second copy.
const LOCAL_DEFAULTS = { ollama: DEFAULT_OLLAMA_URL, server: 'http://127.0.0.1:1234/v1' } as const;

const isOpenRouter = (url: string | undefined) => /(^|\/\/|\.)openrouter\.ai(?=[:/]|$)/i.test(String(url || ''));
const isLoopback = (url: string | undefined) => {
    try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(String(url)).hostname); } catch { return false; }
};

/** Which card a library already configured belongs under. A fresh library is
 *  Ollama with no model, which is not a choice anyone made — so it is offered
 *  the recommended card rather than the one its defaults happen to name. */
function wayOf(s: AIStatus | null): Way {
    if (!s) return 'openrouter';
    if (s.provider === 'ollama') return s.model ? 'local' : 'openrouter';
    if (isOpenRouter(s.baseUrl)) return 'openrouter';
    return isLoopback(s.baseUrl) ? 'local' : 'key';
}

/** A model the app can use right now, through the way that is on screen. */
function isReady(s: AIStatus | null, way: Way): boolean {
    if (!s || !s.enabled || !s.available) return false;
    if (way === 'local') return s.provider === 'ollama' || isLoopback(s.baseUrl);
    if (s.provider !== 'openai' || !s.hasApiKey) return false;
    return way === 'openrouter' ? isOpenRouter(s.baseUrl) : !isLoopback(s.baseUrl);
}

export default function ConnectModel({ onStatus }: {
    /** Tells the step whether a model is chosen and reachable, and its name. */
    onStatus: (s: { ready: boolean; model: string; provider: string }) => void;
}) {
    const { t } = useTranslation();
    const [status, setStatus] = useState<AIStatus | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [way, setWay] = useState<Way>('openrouter');
    const [models, setModels] = useState<OllamaModel[]>([]);
    const [modelsLoading, setModelsLoading] = useState(false);
    const [model, setModel] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // The "key" card's fields.
    const [baseUrl, setBaseUrl] = useState(OPENROUTER_URL);
    const [apiKey, setApiKey] = useState('');
    // The "local" card's fields.
    const [localKind, setLocalKind] = useState<'ollama' | 'server'>('ollama');
    const [localUrl, setLocalUrl] = useState<string>(LOCAL_DEFAULTS.ollama);

    const loadModels = useCallback(async () => {
        setModelsLoading(true);
        try {
            const r = await api.getModels();
            setModels(r.success ? r.models : []);
        } catch {
            setModels([]);
        } finally {
            setModelsLoading(false);
        }
    }, []);

    const refresh = useCallback(async (forWay?: Way) => {
        try {
            const s = await api.getAIStatus();
            setStatus(s);
            setModel(s.model || '');
            if (isReady(s, forWay ?? wayOf(s))) void loadModels();
            return s;
        } catch {
            setStatus(null);
            return null;
        }
    }, [loadModels]);

    // First look: put the learner on the card their library already matches,
    // and fill that card's fields from what is saved.
    useEffect(() => {
        void (async () => {
            const s = await refresh();
            const w = wayOf(s);
            setWay(w);
            if (s?.provider === 'openai' && s.baseUrl && w === 'key') setBaseUrl(s.baseUrl);
            if (s && w === 'local') {
                if (s.provider === 'ollama') { setLocalKind('ollama'); setLocalUrl(s.ollamaUrl || LOCAL_DEFAULTS.ollama); }
                else { setLocalKind('server'); setLocalUrl(s.baseUrl || LOCAL_DEFAULTS.server); }
            }
            setLoaded(true);
        })();
    }, [refresh]);

    const ready = isReady(status, way);
    useEffect(() => {
        onStatus({ ready: ready && !!model, model, provider: way === 'openrouter' ? 'OpenRouter' : status?.provider === 'ollama' ? 'Ollama' : hostOf(status?.baseUrl) });
    }, [ready, model, way, status, onStatus]);

    const run = async (job: () => Promise<void>) => {
        setBusy(true);
        setError(null);
        try { await job(); } catch (e: any) { setError(e?.message || t("Something went wrong")); } finally { setBusy(false); }
    };

    const connect = () => run(async () => {
        // Leaves the page; the welcome screen reopens on this step when it comes back.
        await connectOpenRouter('/');
    });

    const saveKey = () => run(async () => {
        const url = baseUrl.trim();
        if (!url) throw new Error(t("Enter the provider's API address first."));
        await api.setSetting('ai_provider', 'openai');
        await api.setSetting('ai_openai_base_url', url);
        await api.setSetting('ai_enabled', 'true');
        if (apiKey.trim()) await api.setAIKey(apiKey.trim(), url);
        setApiKey('');
        const s = await refresh('key');
        if (s && !s.available) throw new Error(s.error || t("The provider did not answer at that address."));
    });

    const checkLocal = () => run(async () => {
        const url = localUrl.trim();
        if (localKind === 'ollama') {
            await api.setSetting('ai_provider', 'ollama');
            await api.setSetting('ai_ollama_url', url);
        } else {
            await api.setSetting('ai_provider', 'openai');
            await api.setSetting('ai_openai_base_url', url);
        }
        await api.setSetting('ai_enabled', 'true');
        const s = await refresh('local');
        if (s && !s.available) throw new Error(s.error || t("Nothing answered at that address. Is the server running?"));
    });

    const chooseModel = (id: string) => {
        setModel(id);
        const key = status?.provider === 'ollama' ? 'ai_model' : 'ai_openai_model';
        api.setSetting(key, id).catch(e => setError(e?.message || t("Could not save the model")));
    };

    if (!loaded) {
        return (
            <p className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> {t("Checking what is set up…")}
            </p>
        );
    }

    const WAYS: { value: Way; label: string; desc: string; tag?: string }[] = [
        { value: 'openrouter', label: 'OpenRouter', tag: t("Recommended"), desc: t("One account for models from every major lab, paid per use. You can set a spending limit on their site.") },
        { value: 'key', label: t("Another hosted provider"), desc: t("OpenAI, or any service with an OpenAI-compatible API, with your own key.") },
        { value: 'local', label: t("A model on this computer"), desc: t("Ollama, LM Studio or llama.cpp. Only worth it with a large graphics card: the models a typical 8 GB card can run write weaker lessons, and write them slowly.") },
    ];

    return (
        <div className="space-y-5">
            <fieldset>
                <legend className="sr-only">{t("How to reach a model")}</legend>
                <div className="grid gap-2">
                    {WAYS.map(opt => (
                        <label
                            key={opt.value}
                            className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition ${way === opt.value
                                ? 'border-accent bg-accent/10'
                                : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700/40'}`}
                        >
                            <Radio
                                name="welcome_model_way"
                                value={opt.value}
                                className="mt-0.5"
                                checked={way === opt.value}
                                onChange={() => { setWay(opt.value); setError(null); if (isReady(status, opt.value)) void loadModels(); }}
                            />
                            <span className="min-w-0">
                                <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">
                                    {opt.label}
                                    {opt.tag && (
                                        <span className="ml-2 align-middle text-xs font-medium px-1.5 py-0.5 rounded bg-accent/10 text-accent-fg">{opt.tag}</span>
                                    )}
                                </span>
                                <span className="block text-sm text-slate-500 dark:text-slate-400">{opt.desc}</span>
                            </span>
                        </label>
                    ))}
                </div>
            </fieldset>

            {way === 'openrouter' && (
                ready ? (
                    <ConnectedLine text={t("Connected to OpenRouter")} />
                ) : (
                    <div className="space-y-2">
                        <Button
                            variant="primary"
                            onClick={connect}
                            busy={busy}
                            icon={<ExternalLink className="w-4 h-4" aria-hidden="true" />}
                        >
                            {t("Connect OpenRouter")}
                        </Button>
                        <p className="text-sm text-slate-500 dark:text-slate-400">
                            {t("Opens openrouter.ai, where you sign in or create an account and approve a key for this app. You come straight back here. The key is yours: you can cap or revoke it on their site.")}
                        </p>
                    </div>
                )
            )}

            {way === 'key' && (
                ready ? (
                    <ConnectedLine text={t("Connected to {{host}}", { host: hostOf(status?.baseUrl) })} />
                ) : (
                    <div className="space-y-3">
                        <Field label={t("API address")}>
                            {id => (
                                <>
                                    <TextInput
                                        id={id}
                                        value={baseUrl}
                                        onChange={e => setBaseUrl(e.target.value)}
                                        placeholder="https://…/v1"
                                        spellCheck={false}
                                        autoComplete="off"
                                    />
                                    <div className="mt-2 flex flex-wrap gap-1.5">
                                        {HOSTED_PRESETS.map(p => (
                                            <Button
                                                key={p.url}
                                                size="sm"
                                                variant="subtle"
                                                aria-pressed={baseUrl === p.url}
                                                icon={<Check className={`w-3.5 h-3.5 text-accent-fg ${baseUrl === p.url ? '' : 'invisible'}`} aria-hidden="true" />}
                                                onClick={() => setBaseUrl(p.url)}
                                            >
                                                {p.label}
                                            </Button>
                                        ))}
                                    </div>
                                </>
                            )}
                        </Field>
                        <Field label={t("API key")} hint={status?.hasApiKey ? t("A key is already saved for this address. Type a new one to replace it.") : undefined}>
                            {id => (
                                <TextInput
                                    id={id}
                                    type="password"
                                    value={apiKey}
                                    onChange={e => setApiKey(e.target.value)}
                                    onKeyDown={e => { if (e.key === 'Enter') void saveKey(); }}
                                    autoComplete="off"
                                    placeholder={t("sk-...")}
                                />
                            )}
                        </Field>
                        <Button variant="primary" onClick={saveKey} busy={busy} icon={<KeyRound className="w-4 h-4" aria-hidden="true" />}>
                            {t("Save and connect")}
                        </Button>
                    </div>
                )
            )}

            {way === 'local' && (
                ready ? (
                    <ConnectedLine text={t("Connected to {{host}}", { host: status?.provider === 'ollama' ? 'Ollama' : hostOf(status?.baseUrl) })} />
                ) : (
                    <div className="space-y-3">
                        <SegmentedControl
                            label={t("Which local server")}
                            value={localKind}
                            onChange={v => { setLocalKind(v); setLocalUrl(LOCAL_DEFAULTS[v]); }}
                            options={[
                                { value: 'ollama', label: 'Ollama' },
                                { value: 'server', label: t("LM Studio or llama.cpp") },
                            ]}
                        />
                        <Field label={t("Server address")}>
                            {id => (
                                <div className="flex gap-2">
                                    <TextInput
                                        id={id}
                                        value={localUrl}
                                        onChange={e => setLocalUrl(e.target.value)}
                                        spellCheck={false}
                                        autoComplete="off"
                                    />
                                    <Button variant="primary" onClick={checkLocal} busy={busy} className="shrink-0">
                                        {t("Connect")}
                                    </Button>
                                </div>
                            )}
                        </Field>
                    </div>
                )
            )}

            {error && (
                <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>
            )}

            {ready && (
                <Field
                    label={t("Model")}
                    hint={t("Choose a recent model from a major lab. A fast, low-cost one is enough for most subjects; a stronger one writes better lessons for hard ones. You can switch at any time in Settings → AI & Models.")}
                >
                    {id => (
                        <ModelPicker
                            id={id}
                            label={t("Model")}
                            value={model}
                            onChange={chooseModel}
                            models={models}
                            loading={modelsLoading}
                            onRefresh={loadModels}
                            placeholder={t("Choose or type a model id")}
                        />
                    )}
                </Field>
            )}
            {ready && way === 'local' && !modelsLoading && models.length === 0 && (
                <p className="text-sm text-slate-500 dark:text-slate-400">
                    {t("The server answered but lists no models. Install one there, or in Settings → AI & Models for Ollama.")}
                </p>
            )}

            <PrivacyNote>
                {way === 'local'
                    ? t("With a model on this computer, your studying does not leave it.")
                    : t("Your key is stored on this computer and sent only to the address it was saved for. For each lesson, question or chat turn, the text the model needs (the topic, your profile, your question) goes to that provider, under their terms, and nowhere else.")}
            </PrivacyNote>
        </div>
    );
}

function ConnectedLine({ text }: { text: string }) {
    return (
        <p className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
            <Check className="w-4 h-4" aria-hidden="true" /> {text}
        </p>
    );
}

function hostOf(url: string | undefined): string {
    try { return new URL(String(url)).host; } catch { return String(url || ''); }
}

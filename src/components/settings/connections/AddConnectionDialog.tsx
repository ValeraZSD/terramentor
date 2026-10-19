import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowLeft, CheckCircle2, ExternalLink, LogIn } from 'lucide-react';
import Modal from '../../Modal';
import { Button } from '../../ui/Button';
import { Field, PasswordInput, Select, TextInput } from '../../ui/Field';
import ModelPicker from '../../ModelPicker';
import { api, type ConnectionKind, type ConnectionKindRules, type ConnectionTest, type ConnectionsResponse, type OllamaModel, type SavedConnection } from '../../../api';
import { connectOpenRouter } from '../../../utils/openRouterConnect';
import { FAILURE_TEXT, REGION_KEY_HINT, providerOf } from './providers';
import ProviderPicker from './ProviderPicker';

type Step = 'pick' | 'form' | 'model';

/** A link's site in words: the last two labels of its host (bigmodel.cn, not
 *  open.bigmodel.cn), which is the name a person knows the site by and fits a
 *  phone on one line. */
const siteOf = (url: string) => { try { return new URL(url).hostname.split('.').slice(-2).join('.'); } catch { return ''; } };

/** The region a new connection starts on: the mainland one for a Chinese
 *  interface (an account there is the likelier one), else the first listed. */
const MAINLAND = ['china', 'beijing'];
function startRegion(rules: ConnectionKindRules | undefined, language: string): string {
    const regions = rules?.regions ?? [];
    if (language.startsWith('zh')) {
        const mainland = regions.find(r => MAINLAND.includes(r.id));
        if (mainland) return mainland.id;
    }
    return regions[0]?.id ?? '';
}

/**
 * Connecting a model, in at most three steps: which service, its key (tested
 * before anything is saved), then which of its models. Also the editor for a
 * saved one — a new key or address is tried first and replaces the old only
 * if it works, so a typo can never take down a connection that was working.
 *
 * Kinds come from `PROVIDERS`; what each needs (a key, an address, a
 * sign-in) from the server's table, so the form and the server agree.
 */
export default function AddConnectionDialog({ open, onClose, kinds, initialKind = null, editing = null, choosingFor = null, onDone }: {
    open: boolean;
    onClose: () => void;
    kinds: ConnectionsResponse['kinds'];
    /** Open straight on one service's form (a tile pressed in the empty state). */
    initialKind?: ConnectionKind | null;
    /** Replace the key or address of a saved connection. */
    editing?: SavedConnection | null;
    /** Open on the model step for a saved connection that has none (a ChatGPT
     *  sign-in just back, or "Choose a model" on its row); finishing uses it. */
    choosingFor?: SavedConnection | null;
    /** A connection was saved (or changed); `testIt` asks the list to run its full test. */
    onDone: (id: number, opts: { testIt: boolean }) => void;
}) {
    const { t, i18n } = useTranslation();
    const [step, setStep] = useState<Step>('pick');
    const [kind, setKind] = useState<ConnectionKind>('openrouter');
    const [apiKey, setApiKey] = useState('');
    const [address, setAddress] = useState('');
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<ConnectionTest | null>(null);
    // The server's answer: is the address on the learner's own network, so it may be saved while off?
    const [canSaveAnyway, setCanSaveAnyway] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [savedId, setSavedId] = useState<number | null>(null);
    const [modelCount, setModelCount] = useState(0);
    const [models, setModels] = useState<OllamaModel[]>([]);
    const [modelsLoading, setModelsLoading] = useState(false);
    const [model, setModel] = useState('');
    const [othersInUse, setOthersInUse] = useState(false);
    // A lab's region, and the model typed in its form (the lab may list none).
    const [region, setRegion] = useState('');
    const [typedModel, setTypedModel] = useState('');
    const [listed, setListed] = useState(true);
    const keyRef = useRef<HTMLInputElement>(null);
    const modelRef = useRef<HTMLInputElement>(null);

    // Reset when the dialog OPENS or its target changes — by id: the list hands
    // over fresh objects on every reload (a row's test finishing reloads it),
    // and keyed on those the dialog jumped back to the form mid-flow, after
    // the connection was already saved, inviting a second copy. Before paint,
    // so an opening dialog never shows a frame of the last step at its width.
    const kindsRef = useRef(kinds);
    kindsRef.current = kinds;
    useLayoutEffect(() => {
        if (!open) return;
        const start = choosingFor?.kind ?? editing?.kind ?? initialKind;
        setKind(start ?? 'openrouter');
        setStep(choosingFor ? 'model' : start ? 'form' : 'pick');
        setApiKey(''); setFailure(null); setError(null); setBusy(false);
        setSavedId(choosingFor?.id ?? null); setModels([]); setModel(''); setModelCount(0);
        setOthersInUse(false);
        setAddress(choosingFor?.baseUrl ?? editing?.baseUrl ?? (start ? kindsRef.current?.[start]?.baseUrl ?? '' : ''));
        setRegion(editing?.region || (start ? startRegion(kindsRef.current?.[start], i18n.language) : ''));
        setTypedModel(''); setListed(true);
        if (choosingFor) void loadModels(choosingFor.id);
    }, [open, initialKind, editing?.id, choosingFor?.id]);

    const info = providerOf(kind);
    const rules = kinds?.[kind];
    const regions = rules?.regions ?? [];
    // Asked up front where the lab documents no model list; anywhere else only
    // once a test has found the list missing.
    const takesModel = !editing && (!!rules?.typedModel || failure?.reason === 'needs_model' || !!typedModel);
    // Keys are made per region where a lab has regions, each on its own page.
    const keyUrl = regions.find(r => r.id === region)?.keyUrl || rules?.keyUrl || '';
    const modelsUrl = regions.find(r => r.id === region)?.modelsUrl || rules?.modelsUrl || '';
    const keySite = info.keyWhere || siteOf(keyUrl);
    const regionMoved = !!editing && regions.length > 0 && !!region && region !== editing.region;
    const needsKey = rules?.key === 'required';
    const takesKey = rules?.key !== 'none';
    const editable = !!rules?.editable;
    const local = kind === 'ollama' || kind === 'custom';
    // A server of the learner's own is named by its address; a service by its name.
    const host = (() => { try { return new URL(address).host; } catch { return address; } })();
    const name = kind === 'custom' ? (host || t(info.name)) : info.name;

    const choose = (k: ConnectionKind) => {
        setKind(k); setStep('form'); setFailure(null); setError(null);
        setAddress(kinds?.[k]?.baseUrl ?? '');
        setRegion(startRegion(kinds?.[k], i18n.language)); setTypedModel('');
    };

    const loadModels = async (id: number) => {
        setModelsLoading(true);
        try {
            const r = await api.getConnectionModels(id);
            setModels(r.success ? r.models : []);
        } catch { setModels([]); } finally { setModelsLoading(false); }
    };

    const submit = async (saveAnyway = false) => {
        if (needsKey && !apiKey.trim()) { setError(t("Paste the key first.")); keyRef.current?.focus(); return; }
        // A saved key is bound to the address it was typed for and is not sent
        // to a new one, so a changed address needs the key again.
        if (editing?.hasKey && editable && !apiKey.trim() && address.trim() !== editing.baseUrl) {
            setError(t("The address changed, so paste the key again: a saved key is sent only to the address it was saved for."));
            keyRef.current?.focus();
            return;
        }
        // Nothing to test a key against without a model where the lab lists none.
        if (rules?.typedModel && !editing && !typedModel.trim()) {
            setError(t("Type the model's name first."));
            modelRef.current?.focus();
            return;
        }
        if (regionMoved && !apiKey.trim()) {
            setError(t("The region changed, so paste a key made in that region."));
            keyRef.current?.focus();
            return;
        }
        setBusy(true); setFailure(null); setError(null);
        const body = {
            kind, apiKey: apiKey.trim(),
            ...(editable ? { baseUrl: address.trim() } : {}),
            ...(regions.length ? { region } : {}),
        };
        try {
            if (editing) {
                // Tried first, saved only if it works: the old key keeps working until then.
                const keyChanged = !!apiKey.trim();
                await api.tryConnection({ ...body, apiKey: keyChanged ? body.apiKey : undefined, model: editing.model });
                await api.updateConnection(editing.id, {
                    ...(keyChanged ? { apiKey: body.apiKey } : {}),
                    ...(editable ? { baseUrl: body.baseUrl } : {}),
                    ...(regionMoved ? { region } : {}),
                });
                onDone(editing.id, { testIt: false });
                onClose();
                return;
            }
            const r = await api.addConnection({ ...body, ...(takesModel && typedModel.trim() ? { model: typedModel.trim() } : {}), saveAnyway });
            setSavedId(r.id);
            setModelCount(r.test?.models ?? 0);
            setListed(r.test?.listed !== false);
            setModel(takesModel ? typedModel.trim() : '');
            setOthersInUse(r.activeId !== r.id);
            setStep('model');
            if (r.test?.listed !== false) void loadModels(r.id);
        } catch (e: any) {
            if (e?.data?.test) {
                const test = e.data.test as ConnectionTest;
                setFailure(test); setCanSaveAnyway(e.data.canSaveAnyway === true);
                if (test.reason === 'needs_model') setTimeout(() => modelRef.current?.focus(), 0);
            }
            else setError(e?.message || t("Something went wrong"));
        } finally { setBusy(false); }
    };

    const finish = async (use: boolean) => {
        if (savedId == null) return;
        if (choosingFor && !model) { setError(t("Choose a model first.")); return; }
        setBusy(true);
        try {
            if (model) await api.updateConnection(savedId, { model });
            if (use || choosingFor) await api.useConnection(savedId);
            // The plan notice is said here, once, on the step that finishes a sign-in.
            if (choosingFor?.needsPlanNotice) await api.planNoticeSeen(savedId).catch(() => { });
            onDone(savedId, { testIt: !!model });
            onClose();
        } catch (e: any) { setError(e?.message || t("Something went wrong")); } finally { setBusy(false); }
    };

    const chatgpt = async () => {
        setBusy(true); setError(null);
        try {
            const { url } = await api.startChatgptSignIn('/settings#ai', editing?.id);
            window.location.assign(url);
        } catch (e: any) {
            setError(e?.message === 'not-local'
                ? t("Signing in with ChatGPT works in a browser on the computer Terramentor runs on. Open it there and try again.")
                : (e?.message || t("Something went wrong")));
            setBusy(false);
        }
    };

    const title = choosingFor
        ? (choosingFor.kind === 'chatgpt' && choosingFor.needsPlanNotice ? t("You're using your ChatGPT plan") : t("Choose a model for {{name}}", { name }))
        : editing
        ? t("Change {{name}}", { name })
        : step === 'pick' ? t("Connect a model")
        : kind === 'custom' ? t("Connect a server") : t("Connect {{name}}", { name });

    return (
        // The choice is two columns of lists; a form is one column of fields.
        <Modal isOpen={open} onClose={onClose} title={title} maxWidth={step === 'pick' ? 'max-w-3xl' : 'max-w-xl'}>
            {step === 'pick' && (
                <div className="space-y-4">
                    <p className="text-sm text-slate-600 dark:text-slate-300">
                        {t("Choose where the model comes from. You can connect several and switch between them; one is used at a time.")}
                    </p>
                    <ProviderPicker onChoose={choose} />
                </div>
            )}

            {step === 'form' && (
                <form className="space-y-4" onSubmit={e => { e.preventDefault(); if (kind !== 'chatgpt') void submit(); }}>
                    <p className="text-sm text-slate-600 dark:text-slate-300">{t(info.blurb)}</p>

                    {kind === 'chatgpt' && (
                        <div className="space-y-3">
                            <p className="text-sm text-slate-600 dark:text-slate-300">
                                {t("Requests then count against your ChatGPT plan, not an API bill. ChatGPT Plus shares one five-hour limit across every app that uses the plan. You can see and limit this app's use in ChatGPT under Settings, Usage.")}
                            </p>
                            <Button variant="primary" size="lg" onClick={chatgpt} busy={busy} icon={<LogIn className="w-4 h-4" aria-hidden="true" />}>
                                {t("Continue with ChatGPT")}
                            </Button>
                        </div>
                    )}

                    {kind === 'openrouter' && !editing && (
                        <div className="space-y-2">
                            <Button
                                variant="primary"
                                onClick={() => { connectOpenRouter('/settings#ai').catch((e: any) => setError(e?.message || t("Could not connect OpenRouter"))); }}
                                icon={<ExternalLink className="w-4 h-4" aria-hidden="true" />}
                            >
                                {t("Sign in with OpenRouter")}
                            </Button>
                            <p className="text-sm text-slate-500 dark:text-slate-400">{t("Approve a key for this app on openrouter.ai, without copying one. Or paste a key you already have:")}</p>
                        </div>
                    )}

                    {editable && (
                        <Field label={kind === 'ollama' ? t("Ollama address") : t("Server address")} help={kind === 'custom' ? t("The address ends in /v1 on most servers.") : undefined}>
                            {id => (
                                <TextInput id={id} value={address} onChange={e => setAddress(e.target.value)} spellCheck={false} autoComplete="off"
                                    placeholder={kinds?.[kind]?.baseUrl} />
                            )}
                        </Field>
                    )}

                    {regions.length > 0 && (
                        <Field label={t("Region")} help={t("The site your account and key were made on. Each region has its own keys.")}>
                            {id => (
                                <Select id={id} value={region} onChange={e => { setRegion(e.target.value); setFailure(null); setError(null); }}>
                                    {regions.map(r => <option key={r.id} value={r.id}>{info.regions?.[r.id] ? t(info.regions[r.id]) : r.id}</option>)}
                                </Select>
                            )}
                        </Field>
                    )}

                    {takesKey && kind !== 'chatgpt' && (
                        <Field
                            label={needsKey ? t("API key") : t("API key (optional)")}
                            help={editing?.hasKey
                                ? (regionMoved ? t("Paste a key made in the new region.")
                                    : needsKey ? t("The saved key ends in {{hint}}. Paste the new one; the old one stays until the new one passes the test.", { hint: editing.keyHint }) : t("Leave it empty to keep the saved key ({{hint}}) at the same address.", { hint: editing.keyHint }))
                                : editing?.keyMissing ? t("This copy of the library came without its keys file, so paste the key again.")
                                : undefined}
                            hint={keySite && keyUrl ? (
                                <a href={keyUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent-fg hover:underline">
                                    {t("Get a key at {{site}}", { site: keySite })}<ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                                </a>
                            ) : undefined}
                        >
                            {id => (
                                <PasswordInput
                                    kind="key"
                                    id={id}
                                    ref={keyRef}
                                    value={apiKey}
                                    onChange={e => { setApiKey(e.target.value); setFailure(null); setError(null); }}
                                    autoComplete="off"
                                    spellCheck={false}
                                    placeholder={info.keyPlaceholder ?? ''}
                                />
                            )}
                        </Field>
                    )}

                    {takesModel && (
                        <Field
                            label={t("Model")}
                            help={rules?.typedModel ? t("{{name}} publishes no list of its models, so type the model's name as its documentation writes it.", { name }) : undefined}
                            hint={modelsUrl ? (
                                <a href={modelsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent-fg hover:underline">
                                    {t("Model names at {{site}}", { site: siteOf(modelsUrl) })}<ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                                </a>
                            ) : undefined}
                        >
                            {id => (
                                <TextInput id={id} ref={modelRef} value={typedModel} spellCheck={false} autoComplete="off"
                                    onChange={e => { setTypedModel(e.target.value); setFailure(null); setError(null); }} />
                            )}
                        </Field>
                    )}

                    {(failure || error) && (
                        <div role="alert" className="flex gap-2.5 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-100">
                            <AlertTriangle className="mt-0.5 w-4 h-4 shrink-0" aria-hidden="true" />
                            <div className="min-w-0 space-y-1">
                                <p>
                                    {failure ? t(FAILURE_TEXT[failure.reason ?? 'other']) : error}
                                    {failure?.reason === 'key' && regions.length > 0 && <> {t(REGION_KEY_HINT)}</>}
                                </p>
                                {failure?.reason === 'other' && failure.detail && (
                                    <p className="break-words text-xs opacity-80">{failure.status ? `${failure.status} · ` : ''}{failure.detail}</p>
                                )}
                            </div>
                        </div>
                    )}

                    {kind !== 'chatgpt' && (
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                            {local
                                ? t("A model on this computer: your studying does not leave it.")
                                : t("The key is stored on this computer and sent only to {{name}}, which bills your account for what you use. Terramentor itself charges nothing.", { name })}
                        </p>
                    )}

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                        {!editing && !initialKind ? (
                            <Button variant="quiet" onClick={() => setStep('pick')} icon={<ArrowLeft className="w-4 h-4" aria-hidden="true" />}>{t("Back")}</Button>
                        ) : <span />}
                        {kind !== 'chatgpt' && (
                            <div className="flex flex-wrap gap-2 ml-auto">
                                {failure && canSaveAnyway && !editing && (
                                    <Button variant="neutral" onClick={() => void submit(true)} disabled={busy}>{t("Save anyway")}</Button>
                                )}
                                <Button type="submit" variant="primary" busy={busy}>
                                    {busy ? t("Testing…") : editing ? t("Test and save") : t("Test and connect")}
                                </Button>
                            </div>
                        )}
                    </div>
                </form>
            )}

            {step === 'model' && (
                <div className="space-y-4">
                    {choosingFor?.kind === 'chatgpt' ? (
                        // OpenAI's guideline, and a fair one: the first time a
                        // sign-in spends the learner's plan, say so plainly.
                        <div className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
                            <p className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-400">
                                <CheckCircle2 className="w-5 h-5 shrink-0" aria-hidden="true" />
                                {t("Signed in as {{account}}.", { account: choosingFor.account || 'ChatGPT' })}
                            </p>
                            <p>{t("Lessons, questions and the assistant in Terramentor now count against your ChatGPT plan's usage. You can see and limit this app's use in ChatGPT under Settings, Usage.")}</p>
                        </div>
                    ) : choosingFor ? null : (
                        <p className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-400">
                            <CheckCircle2 className="w-5 h-5 shrink-0" aria-hidden="true" />
                            {!listed && typedModel.trim()
                                ? t("Connected to {{name}}. {{model}} answered the test.", { name, model: typedModel.trim() })
                                : modelCount
                                ? t("Connected to {{name}}: {{count}} models available.", { name, count: modelCount })
                                : t("Saved. Terramentor will test it again when it is reachable.")}
                        </p>
                    )}
                    {/* With no list, the typed model is the one the test just
                        heard from: nothing is left to choose here. */}
                    {(listed || choosingFor) && (
                        <Field label={t("Model")} hint={local
                            ? t("Choose one of the models this server lists.")
                            : t("Choose a recent model from the list. One strong model for everything is the simple choice, and you can change it at any time.")}>
                            {id => (
                                <ModelPicker id={id} label={t("Model")} value={model} onChange={setModel} models={models}
                                    loading={modelsLoading} onRefresh={() => savedId != null && loadModels(savedId)} placeholder={t("Choose or type a model id")} />
                            )}
                        </Field>
                    )}
                    {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
                    <div className="flex flex-wrap justify-end gap-2">
                        {choosingFor ? (
                            <Button variant="primary" onClick={() => void finish(true)} busy={busy}>{t("Use this model")}</Button>
                        ) : othersInUse ? (
                            <>
                                <Button variant="neutral" onClick={() => void finish(false)} disabled={busy}>{t("Keep for later")}</Button>
                                <Button variant="primary" onClick={() => void finish(true)} busy={busy}>{t("Use this connection")}</Button>
                            </>
                        ) : (
                            <Button variant="primary" onClick={() => void finish(false)} busy={busy}>{t("Done")}</Button>
                        )}
                    </div>
                </div>
            )}
        </Modal>
    );
}

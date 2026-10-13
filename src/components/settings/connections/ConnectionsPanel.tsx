import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, KeyRound, Link2, LogIn, MoreVertical, Plus, Trash2 } from 'lucide-react';
import { api, type ConnectionFailure, type ConnectionTest, type ConnectionsResponse, type SavedConnection } from '../../../api';
import { useStore } from '../../../store';
import { Button, IconButton } from '../../ui/Button';
import { MenuItem, MenuPopover, menuTriggerKeys } from '../../ui/Popover';
import Modal from '../../Modal';
import { cx } from '../../ui/vocabulary';
import { FAILURE_TEXT, PROVIDERS, REGION_KEY_HINT, providerOf } from './providers';
import ProviderTile, { ProviderMark } from './ProviderTile';
import AddConnectionDialog from './AddConnectionDialog';

const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };

/**
 * Settings → AI & Models → Connections: every way this library has connected
 * a model, the one in use marked, the others one press from taking over.
 *
 * One connection answers everything at a time (lessons, questions, checks,
 * the assistant) — said once under the list when there is more than one,
 * because "which one does it use?" is the question two rows raise.
 *
 * With nothing connected the services are offered right here, not behind a
 * button: the empty state IS the first step of the dialog.
 */
export default function ConnectionsPanel({ onChanged, onActive }: {
    /** The connection in use (or its model) changed: re-ask the server who answers. */
    onChanged: () => void;
    /** The connection in use, each time the list is read (null: none). */
    onActive?: (c: SavedConnection | null) => void;
}) {
    const { t } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const showConfirm = useStore(s => s.showConfirm);
    const [data, setData] = useState<ConnectionsResponse | null>(null);
    const [dialog, setDialog] = useState<{ open: boolean; kind: SavedConnection['kind'] | null; editing: SavedConnection | null }>({ open: false, kind: null, editing: null });
    const [testing, setTesting] = useState<Set<number>>(new Set());
    const [results, setResults] = useState<Record<number, ConnectionTest>>({});
    // A saved connection that still needs its model: a ChatGPT sign-in just
    // back (its plan notice rides on that step), or "Choose a model" on a row.
    const [choosing, setChoosing] = useState<SavedConnection | null>(null);
    const dismissed = useRef(new Set<number>());
    const activeRef = useRef(onActive);
    activeRef.current = onActive;
    useEffect(() => {
        if (data) activeRef.current?.(data.connections.find(c => c.active) ?? null);
    }, [data]);

    const load = async () => {
        try {
            const r = await api.getConnections();
            setData(r);
            // A sign-in not finished yet (no model, plan notice unsaid): finish
            // it — unless it was closed during this visit (it asks again next time).
            setChoosing(n => n ?? r.connections.find(c => c.needsPlanNotice && !c.model && !dismissed.current.has(c.id)) ?? null);
            return r;
        } catch { return null; }
    };

    const runTest = async (id: number) => {
        setTesting(s => new Set(s).add(id));
        try {
            const r = await api.testConnection(id);
            setResults(m => ({ ...m, [id]: r }));
        } catch (e: any) {
            setResults(m => ({ ...m, [id]: { ok: false, step: 'list', reason: 'other', detail: e?.message } }));
        } finally {
            setTesting(s => { const n = new Set(s); n.delete(id); return n; });
            void load();
        }
    };

    // Back from "Continue with ChatGPT": the callback lands here with
    // ?chatgpt=connected-<id> | declined | noplan | failed. Said once, then
    // taken off the address so a reload does not say it again.
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const outcome = params.get('chatgpt');
        void (async () => {
            const r = await load();
            if (!outcome) return;
            params.delete('chatgpt');
            const rest = params.toString();
            window.history.replaceState(window.history.state, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`);
            if (outcome.startsWith('connected')) {
                onChanged();
                // The sign-in is finished by choosing its model (the step
                // that also says the plan is now being used).
                const id = Number(outcome.split('-')[1]);
                const signedIn = r?.connections.find(c => c.id === id);
                if (signedIn && !signedIn.model) setChoosing(signedIn);
            } else if (outcome === 'noplan') {
                addToast('error', t("Signed in, but ChatGPT plan usage was not allowed, so nothing will be sent. Sign in again and allow it, or connect another way."));
            } else if (outcome === 'declined') {
                addToast('error', t("ChatGPT sign-in was cancelled."));
            } else {
                addToast('error', t("ChatGPT sign-in did not complete. Try again."));
            }
        })();
    }, []);

    const use = async (c: SavedConnection) => {
        try {
            setData(await api.useConnection(c.id));
            onChanged();
        } catch (e: any) { addToast('error', t("Could not switch connection"), e?.message); }
    };

    const remove = async (c: SavedConnection) => {
        const name = c.kind === 'custom' ? hostOf(c.baseUrl) : providerOf(c.kind).name;
        const ok = await showConfirm({
            title: t("Remove {{name}}?", { name }),
            message: c.kind === 'chatgpt'
                ? t("Terramentor signs out of ChatGPT on this computer and forgets the sign-in. Your ChatGPT account is not changed.")
                : c.active
                    ? t("Its key is deleted from this computer. Terramentor switches to another saved connection, or to none.")
                    : t("Its key is deleted from this computer."),
            confirmLabel: t("Remove"),
            variant: 'danger',
        });
        if (!ok) return;
        try {
            const r = await api.removeConnection(c.id);
            setData(r);
            if (c.kind === 'chatgpt' && r.revoked === false) addToast('error', t("Removed here, but OpenAI did not confirm the sign-out. You can disconnect the app in ChatGPT's settings."));
            if (c.active) onChanged();
        } catch (e: any) { addToast('error', t("Could not remove it"), e?.message); }
    };

    const reauth = async (c: SavedConnection) => {
        try { window.location.assign((await api.startChatgptSignIn('/settings#ai', c.id)).url); }
        catch (e: any) {
            addToast('error', e?.message === 'not-local'
                ? t("Signing in with ChatGPT works in a browser on the computer Terramentor runs on.")
                : t("Could not start the ChatGPT sign-in"), e?.message === 'not-local' ? undefined : e?.message);
        }
    };

    if (!data) return <div className="h-24" aria-hidden="true" />;
    // The one in use first: it is the one the rest of the page is about.
    const list = [...data.connections].sort((a, b) => Number(b.active) - Number(a.active));

    return (
        <div className="space-y-3">
            {list.length === 0 ? (
                <div className="space-y-3">
                    <p className="text-sm text-slate-600 dark:text-slate-300">
                        {t("Connect a model to write lessons and questions. Already have a key or a ChatGPT plan? Choose that one. Starting from nothing? OpenRouter is the easiest.")}
                    </p>
                    {/* Columns from the panel's own width: Settings can sit in a
                        narrow pane on a wide screen. */}
                    <ul className="grid gap-2 grid-cols-[repeat(auto-fit,minmax(15rem,1fr))]">
                        {PROVIDERS.map(p => (
                            <li key={p.kind}><ProviderTile provider={p} onClick={() => setDialog({ open: true, kind: p.kind, editing: null })} /></li>
                        ))}
                    </ul>
                </div>
            ) : (
                <>
                    <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 dark:divide-slate-700 dark:border-slate-700">
                        {list.map(c => (
                            <ConnectionRow
                                key={c.id}
                                c={c}
                                testing={testing.has(c.id)}
                                result={results[c.id]}
                                onUse={() => (c.model ? void use(c) : setChoosing(c))}
                                onTest={() => void runTest(c.id)}
                                onEdit={() => setDialog({ open: true, kind: c.kind, editing: c })}
                                onReauth={() => void reauth(c)}
                                onRemove={() => void remove(c)}
                            />
                        ))}
                    </ul>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        {/* A floor on the sentence's width: in a narrow panel the
                            button wraps under it rather than squeezing it into a
                            column of one-word lines. */}
                        <p className="min-w-64 flex-1 text-sm text-slate-500 dark:text-slate-400">
                            {list.length > 1 && t("One connection is used at a time, for everything: lessons, questions, checks and the assistant. The others stay saved.")}
                        </p>
                        <Button variant="neutral" onClick={() => setDialog({ open: true, kind: null, editing: null })} icon={<Plus className="w-4 h-4" aria-hidden="true" />}>
                            {t("Add a connection")}
                        </Button>
                    </div>
                </>
            )}

            <AddConnectionDialog
                open={dialog.open}
                onClose={() => setDialog(d => ({ ...d, open: false }))}
                kinds={data.kinds}
                initialKind={dialog.kind}
                editing={dialog.editing}
                onDone={(id, { testIt }) => {
                    void load().then(r => {
                        onChanged();
                        if (testIt || r?.connections.find(c => c.id === id)?.active) void runTest(id);
                    });
                }}
            />

            {/* Finishing a connection that has no model yet: choose it, and
                it is put in use. A ChatGPT sign-in's plan notice is said here. */}
            <AddConnectionDialog
                open={!!choosing}
                onClose={() => { if (choosing) dismissed.current.add(choosing.id); setChoosing(null); void load(); }}
                kinds={data.kinds}
                choosingFor={choosing}
                onDone={(id) => { setChoosing(null); void load().then(() => { onChanged(); void runTest(id); }); }}
            />
        </div>
    );
}

function ConnectionRow({ c, testing, result, onUse, onTest, onEdit, onReauth, onRemove }: {
    c: SavedConnection;
    testing: boolean;
    result?: ConnectionTest;
    onUse: () => void;
    onTest: () => void;
    onEdit: () => void;
    onReauth: () => void;
    onRemove: () => void;
}) {
    const { t } = useTranslation();
    const [menu, setMenu] = useState(false);
    const menuBtn = useRef<HTMLButtonElement>(null);
    const p = providerOf(c.kind);
    // A server of the learner's own is named by its address.
    const name = c.kind === 'custom' ? hostOf(c.baseUrl) : p.name;
    const facts: string[] = [];
    if (c.kind === 'chatgpt') facts.push(c.account || t("Signed in"));
    else if (c.kind === 'ollama') facts.push(hostOf(c.baseUrl));
    else if (c.region && p.regions?.[c.region]) facts.push(t(p.regions[c.region]));
    if (c.hasKey) facts.push(t("key {{hint}}", { hint: c.keyHint }));
    facts.push(c.model || t("no model chosen"));

    // A refused key where keys are made per region may be the wrong region's.
    const failText = (reason: ConnectionFailure) => t(FAILURE_TEXT[reason]) + (reason === 'key' && p.regions ? ` ${t(REGION_KEY_HINT)}` : '');
    // The newest verdict: this session's test, else the stored one.
    const verdict: { ok: boolean; text: string } | null = result
        ? { ok: result.ok, text: result.ok
            ? (result.step === 'reply' ? t("Working: {{model}} answered.", { model: result.model }) : t("Reachable: {{count}} models listed. Choose a model to finish the test.", { count: result.models ?? 0 }))
            : failText(result.reason ?? 'other') }
        : c.kind === 'chatgpt' && !c.signedIn ? { ok: false, text: t("Signed out. Sign in again to use it.") }
        : c.kind === 'chatgpt' && !c.planEnabled ? { ok: false, text: t("Plan usage was not allowed at sign-in, so nothing is sent.") }
        : c.test && !c.test.ok ? { ok: false, text: failText(c.test.reason || 'other') }
        : null;
    const failedWith = result ? (result.ok ? '' : result.reason) : c.test && !c.test.ok ? c.test.reason : '';
    const keyProblem = c.hasKey && (failedWith === 'key' || failedWith === 'credit');

    return (
        <li className={cx('flex flex-wrap items-start gap-3 p-3', c.active && 'bg-accent/5 dark:bg-accent/10')}>
            <ProviderMark kind={c.kind} place="saved" inUse={c.active} />
            <div className="min-w-0 flex-1 basis-48">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-slate-900 dark:text-white">
                    {name}
                    {c.active && (
                        <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent-fg">{t("In use")}</span>
                    )}
                    {c.kind === 'chatgpt' && c.active && c.planEnabled && (
                        <span className="text-xs font-normal text-slate-500 dark:text-slate-400">{t("Using ChatGPT plan")}</span>
                    )}
                </p>
                <p className="mt-0.5 break-words text-sm text-slate-500 dark:text-slate-400">{facts.join(' · ')}</p>
                {testing ? (
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400" role="status">{t("Testing…")}</p>
                ) : verdict && (
                    <p className={cx('mt-1 flex items-start gap-1.5 text-sm', verdict.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-800 dark:text-amber-300')} role="status">
                        {verdict.ok
                            ? <CheckCircle2 className="mt-0.5 w-4 h-4 shrink-0" aria-hidden="true" />
                            : <AlertTriangle className="mt-0.5 w-4 h-4 shrink-0" aria-hidden="true" />}
                        <span>{verdict.text}</span>
                    </p>
                )}
                {/* A refused key's fix sits beside the reason, not in the menu. */}
                {!testing && keyProblem && (
                    <div className="mt-1.5">
                        <Button size="sm" variant="neutral" onClick={onEdit} icon={<KeyRound className="w-4 h-4" aria-hidden="true" />}>
                            {p.regions ? t("Change region or key") : t("Replace the key")}
                        </Button>
                    </div>
                )}
                {c.kind === 'chatgpt' && c.active && (
                    <p className="mt-1 text-sm">
                        <a href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer" className="text-accent-fg hover:underline">
                            {t("Manage usage in ChatGPT")}
                        </a>
                    </p>
                )}
            </div>
            <div className="ml-auto flex items-center gap-1.5">
                {/* A connection with no model cannot answer: its one action
                    is choosing the model, which also puts it in use. */}
                {!c.model && (c.kind !== 'chatgpt' || c.signedIn)
                    ? <Button size="sm" variant={c.active ? 'primary' : 'neutral'} onClick={onUse}>{t("Choose a model")}</Button>
                    : !c.active && <Button size="sm" variant="neutral" onClick={onUse}>{t("Use")}</Button>}
                <Button size="sm" variant="subtle" onClick={onTest} busy={testing}>{t("Test")}</Button>
                <IconButton
                    ref={menuBtn}
                    size="sm"
                    label={t("More for {{name}}", { name })}
                    icon={<MoreVertical className="w-4 h-4" aria-hidden="true" />}
                    aria-haspopup="menu"
                    aria-expanded={menu}
                    onClick={() => setMenu(v => !v)}
                    onKeyDown={menuTriggerKeys(() => setMenu(true))}
                />
                <MenuPopover open={menu} onClose={() => setMenu(false)} anchorRef={menuBtn} label={t("More for {{name}}", { name })} align="end">
                    {c.kind === 'chatgpt' ? (
                        <MenuItem icon={<LogIn className="w-4 h-4" />} onSelect={() => { setMenu(false); onReauth(); }}>{t("Sign in again")}</MenuItem>
                    ) : c.kind === 'ollama' || c.kind === 'custom' ? (
                        <MenuItem icon={<Link2 className="w-4 h-4" />} onSelect={() => { setMenu(false); onEdit(); }}>{t("Change address or key")}</MenuItem>
                    ) : p.regions ? (
                        <MenuItem icon={<KeyRound className="w-4 h-4" />} onSelect={() => { setMenu(false); onEdit(); }}>{t("Change region or key")}</MenuItem>
                    ) : (
                        <MenuItem icon={<KeyRound className="w-4 h-4" />} onSelect={() => { setMenu(false); onEdit(); }}>{t("Replace the key")}</MenuItem>
                    )}
                    <MenuItem icon={<Trash2 className="w-4 h-4" />} onSelect={() => { setMenu(false); onRemove(); }}>{t("Remove")}</MenuItem>
                </MenuPopover>
            </div>
        </li>
    );
}

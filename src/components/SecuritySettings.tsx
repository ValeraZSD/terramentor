import { useEffect, useState, type ReactNode } from 'react';
import { Shield, ShieldCheck, KeyRound, Copy, Check, RefreshCw, Trash2 } from 'lucide-react';
import { useStore } from '../store';
import { api } from '../api';
import { copyText } from '../utils/clipboard';
import { useTranslation } from 'react-i18next';
import { Button, IconButton } from './ui/Button';
import { TextInput } from './ui/Field';
import { GROUP_CAPTION, SettingNote } from './ui/SettingRow';

/**
 * Settings → Security panel for the single-user auth gate: create / change /
 * remove the password, and manage the API key programmatic clients (e.g. a bot)
 * use as a `Bearer` token. Backed by the /api/auth/* endpoints.
 */
export default function SecuritySettings() {
    const { t } = useTranslation();
    const authEnabled = useStore(s => s.authEnabled);
    const loadAuth = useStore(s => s.loadAuth);

    const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
    const [busy, setBusy] = useState(false);

    // Set-password (first run) fields
    const [newPass, setNewPass] = useState('');
    const [confirmPass, setConfirmPass] = useState('');

    // Change-password fields
    const [curPass, setCurPass] = useState('');
    const [changePass, setChangePass] = useState('');

    // Disable
    const [disablePass, setDisablePass] = useState('');

    // API key
    const [apiKey, setApiKey] = useState<string | null>(null);
    const [showKey, setShowKey] = useState(false);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (authEnabled) {
            api.getApiKey().then(r => setApiKey(r.apiKey)).catch(() => { });
        }
    }, [authEnabled]);

    const flash = (kind: 'ok' | 'err', text: string) => {
        setMsg({ kind, text });
        if (kind === 'ok') setTimeout(() => setMsg(null), 4000);
    };

    const doSetup = async () => {
        if (newPass.length < 6) return flash('err', t("Password must be at least 6 characters."));
        if (newPass !== confirmPass) return flash('err', t("Passwords do not match."));
        setBusy(true);
        try {
            await api.setupPassword(newPass);
            await loadAuth();
            setNewPass(''); setConfirmPass('');
            flash('ok', t("Password set. Other devices will need it to sign in."));
        } catch (e: any) { flash('err', e?.message || t("Failed to set password.")); }
        finally { setBusy(false); }
    };

    const doChange = async () => {
        if (changePass.length < 6) return flash('err', t("New password must be at least 6 characters."));
        setBusy(true);
        try {
            await api.changePassword(curPass, changePass);
            setCurPass(''); setChangePass('');
            flash('ok', t("Password changed. Other devices have been signed out."));
        } catch (e: any) { flash('err', e?.message || t("Failed to change password.")); }
        finally { setBusy(false); }
    };

    const doDisable = async () => {
        setBusy(true);
        try {
            await api.disableAuth(disablePass);
            await loadAuth();
            setDisablePass('');
            flash('ok', t("Password removed. The app is now open on this machine."));
        } catch (e: any) { flash('err', e?.message || t("Failed to remove password.")); }
        finally { setBusy(false); }
    };

    const regenKey = async () => {
        setBusy(true);
        try {
            const r = await api.regenerateApiKey();
            setApiKey(r.apiKey); setShowKey(true);
            flash('ok', t("New API key generated. Update any scripts/bots that used the old one."));
        } catch (e: any) { flash('err', e?.message || t("Failed to regenerate key.")); }
        finally { setBusy(false); }
    };

    const removeKey = async () => {
        setBusy(true);
        try {
            await api.deleteApiKey();
            setApiKey(null); setShowKey(false);
            flash('ok', t("API key deleted. Anything still sending it will be refused."));
        } catch (e: any) { flash('err', e?.message || t("Failed to delete key.")); }
        finally { setBusy(false); }
    };

    const copyKey = async () => {
        if (!apiKey) return;
        // `navigator.clipboard` is undefined over plain http, which is how this
        // is reached from a phone; `copyText` falls back to execCommand there,
        // and the tick only appears when the key really reached the clipboard.
        if (!await copyText(apiKey)) return;
        setCopied(true); setTimeout(() => setCopied(false), 1500);
    };

    return (
        <section className="mb-8">
            {/* The same caption every other section on the page draws. This one
                was `text-lg` in near-black, the only section heading on the Data
                tab that announced itself as loudly as the page title. */}
            <h2 className={`${GROUP_CAPTION} flex items-center gap-2`}>
                {authEnabled
                    ? <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                    : <Shield className="w-4 h-4 text-accent-fg" aria-hidden="true" />}
                {t("Security")}
            </h2>
            <div className="mb-2 px-1">
                <SettingNote>
                    {t("Protect this app with a password. Required if you reach it remotely (e.g. over Tailscale); the server only listens on this machine, so a password is your second layer of defense.")}
                </SettingNote>
            </div>

            {msg && (
                <div
                    role="status"
                    className={`mb-3 text-sm rounded-lg px-4 py-2.5 ${msg.kind === 'ok'
                        ? 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
                        : 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300'}`}
                >
                    {msg.text}
                </div>
            )}

            <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm divide-y divide-slate-100 dark:divide-slate-700/60">
                {!authEnabled ? (
                    <Block
                        title={t("Set a password")}
                        hint={t("At least 6 characters. You'll stay signed in on this device.")}
                    >
                        <FieldRow>
                            <PasswordInput autoComplete="new-password" label={t("New password")} value={newPass} onChange={setNewPass} />
                            <PasswordInput autoComplete="new-password" label={t("Confirm password")} value={confirmPass} onChange={setConfirmPass} />
                            <Button variant="primary" busy={busy} onClick={doSetup} icon={<Shield className="w-4 h-4" aria-hidden="true" />}>
                                {t("Enable password")}
                            </Button>
                        </FieldRow>
                    </Block>
                ) : (
                    <>
                        <Block title={t("Change password")} hint={t("Changing it signs out every other device.")}>
                            <FieldRow>
                                <PasswordInput autoComplete="current-password" label={t("Current password")} value={curPass} onChange={setCurPass} />
                                <PasswordInput autoComplete="new-password" label={t("New password")} value={changePass} onChange={setChangePass} />
                                <Button variant="primary" busy={busy} onClick={doChange} icon={<KeyRound className="w-4 h-4" aria-hidden="true" />}>
                                    {t("Update password")}
                                </Button>
                            </FieldRow>
                        </Block>

                        <Block
                            title={<span className="flex items-center gap-2"><KeyRound className="w-4 h-4" aria-hidden="true" /> {t("API key")}</span>}
                            hint={<>{t("For scripts and bots. Send it as")}{' '}<code className="px-1 rounded bg-slate-100 dark:bg-slate-700">Authorization: Bearer &lt;key&gt;</code>.</>}
                        >
                            {apiKey ? (
                                <div className="flex items-center gap-2">
                                    <TextInput
                                        readOnly
                                        aria-label={t("API key")}
                                        className="font-mono text-xs"
                                        value={showKey ? apiKey : '•'.repeat(24)}
                                        onFocus={e => e.target.select()}
                                    />
                                    <Button onClick={() => setShowKey(v => !v)} aria-label={showKey ? t("Hide key") : t("Show key")}>
                                        {showKey ? t("Hide") : t("Show")}
                                    </Button>
                                    <IconButton
                                        variant="neutral"
                                        onClick={copyKey}
                                        label={t("Copy key")}
                                        icon={copied ? <Check className="w-4 h-4 text-emerald-500" aria-hidden="true" /> : <Copy className="w-4 h-4" aria-hidden="true" />}
                                    />
                                </div>
                            ) : (
                                <p className="text-sm text-slate-500 dark:text-slate-400">{t("No API key yet.")}</p>
                            )}
                            {/* Two different questions, so two controls.
                                Regenerate answers "this leaked"; Delete answers
                                "nothing uses one any more" — which had no answer
                                at all short of taking the password off the whole
                                app, i.e. removing more security to remove a
                                credential. */}
                            <div className="mt-3 flex flex-wrap items-center gap-2">
                                <Button disabled={busy} onClick={regenKey} icon={<RefreshCw className="w-4 h-4" aria-hidden="true" />}>
                                    {apiKey ? t("Regenerate key") : t("Generate key")}
                                </Button>
                                {apiKey && (
                                    <Button variant="danger" disabled={busy} onClick={removeKey} icon={<Trash2 className="w-4 h-4" aria-hidden="true" />}>
                                        {t("Delete key")}
                                    </Button>
                                )}
                            </div>
                        </Block>

                        <Block title={t("Remove password")} hint={t("Turns the gate off. Only do this if the app is never reachable remotely.")}>
                            <FieldRow>
                                <PasswordInput autoComplete="current-password" label={t("Current password")} value={disablePass} onChange={setDisablePass} />
                                <Button variant="danger" busy={busy} disabled={!disablePass} onClick={doDisable}>
                                    {t("Remove password")}
                                </Button>
                            </FieldRow>
                        </Block>
                    </>
                )}
            </div>
        </section>
    );
}

/** One job on the card: its name, one line on what it does, then the controls. */
function Block({ title, hint, children }: { title: ReactNode; hint: ReactNode; children: ReactNode }) {
    return (
        <div className="p-4">
            <p className="font-medium text-slate-900 dark:text-white">{title}</p>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{hint}</p>
            <div className="mt-3">{children}</div>
        </div>
    );
}

/**
 * The fields and the button that submits them, on ONE line wherever the card
 * holds them. Stacked, "Set a password" was three full-width 40px rows for two
 * short secrets and a button — the page's tallest card for its smallest job.
 * Each field keeps a floor it can be read at (14rem), so the row breaks by the
 * CARD's width, never a viewport breakpoint: a phone gets the fields one under
 * the other and the button under both, a desktop gets all of it on one line.
 */
function FieldRow({ children }: { children: ReactNode }) {
    return <div className="flex flex-wrap items-center gap-3 [&>input]:min-w-[14rem] [&>input]:flex-1 [&>button]:shrink-0">{children}</div>;
}

/** A password field. The placeholder is the only visible name here, so it is
 *  also given as the accessible one — a placeholder is not a label and some
 *  screen readers skip it. */
function PasswordInput({ label, value, onChange, autoComplete }: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    autoComplete: string;
}) {
    return (
        <TextInput
            type="password"
            autoComplete={autoComplete}
            aria-label={label}
            placeholder={label}
            value={value}
            onChange={e => onChange(e.target.value)}
        />
    );
}

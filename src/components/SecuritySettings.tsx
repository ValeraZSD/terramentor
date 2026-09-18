import { useEffect, useState } from 'react';
import { Shield, ShieldCheck, KeyRound, Copy, Check, RefreshCw, Trash2, Loader2 } from 'lucide-react';
import { useStore } from '../store';
import { api } from '../api';
import { copyText } from '../utils/clipboard';
import { useTranslation } from 'react-i18next';

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
        if (newPass.length < 6) return flash('err', 'Password must be at least 6 characters.');
        if (newPass !== confirmPass) return flash('err', 'Passwords do not match.');
        setBusy(true);
        try {
            await api.setupPassword(newPass);
            await loadAuth();
            setNewPass(''); setConfirmPass('');
            flash('ok', 'Password set. Other devices will need it to sign in.');
        } catch (e: any) { flash('err', e?.message || 'Failed to set password.'); }
        finally { setBusy(false); }
    };

    const doChange = async () => {
        if (changePass.length < 6) return flash('err', 'New password must be at least 6 characters.');
        setBusy(true);
        try {
            await api.changePassword(curPass, changePass);
            setCurPass(''); setChangePass('');
            flash('ok', 'Password changed. Other devices have been signed out.');
        } catch (e: any) { flash('err', e?.message || 'Failed to change password.'); }
        finally { setBusy(false); }
    };

    const doDisable = async () => {
        setBusy(true);
        try {
            await api.disableAuth(disablePass);
            await loadAuth();
            setDisablePass('');
            flash('ok', 'Password removed. The app is now open on this machine.');
        } catch (e: any) { flash('err', e?.message || 'Failed to remove password.'); }
        finally { setBusy(false); }
    };

    const regenKey = async () => {
        setBusy(true);
        try {
            const r = await api.regenerateApiKey();
            setApiKey(r.apiKey); setShowKey(true);
            flash('ok', 'New API key generated. Update any scripts/bots that used the old one.');
        } catch (e: any) { flash('err', e?.message || 'Failed to regenerate key.'); }
        finally { setBusy(false); }
    };

    const removeKey = async () => {
        setBusy(true);
        try {
            await api.deleteApiKey();
            setApiKey(null); setShowKey(false);
            flash('ok', 'API key deleted. Anything still sending it will be refused.');
        } catch (e: any) { flash('err', e?.message || 'Failed to delete key.'); }
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

    const inputCls = 'w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-accent/60';
    const btnCls = 'px-4 py-2 bg-accent text-white rounded-lg hover:bg-accent/90 disabled:opacity-50 transition-colors font-medium inline-flex items-center gap-2';

    return (
        <section className="mb-8">
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-1 flex items-center gap-2">
                {authEnabled ? <ShieldCheck className="w-5 h-5 text-emerald-500" /> : <Shield className="w-5 h-5 text-slate-400" />}
                {t("Security")}
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
                {t("Protect this app with a password. Required if you reach it remotely (e.g. over Tailscale); the server only listens on this machine, so a password is your second layer of defense.")}
            </p>

            {msg && (
                <div
                    role="status"
                    className={`mb-4 text-sm rounded-lg px-4 py-2.5 ${msg.kind === 'ok'
                        ? 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
                        : 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300'}`}
                >
                    {msg.text}
                </div>
            )}

            <div className="bg-white dark:bg-slate-800 rounded-xl p-4 shadow-sm space-y-6">
                {!authEnabled ? (
                    <div className="space-y-3">
                        <div>
                            <p className="font-semibold text-slate-900 dark:text-white">{t("Set a password")}</p>
                            <p className="text-sm text-slate-500 dark:text-slate-400">{t("At least 6 characters. You'll stay signed in on this device.")}</p>
                        </div>
                        <input type="password" autoComplete="new-password" className={inputCls} placeholder={t("New password")} value={newPass} onChange={e => setNewPass(e.target.value)} />
                        <input type="password" autoComplete="new-password" className={inputCls} placeholder={t("Confirm password")} value={confirmPass} onChange={e => setConfirmPass(e.target.value)} />
                        <button className={btnCls} disabled={busy} onClick={doSetup}>
                            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />} {t("Enable password")}
                        </button>
                    </div>
                ) : (
                    <>
                        {/* Change password */}
                        <div className="space-y-3">
                            <div>
                                <p className="font-semibold text-slate-900 dark:text-white">{t("Change password")}</p>
                                <p className="text-sm text-slate-500 dark:text-slate-400">{t("Changing it signs out every other device.")}</p>
                            </div>
                            <input type="password" autoComplete="current-password" className={inputCls} placeholder={t("Current password")} value={curPass} onChange={e => setCurPass(e.target.value)} />
                            <input type="password" autoComplete="new-password" className={inputCls} placeholder={t("New password")} value={changePass} onChange={e => setChangePass(e.target.value)} />
                            <button className={btnCls} disabled={busy} onClick={doChange}>
                                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />} {t("Update password")}
                            </button>
                        </div>

                        {/* API key */}
                        <div className="space-y-3 border-t border-slate-200 dark:border-slate-700 pt-5">
                            <div>
                                <p className="font-semibold text-slate-900 dark:text-white flex items-center gap-2"><KeyRound className="w-4 h-4" /> {t("API key")}</p>
                                <p className="text-sm text-slate-500 dark:text-slate-400">
                                    {t("For scripts and bots. Send it as")}{' '}<code className="px-1 rounded bg-slate-100 dark:bg-slate-700">Authorization: Bearer &lt;key&gt;</code>.
                                </p>
                            </div>
                            {apiKey ? (
                                <div className="flex items-center gap-2">
                                    <input readOnly className={`${inputCls} font-mono text-xs`} value={showKey ? apiKey : '•'.repeat(24)} onFocus={e => e.target.select()} />
                                    <button type="button" aria-label={showKey ? t("Hide key") : t("Show key")} className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700" onClick={() => setShowKey(v => !v)}>
                                        {showKey ? t("Hide") : t("Show")}
                                    </button>
                                    <button type="button" aria-label={t("Copy key")} className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700" onClick={copyKey}>
                                        {copied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                                    </button>
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
                            <div className="flex flex-wrap items-center gap-2">
                                <button className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 inline-flex items-center gap-2 disabled:opacity-50" disabled={busy} onClick={regenKey}>
                                    <RefreshCw className="w-4 h-4" /> {apiKey ? t("Regenerate key") : t("Generate key")}
                                </button>
                                {apiKey && (
                                    <button className="px-4 py-2 rounded-lg border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/30 inline-flex items-center gap-2 disabled:opacity-50" disabled={busy} onClick={removeKey}>
                                        <Trash2 className="w-4 h-4" /> {t("Delete key")}
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* Disable */}
                        <div className="space-y-3 border-t border-slate-200 dark:border-slate-700 pt-5">
                            <div>
                                <p className="font-semibold text-slate-900 dark:text-white">{t("Remove password")}</p>
                                <p className="text-sm text-slate-500 dark:text-slate-400">{t("Turns the gate off. Only do this if the app is never reachable remotely.")}</p>
                            </div>
                            <input type="password" autoComplete="current-password" className={inputCls} placeholder={t("Current password")} value={disablePass} onChange={e => setDisablePass(e.target.value)} />
                            <button className="px-4 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors font-medium inline-flex items-center gap-2" disabled={busy || !disablePass} onClick={doDisable}>
                                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null} {t("Remove password")}
                            </button>
                        </div>
                    </>
                )}
            </div>
        </section>
    );
}

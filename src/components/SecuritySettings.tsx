import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Shield, ShieldCheck, KeyRound, Copy, Check, RefreshCw, Trash2, Monitor, Smartphone } from 'lucide-react';
import { useStore } from '../store';
import { api, siteApi, type SiteSession } from '../api';
import { copyText } from '../utils/clipboard';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { uiLocale } from '../utils/locale';
import { Button, ButtonLink, IconButton } from './ui/Button';
import { PasswordInput } from './ui/Field';
import { GROUP_CAPTION, SettingNote, SettingRow } from './ui/SettingRow';
import { DEVICES_CHANGED } from './OtherDevices';

/**
 * Settings → Security panel for the single-user auth gate: create / change /
 * remove the password, and manage the API key programmatic clients (e.g. a bot)
 * use as a `Bearer` token. Backed by the /api/auth/* endpoints.
 */
export default function SecuritySettings() {
    const authSite = useStore(s => s.authSite);
    return authSite ? <SiteAccount /> : <PasswordSecurity />;
}

/**
 * A library on a shared site (server/site/): the account and the devices it
 * is signed in on, kept by the site's front desk and read from it. Signing out
 * of this device is a form post, so the browser leaves the app and the front
 * desk can clear what the library left in it.
 */
function SiteAccount() {
    const { t } = useTranslation();
    const showConfirm = useStore(s => s.showConfirm);
    const addToast = useStore(s => s.addToast);
    const [account, setAccount] = useState<{ email: string; sessions: SiteSession[] } | null>(null);
    const [failed, setFailed] = useState(false);
    const [busy, setBusy] = useState<number | 'others' | null>(null);

    const load = useCallback(() => siteApi.sessions()
        .then(a => { setAccount(a); setFailed(false); })
        .catch(() => setFailed(true)), []);
    useEffect(() => { load(); }, [load]);

    // This device first, then the most recently used.
    const sessions = [...(account?.sessions ?? [])].sort((a, b) => Number(b.current) - Number(a.current) || b.last_seen_at.localeCompare(a.last_seen_at));
    const others = sessions.filter(s => !s.current);

    const signOutOne = async (s: SiteSession) => {
        const ok = await showConfirm({
            title: t("Sign out of {{device}}?", { device: deviceName(s.device, t) }),
            message: t("That device will need your password to get back in."),
            confirmLabel: t("Sign out"),
        });
        if (!ok) return;
        setBusy(s.id);
        try { await siteApi.signOutSession(s.id); await load(); }
        catch (e: any) { addToast('error', e?.message || t("Could not sign out that device.")); }
        finally { setBusy(null); }
    };
    const signOutOthers = async () => {
        const ok = await showConfirm({
            title: t("Sign out of all other devices?"),
            message: t("Every device except this one will need your password to get back in."),
            confirmLabel: t("Sign out of all other devices"),
        });
        if (!ok) return;
        setBusy('others');
        try { await siteApi.signOutOthers(); await load(); }
        catch (e: any) { addToast('error', e?.message || t("Could not sign out the other devices.")); }
        finally { setBusy(null); }
    };

    const now = Date.now();
    // Signing out of this device is a form post: the browser leaves the app and
    // the front desk clears what the library left in it.
    const signOutHere = (
        <form method="post" action="/site/sign-out">
            <Button type="submit">{t("Sign out")}</Button>
        </form>
    );
    const listed = sessions.some(s => s.current);
    return (
        <section className="mb-8">
            <h2 className={`${GROUP_CAPTION} flex items-center gap-2`}>
                <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                {t("Account")}
            </h2>
            <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm divide-y divide-slate-100 dark:divide-slate-700/60">
                {/* Every Sign out ends the device on its own row; the account row
                    carries one only while the list is not there to hold it. */}
                <SettingRow label={account?.email ?? t("Signed in")} control={listed ? undefined : signOutHere} />
                {failed && (
                    <div className="p-4 flex flex-wrap items-center justify-between gap-3">
                        <p className="text-sm text-slate-700 dark:text-slate-200">{t("Could not load your signed-in devices.")}</p>
                        <Button size="sm" onClick={load}>{t("Try again")}</Button>
                    </div>
                )}
                {sessions.length > 0 && (
                    <div>
                        <p className="px-4 pt-4 text-sm font-medium text-slate-600 dark:text-slate-300">{t("Signed-in devices")}</p>
                        <ul className="divide-y divide-slate-100 dark:divide-slate-700/60" aria-label={t("Signed-in devices")}>
                            {sessions.map(s => {
                                const Icon = /Android|iOS/.test(s.device) ? Smartphone : Monitor;
                                return (
                                    <li key={s.id} className="p-4 flex items-center gap-3">
                                        <Icon className="w-5 h-5 shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" />
                                        <div className="min-w-0 flex-1">
                                            <p className="font-medium text-slate-900 dark:text-white truncate">{deviceName(s.device, t)}</p>
                                            {/* The device in hand is the one in use now, so its line says which it is. */}
                                            <p className={`text-sm ${s.current ? 'font-medium text-emerald-800 dark:text-emerald-300' : 'text-slate-600 dark:text-slate-300'}`}>
                                                {s.current ? t("This device") : activeAgo(s.last_seen_at, now, t)}
                                            </p>
                                        </div>
                                        {s.current
                                            ? signOutHere
                                            : <Button busy={busy === s.id} disabled={busy !== null} onClick={() => signOutOne(s)}>{t("Sign out")}</Button>}
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                )}
                {others.length > 1 && (
                    <div className="p-4">
                        <Button busy={busy === 'others'} disabled={busy !== null} onClick={signOutOthers}>{t("Sign out of all other devices")}</Button>
                    </div>
                )}
            </div>
        </section>
    );
}

/** "Edge on Windows", as the front desk names a device from its browser, in the interface language. */
function deviceName(label: string, t: TFunction) {
    const [browser, os] = label.split(' on ');
    return os ? t("{{browser}} on {{os}}", { browser, os }) : browser;
}

/** "Active 3 hours ago", "Active yesterday": how long ago a device was last used. */
function activeAgo(iso: string, now: number, t: TFunction) {
    const min = Math.max(0, Math.floor((now - Date.parse(iso)) / 60000));
    if (min < 2) return t("Active now");
    const [n, unit]: [number, Intl.RelativeTimeFormatUnit] = min < 60 ? [min, 'minute'] : min < 1440 ? [Math.floor(min / 60), 'hour'] : [Math.floor(min / 1440), 'day'];
    return t("Active {{when}}", { when: new Intl.RelativeTimeFormat(uiLocale(), { numeric: 'auto' }).format(-n, unit) });
}

function PasswordSecurity() {
    const { t } = useTranslation();
    const authEnabled = useStore(s => s.authEnabled);
    const loadAuth = useStore(s => s.loadAuth);

    const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
    // Which request is out, so only its own button spins; every button waits
    // while any of them runs.
    const [busy, setBusy] = useState<'setup' | 'change' | 'signout' | 'disable' | 'key' | null>(null);

    // Set-password (first run) fields
    const [newPass, setNewPass] = useState('');
    const [confirmPass, setConfirmPass] = useState('');

    // Change-password fields
    const [curPass, setCurPass] = useState('');
    const [changePass, setChangePass] = useState('');

    // Sign out everywhere
    const [signOutPass, setSignOutPass] = useState('');

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

    // A success line clears itself; the timer is dropped when a newer line
    // replaces it, or an error that arrived within 4 s would vanish with it.
    const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);
    const flash = (kind: 'ok' | 'err', text: string) => {
        if (flashTimer.current) clearTimeout(flashTimer.current);
        flashTimer.current = null;
        setMsg({ kind, text });
        if (kind === 'ok') flashTimer.current = setTimeout(() => setMsg(null), 4000);
    };

    const doSetup = async () => {
        if (newPass.length < 10) return flash('err', t("Password must be at least 10 characters."));
        if (newPass !== confirmPass) return flash('err', t("Passwords do not match."));
        setBusy('setup');
        try {
            await api.setupPassword(newPass);
            await loadAuth();
            setNewPass(''); setConfirmPass('');
            flash('ok', t("Password set. Other devices will need it to sign in."));
        } catch (e: any) { flash('err', e?.message || t("Failed to set password.")); }
        finally { setBusy(null); }
    };

    const doChange = async () => {
        if (changePass.length < 10) return flash('err', t("New password must be at least 10 characters."));
        setBusy('change');
        try {
            await api.changePassword(curPass, changePass);
            setCurPass(''); setChangePass('');
            flash('ok', t("Password changed. Other devices have been signed out."));
        } catch (e: any) { flash('err', e?.message || t("Failed to change password.")); }
        finally { setBusy(null); }
    };

    // Ends every other sign-in and removes every connected device, without
    // making anyone choose a new password: the answer to "I signed in on a
    // computer that is not mine". This device stays signed in (the server
    // sends it a fresh cookie), and the device list beside this panel is
    // told to reload, since every row in it is gone.
    const doSignOutEverywhere = async () => {
        setBusy('signout');
        try {
            await api.signOutEverywhere(signOutPass);
            setSignOutPass('');
            window.dispatchEvent(new Event(DEVICES_CHANGED));
            flash('ok', t("Every other device has been signed out, connected ones included."));
        } catch (e: any) { flash('err', e?.message || t("Could not sign out the other devices.")); }
        finally { setBusy(null); }
    };

    const doDisable = async () => {
        setBusy('disable');
        try {
            await api.disableAuth(disablePass);
            await loadAuth();
            setDisablePass('');
            flash('ok', t("Password removed. The app is now open on this machine."));
        } catch (e: any) { flash('err', e?.message || t("Failed to remove password.")); }
        finally { setBusy(null); }
    };

    const regenKey = async () => {
        setBusy('key');
        try {
            const r = await api.regenerateApiKey();
            setApiKey(r.apiKey); setShowKey(true);
            flash('ok', t("New API key generated. Update any scripts/bots that used the old one."));
        } catch (e: any) { flash('err', e?.message || t("Failed to regenerate key.")); }
        finally { setBusy(null); }
    };

    const removeKey = async () => {
        setBusy('key');
        try {
            await api.deleteApiKey();
            setApiKey(null); setShowKey(false);
            flash('ok', t("API key deleted. Anything still sending it will be refused."));
        } catch (e: any) { flash('err', e?.message || t("Failed to delete key.")); }
        finally { setBusy(null); }
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
                    {t("Optional: a phone connected above needs none. While a password is set, Tailscale alone lets no device in.")}
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
                        hint={t("At least 10 characters. You'll stay signed in on this device; connected devices are signed out and sign in with it or a new code.")}
                    >
                        <FieldRow>
                            <SecretField autoComplete="new-password" label={t("New password")} value={newPass} onChange={setNewPass} />
                            <SecretField autoComplete="new-password" label={t("Confirm password")} value={confirmPass} onChange={setConfirmPass} />
                            <Button variant="primary" busy={busy === 'setup'} disabled={busy !== null} onClick={doSetup} icon={<Shield className="w-4 h-4" aria-hidden="true" />}>
                                {t("Enable password")}
                            </Button>
                        </FieldRow>
                    </Block>
                ) : (
                    <>
                        <Block title={t("Change password")} hint={t("Changing it signs out every other device, connected ones included.")}>
                            <FieldRow>
                                <SecretField autoComplete="current-password" label={t("Current password")} value={curPass} onChange={setCurPass} />
                                <SecretField autoComplete="new-password" label={t("New password")} value={changePass} onChange={setChangePass} />
                                <Button variant="primary" busy={busy === 'change'} disabled={busy !== null} onClick={doChange} icon={<KeyRound className="w-4 h-4" aria-hidden="true" />}>
                                    {t("Update password")}
                                </Button>
                            </FieldRow>
                        </Block>

                        <Block title={t("Sign out everywhere")} hint={t("Signs out every other device and removes the connected ones, without changing the password.")}>
                            <FieldRow>
                                <SecretField autoComplete="current-password" label={t("Current password")} value={signOutPass} onChange={setSignOutPass} />
                                <Button variant="danger" busy={busy === 'signout'} disabled={busy !== null || !signOutPass} onClick={doSignOutEverywhere}>
                                    {t("Sign out everywhere")}
                                </Button>
                            </FieldRow>
                        </Block>

                        <Block
                            title={<span className="flex items-center gap-2"><KeyRound className="w-4 h-4" aria-hidden="true" /> {t("API key")}</span>}
                            hint={<>{t("For scripts and bots. Send it as")}{' '}<code className="px-1 rounded bg-slate-100 dark:bg-slate-700">Authorization: Bearer &lt;key&gt;</code>.</>}
                        >
                            {apiKey ? (
                                <div className="flex items-center gap-2">
                                    <PasswordInput
                                        kind="key"
                                        readOnly
                                        aria-label={t("API key")}
                                        className="flex-1 font-mono"
                                        autoComplete="off"
                                        // Hidden, the field holds a fixed mask, not the key: its
                                        // length would show in the dots, and its text in the DOM.
                                        value={showKey ? apiKey : '•'.repeat(24)}
                                        shown={showKey}
                                        onShownChange={setShowKey}
                                        onFocus={e => e.target.select()}
                                    />
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
                                <Button disabled={busy !== null} onClick={regenKey} icon={<RefreshCw className="w-4 h-4" aria-hidden="true" />}>
                                    {apiKey ? t("Regenerate key") : t("Generate key")}
                                </Button>
                                {apiKey && (
                                    <Button variant="danger" disabled={busy !== null} onClick={removeKey} icon={<Trash2 className="w-4 h-4" aria-hidden="true" />}>
                                        {t("Delete key")}
                                    </Button>
                                )}
                            </div>
                        </Block>

                        <Block title={t("Remove password")} hint={t("Other devices then open the app only if they are connected above.")}>
                            <FieldRow>
                                <SecretField autoComplete="current-password" label={t("Current password")} value={disablePass} onChange={setDisablePass} />
                                <Button variant="danger" busy={busy === 'disable'} disabled={busy !== null || !disablePass} onClick={doDisable}>
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
    return <div className="flex flex-wrap items-center gap-3 [&>button]:shrink-0">{children}</div>;
}

/** A password field. The placeholder is the only visible name here, so it is
 *  also given as the accessible one — a placeholder is not a label and some
 *  screen readers skip it. */
function SecretField({ label, value, onChange, autoComplete }: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    autoComplete: string;
}) {
    return (
        <PasswordInput
            className="min-w-[14rem] flex-1"
            autoComplete={autoComplete}
            aria-label={label}
            placeholder={label}
            value={value}
            onChange={e => onChange(e.target.value)}
        />
    );
}

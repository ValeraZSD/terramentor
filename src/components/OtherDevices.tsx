import { useCallback, useEffect, useRef, useState } from 'react';
import { Smartphone, QrCode as QrIcon, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { useStore } from '../store';
import type { ConnectedDevice, PairingOffer } from '../types';
import { uiLocale } from '../utils/locale';
import { Button, ButtonLink } from './ui/Button';
import Switch from './ui/Switch';
import { PasswordInput } from './ui/Field';
import { GROUP_CAPTION, SettingNote } from './ui/SettingRow';
import QrCode from './QrCode';
import { Explain } from './ui/Disclosure';

const REMOTE_ACCESS_GUIDE = 'https://github.com/ValeraZSD/terramentor/blob/main/docs/REMOTE_ACCESS.md';
/** How often the open code asks whether a phone has used it yet. */
const WATCH_MS = 2000;

/**
 * Settings → Data → Other devices: the ways a phone gets into this app without
 * the password (server/devices.js). A QR code the phone scans here, the
 * computer's own Tailscale account for when nobody is at this screen, and the
 * list of connected devices with a Remove on each.
 */
export default function OtherDevices({ active }: { active: boolean }) {
    const { t } = useTranslation();
    const showConfirm = useStore(s => s.showConfirm);
    const addToast = useStore(s => s.addToast);
    const [devices, setDevices] = useState<ConnectedDevice[] | null>(null);
    const [tailscale, setTailscale] = useState<{ login: string | null; on: boolean; served: boolean } | null>(null);
    const [offer, setOffer] = useState<PairingOffer | null>(null);
    const [busy, setBusy] = useState(false);
    const authEnabled = useStore(s => s.authEnabled);
    const [password, setPassword] = useState('');
    // The devices there were before the code showed; null until a list has
    // loaded, so a slow or failed first load never reads old devices as new.
    const known = useRef<Set<number> | null>(null);

    const load = useCallback(async () => {
        const r = await api.getDevices();
        setDevices(r.devices);
        setTailscale(r.tailscale);
        return r.devices;
    }, []);

    useEffect(() => {
        if (!active) return;
        load().then(list => { known.current = new Set(list.map(d => d.id)); }).catch(() => { });
    }, [active, load]);

    // While a code is on screen, watch for the phone that uses it, then put the
    // code away: it is spent, and the new row in the list is the answer.
    useEffect(() => {
        if (!offer?.url) return;
        let asking = false; // a slow answer must not stack a second request on top of it
        const timer = setInterval(async () => {
            if (offer.expiresAt && Date.now() > Date.parse(offer.expiresAt)) { setOffer(null); return; }
            if (asking) return;
            asking = true;
            try {
                const list = await load();
                const before = known.current;
                known.current = new Set(list.map(d => d.id));
                const added = before ? list.find(d => !before.has(d.id)) : undefined;
                if (added) {
                    setOffer(null);
                    addToast('success', t("Connected: {{name}}", { name: added.name }));
                }
            } catch { /* the next tick asks again */ }
            finally { asking = false; }
        }, WATCH_MS);
        return () => clearInterval(timer);
    }, [offer, load, addToast, t]);

    // With a password set, a code that admits a new device costs the password
    // again (server/routes/devices.js), so a borrowed session cannot mint one.
    const showCode = async () => {
        setBusy(true);
        try { const o = await api.pairDevice(authEnabled ? password : undefined); setOffer(o); if (o.url) setPassword(''); }
        catch (e: any) { addToast('error', e?.message || t("Could not make a code.")); }
        finally { setBusy(false); }
    };

    const turnOnServe = async () => {
        setBusy(true);
        try { const o = await api.serveOnTailnet(authEnabled ? password : undefined); setOffer(o); if (o.url) { setPassword(''); void load(); } }
        catch (e: any) { addToast('error', e?.message || t("Could not change the setting.")); }
        finally { setBusy(false); }
    };

    const remove = async (d: ConnectedDevice) => {
        const confirmed = await showConfirm({
            title: t("Remove device"),
            message: d.current
                ? t("Remove this device? It will be locked out until you connect it again.")
                : t("Remove “{{name}}”? It will be locked out until you connect it again.", { name: d.name }),
            confirmLabel: t("Remove"),
            variant: 'danger',
        });
        if (!confirmed) return;
        try {
            await api.removeDevice(d.id);
            await load();
        } catch (e: any) { addToast('error', e?.message || t("Could not remove the device.")); }
    };

    const toggleTailscale = async (on: boolean) => {
        try { const r = await api.setTailscaleTrust(on); setTailscale(prev => prev && { ...prev, on: r.on }); }
        catch (e: any) { addToast('error', e?.message || t("Could not change the setting.")); }
    };

    // With a password set, showing a code asks for it again.
    const passwordField = authEnabled && (
        <PasswordInput
            autoComplete="current-password"
            aria-label={t("Password")}
            placeholder={t("Password")}
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="w-full max-w-[16rem]"
        />
    );

    const date = (iso: string | null) => iso
        ? new Intl.DateTimeFormat(uiLocale(), { dateStyle: 'medium' }).format(new Date(iso))
        : '';

    return (
        <section className="mb-8">
            <h2 className={`${GROUP_CAPTION} flex items-center gap-2`}>
                <Smartphone className="w-4 h-4 text-accent-fg" aria-hidden="true" />
                {t("Other devices")}
            </h2>
            <div className="mb-2 px-1">
                <SettingNote>
                    {t("A phone or another computer opens this app only once you connect it here, or with the password if you set one.")}
                </SettingNote>
            </div>

            <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm divide-y divide-slate-100 dark:divide-slate-700/60">
                <div className="p-4">
                    <p className="font-medium text-slate-900 dark:text-white">{t("Connect a phone")}</p>
                    {!offer?.url && (
                        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                            {t("Show a code here and scan it with the phone. It works once, for 10 minutes.")}
                        </p>
                    )}
                    {offer?.url ? (
                        // The code on a white tile of its own (a scanner wants a
                        // quiet light margin round it, on either theme), the two
                        // steps beside it, and when it runs out. Wraps by the
                        // CARD's width: in a narrow window the code goes above
                        // the steps, centred. No panel behind it: the card is the
                        // panel.
                        <div className="mt-4 flex flex-wrap items-center justify-center gap-x-10 gap-y-5">
                            <div className="shrink-0 rounded-2xl bg-white p-3 shadow-md ring-1 ring-black/5">
                                <QrCode text={offer.url} label={t("Code to scan with the phone")} className="block w-56 h-56" />
                            </div>
                            <div className="min-w-0 flex-1 basis-64 space-y-4">
                                <ol className="space-y-3">
                                    {[
                                        t("On the phone, press Scan code in Terramentor, or open the camera app."),
                                        t("Point it at this code. The phone is in, and stays connected."),
                                    ].map((step, i) => (
                                        <li key={i} className="flex items-start gap-3 text-slate-700 dark:text-slate-200">
                                            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-white" aria-hidden="true">{i + 1}</span>
                                            <span>{step}</span>
                                        </li>
                                    ))}
                                </ol>
                                <ExpiresIn at={offer.expiresAt} />
                                <Explain summary={t("Can't scan? Open this address on the phone")}>
                                    <p className="font-mono text-sm break-all text-slate-700 dark:text-slate-200 select-all">{offer.url}</p>
                                </Explain>
                                <Button variant="quiet" onClick={() => setOffer(null)}>{t("Hide code")}</Button>
                            </div>
                        </div>
                    ) : offer && !offer.url && offer.tailscale ? (
                        <div className="mt-3 space-y-3">
                            <p className="text-sm text-slate-600 dark:text-slate-300">
                                {t("Tailscale is on this computer, but your phone can't open Terramentor through it yet. Turn it on and your phone can, at home or away. Only your own Tailscale devices can reach it, never the open internet.")}
                            </p>
                            {offer.failed && offer.command && (
                                <p className="text-sm text-slate-600 dark:text-slate-300">
                                    {t("Tailscale didn't let the app do it. Run this once on this computer, then press Show code again:")}{' '}
                                    <code className="px-1 rounded bg-slate-100 dark:bg-slate-700 break-all">{offer.command}</code>
                                </p>
                            )}
                            {offer.failed && !offer.command && (
                                <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">
                                    {t("Tailscale didn't answer. Check that it is running on this computer, then try again.")}
                                </p>
                            )}
                            <div className="flex flex-wrap gap-2">
                                {passwordField}
                                <Button variant="primary" busy={busy} disabled={authEnabled && !password} onClick={turnOnServe}>{t("Turn it on")}</Button>
                                <Button variant="quiet" onClick={() => setOffer(null)}>{t("Not now")}</Button>
                            </div>
                        </div>
                    ) : offer && !offer.url ? (
                        <div className="mt-3 space-y-3">
                            <p className="text-sm text-slate-600 dark:text-slate-300">
                                {t("No phone can reach this computer yet. Tailscale (free) connects them, at home or away; then come back here.")}
                            </p>
                            <div className="flex flex-wrap gap-2">
                                <ButtonLink href={REMOTE_ACCESS_GUIDE} target="_blank" rel="noopener noreferrer">{t("How to set it up")}</ButtonLink>
                                <Button variant="quiet" onClick={showCode} busy={busy}>{t("Try again")}</Button>
                            </div>
                        </div>
                    ) : (
                        <div className="mt-3 flex flex-wrap gap-2">
                            {passwordField}
                            <Button variant="primary" busy={busy} disabled={authEnabled && !password} onClick={showCode} icon={<QrIcon className="w-4 h-4" aria-hidden="true" />}>
                                {t("Show code")}
                            </Button>
                        </div>
                    )}
                </div>

                {/* With a password set, Tailscale lets nobody in (server/devices.js),
                    so the switch goes and one line says why. */}
                {tailscale?.login && authEnabled && (
                    <p className="p-4 text-sm text-slate-500 dark:text-slate-400">
                        {t("Tailscale: while a password is set, your Tailscale devices need it too, or a code from here.")}
                    </p>
                )}
                {tailscale?.login && !authEnabled && (
                    <div className="p-4 flex items-start gap-4">
                        <div className="min-w-0 flex-1">
                            <p className="font-medium text-slate-900 dark:text-white">{t("Tailscale")}</p>
                            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                                {t("Your devices signed in to Tailscale as {{login}} open this app without a password, wherever they are.", { login: tailscale.login })}
                            </p>
                            {tailscale.on && !tailscale.served && (
                                <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
                                    {t("Not reachable through Tailscale yet: press Show code, then Turn it on.")}
                                </p>
                            )}
                        </div>
                        <Switch checked={tailscale.on} onChange={toggleTailscale} label={t("Let my Tailscale devices in")} />
                    </div>
                )}

                {devices && devices.length > 0 && (
                    <div>
                    <p className="px-4 pt-4 text-sm font-medium text-slate-500 dark:text-slate-400">{t("Connected devices")}</p>
                    <ul className="divide-y divide-slate-100 dark:divide-slate-700/60" aria-label={t("Connected devices")}>
                        {devices.map(d => (
                            <li key={d.id} className="p-4 flex items-center gap-3">
                                <Smartphone className="w-5 h-5 shrink-0 text-slate-400" aria-hidden="true" />
                                <div className="min-w-0 flex-1">
                                    <p className="font-medium text-slate-900 dark:text-white truncate">
                                        {d.name}
                                        {d.current && <span className="ml-2 text-sm font-normal text-slate-500 dark:text-slate-400">{t("(this device)")}</span>}
                                    </p>
                                    <p className="text-sm text-slate-500 dark:text-slate-400">
                                        {t("Connected {{date}}", { date: date(d.createdAt) })}
                                        {d.lastSeenAt && date(d.lastSeenAt) !== date(d.createdAt) && <> · {t("last used {{date}}", { date: date(d.lastSeenAt) })}</>}
                                    </p>
                                </div>
                                <Button variant="danger" onClick={() => remove(d)} icon={<Trash2 className="w-4 h-4" aria-hidden="true" />}>
                                    {t("Remove")}
                                </Button>
                            </li>
                        ))}
                    </ul>
                    </div>
                )}
            </div>
        </section>
    );
}

/** "Works once · expires in 9:41", ticking, amber in the last minute; "Expired" once it has run out. */
function ExpiresIn({ at }: { at?: string }) {
    const { t } = useTranslation();
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);
    const left = at ? Math.max(0, Date.parse(at) - now) : 0;
    const tone = left < 60_000 ? 'text-amber-700 dark:text-amber-300' : 'text-slate-600 dark:text-slate-300';
    if (!at || left === 0) return <p className={`text-sm font-medium ${tone}`}>{t("Expired")}</p>;
    const sec = Math.ceil(left / 1000);
    return (
        <p className={`text-sm font-medium tabular-nums ${tone}`}>
            {t("Works once · expires in {{time}}", { time: `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` })}
        </p>
    );
}

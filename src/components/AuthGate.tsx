import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Lock, Loader2, Smartphone, QrCode, Globe, Camera, RefreshCw } from 'lucide-react';
import QrScanner, { canScanLive, usePhotoScan } from './QrScanner';
import { useStore } from '../store';
import { api } from '../api';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/Button';
import { TextInput } from './ui/Field';

/**
 * How often the lock screen asks the server whether it is still needed.
 *
 * The screen is idle by construction — nothing else on it talks to the server —
 * so the poll is the only thing that can notice the gate being turned off from
 * another device, and it stops the moment the app unlocks (the component
 * unmounts). 10s is the interval at which "I just removed the password on the
 * desktop, why is my phone still asking" stops being a bug report.
 */
const RECHECK_MS = 10000;

/**
 * Full-screen gate shown to a device that is not let in yet: the password form
 * when a password exists, otherwise the ways to connect this device
 * (RemoteSetup). Either one also spends a QR code's `#pair=` from Settings →
 * Data → Other devices, which lets a device in with no password at all.
 *
 * IT ALSO WATCHES FOR THE GATE DISAPPEARING. The auth verdict was read once, at
 * mount, and this is the one screen where that is not enough: removing the
 * password on the desktop left every other device sitting on a login form for a
 * lock that no longer existed, and the only way past it was a full page reload
 * — the app cannot ask a question it never re-asks. So the screen re-checks on
 * a timer, whenever the tab comes back to the foreground, and after any failed
 * attempt (the likeliest moment for the answer to have changed underneath the
 * person typing).
 */
export default function AuthGate() {
    const setupRequired = useStore(s => s.authSetupRequired);
    return setupRequired ? <RemoteSetup /> : <Login />;
}

/**
 * Every control on these screens comes from `ui/` at ONE size, `lg`: they are
 * pressed on a phone. Each action is full width at the card's own edge; one
 * primary per screen, the second way in outlined with its icon, and the setup
 * code the one quiet link. Hand-written buttons here once gave two actions two
 * widths, two heights and two positions on one card, and read as two apps.
 */
const ACTION = { block: true, size: 'lg' } as const;
const LABEL = 'block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1';

type RecheckRef = { current: () => Promise<void> };

/** Re-ask the server on a timer and whenever the tab comes back (see RECHECK_MS). */
function useRecheck() {
    const recheckAuth = useStore(s => s.recheckAuth);
    // Read live in the listeners without making them re-register on every keystroke.
    const recheckRef = useRef(recheckAuth);
    recheckRef.current = recheckAuth;
    useEffect(() => {
        const check = () => { void recheckRef.current(); };
        check();
        const timer = setInterval(() => { if (!document.hidden) check(); }, RECHECK_MS);
        // A phone wakes by coming back to the foreground, not by a timer that
        // was suspended with the tab — both events, because Safari and Chrome
        // do not agree about which fires on a PWA resume.
        const onVisible = () => { if (!document.hidden) check(); };
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('focus', onVisible);
        return () => {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisible);
            window.removeEventListener('focus', onVisible);
        };
    }, []);
    return recheckRef;
}

/**
 * Spend a `#pair=<code>` the page was opened with: the address in the QR code
 * Settings shows on the computer (server/devices.js). The code rides in the
 * fragment, so it reached no server log on the way; it is taken out of the
 * address bar at once, so it is not left in the history either.
 */
function takePairCode(): string | null {
    const m = /(?:^#|&)pair=([A-Za-z0-9_-]{16,})/.exec(window.location.hash);
    if (!m) return null;
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    return m[1];
}

/**
 * Connect this device with a code: the one the page was opened with, if any,
 * or one scanned on this screen (`claim`); then re-ask the server.
 */
function usePairing(recheckRef: RecheckRef) {
    const { t } = useTranslation();
    const [state, setState] = useState<{ busy: boolean; error: string }>({ busy: false, error: '' });
    const claim = (code: string) => {
        setState({ busy: true, error: '' });
        api.claimPairing(code)
            .then(() => recheckRef.current())
            .then(() => {
                setState({ busy: false, error: '' });
                // The app simply opening said nothing about what happened or
                // whether it lasts. Said only once the app really is open: the
                // re-check swallows its own failures.
                const st = useStore.getState();
                if (!st.authSetupRequired && (!st.authEnabled || st.authenticated)) {
                    st.addToast('success', t("This device is connected. It stays connected unless it is removed on the computer or goes unused for six months."));
                }
            })
            .catch((err: any) => setState({ busy: false, error: err?.message || t("This code did not work. Show a new one on the computer.") }));
    };
    useEffect(() => {
        const code = takePairCode();
        if (code) claim(code);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return { ...state, claim };
}

const CARD = "w-full max-w-sm bg-white dark:bg-slate-800 rounded-2xl shadow-xl p-6 sm:p-8";

/**
 * How a device that is not the server's machine gets in, when no password
 * exists.
 *
 * An app with no password answers only its own machine (server/auth.js), so a
 * phone lands here instead of on the data. It used to land on a form for the
 * first password that wanted a code printed in the server's log — a log a
 * desktop user never sees. The ways in now, in the order a person meets them:
 * scan the QR code Settings shows on the computer; or, away from it, sign in to
 * Tailscale with the computer's own account (shown only when the computer is on
 * Tailscale). The log's code stays, folded, for a server nobody can sit at.
 */
function RemoteSetup() {
    const { t } = useTranslation();
    const tailscale = useStore(s => s.authTailscale);
    const recheckRef = useRecheck();
    const pairing = usePairing(recheckRef);
    const scan = useScan(pairing);
    const [withCode, setWithCode] = useState(false);
    const [checking, setChecking] = useState(false);
    const tryAgain = async () => {
        setChecking(true);
        try { await recheckRef.current(); } finally { setChecking(false); }
    };

    if (pairing.busy) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-slate-100 dark:bg-slate-900 px-4">
                <div className={`${CARD} flex flex-col items-center text-center`} role="status">
                    <Loader2 className="w-7 h-7 animate-spin text-accent-fg" aria-hidden="true" />
                    <p className="mt-3 text-slate-700 dark:text-slate-200">{t("Connecting this device…")}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-slate-100 dark:bg-slate-900 px-4 py-8">
            {scan.elements}
            {/* While the camera is open the card goes: the scanner is the
                screen, and a card peeking out round it read as a glitch. */}
            <div className={scan.scanning ? 'hidden' : CARD}>
                <div className="flex flex-col items-center text-center mb-5">
                    <div className="p-3 bg-accent/10 rounded-2xl mb-3">
                        <Smartphone className="w-7 h-7 text-accent-fg" aria-hidden="true" />
                    </div>
                    <h1 className="text-xl font-semibold text-slate-900 dark:text-white">{t("Connect this device")}</h1>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                        {t("Terramentor opens only on the computer it runs on until you connect another device.")}
                    </p>
                </div>

                {(pairing.error || scan.error) && (
                    <p role="alert" className="mb-4 text-sm text-red-600 dark:text-red-400">{pairing.error || scan.error}</p>
                )}

                <ol className="space-y-4">
                    <Way icon={<QrCode className="w-5 h-5" aria-hidden="true" />} title={t("At the computer")}>
                        {t("On the computer, open Terramentor: Settings → Data → Other devices → Show code. Then press Scan code.")}
                    </Way>
                </ol>
                <Button {...ACTION} variant="primary" className="mt-4" icon={<Camera className="w-4 h-4" aria-hidden="true" />} onClick={scan.start}>
                    {t("Scan code")}
                </Button>
                {tailscale && (
                    <>
                        <ol className="mt-6 space-y-4">
                            <Way icon={<Globe className="w-5 h-5" aria-hidden="true" />} title={t("Away from it")}>
                                {tailscale === 'other-account'
                                    ? t("This device reached the computer through Tailscale, but signed in to a different account. Sign in to Tailscale here with the computer's account, and this screen opens by itself.")
                                    : t("Sign in to Tailscale on this device with the same account as the computer. No password needed.")}
                            </Way>
                        </ol>
                        {/* The screen re-asks by itself every few seconds; this is
                            for whoever just signed in and wants to know now. */}
                        <Button {...ACTION} className="mt-4" busy={checking} icon={<RefreshCw className="w-4 h-4" aria-hidden="true" />} onClick={tryAgain}>
                            {t("I've signed in to Tailscale")}
                        </Button>
                    </>
                )}

                <div className="mt-5 flex flex-col items-center gap-1">
                    {!withCode && (
                        <Button variant="quiet" size="sm" onClick={() => setWithCode(true)}>
                            {t("Running it on a server with no screen? Use its setup code")}
                        </Button>
                    )}
                </div>
                {withCode && <SetupCodeForm recheckRef={recheckRef} />}
            </div>
        </div>
    );
}

/**
 * Scan code: the live camera where the browser allows it, otherwise straight
 * into the phone's camera app for a photo (one press, no sheet in between).
 */
function useScan(pairing: { claim: (code: string) => void }) {
    const [scanning, setScanning] = useState(false);
    const [error, setError] = useState('');
    const photo = usePhotoScan((code) => { setError(''); pairing.claim(code); }, setError);
    const start = () => {
        setError('');
        if (canScanLive()) setScanning(true);
        else photo.open();
    };
    const elements = (
        <>
            {photo.input}
            <QrScanner open={scanning} onClose={() => setScanning(false)} onCode={(code) => { setScanning(false); pairing.claim(code); }} />
        </>
    );
    return { start, scanning, error, elements };
}

/** One way in: an icon, its name, one sentence. */
function Way({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
    return (
        <li className="flex gap-3">
            <span className="mt-0.5 shrink-0 text-accent-fg">{icon}</span>
            <div className="min-w-0 flex-1">
                <p className="font-medium text-slate-900 dark:text-white">{title}</p>
                <p className="text-sm text-slate-600 dark:text-slate-300">{children}</p>
            </div>
        </li>
    );
}

/**
 * The first password, set from this device with the one-time code the server
 * prints in its log — for a server nobody can sit at (Docker). Whoever reached
 * an unlocked app first would otherwise choose its password.
 */
function SetupCodeForm({ recheckRef }: { recheckRef: RecheckRef }) {
    const { t } = useTranslation();
    const setupFromRemote = useStore(s => s.setupFromRemote);
    const [code, setCode] = useState('');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (busy) return;
        if (password.length < 6) return setError(t("Password must be at least 6 characters."));
        if (password !== confirm) return setError(t("Passwords do not match."));
        setBusy(true);
        setError('');
        try {
            await setupFromRemote(password, code);
        } catch (err: any) {
            setError(err?.message || t("Failed to set password."));
            // A password may have been set from elsewhere meanwhile.
            void recheckRef.current();
        } finally {
            setBusy(false);
        }
    };

    return (
        <form onSubmit={submit} className="mt-5 pt-5 border-t border-slate-200 dark:border-slate-700">
                <p className="font-medium text-slate-900 dark:text-white">{t("Set a password with the setup code")}</p>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5 mb-3">
                    {t("For a server you can't sit at. The password then opens the app from any device.")}
                </p>

                <label htmlFor="auth-setup-code" className={LABEL}>{t("Setup code")}</label>
                <TextInput
                    id="auth-setup-code"
                    size="lg"
                    autoFocus
                    autoComplete="one-time-code"
                    autoCapitalize="characters"
                    spellCheck={false}
                    value={code}
                    onChange={e => setCode(e.target.value)}
                    placeholder="XXXX-XXXX-XXXX"
                    className="font-mono"
                />
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    {t("Printed in the server's log when it starts. In Docker:")}{' '}
                    <code className="bg-slate-100 dark:bg-slate-700 px-1 rounded">docker compose logs app</code>
                </p>

                <label htmlFor="auth-new-password" className={`${LABEL} mt-4`}>{t("New password")}</label>
                <TextInput
                    id="auth-new-password"
                    size="lg"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                />
                <label htmlFor="auth-confirm-password" className={`${LABEL} mt-3`}>{t("Confirm password")}</label>
                <TextInput
                    id="auth-confirm-password"
                    size="lg"
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={e => setConfirm(e.target.value)}
                />

                {error && (
                    <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>
                )}

                <Button {...ACTION} type="submit" variant="primary" className="mt-5" busy={busy} disabled={!code.trim() || !password || !confirm}>
                    {busy ? t("Setting…") : t("Set password")}
                </Button>
        </form>
    );
}

function Login() {
    const { t } = useTranslation();
    const login = useStore(s => s.login);
    const recheckRef = useRecheck();
    // A QR code from Settings works here too: a connected device needs no password.
    const pairing = usePairing(recheckRef);
    const scan = useScan(pairing);
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (!password || busy) return;
        setBusy(true);
        setError('');
        try {
            await login(password);
        } catch (err: any) {
            setError(err?.message || 'Login failed');
            setPassword('');
            // The password may have been changed or removed while this form was
            // open — a wrong answer is the moment to find out, not to insist.
            void recheckRef.current();
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center bg-slate-100 dark:bg-slate-900 px-4">
            <form
                onSubmit={submit}
                className={CARD}
            >
                <div className="flex flex-col items-center text-center mb-6">
                    <div className="p-3 bg-accent/10 rounded-2xl mb-3">
                        <Lock className="w-7 h-7 text-accent-fg" />
                    </div>
                    <h1 className="text-xl font-semibold text-slate-900 dark:text-white">{t("Locked")}</h1>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                        {t("Enter your password to unlock this app.")}
                    </p>
                </div>

                <label htmlFor="auth-password" className="sr-only">{t("Password")}</label>
                <TextInput
                    id="auth-password"
                    size="lg"
                    type="password"
                    autoFocus
                    autoComplete="current-password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder={t("Password")}
                />

                {(error || pairing.error || scan.error) && (
                    <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error || pairing.error || scan.error}</p>
                )}

                <Button {...ACTION} type="submit" variant="primary" className="mt-5" busy={busy || pairing.busy} disabled={!password}>
                    {pairing.busy ? t("Connecting this device…") : busy ? t("Unlocking…") : t("Unlock")}
                </Button>

                <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">
                    {t("No password at hand? Scan a code from Settings → Data → Other devices on the computer.")}
                </p>
                <Button {...ACTION} type="button" className="mt-3" icon={<Camera className="w-4 h-4" aria-hidden="true" />} onClick={scan.start}>
                    {t("Scan code")}
                </Button>
            </form>
            {scan.elements}
        </div>
    );
}

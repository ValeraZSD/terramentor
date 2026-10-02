import { useEffect, useRef, useState, FormEvent } from 'react';
import { Lock, Loader2 } from 'lucide-react';
import { useStore } from '../store';
import { useTranslation } from 'react-i18next';

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
 * Full-screen login shown when a password gate is enabled and this device isn't
 * authenticated yet. Blocks the app until the correct password is entered. The
 * initial password is created in Settings → Security on the server's own
 * machine; from any other device, it is created here (RemoteSetup).
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

const FIELD = "w-full px-4 py-2.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-accent/60";
const SUBMIT = "mt-5 w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-accent text-white rounded-lg hover:bg-accent/90 disabled:opacity-50 transition-colors font-medium";

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
 * The first password, set from a device that is not the server's machine.
 *
 * An app with no password answers only its own machine (server/auth.js), so a
 * phone — or any browser reaching a container, whose requests always arrive
 * from outside it — lands here instead of on the data. The code is printed in
 * the server's log, which only whoever runs the server can read; without it,
 * whoever reached an unlocked app first would choose its password.
 */
function RemoteSetup() {
    const { t } = useTranslation();
    const setupFromRemote = useStore(s => s.setupFromRemote);
    const recheckRef = useRecheck();
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
        <div className="min-h-screen flex items-center justify-center bg-slate-100 dark:bg-slate-900 px-4">
            <form
                onSubmit={submit}
                className="w-full max-w-sm bg-white dark:bg-slate-800 rounded-2xl shadow-xl p-8"
            >
                <div className="flex flex-col items-center text-center mb-6">
                    <div className="p-3 bg-accent/10 rounded-2xl mb-3">
                        <Lock className="w-7 h-7 text-accent-fg" />
                    </div>
                    <h1 className="text-xl font-semibold text-slate-900 dark:text-white">{t("Set a password")}</h1>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                        {t("This app has no password yet, so it only opens on the computer it runs on. Set one to use it from this device.")}
                    </p>
                </div>

                <label htmlFor="auth-setup-code" className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1">{t("Setup code")}</label>
                <input
                    id="auth-setup-code"
                    autoFocus
                    autoComplete="one-time-code"
                    autoCapitalize="characters"
                    spellCheck={false}
                    value={code}
                    onChange={e => setCode(e.target.value)}
                    placeholder="XXXX-XXXX-XXXX"
                    className={`${FIELD} font-mono`}
                />
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    {t("Printed in the server's log when it starts. In Docker:")}{' '}
                    <code className="bg-slate-100 dark:bg-slate-700 px-1 rounded">docker compose logs app</code>
                </p>

                <label htmlFor="auth-new-password" className="block text-sm font-medium text-slate-700 dark:text-slate-200 mt-4 mb-1">{t("New password")}</label>
                <input
                    id="auth-new-password"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className={FIELD}
                />
                <label htmlFor="auth-confirm-password" className="block text-sm font-medium text-slate-700 dark:text-slate-200 mt-3 mb-1">{t("Confirm password")}</label>
                <input
                    id="auth-confirm-password"
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={e => setConfirm(e.target.value)}
                    className={FIELD}
                />

                {error && (
                    <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>
                )}

                <button type="submit" disabled={busy || !code.trim() || !password || !confirm} className={SUBMIT}>
                    {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> {t("Setting…")}</> : t("Set password")}
                </button>
            </form>
        </div>
    );
}

function Login() {
    const { t } = useTranslation();
    const login = useStore(s => s.login);
    const recheckRef = useRecheck();
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
                className="w-full max-w-sm bg-white dark:bg-slate-800 rounded-2xl shadow-xl p-8"
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
                <input
                    id="auth-password"
                    type="password"
                    autoFocus
                    autoComplete="current-password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder={t("Password")}
                    className={FIELD}
                />

                {error && (
                    <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>
                )}

                <button
                    type="submit"
                    disabled={busy || !password}
                    className={SUBMIT}
                >
                    {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> {t("Unlocking…")}</> : t("Unlock")}
                </button>

                <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">
                    {t("If you removed the password on another device, this unlocks on its own.")}
                </p>
            </form>
        </div>
    );
}

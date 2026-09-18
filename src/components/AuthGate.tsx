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
 * initial password is created in Settings → Security, not here.
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
    const { t } = useTranslation();
    const login = useStore(s => s.login);
    const recheckAuth = useStore(s => s.recheckAuth);
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
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
                    className="w-full px-4 py-2.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-accent/60"
                />

                {error && (
                    <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>
                )}

                <button
                    type="submit"
                    disabled={busy || !password}
                    className="mt-5 w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-accent text-white rounded-lg hover:bg-accent/90 disabled:opacity-50 transition-colors font-medium"
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

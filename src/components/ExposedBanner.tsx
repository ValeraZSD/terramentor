import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ShieldAlert } from 'lucide-react';
import { Button } from './ui/Button';
import { useStore } from '../store';

/**
 * A strip under the header while the server says it listens on more than this
 * computer and no password is set (`exposed` in GET /api/auth/status, from
 * `exposedWithoutPassword()` in server/auth.js). Nobody on this computer is
 * asked for anything then, but a device elsewhere on the network that reaches
 * the port is only kept out by the setup code and the device list, so the app
 * says so for as long as it is true, and offers the one fix.
 *
 * It has no close button on purpose: it describes the state of the server,
 * not a message to acknowledge, and it goes away by itself once a password is
 * set or the server is started on 127.0.0.1 again. Same shape as the strip in
 * update/UpdateNotice.tsx, in normal flow, so it never covers the tab rail.
 */
export default function ExposedBanner() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const exposed = useStore(s => s.authExposed);
    if (!exposed) return null;
    return (
        <div
            role="status"
            className="shrink-0 border-b px-3 sm:px-4 py-2 border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60"
        >
            <div className="flex flex-wrap items-center gap-2 sm:gap-3 text-sm text-slate-800 dark:text-slate-100">
                <ShieldAlert className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0" aria-hidden="true" />
                <p className="min-w-0 flex-1 basis-56">
                    {t("Other devices on your network can reach this app, and it has no password.")}
                </p>
                <Button size="sm" variant="primary" className="ml-auto" onClick={() => navigate('/settings#data')}>
                    {t("Set a password")}
                </Button>
            </div>
        </div>
    );
}

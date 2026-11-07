import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { api } from '../../api';
import { desktopApi } from '../../desktopApi';
import { useDesktop } from '../../hooks/useDesktop';
import { useStore } from '../../store';
import { Button } from '../ui/Button';
import DesktopQuitScreen from '../DesktopQuitScreen';
import { Strip } from './UpdateNotice';

const DISMISS_KEY = 'app_placement_notice_dismissed';

/**
 * macOS opened Terramentor where it was unzipped, so it runs a temporary
 * read-only copy of it (App Translocation; server/appPlacement.js). That copy
 * works, but it cannot update itself and is gone once it quits, so it cannot
 * start at sign-in either. The fix is the one every Mac app asks for: move it
 * into Applications. Said once, in the strip under the header: dismissing it
 * is remembered, and the update panel still says why it cannot install
 * (HowToUpdate in UpdateDialog.tsx).
 *
 * A bundle this account cannot write ('read-only') gets no strip: it may
 * already be in Applications, installed by another account, and the update
 * panel is where that matters.
 */
export default function AppPlacementNotice() {
    const { t } = useTranslation();
    const { status } = useDesktop();
    // A device in without the password reads the app and quits nothing.
    const controls = useStore(s => s.updateStatus?.controls);
    const placement = status?.appPlacement ?? null;
    const [dismissed, setDismissed] = useState<string | null | undefined>(undefined);
    const [quitting, setQuitting] = useState(false);

    useEffect(() => {
        if (placement !== 'translocated') return;
        api.getSettings()
            .then(s => setDismissed(typeof s[DISMISS_KEY] === 'string' ? s[DISMISS_KEY] : null))
            .catch(() => setDismissed(null));
    }, [placement]);

    // Only once the server has said this device may quit the app: before the
    // update status arrives, a phone over the network would be offered Quit.
    if (placement !== 'translocated' || controls !== true || dismissed === undefined || dismissed === placement) return null;

    const dismiss = async () => {
        setDismissed(placement);
        try { await api.setSetting(DISMISS_KEY, placement); } catch { /* shown again next time, nothing lost */ }
    };
    const quit = () => {
        setQuitting(true);
        desktopApi.quit().catch(() => { /* it is going away */ });
    };

    return (
        <Strip onClose={dismiss} closeLabel={t("Dismiss")}>
            {/* Beside the first line: on a phone the sentence runs to five. */}
            <Info className="w-5 h-5 text-accent-fg shrink-0 self-start" aria-hidden="true" />
            <p className="min-w-0 flex-1 basis-64">
                {t("macOS is running Terramentor from a temporary copy, so it cannot update itself or start when you sign in. Quit it, drag Terramentor into your Applications folder, and open it from there.")}
            </p>
            <Button size="sm" variant="neutral" className="ml-auto" onClick={quit}>{t("Quit now")}</Button>
            {quitting && <DesktopQuitScreen onStillRunning={() => setQuitting(false)} />}
        </Strip>
    );
}

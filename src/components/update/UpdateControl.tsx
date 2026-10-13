import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowDownCircle, RotateCw } from 'lucide-react';
import { Button, IconButton } from '../ui/Button';
import { useStore } from '../../store';
import UpdateDialog from './UpdateDialog';
import { updateView } from './updateView';

/**
 * The header's update button: absent until there is something to say, then
 * one quiet control that says it — "Update available", the download's
 * percentage, "Restart to update", or that the download failed. Every press
 * opens the same dialog. Below `md` it is the icon alone, so it costs the tab
 * rail one icon's width on a phone.
 *
 * While a download runs it re-reads the stored status once a second. That is a
 * local GET of a few hundred bytes, never the network.
 */
export default function UpdateControl() {
    const { t } = useTranslation();
    const status = useStore(s => s.updateStatus);
    const refresh = useStore(s => s.refreshUpdates);
    const downloadUpdate = useStore(s => s.downloadUpdate);
    const [open, setOpen] = useState(false);
    const view = updateView(status);
    // "Update available" on a copy that installs itself IS the download button —
    // one press, as in most apps; everything else opens the dialog.
    const press = () => (view.kind === 'available' && view.canInstall ? downloadUpdate() : setOpen(true));

    // Also right after an update, while the updater is still watching this
    // version start: its note ("Terramentor has been updated to …") lands a moment later.
    const trial = status?.install?.trial === true;
    useEffect(() => {
        if (view.kind !== 'downloading' && !trial) return;
        const id = setInterval(refresh, 1000);
        return () => clearInterval(id);
    }, [view.kind, trial, refresh]);

    // While the note says this version just failed to start here, the header
    // does not offer it again beside that note; Settings → About still can.
    const failedHere = view.kind === 'available' && status?.install?.result?.ok === false && status.install.result.failed === view.version;
    if (view.kind === 'none' || failedHere) return <UpdateDialog isOpen={open} onClose={() => setOpen(false)} />;

    const preparing = view.kind === 'downloading' && (view.checking || view.percent == null);
    const { icon, label, variant } = view.kind === 'ready'
        ? { icon: <RotateCw className="w-4 h-4" aria-hidden="true" />, label: t("Restart to update"), variant: 'primary' as const }
        : view.kind === 'downloading'
            ? {
                icon: <ProgressRing percent={view.percent} />,
                label: view.percent == null ? t("Preparing update")
                    : view.checking ? t("Preparing {{percent}}%", { percent: view.percent })
                        : t("Downloading {{percent}}%", { percent: view.percent }),
                variant: 'subtle' as const,
            }
            : view.kind === 'failed'
                ? { icon: <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />, label: t("Update failed"), variant: 'subtle' as const }
                // A down arrow: pressing it downloads. A release's number names
                // it; a nightly's is a date stamp too long for a header, so that
                // one just says an update is there.
                : { icon: <ArrowDownCircle className="w-4 h-4 text-accent-fg" aria-hidden="true" />, label: view.version.includes('-') ? t("Update available") : t("Update to {{version}}", { version: view.version }), variant: 'subtle' as const };
    // On screen while it counts, the number sits in a fixed slot (the label
    // above stays the button's name for a screen reader).
    const text = view.kind === 'downloading'
        ? (view.percent == null
            ? <>{t("Preparing")} <span className="inline-block w-[3.5ch] text-right" aria-hidden="true">…</span></>
            : <Counting word={preparing ? t("Preparing") : t("Downloading")} percent={view.percent} />)
        : label;

    return (
        <>
            <IconButton className="md:hidden" variant={variant} label={label} icon={icon} onClick={press} />
            <Button className="hidden md:inline-flex whitespace-nowrap" variant={variant} icon={icon} onClick={press} aria-label={label}>{text}</Button>
            <UpdateDialog isOpen={open} onClose={() => setOpen(false)} />
        </>
    );
}

/**
 * A 16px ring that fills with the download; spins while the size is unknown.
 *
 * The quarter turn that starts the arc at 12 o'clock is on the inner group,
 * never on the spinning element: Tailwind's spin only names its END (360°), so
 * on an element already turned −90° every turn ran −90° → 360° and then
 * snapped back a quarter, a visible jerk once a second.
 *
 * The fill eases over the second between two status reads, so it grows
 * steadily instead of in a step per read.
 */
function ProgressRing({ percent }: { percent: number | null }) {
    const r = 6.5, c = 2 * Math.PI * r;
    return (
        <svg viewBox="0 0 16 16" className={`w-4 h-4 ${percent == null ? 'motion-safe:animate-spin' : ''}`} aria-hidden="true">
            <g transform="rotate(-90 8 8)">
                <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2.5" className="stroke-slate-300 dark:stroke-slate-600" />
                <circle
                    cx="8" cy="8" r={r} fill="none" strokeWidth="2.5" strokeLinecap="round"
                    className="stroke-accent motion-safe:transition-[stroke-dashoffset] motion-safe:duration-1000 motion-safe:ease-linear"
                    strokeDasharray={c}
                    strokeDashoffset={c * (1 - (percent ?? 25) / 100)}
                />
            </g>
        </svg>
    );
}

/** "Preparing 7%": the number in a fixed-width slot of even-width digits, so
 *  the button does not grow and shrink by a digit as the count climbs. */
function Counting({ word, percent }: { word: string; percent: number }) {
    return (
        <>
            {word}{' '}
            <span className="inline-block w-[3.5ch] text-right tabular-nums">{percent}%</span>
        </>
    );
}

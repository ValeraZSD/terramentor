import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowDownCircle, Check, ExternalLink, PackageCheck, RotateCw } from 'lucide-react';
import { Button, IconButton } from '../ui/Button';
import { MenuItem, MenuPopover, menuTriggerKeys } from '../ui/Popover';
import { useStore } from '../../store';
import UpdateDialog from './UpdateDialog';
import { updateView } from './updateView';

/**
 * The header's update button: absent until there is something to say, then
 * one quiet control that says it — "Update available", the download's
 * percentage, "Restart to update", or that the download failed. Every press
 * opens the same dialog. Below `md` it is the icon alone, so it costs the tab
 * rail one icon's width on a phone. With nothing to offer, it can still say
 * that an update just went in (`UpdatedNote`).
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
    // Only while nothing newer is offered: beside "Update available" it is old
    // news, and two icons side by side on a phone.
    const updated = view.kind === 'none' && status?.install?.result?.ok;
    // The note arrives while the page is open (the updater writes it a moment
    // after this version starts), and a button appearing is silent to a screen
    // reader. So a status region stays mounted in every state and says it.
    const announce = (
        <span role="status" className="sr-only">
            {updated ? t("Terramentor has been updated to {{version}}.", { version: status?.install?.result?.to || '' }) : ''}
        </span>
    );
    if (view.kind === 'none' || failedHere) {
        return <>{announce}{updated && <UpdatedNote />}<UpdateDialog isOpen={open} onClose={() => setOpen(false)} /></>;
    }

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
            ? <Counting word={t("Preparing")} percent={null} />
            : <Counting word={preparing ? t("Preparing") : t("Downloading")} percent={view.percent} />)
        : label;

    return (
        <>
            {announce}
            <IconButton className="md:hidden" variant={variant} label={label} icon={icon} onClick={press} />
            <Button className="hidden md:inline-flex whitespace-nowrap" variant={variant} icon={icon} onClick={press} aria-label={label}>{text}</Button>
            <UpdateDialog isOpen={open} onClose={() => setOpen(false)} />
        </>
    );
}

/**
 * After an update that worked: "Updated" in the header, where the update
 * itself was offered, until "Got it" or the next launch (the server drops the
 * result when it starts): a fact that needs one glance, not a strip across the
 * page with a sentence at one edge and its controls at the other. The sentence
 * with the version, What's new and Got it are in its menu. Quiet, like Capture
 * beside it: it reports, where the update states above ask for a press. The
 * update has happened, so the last item acknowledges it; "Dismiss" and an X
 * read as waving something away.
 */
function UpdatedNote() {
    const { t } = useTranslation();
    const status = useStore(s => s.updateStatus);
    const dismiss = useStore(s => s.dismissUpdateResult);
    const [open, setOpen] = useState(false);
    // Two buttons, one per width, like the update button above: the menu
    // hangs from (and hands focus back to) whichever is on screen.
    const wide = useRef<HTMLButtonElement | null>(null);
    const narrow = useRef<HTMLButtonElement | null>(null);
    const anchor = useMemo(() => ({
        get current() { return wide.current?.offsetParent ? wide.current : narrow.current; },
    }), []);
    const result = status?.install?.result;
    if (!status || !result?.ok) return null;
    const version = result.to || '';
    const sentence = t("Terramentor has been updated to {{version}}.", { version });
    const releaseUrl = version ? `${status.repoUrl}/releases/tag/v${version}` : `${status.repoUrl}/releases`;
    // A package with a tick: "installed". A plain tick read as "done" beside
    // the phone header's other icons.
    const icon = <PackageCheck className="w-4 h-4 text-accent-fg" aria-hidden="true" />;
    const menu = { 'aria-haspopup': 'menu' as const, 'aria-expanded': open, onClick: () => setOpen(o => !o), onKeyDown: menuTriggerKeys(() => setOpen(true)) };
    // Reading the notes leaves the note: a link that did not open would take
    // them with it. Focus goes back to the button, as on Escape.
    const read = () => { setOpen(false); anchor.current?.focus(); };
    // Got it takes the button away, so focus moves to the header control
    // after it (Capture) rather than falling to the page.
    const done = () => {
        const here = anchor.current;
        const controls = here ? [...(here.closest('header') ?? document.body).querySelectorAll<HTMLElement>('button, a[href]')].filter(el => el.offsetParent) : [];
        const at = here ? controls.indexOf(here) : -1;
        (controls[at + 1] ?? controls[at - 1])?.focus();
        setOpen(false);
        void dismiss();
    };
    return (
        <>
            <IconButton ref={narrow} className="md:hidden" variant="quiet" label={sentence} icon={icon} {...menu} />
            <Button ref={wide} className="hidden md:inline-flex whitespace-nowrap" variant="quiet" icon={icon} aria-label={sentence} title={sentence} {...menu}>{t("Updated")}</Button>
            <MenuPopover open={open} onClose={() => setOpen(false)} anchorRef={anchor} label={t("Updated")} align="end">
                {/* The button already says this to a screen reader, and a menu
                    holds items only. Non-breaking hyphens: a nightly's number
                    broke at "1.3.0-". */}
                <p aria-hidden="true" className="px-3 pt-2 pb-1.5 max-w-xs text-sm text-slate-600 dark:text-slate-300 break-words">{t("Terramentor has been updated to {{version}}.", { version: version.replace(/-/g, '‑') })}</p>
                <MenuItem href={releaseUrl} onSelect={read} icon={<ExternalLink className="w-4 h-4" />}>{t("What's new")}</MenuItem>
                <MenuItem onSelect={done} icon={<Check className="w-4 h-4" />}>{t("Got it")}</MenuItem>
            </MenuPopover>
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

/** "Preparing 7%", or "Preparing…" before there is a number. ONE span: the
 *  button is a flex row with a gap, so a word and a number handed to it as
 *  siblings are two flex items with the icon's gap between them. The digits
 *  are even-width, so the button grows only when the count gains a digit
 *  (once, at 10%); a fixed slot right-aligned to hold "99%" kept the width
 *  still but left "2%" and the ellipsis floating away from their word. */
function Counting({ word, percent }: { word: string; percent: number | null }) {
    return (
        <span>
            {word}{percent == null ? '…' : <> <span className="tabular-nums">{percent}%</span></>}
        </span>
    );
}

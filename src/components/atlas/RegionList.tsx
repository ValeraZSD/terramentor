import { ReactNode, useEffect, useRef, useState } from 'react';
import { AtlasColorMode, AtlasRegion } from '../../types';
import { useStore } from '../../store';
import { ColourSurface, CourseHue, regionColor } from './atlasColors';
import { topicDotStatus } from './topicStatus';
import { ArrowUpRight, ChevronDown, Check, Pencil, RotateCcw, Sparkles, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, IconButton } from '../ui/Button';
import { TextInput } from '../ui/Field';
import { useNumberFormat } from '../../hooks/useNumberFormat';

interface Props {
    regions: AtlasRegion[];
    selectedId: number | null;
    onSelect: (id: number | null) => void;
    dark: boolean;
    /** The app accent hex — the ramp is derived from it. */
    accent: string;
    /** What the swatch means. It must agree with the map or the list stops
     *  being the same information as text. */
    colorMode: AtlasColorMode;
    /** The map's course hues, so the swatch is the colour actually drawn. */
    hues: Map<number, CourseHue>;
    /** Which surface is on screen: Terra paints its own ladder. */
    surface: ColourSurface;
    /** Name a region by hand. */
    onRename: (region: AtlasRegion, label: string) => Promise<void>;
    /** Hand it back to the map: the medoid now, a model name on the next sweep. */
    onResetName: (region: AtlasRegion) => Promise<void>;
}

const STATUS_DOT: Record<string, string> = {
    completed: 'bg-emerald-500',
    in_progress: 'bg-amber-500',
    skipped: 'bg-slate-400',
    not_started: 'bg-slate-300 dark:bg-slate-600',
};

/**
 * Name a region by hand.
 *
 * Sits inside the expanded region rather than beside the name in the collapsed
 * row: renaming is deliberate and rare, and an edit control on all 115 rows is
 * 115 things to mis-tap while scanning. Not hover-revealed either — a phone
 * cannot hover, and this app has been bitten by that in three other places.
 *
 * At rest it is one button at the end of the region's course chips (`children`);
 * where the name came from is no longer spelled out in three sentences. The one
 * fact a reader needs about it — that the name can be changed — is the button.
 */
function RegionName({ region, onRename, onResetName, children }: {
    region: AtlasRegion;
    onRename: (region: AtlasRegion, label: string) => Promise<void>;
    onResetName: (region: AtlasRegion) => Promise<void>;
    children: ReactNode;
}) {
    const { t: tr } = useTranslation();
    const [editing, setEditing] = useState(false);
    const [value, setValue] = useState(region.label);
    const [busy, setBusy] = useState(false);
    const inputRef = useRef<HTMLInputElement | null>(null);

    // Opening the editor on a DIFFERENT region must not carry the last one's
    // draft across — the rows are recycled as the list filters and scrolls.
    useEffect(() => { setValue(region.label); setEditing(false); }, [region.signature, region.label]);
    useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

    const commit = async () => {
        const next = value.trim();
        if (!next || next === region.label) { setEditing(false); return; }
        setBusy(true);
        try { await onRename(region, next); setEditing(false); } finally { setBusy(false); }
    };

    const reset = async () => {
        setBusy(true);
        try { await onResetName(region); setEditing(false); } finally { setBusy(false); }
    };

    if (editing) {
        return (
            <div className="py-2">
                {/* The editor is built from the control vocabulary rather
                    than hand-sized here: four shapes were invented in this one
                    row, and the odd one out was the reset below — a text-only
                    button, which reads as a control only while the pointer is
                    on it and is a paragraph the rest of the time. */}
                <div className="flex items-center gap-2">
                    <TextInput
                        ref={inputRef}
                        value={value}
                        autoFocus
                        maxLength={60}
                        onChange={e => setValue(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Enter') { e.preventDefault(); void commit(); }
                            // Escape belongs to the editor while it is open, or it
                            // would close the whole map's full-screen mode instead.
                            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(false); setValue(region.label); }
                        }}
                        aria-label={tr("Region name")}
                        className="min-w-0 flex-1"
                    />
                    <IconButton
                        variant="primary"
                        onClick={() => void commit()}
                        busy={busy}
                        label={tr("Save name")}
                        icon={<Check className="w-4 h-4" aria-hidden="true" />}
                    />
                    <IconButton
                        onClick={() => { setEditing(false); setValue(region.label); }}
                        label={tr("Cancel")}
                        icon={<X className="w-4 h-4" aria-hidden="true" />}
                    />
                </div>
                {region.labelSource !== 'medoid' && (
                    // Full width, because it is the only thing on its row and a
                    // button that stops short of the field above it reads as
                    // something that got cut off. Filled at rest (`subtle`), so
                    // it is a button before you touch it.
                    <Button
                        className="mt-2"
                        variant="subtle"
                        block
                        busy={busy}
                        onClick={() => void reset()}
                        // The panel is 352px wide and a medoid title can be
                        // sixty characters, so the label truncates — the title
                        // is what gets the rest of it back.
                        title={`${tr("Use the automatic name")}${region.medoidLabel ? ` (“${region.medoidLabel}”)` : ''}`}
                        icon={<RotateCcw className="w-4 h-4 shrink-0" aria-hidden="true" />}
                    >
                        <span className="min-w-0 truncate">
                            {tr("Use the automatic name")}{region.medoidLabel ? ` (“${region.medoidLabel}”)` : ''}
                        </span>
                    </Button>
                )}
            </div>
        );
    }

    return (
        <div className="flex items-start justify-between gap-2 py-2">
            <div className="min-w-0 flex flex-wrap gap-1.5 pt-1">{children}</div>
            <Button
                variant="quiet"
                size="sm"
                className="shrink-0"
                icon={<Pencil className="w-3.5 h-3.5" aria-hidden="true" />}
                onClick={() => setEditing(true)}
            >
                {tr("Rename")}
            </Button>
        </div>
    );
}

/**
 * Whether the learner has set foot in a region: any topic in it started or
 * proven. The list is split on this — the land they know, then the rest of the
 * map.
 */
const explored = (r: AtlasRegion) => r.mastery.proven + r.mastery.learning > 0;

/**
 * Every region, in text — the map's readable twin.
 *
 * This is not a fallback or an alternate mode behind a toggle: a map that
 * encodes a quantity in colour is unreadable to a chunk of its audience and on
 * a monochrome print-out, so the numbers have to exist somewhere in words, and
 * something that only exists when you go looking for it does not count. It also
 * happens to be the better interface for the thing people most often want —
 * finding one topic — because a name can be scanned and a bubble cannot.
 *
 * Two groups, because the atlas answers two questions and a list sorted by size
 * answers neither: EXPLORED first, most proven at the top (how much do I know,
 * and where — opening one lists the untouched topics right beside the proven
 * ones), then NOT STARTED YET by size (what is out there). The group is named
 * in the words the rest of the app uses for a topic nobody has opened.
 *
 * Each row is one line: the swatch the map paints the region in (which quietly
 * makes this list the map's key), the name, and the count — proven of all in
 * explored land, the size alone where nothing is proven to count.
 */
export default function RegionList({ regions, selectedId, onSelect, dark, accent, colorMode, hues, surface, onRename, onResetName }: Props) {
    const { t: tr } = useTranslation();
    const num = useNumberFormat();
    const openProjectNode = useStore(s => s.openProjectNode);

    if (regions.length === 0) {
        return <p className="text-sm text-slate-500 dark:text-slate-400 px-3 py-2">{tr("No regions to show.")}</p>;
    }

    const known = regions.filter(explored).sort((a, b) =>
        b.mastery.proven - a.mastery.proven || b.mastery.learning - a.mastery.learning || b.size - a.size);
    const unknown = regions.filter(r => !explored(r));

    const row = (region: AtlasRegion, inKnown: boolean) => {
        const open = region.id === selectedId;
        return (
            <li key={region.id}>
                <button
                    data-row
                    onClick={() => onSelect(open ? null : region.id)}
                    aria-expanded={open}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 min-h-11 rounded-lg text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${open
                        ? 'bg-accent/10'
                        : 'can-hover:hover:bg-slate-100 dark:can-hover:hover:bg-slate-700/60'}`}
                >
                    <span
                        aria-hidden="true"
                        className="w-3 h-3 rounded shrink-0 ring-1 ring-black/10 dark:ring-white/15"
                        style={{ background: regionColor(region, colorMode, hues, accent, dark, surface) }}
                    />
                    <span className={`min-w-0 flex-1 truncate text-sm text-slate-800 dark:text-slate-100 ${open ? 'font-medium' : ''}`}>
                        {region.label}
                    </span>
                    <span aria-hidden="true" className="shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400">
                        {inKnown ? `${num(region.mastery.proven)}/${num(region.size)}` : num(region.size)}
                    </span>
                    <span className="sr-only">
                        {inKnown
                            ? tr("{{proven}} of {{count}} topics proven", { proven: num(region.mastery.proven), count: region.size })
                            : tr("{{count}} topics", { count: region.size })}
                    </span>
                    <ChevronDown
                        className={`w-4 h-4 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
                        aria-hidden="true"
                    />
                </button>

                {open && (
                    <div className="mx-1 mb-2 px-2 pb-1 rounded-b-lg border-l-2 border-accent/40">
                        <RegionName region={region} onRename={onRename} onResetName={onResetName}>
                            {region.projects.map(p => (
                                <span
                                    key={p.id}
                                    className="inline-flex max-w-full items-center gap-1.5 px-2 py-0.5 rounded-full text-2xs font-medium bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200"
                                >
                                    <span
                                        aria-hidden="true"
                                        className="w-2 h-2 shrink-0 rounded-full"
                                        style={{ background: p.color || '#94a3b8' }}
                                    />
                                    <span className="truncate">{p.name}</span>
                                    <span className="shrink-0 tabular-nums">{num(p.count)}</span>
                                </span>
                            ))}
                        </RegionName>
                        <ul>
                            {region.topics.map(t => (
                                <li key={t.id}>
                                    <button
                                        data-row
                                        onClick={() => openProjectNode(t.projectId, t.id)}
                                        className="group w-full flex items-center gap-2 px-2 py-1.5 min-h-11 rounded-lg text-left can-hover:hover:bg-slate-100 dark:can-hover:hover:bg-slate-700/60 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                                    >
                                        <span
                                            aria-hidden="true"
                                            className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[topicDotStatus(t)] || STATUS_DOT.not_started}`}
                                        />
                                        <span className="min-w-0 flex-1">
                                            <span className="block text-sm text-slate-700 dark:text-slate-200 truncate">
                                                {t.title}
                                                {t.transferred && (
                                                    <>
                                                        <Sparkles className="inline w-3 h-3 ml-1 -mt-0.5 text-accent-fg" aria-hidden="true" />
                                                        <span className="sr-only">{tr("started with a head start from another project")}</span>
                                                    </>
                                                )}
                                            </span>
                                            <span className="block text-2xs text-slate-500 dark:text-slate-400 truncate">
                                                {t.projectName}
                                            </span>
                                        </span>
                                        <ArrowUpRight className="w-3.5 h-3.5 shrink-0 text-slate-400 dark:text-slate-500 can-hover:group-hover:text-accent-fg group-focus-visible:text-accent-fg" aria-hidden="true" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </li>
        );
    };

    const group = (title: string, list: AtlasRegion[], inKnown: boolean) => list.length > 0 && (
        <div>
            <h3 className="sticky top-0 z-[1] flex items-baseline justify-between gap-2 px-3 pt-3 pb-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400 bg-white dark:bg-slate-800">
                <span>{title}</span>
                <span className="tabular-nums font-normal">{num(list.length)}</span>
            </h3>
            <ul>{list.map(r => row(r, inKnown))}</ul>
        </div>
    );

    return (
        <div>
            {group(tr("Explored"), known, true)}
            {group(tr("Not started yet"), unknown, false)}
        </div>
    );
}

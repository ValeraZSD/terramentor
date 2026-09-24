import { useEffect, useRef, useState } from 'react';
import { AtlasColorMode, AtlasRegion } from '../../types';
import { useStore } from '../../store';
import { CourseHue, regionColor } from './atlasColors';
import { ArrowUpRight, ChevronDown, ChevronRight, Check, Pencil, RotateCcw, Sparkles, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, IconButton } from '../ui/Button';
import { TextInput } from '../ui/Field';

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
 * Where a name came from, in the words a reader needs to decide what to do
 * about it. This is the one piece of provenance the map cannot draw: two names
 * look identical on a bubble, and only one of them is worth arguing with a
 * model about. `medoid` deliberately explains itself rather than being labelled
 * — "read off its most central topic" IS the complaint people arrive with.
 */
const SOURCE_NOTE: Record<AtlasRegion['labelSource'], string> = {
    user: 'Your name for this region.',
    model: 'Written for this region from all of its topics.',
    medoid: 'Taken from its most central topic — no name has been written for it yet.',
};

/**
 * Name a region by hand.
 *
 * Sits inside the expanded region rather than beside the name in the collapsed
 * row: renaming is deliberate and rare, and an edit control on all 115 rows is
 * 115 things to mis-tap while scanning. Not hover-revealed either — a phone
 * cannot hover, and this app has been bitten by that in three other places.
 */
function RegionName({ region, onRename, onResetName }: {
    region: AtlasRegion;
    onRename: (region: AtlasRegion, label: string) => Promise<void>;
    onResetName: (region: AtlasRegion) => Promise<void>;
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
            <div className="py-2.5 border-b border-slate-100 dark:border-slate-700/60">
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
                        // The panel is 340px wide and a medoid title can be
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
        <div className="flex items-start justify-between gap-2 py-2.5 border-b border-slate-100 dark:border-slate-700/60">
            <p className="min-w-0 text-xs text-slate-500 dark:text-slate-400">
                {SOURCE_NOTE[region.labelSource]}
                {region.labelSource !== 'medoid' && region.medoidLabel && region.medoidLabel !== region.label && (
                    <span className="block truncate">{tr("Its most central topic is “{{medoidLabel}}”.", { medoidLabel: region.medoidLabel })}</span>
                )}
            </p>
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
 * Every region, in text — the map's readable twin.
 *
 * This is not a fallback or an alternate mode behind a toggle: a map that
 * encodes a quantity in colour is unreadable to a chunk of its audience and on
 * a monochrome print-out, so the numbers have to exist somewhere in words, and
 * something that only exists when you go looking for it does not count. It also
 * happens to be the better interface for the thing people most often want —
 * finding one topic — because a name can be scanned and a bubble cannot.
 *
 * The swatch is the same ramp step the map draws, which quietly makes this list
 * the map's legend key as well.
 */
export default function RegionList({ regions, selectedId, onSelect, dark, accent, colorMode, hues, onRename, onResetName }: Props) {
    const { t: tr } = useTranslation();
    const openProjectNode = useStore(s => s.openProjectNode);

    if (regions.length === 0) {
        return <p className="text-sm text-slate-500 dark:text-slate-400 px-1">{tr("No regions to show.")}</p>;
    }

    return (
        <ul className="space-y-1.5">
            {regions.map(region => {
                const open = region.id === selectedId;
                const pct = region.size ? Math.round((region.mastery.proven / region.size) * 100) : 0;
                return (
                    <li key={region.id} className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-hidden">
                        <button
                            onClick={() => onSelect(open ? null : region.id)}
                            aria-expanded={open}
                            className={`w-full flex items-center gap-2.5 px-3 py-2.5 min-h-11 text-left transition ${open ? 'bg-accent/5' : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'}`}
                        >
                            {open
                                ? <ChevronDown className="w-4 h-4 shrink-0 text-slate-400" aria-hidden="true" />
                                : <ChevronRight className="w-4 h-4 shrink-0 text-slate-400" aria-hidden="true" />}
                            <span
                                aria-hidden="true"
                                className="w-3 h-3 rounded-full shrink-0 ring-1 ring-black/10 dark:ring-white/10"
                                style={{ background: regionColor(region, colorMode, hues, accent, dark) }}
                            />
                            <span className="min-w-0 flex-1">
                                <span className="block text-sm font-medium text-slate-900 dark:text-white truncate">
                                    {region.label}
                                </span>
                                <span className="block text-xs text-slate-500 dark:text-slate-400 truncate">
                                    {tr("{{count}} topics", { count: region.size })} {tr("· {{pct}}% proven", { pct })}
                                    {region.crossProject && ` ${tr("· {{count}} projects", { count: region.projects.length })}`}
                                </span>
                            </span>
                        </button>

                        {open && (
                            <div className="px-3 pb-3 border-t border-slate-100 dark:border-slate-700/60">
                                <RegionName region={region} onRename={onRename} onResetName={onResetName} />
                                <div className="flex flex-wrap gap-1.5 py-2.5">
                                    {region.projects.map(p => (
                                        <span
                                            key={p.id}
                                            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200"
                                        >
                                            <span
                                                aria-hidden="true"
                                                className="w-2 h-2 rounded-full"
                                                style={{ background: p.color || '#94a3b8' }}
                                            />
                                            {p.name} · {p.count}
                                        </span>
                                    ))}
                                </div>
                                <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">
                                    {tr("{{proven}} proven · {{learning}} in progress · {{untouched}} untouched", { proven: region.mastery.proven, learning: region.mastery.learning, untouched: region.mastery.untouched })}
                                </p>
                                <ul className="space-y-0.5">
                                    {region.topics.map(t => (
                                        <li key={t.id}>
                                            <button
                                                onClick={() => openProjectNode(t.projectId, t.id)}
                                                className="group w-full flex items-center gap-2 px-2 py-2 min-h-11 rounded-lg text-left hover:bg-slate-50 dark:hover:bg-slate-700/50 transition"
                                            >
                                                <span
                                                    aria-hidden="true"
                                                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[t.status] || STATUS_DOT.not_started}`}
                                                />
                                                <span className="min-w-0 flex-1">
                                                    <span className="block text-sm text-slate-700 dark:text-slate-200 truncate">
                                                        {t.title}
                                                        {t.transferred && (
                                                            <Sparkles
                                                                className="inline w-3 h-3 ml-1 -mt-0.5 text-accent-fg"
                                                                aria-label={tr("started with a head start from another project")}
                                                            />
                                                        )}
                                                    </span>
                                                    <span className="block text-[11px] text-slate-500 dark:text-slate-400 truncate">
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
            })}
        </ul>
    );
}

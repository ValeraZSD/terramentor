import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Check, ChevronDown, RefreshCw, Search, Trash2 } from 'lucide-react';
import type { OllamaModel } from '../api';
import {
    MODEL_SORTS, TIER_TONE, filterModels, formatModelSize, sortModels, tierForModel,
} from '../utils/modelTiers';
// A type in a value-import list survives esbuild's transform as a real named
// import, and the module then fails to link at runtime with the neighbouring
// const "not defined". Type imports stay separate.
import type { ModelSort } from '../utils/modelTiers';
import { FIELD_BASE, FIELD_SIZE, FOCUS_RING, cx } from './ui/vocabulary';
import { IconButton } from './ui/Button';

interface Props {
    /** The chosen model id. `''` means "inherit", when `inherit` is given. */
    value: string;
    onChange: (model: string) => void;
    models: OllamaModel[];
    /** Accessible name — every picker in the app names what it is choosing FOR. */
    label: string;
    /** Offered as the first row and as the empty state. Omit to require a model. */
    inherit?: { label: string; detail?: string };
    /** Shown in the trigger when there is no value and no `inherit`. */
    placeholder?: string;
    loading?: boolean;
    onRefresh?: () => void;
    /** Ollama only: removing the model from disk. Never offered for a remote list. */
    onDelete?: (model: string) => void;
    /** A badge rendered inside the trigger's right end (e.g. "connected"). */
    status?: ReactNode;
    disabled?: boolean;
    id?: string;
    className?: string;
}

/** Above this many rows the list is capped and the filter does the work. */
const MAX_ROWS = 150;
/** Below this many models, sorting is noise — there is nothing to order. */
const SORT_THRESHOLD = 8;

/**
 * ONE way to choose a model, everywhere a model is chosen.
 *
 * Before this there were four, for the same job on the same page: the chat
 * model was a free-text box plus a 437-row list in a 256px scroll box where
 * every row said "Click to use"; the vision model and the region-naming model
 * were a `<select>` under Ollama and a bare `<input>` under an OpenAI-compatible
 * endpoint — the SAME setting changing shape with an unrelated setting; and the
 * embedding model was a text box that never listed anything at all. Four
 * mechanisms, four keyboard behaviours, and no way to learn one from another.
 *
 * It is a combobox rather than a `<select>` because both halves are real: the
 * endpoint's list is worth browsing, and any id the endpoint accepts must be
 * typeable (llama-swap aliases, a model added since the last refresh). So the
 * filter box IS the custom-value box — type an id nothing matches and the first
 * row becomes "Use <id>".
 *
 * Keyboard, which is the point of not hand-rolling this a fifth time:
 *   Tab            reaches the trigger, once, wherever it is used
 *   Enter/Space/↓  opens; any printable key opens and starts filtering
 *   ↑ ↓            move the active row (wrapping), Home/End jump to the ends
 *   Enter          takes the active row
 *   Esc            closes, changes nothing, and puts focus back on the trigger
 *   Tab (open)     closes without choosing, then moves on normally
 * A click outside closes it the same way. The active row is always scrolled
 * into view, so ↓ never walks off the bottom of the list invisibly.
 */
export default function ModelPicker({
    value, onChange, models, label, inherit, placeholder, loading, onRefresh, onDelete,
    status, disabled, id, className,
}: Props) {
    const { t } = useTranslation();
    const tr = t as (s: string, o?: Record<string, unknown>) => string;
    const reactId = useId();
    const listId = `${id || reactId}-list`;

    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [sort, setSort] = useState<ModelSort>('name');
    const [active, setActive] = useState(0);
    const [rect, setRect] = useState<{ top: number; left: number; width: number; drop: 'down' | 'up'; max: number } | null>(null);

    const triggerRef = useRef<HTMLButtonElement>(null);
    const popRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const listRef = useRef<HTMLDivElement>(null);

    // Only offer an order the data can support: an OpenAI-compatible /v1/models
    // reports no size and often no date, and an inert sort makes the reader
    // think the LIST is broken rather than that the field is absent.
    const sorts = useMemo(() => MODEL_SORTS.filter(o =>
        o.id === 'name'
        || (o.id === 'size' && models.some(m => m.size > 0))
        || (o.id === 'date' && models.some(m => m.modified_at))), [models]);
    useEffect(() => { if (!sorts.some(o => o.id === sort)) setSort('name'); }, [sorts, sort]);

    const matches = useMemo(() => sortModels(filterModels(models, query), sort), [models, query, sort]);
    const shown = matches.slice(0, MAX_ROWS);
    const typed = query.trim();
    const custom = typed && !models.some(m => m.name === typed) ? typed : '';

    /** Every selectable row, in render order — one list so the keyboard has one index. */
    const rows = useMemo(() => {
        const out: { key: string; model: string; kind: 'custom' | 'inherit' | 'model'; meta?: OllamaModel }[] = [];
        if (custom) out.push({ key: `custom:${custom}`, model: custom, kind: 'custom' });
        if (inherit && !typed) out.push({ key: 'inherit', model: '', kind: 'inherit' });
        for (const m of shown) out.push({ key: m.name, model: m.name, kind: 'model', meta: m });
        return out;
    }, [custom, inherit, typed, shown]);

    const close = useCallback((refocus = true) => {
        setOpen(false);
        setQuery('');
        if (refocus) triggerRef.current?.focus();
    }, []);

    const commit = (model: string) => {
        onChange(model);
        close();
    };

    const place = useCallback(() => {
        const el = triggerRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const below = window.innerHeight - r.bottom - 12;
        const above = r.top - 12;
        // Drop upward only when below genuinely cannot hold a usable list.
        const drop = below < 260 && above > below ? 'up' : 'down';
        setRect({
            top: drop === 'down' ? r.bottom + 6 : r.top - 6,
            left: r.left,
            width: Math.max(r.width, 300),
            drop,
            max: Math.min(420, (drop === 'down' ? below : above) - 8),
        });
    }, []);

    useLayoutEffect(() => { if (open) place(); }, [open, place]);
    useEffect(() => {
        if (!open) return;
        const onScroll = () => place();
        // `true` — a scroll inside any ancestor moves the trigger too.
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onScroll);
        return () => {
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', onScroll);
        };
    }, [open, place]);

    // Opening lands on the current value, not on row 0: ↓ from a 437-row list
    // should continue from where you are.
    useEffect(() => {
        if (!open) return;
        const at = rows.findIndex(r => r.model === value);
        setActive(at >= 0 ? at : 0);
    }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

    /**
     * Focus the filter the moment it EXISTS, not the moment `open` flips.
     *
     * The popup renders only once `place()` has measured the trigger, so on the
     * render that sets `open` the input is still null — an effect (or a rAF from
     * one) fired against nothing, focus stayed on the trigger, and every key
     * went to the trigger's handler instead of the list's: arrows did nothing,
     * Escape did nothing, and the whole keyboard story silently did not exist.
     * A callback ref runs exactly when the node mounts.
     */
    const attachInput = useCallback((el: HTMLInputElement | null) => {
        inputRef.current = el;
        if (el) el.focus();
    }, []);

    useEffect(() => { if (active >= rows.length) setActive(Math.max(0, rows.length - 1)); }, [rows.length, active]);

    // Keep the active row visible without scrolling the page behind the popup.
    useEffect(() => {
        if (!open) return;
        listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
            ?.scrollIntoView({ block: 'nearest' });
    }, [active, open]);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            const target = e.target as Node;
            if (popRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
            close(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [open, close]);

    const onTriggerKey = (e: React.KeyboardEvent) => {
        // Enter and Space are deliberately NOT handled: the trigger is a real
        // <button>, so the browser already turns them into a click, and opening
        // here as well toggled it open and straight back shut.
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
        } else if (e.key === 'Escape' && open) {
            // A safety net: if focus is on the trigger while the list is open,
            // Escape must still shut it rather than fall through to the page.
            e.preventDefault();
            close();
        } else if (e.key.length === 1 && e.key !== ' ' && !e.metaKey && !e.ctrlKey && !e.altKey) {
            // Type-to-open, the way a native select behaves — except here the
            // character starts a FILTER rather than jumping to a first letter,
            // because these names are namespaced ("google/gemma-…"). Space is
            // excluded: it is the button's own activation key, not a query.
            setOpen(true);
            setQuery(e.key);
            e.preventDefault();
        }
    };

    const onListKey = (e: React.KeyboardEvent) => {
        const n = rows.length;
        switch (e.key) {
            case 'ArrowDown': e.preventDefault(); if (n) setActive((active + 1) % n); break;
            case 'ArrowUp': e.preventDefault(); if (n) setActive((active - 1 + n) % n); break;
            case 'Home': e.preventDefault(); setActive(0); break;
            case 'End': e.preventDefault(); setActive(Math.max(0, n - 1)); break;
            case 'PageDown': e.preventDefault(); setActive(Math.min(n - 1, active + 8)); break;
            case 'PageUp': e.preventDefault(); setActive(Math.max(0, active - 8)); break;
            case 'Enter': e.preventDefault(); if (rows[active]) commit(rows[active].model); break;
            case 'Escape': e.preventDefault(); close(); break;
            case 'Tab': close(false); break;
        }
    };

    const selectedTier = value ? tierForModel(value) : null;

    return (
        <div className={cx('min-w-0', className)}>
            <button
                ref={triggerRef}
                id={id}
                type="button"
                aria-expanded={open}
                aria-controls={open ? listId : undefined}
                aria-haspopup="listbox"
                aria-label={label}
                disabled={disabled}
                onClick={() => setOpen(o => !o)}
                onKeyDown={onTriggerKey}
                className={cx(
                    'w-full', FIELD_BASE, FIELD_SIZE.md,
                    'flex items-center gap-2 text-left cursor-pointer',
                    open && 'ring-2 ring-accent border-accent',
                )}
            >
                <span className={cx('flex-1 min-w-0 truncate', !value && 'text-slate-500 dark:text-slate-400')}>
                    {value || inherit?.label || placeholder || tr("Choose a model")}
                    {!value && inherit?.detail && (
                        <span className="text-slate-500 dark:text-slate-400"> ({inherit.detail})</span>
                    )}
                </span>
                {selectedTier && (
                    <span className={cx('shrink-0 hidden sm:inline-block px-1.5 py-0.5 rounded border text-[11px] font-medium', TIER_TONE[selectedTier.tone])}>
                        {tr(selectedTier.label)}
                    </span>
                )}
                {status}
                <ChevronDown className={cx('w-4 h-4 shrink-0 text-slate-500 dark:text-slate-400 transition-transform', open && 'rotate-180')} aria-hidden="true" />
            </button>

            {open && rect && createPortal(
                <div
                    ref={popRef}
                    // Fixed + portalled: a popup written inside the panel is clipped
                    // by the first `overflow-hidden` ancestor, and any ancestor with
                    // a transform/filter becomes its containing block.
                    style={{
                        position: 'fixed',
                        left: rect.left,
                        width: rect.width,
                        ...(rect.drop === 'down' ? { top: rect.top } : { bottom: window.innerHeight - rect.top }),
                        maxHeight: rect.max,
                    }}
                    className="z-[70] flex flex-col overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-xl"
                >
                    <div className="flex items-center gap-2 p-2 border-b border-slate-100 dark:border-slate-700/70">
                        <div className="relative flex-1 min-w-0">
                            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 dark:text-slate-400 pointer-events-none" aria-hidden="true" />
                            <input
                                ref={attachInput}
                                type="text"
                                role="combobox"
                                aria-expanded="true"
                                autoComplete="off"
                                value={query}
                                onChange={e => { setQuery(e.target.value); setActive(0); }}
                                onKeyDown={onListKey}
                                aria-label={tr("Filter models, or type a model id")}
                                aria-controls={listId}
                                aria-activedescendant={rows[active] ? `${listId}-${active}` : undefined}
                                placeholder={tr("Filter, or type any model id")}
                                className={cx('w-full', FIELD_BASE, FIELD_SIZE.md, 'pl-8')}
                            />
                        </div>
                        {models.length >= SORT_THRESHOLD && sorts.length > 1 && (
                            <select
                                value={sort}
                                onChange={e => setSort(e.target.value as ModelSort)}
                                aria-label={tr("Sort models")}
                                className={cx(FIELD_BASE, FIELD_SIZE.md, 'shrink-0 cursor-pointer')}
                            >
                                {sorts.map(o => <option key={o.id} value={o.id}>{tr(o.label)}</option>)}
                            </select>
                        )}
                        {onRefresh && (
                            <IconButton
                                size="md"
                                variant="subtle"
                                label={tr("Refresh the list")}
                                busy={loading}
                                onClick={() => onRefresh()}
                                icon={<RefreshCw className="w-4 h-4" aria-hidden="true" />}
                            />
                        )}
                    </div>

                    <div ref={listRef} id={listId} role="listbox" aria-label={label} className="min-h-0 flex-1 overflow-y-auto p-1">
                        {rows.length === 0 && (
                            <p className="px-3 py-6 text-center text-sm text-slate-500 dark:text-slate-400">
                                {models.length === 0
                                    ? tr("This endpoint listed no models — type the id it expects.")
                                    : tr("Nothing matches. Type the full id to use it anyway.")}
                            </p>
                        )}
                        {rows.map((row, i) => {
                            const isActive = i === active;
                            const isValue = row.model === value;
                            const tier = row.kind === 'model' ? tierForModel(row.model) : null;
                            return (
                                <div
                                    key={row.key}
                                    id={`${listId}-${i}`}
                                    role="option"
                                    aria-selected={isValue}
                                    data-active={isActive}
                                    onMouseEnter={() => setActive(i)}
                                    onClick={() => commit(row.model)}
                                    className={cx(
                                        'group flex items-center gap-2.5 px-2.5 h-10 touch:h-11 rounded-lg cursor-pointer',
                                        isActive ? 'bg-accent/10' : '',
                                    )}
                                >
                                    {/* Two fixed gutters, always present and only ever
                                        faded in or out: the tick says which model is
                                        CHOSEN, the arrow says which row Enter would
                                        take. Marking the active row with a trailing
                                        glyph instead pushed the size and tier badges
                                        sideways under the pointer. */}
                                    <span className="shrink-0 flex items-center gap-1">
                                        <Check className={cx('w-4 h-4', isValue ? 'text-accent-fg' : 'opacity-0')} aria-hidden="true" />
                                        <ArrowRight className={cx('w-3.5 h-3.5 text-slate-400 dark:text-slate-500', isActive ? '' : 'opacity-0')} aria-hidden="true" />
                                    </span>
                                    <span className="flex-1 min-w-0">
                                        <span className="block truncate text-sm text-slate-900 dark:text-white">
                                            {row.kind === 'custom'
                                                ? <>{tr("Use")} <span className="font-medium">{row.model}</span></>
                                                : row.kind === 'inherit' ? inherit!.label : row.model}
                                        </span>
                                        {(row.kind === 'inherit' && inherit?.detail) && (
                                            <span className="block truncate text-xs text-slate-500 dark:text-slate-400">{inherit.detail}</span>
                                        )}
                                        {row.kind === 'custom' && (
                                            <span className="block text-xs text-slate-500 dark:text-slate-400">{tr("Not in the list — the endpoint may still accept it")}</span>
                                        )}
                                    </span>
                                    {row.meta?.size ? (
                                        <span className="shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400">{formatModelSize(row.meta.size)}</span>
                                    ) : null}
                                    {tier && (
                                        <span className={cx('shrink-0 px-1.5 py-0.5 rounded border text-[11px] font-medium', TIER_TONE[tier.tone])}>
                                            {tr(tier.label)}
                                        </span>
                                    )}
                                    {onDelete && row.kind === 'model' && (
                                        <IconButton
                                            size="sm"
                                            variant="quiet"
                                            label={tr("Delete {{name}}", { name: row.model })}
                                            onClick={e => { e.stopPropagation(); onDelete(row.model); }}
                                            icon={<Trash2 className="w-3.5 h-3.5" aria-hidden="true" />}
                                            className="opacity-0 can-hover:group-hover:opacity-100 focus-visible:opacity-100 touch:opacity-100 hover:text-red-600 dark:hover:text-red-400"
                                        />
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    {matches.length > shown.length && (
                        <p className="shrink-0 px-3 py-2 border-t border-slate-100 dark:border-slate-700/70 text-xs text-slate-500 dark:text-slate-400">
                            {tr("{{shown}} of {{total}} shown — keep typing to narrow it.", { shown: shown.length, total: matches.length })}
                        </p>
                    )}
                </div>,
                document.body,
            )}
        </div>
    );
}

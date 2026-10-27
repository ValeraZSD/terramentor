import {
    Children, Fragment, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
} from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactElement, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, X } from 'lucide-react';
import { usePortalAccent } from '../../hooks/usePortalAccent';
import { useDialogFocus } from '../../hooks/useDialogFocus';
import { useCanHover } from '../../utils/platform';
import { scrollIntoViewWithin } from '../../utils/scrollWithin';
import { IconButton } from './Button';
import { placePopover, MENU_SURFACE } from './Popover';
import type { Placement } from './Popover';
import { FIELD_BASE, FIELD_SIZE, ControlSize, cx } from './vocabulary';

/**
 * A choice of one value from a short list: a field-shaped button that opens
 * the app's own list.
 *
 * It replaced a restyled native `<select>`. Only the CLOSED box could be styled;
 * the list it opened was the operating system's: on Windows a square grey panel
 * with a light-grey highlight under a dark theme, in the system font, with none
 * of the app's radius, colour or row height (screenshots of 21 Oct 2026). On a
 * phone it was the platform's own picker. `appearance: base-select` styles the
 * real list, but only in Chromium (Firefox ships it switched off, Safari from
 * 27), so it would have given two looks; this gives one.
 *
 *   - a mouse gets a list hung from the box (`placePopover`, the menus'
 *     material), the chosen row ticked and scrolled to, the row under the
 *     pointer lit. Focus STAYS on the box and the list is its
 *     `aria-activedescendant` (the WAI-ARIA select-only combobox), so a dialog's
 *     Tab trap and focus return never see a second element.
 *   - a finger (`hover: none`) gets a SHEET from the bottom of the screen:
 *     titled with the field's label, rows a thumb can hit, a close button, and
 *     a handle to pull it down by. A list hung from a box near a phone's bottom
 *     edge has no room to open into.
 *   - either way a list longer than its space fades out over a chevron while
 *     rows remain below, and opens downward when there is room for most of it.
 *   - keys: ↑/↓, Home/End, PageUp/PageDown, Enter or Space to choose, Escape
 *     (claimed — the page and the dialog under it do not also act) and Tab to
 *     close, and typing a name jumps to it, open or closed.
 *
 * The API stays the `<select>`'s: `<option value>` children, with `onChange`
 * handing over the chosen value as a string. `fit` sizes the box to its WIDEST
 * option, which the browser used to measure for a native select: every label is
 * laid in one grid cell and only the chosen one is visible, so the box does not
 * resize as the value changes.
 */

export interface SelectOption {
    value: string;
    label: ReactNode;
    /** The label as text: what type-ahead matches and the sheet announces. */
    text: string;
    disabled?: boolean;
    /** An instruction row ("Trace a course…"), marked `data-placeholder` on its
     *  `<option>`: muted and never ticked, so standing on it does not read as a
     *  choice. Not inferred from an empty value, which can be a real choice
     *  ("Automatic" in the new-course form). */
    placeholder?: boolean;
}

/** An instruction row's text, in the box and in the list. */
const PLACEHOLDER_TEXT = 'text-slate-500 dark:text-slate-300';

function textOf(node: ReactNode): string {
    if (node == null || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textOf).join('');
    if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
    return '';
}

/** The `<option>` children, fragments and arrays flattened. */
export function readOptions(children: ReactNode): SelectOption[] {
    const out: SelectOption[] = [];
    const walk = (nodes: ReactNode) => Children.forEach(nodes, child => {
        if (!isValidElement(child)) return;
        const el = child as ReactElement<{ value?: string | number; children?: ReactNode; disabled?: boolean; 'data-placeholder'?: unknown }>;
        if (el.type === Fragment) { walk(el.props.children); return; }
        if (el.type !== 'option') return;
        const text = textOf(el.props.children);
        out.push({
            value: el.props.value != null ? String(el.props.value) : text,
            label: el.props.children,
            text,
            disabled: !!el.props.disabled,
            placeholder: el.props['data-placeholder'] != null && el.props['data-placeholder'] !== false,
        });
    });
    walk(children);
    return out;
}

export type ListKeyAction =
    | { kind: 'move'; index: number }
    | { kind: 'choose' }
    | { kind: 'close' }
    | null;

/**
 * What a key does to an OPEN list whose lit row is `active`. Pure, so the gate
 * runs every case without a browser. Disabled rows are stepped over; the ends
 * do not wrap, as in every platform's own list.
 */
export function listKey(key: string, active: number, options: SelectOption[], page = 8): ListKeyAction {
    const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter(i => i >= 0);
    if (!enabled.length) return key === 'Escape' || key === 'Tab' ? { kind: 'close' } : null;
    const first = enabled[0], last = enabled[enabled.length - 1];
    const after = (from: number, steps: number) => {
        const later = enabled.filter(i => i > from);
        return later.length ? later[Math.min(steps, later.length) - 1] : last;
    };
    const before = (from: number, steps: number) => {
        const earlier = enabled.filter(i => i < from);
        return earlier.length ? earlier[Math.max(earlier.length - steps, 0)] : first;
    };
    switch (key) {
        case 'ArrowDown': return { kind: 'move', index: active < 0 ? first : after(active, 1) };
        case 'ArrowUp': return { kind: 'move', index: active < 0 ? last : before(active, 1) };
        case 'PageDown': return { kind: 'move', index: after(active, page) };
        case 'PageUp': return { kind: 'move', index: active < 0 ? first : before(active, page) };
        case 'Home': return { kind: 'move', index: first };
        case 'End': return { kind: 'move', index: last };
        case 'Enter': case ' ': return { kind: 'choose' };
        case 'Escape': case 'Tab': return { kind: 'close' };
        default: return null;
    }
}

/**
 * Type-ahead: the row `typed` (lower-cased, accumulated) names, searching from
 * the row AFTER `active` so pressing one letter again walks the rows that start
 * with it. -1 when nothing matches.
 */
export function typeAhead(typed: string, active: number, options: SelectOption[]): number {
    if (!typed) return -1;
    const n = options.length;
    // One letter repeated ("ddd") walks the rows starting with that letter.
    const single = [...typed].every(c => c === typed[0]) ? typed[0] : null;
    const needle = single ?? typed;
    const start = single ? active + 1 : Math.max(active, 0);
    for (let k = 0; k < n; k++) {
        const i = (start + k) % n;
        const o = options[i];
        if (!o.disabled && o.text.trim().toLocaleLowerCase().startsWith(needle)) return i;
    }
    return -1;
}

interface SelectProps {
    value: string | number | null | undefined;
    onChange: (value: string) => void;
    children: ReactNode;
    size?: ControlSize;
    /** Size to the widest option rather than to the container. Use it for a
     *  select that is a row's control; leave it off inside a `Field`. */
    fit?: boolean;
    className?: string;
    id?: string;
    disabled?: boolean;
    title?: string;
    'aria-label'?: string;
    'aria-labelledby'?: string;
}

export function Select({
    value, onChange, children, size = 'md', fit = false, className, id, disabled, title,
    'aria-label': ariaLabel, 'aria-labelledby': ariaLabelledBy,
}: SelectProps) {
    const options = readOptions(children);
    const current = value == null ? '' : String(value);
    const selectedIndex = options.findIndex(o => o.value === current);
    const selected = selectedIndex >= 0 ? options[selectedIndex] : options[0];

    const canHover = useCanHover();
    const [open, setOpen] = useState(false);
    // Fixed for the life of one opening: a pointer change mid-list would swap
    // the surface out from under the finger.
    const [sheet, setSheet] = useState(false);
    const [active, setActive] = useState(-1);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const listId = useId();
    const optionId = (i: number) => `${listId}-o${i}`;

    // Type-ahead buffer: letters typed within a second add up ("ne" → Nederlands).
    const typed = useRef({ text: '', at: 0 });
    // A Space the list used (to choose, or inside a typed word) was taken on
    // keydown; a browser may still turn the keyup into a click on the box,
    // which would open or close the list at once.
    const chosenBySpaceAt = useRef(0);

    const openList = useCallback((at?: number) => {
        if (disabled) return;
        // Safari and Firefox on macOS do not focus a button on a click, and
        // the open list's keys (and its claim on Escape) follow the box's focus.
        buttonRef.current?.focus({ preventScroll: true });
        setSheet(!canHover);
        // Lit on the choice; on nothing while the box stands on an instruction
        // row, which lit would read as chosen. ↓ then starts from the top.
        const start = selectedIndex >= 0
            ? (options[selectedIndex].placeholder ? -1 : selectedIndex)
            : options.findIndex(o => !o.disabled);
        setActive(at ?? start);
        setOpen(true);
    }, [disabled, canHover, selectedIndex, options]);

    const close = useCallback((refocus = true) => {
        setOpen(false);
        if (refocus) buttonRef.current?.focus({ preventScroll: true });
    }, []);

    const choose = useCallback((i: number) => {
        const o = options[i];
        if (!o || o.disabled) return;
        close();
        if (o.value !== current) onChange(o.value);
    }, [options, current, onChange, close]);

    const typeTo = useCallback((ch: string): number => {
        const now = Date.now();
        const t = typed.current;
        t.text = (now - t.at > 1000 ? '' : t.text) + ch.toLocaleLowerCase();
        t.at = now;
        return typeAhead(t.text, open ? active : selectedIndex, options);
    }, [open, active, selectedIndex, options]);

    // The keys of an open list, wherever focus sits (the box on a mouse, the
    // list in a sheet). Returns true when the key was used.
    const onListKey = useCallback((e: KeyboardEvent | ReactKeyboardEvent): boolean => {
        if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const hit = typeTo(e.key);
            if (hit >= 0) setActive(hit);
            return true;
        }
        // Space inside a word being typed ("1 234,5") is part of the word.
        if (e.key === ' ' && Date.now() - typed.current.at < 600 && typed.current.text) {
            chosenBySpaceAt.current = Date.now();
            const hit = typeTo(' ');
            if (hit >= 0) setActive(hit);
            return true;
        }
        const act = listKey(e.key, active, options);
        if (!act) return false;
        if (act.kind === 'move') setActive(act.index);
        else if (act.kind === 'choose') {
            if (e.key === ' ') chosenBySpaceAt.current = Date.now();
            choose(active);
        }
        else close(e.key !== 'Tab');
        // Tab moves on: let the browser take focus to the next control.
        return e.key !== 'Tab';
    }, [active, options, choose, close, typeTo]);

    const onButtonKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
        if (open) return; // the open list's capture listener has it
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            openList();
        } else if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
            // Typing on the closed box chooses, as a native select's does.
            e.preventDefault();
            const hit = typeTo(e.key);
            if (hit >= 0 && options[hit].value !== current) onChange(options[hit].value);
        }
    };

    const visible = (o: SelectOption) => o === selected;

    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                id={id}
                role="combobox"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-controls={open ? listId : undefined}
                aria-activedescendant={open && !sheet && active >= 0 ? optionId(active) : undefined}
                aria-label={ariaLabel}
                aria-labelledby={ariaLabelledBy}
                disabled={disabled}
                title={title}
                data-select=""
                onClick={e => {
                    if (e.detail === 0 && Date.now() - chosenBySpaceAt.current < 500) return;
                    if (open) close(); else openList();
                }}
                onKeyDown={onButtonKey}
                className={cx(
                    // Fit, the box is as wide as the list's widest row (its
                    // label plus the tick's gutter), so the open list's edges
                    // line up with the box's instead of overhanging a few px.
                    'relative inline-flex items-center text-left cursor-pointer',
                    fit ? 'w-auto max-w-full pr-12' : 'w-full pr-9',
                    FIELD_BASE, FIELD_SIZE[size],
                    open && 'border-accent',
                    className,
                )}
            >
                {fit ? (
                    <span className="grid min-w-0">
                        {options.map((o, i) => (
                            <span
                                key={i}
                                aria-hidden={visible(o) ? undefined : true}
                                className={cx('[grid-area:1/1] truncate', !visible(o) && 'invisible', o.placeholder && PLACEHOLDER_TEXT)}
                            >
                                {o.label}
                            </span>
                        ))}
                    </span>
                ) : (
                    <span className={cx('min-w-0 truncate', selected?.placeholder && PLACEHOLDER_TEXT)}>{selected?.label}</span>
                )}
                <ChevronDown
                    className={cx(
                        'absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 dark:text-slate-400 pointer-events-none transition-transform',
                        open && 'rotate-180',
                    )}
                    aria-hidden="true"
                />
            </button>
            {open && (sheet ? (
                <SelectSheet
                    listId={listId}
                    optionId={optionId}
                    options={options}
                    current={current}
                    active={active}
                    setActive={setActive}
                    choose={choose}
                    close={() => close(true)}
                    onListKey={onListKey}
                    title={ariaLabel || labelFor(buttonRef.current)}
                />
            ) : (
                <SelectList
                    anchorRef={buttonRef}
                    listId={listId}
                    optionId={optionId}
                    options={options}
                    current={current}
                    active={active}
                    setActive={setActive}
                    choose={choose}
                    close={close}
                    onListKey={onListKey}
                    label={ariaLabel || labelFor(buttonRef.current)}
                />
            ))}
        </>
    );
}

/** The visible label a `<label for>` or `aria-labelledby` gives the box, for
 *  the sheet's title and the list's name. */
function labelFor(button: HTMLButtonElement | null): string {
    if (!button) return '';
    const by = button.getAttribute('aria-labelledby');
    if (by) return by.split(/\s+/).map(i => document.getElementById(i)?.textContent ?? '').join(' ').trim();
    const label = button.labels?.[0] ?? (button.closest('label') as HTMLLabelElement | null);
    if (!label) return '';
    // The label's own words, without the box's text inside a wrapping label.
    const copy = label.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('[data-select]').forEach(n => n.remove());
    return (copy.textContent ?? '').trim();
}

interface ListProps {
    listId: string;
    optionId: (i: number) => string;
    options: SelectOption[];
    current: string;
    active: number;
    setActive: (i: number) => void;
    choose: (i: number) => void;
    onListKey: (e: KeyboardEvent | ReactKeyboardEvent) => boolean;
}

function Rows({ options, current, active, setActive, choose, optionId, roomy }: ListProps & { roomy: boolean }) {
    return (
        <>
            {options.map((o, i) => {
                const isValue = o.value === current && !o.placeholder;
                return (
                    <div
                        key={i}
                        id={optionId(i)}
                        role="option"
                        aria-selected={isValue}
                        aria-disabled={o.disabled || undefined}
                        data-active={i === active || undefined}
                        // Lit by the pointer as it moves, like a platform list,
                        // and chosen on the press's END so a scroll that begins
                        // on a row does not choose it.
                        // A finger dragging the sheet's list is scrolling, not pointing.
                        onPointerMove={e => { if (e.pointerType === 'mouse' && !o.disabled && i !== active) setActive(i); }}
                        onClick={() => choose(i)}
                        className={cx(
                            'flex items-start gap-2.5 rounded-lg px-2.5 select-none',
                            roomy ? 'min-h-12 py-3 text-base' : 'min-h-9 py-2 text-sm',
                            o.disabled
                                ? 'cursor-default text-slate-400 dark:text-slate-500'
                                : cx('cursor-pointer', o.placeholder ? PLACEHOLDER_TEXT : 'text-slate-700 dark:text-slate-100'),
                            // Chosen is the app's chosen-option tint (as in an
                            // answer's choices); lit is the menus' grey. Two
                            // fills, so the row under the pointer or the keys is
                            // never mistaken for the choice.
                            isValue
                                ? (i === active ? 'bg-accent/20 dark:bg-accent/30' : 'bg-accent/10 dark:bg-accent/20')
                                : i === active && !o.disabled && 'bg-slate-100 dark:bg-slate-600',
                        )}
                    >
                        <Check
                            className={cx(
                                'shrink-0 w-4 h-4 text-accent-fg',
                                roomy ? 'mt-1' : 'mt-0.5',
                                !isValue && 'invisible',
                            )}
                            aria-hidden="true"
                        />
                        <span className={cx('min-w-0 flex-1 break-words text-pretty', isValue && 'font-medium text-slate-900 dark:text-white')}>
                            {o.label}
                        </span>
                    </div>
                );
            })}
        </>
    );
}

/**
 * Whether a scrolling list has rows below what it shows. A list that ends at a
 * row boundary looks complete: the language list stopped at "Українська" with
 * "中文" out of sight, and two readers took the languages under it for missing.
 */
function useMoreBelow(ref: RefObject<HTMLElement | null>) {
    const [more, setMore] = useState(false);
    const check = useCallback(() => {
        const el = ref.current;
        if (el) setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 4);
    }, [ref]);
    // Every render: the list's height and rows settle after it is placed.
    useLayoutEffect(check);
    return { more, check };
}

/** The cue for `useMoreBelow`: a fade over the last rows, a chevron in it.
 *  Zero-height and sticky, so it rides the list's bottom edge and moves nothing. */
function MoreBelow({ from }: { from: string }) {
    return (
        <div aria-hidden="true" data-more-below="" className="pointer-events-none sticky bottom-0 h-0">
            {/* Solid under the chevron, so it never sits on a row's letters. */}
            <div className={cx('absolute inset-x-0 bottom-0 flex h-12 items-end justify-center bg-gradient-to-t from-40% to-transparent', from)}>
                <ChevronDown className="w-4 h-4 text-slate-500 dark:text-slate-300" />
            </div>
        </div>
    );
}

/** Space a list needs at most before it scrolls, in rem: about thirteen rows,
 *  so a library's worth of courses mostly fits, as the browser's list did. */
const LIST_MAX_REM = 30;
/** Room below the box that is enough to open there even if the list must scroll. */
const LIST_BELOW_REM = 18;

/** Is the box (at `r`) wholly out of sight: off the screen, or past the edge
 *  of an element that scrolls or clips it (a dialog's body, a panel)? */
function scrolledAway(box: HTMLElement, r: DOMRect): boolean {
    if (r.bottom < 0 || r.top > window.innerHeight) return true;
    for (let p = box.parentElement; p && p !== document.body; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (!/auto|scroll|hidden|clip/.test(`${s.overflowX} ${s.overflowY}`)) continue;
        const b = p.getBoundingClientRect();
        if (r.bottom <= b.top || r.top >= b.bottom) return true;
    }
    return false;
}

function SelectList(props: ListProps & {
    anchorRef: RefObject<HTMLButtonElement | null>;
    close: (refocus?: boolean) => void;
    label: string;
}) {
    const { anchorRef, listId, optionId, active, close, onListKey, label } = props;
    // The frame (border, radius, shadow) and, inside it, the list that
    // scrolls. One element doing both put the scrollbar's square ends over
    // the rounded corners, and the bottom padding showed a row under the cue.
    const panelRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const [place, setPlace] = useState<(Placement & { maxHeight: number; minWidth: number }) | null>(null);
    const { anchor: accentAnchor, accent } = usePortalAccent(true);
    const closeRef = useRef(close);
    closeRef.current = close;
    const keyRef = useRef(onListKey);
    keyRef.current = onListKey;
    const { more, check: checkMore } = useMoreBelow(listRef);

    const measure = useCallback(() => {
        const btn = anchorRef.current, panel = panelRef.current, list = listRef.current;
        if (!btn || !panel || !list) return;
        const r = btn.getBoundingClientRect();
        // The box scrolled out of sight, off the screen or out of the dialog or
        // panel that scrolls it: a list floating there belongs to nothing.
        if (scrolledAway(btn, r)) { closeRef.current(false); return; }
        const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        const margin = 8, gap = 4;
        const below = window.innerHeight - r.bottom - gap - margin;
        const above = r.top - gap - margin;
        // Below when the list fits there, or when eight rows or so do: a list
        // that flips over the box covers what the reader was reading above it.
        // Only a cramped bottom sends it to the roomier side.
        const wanted = Math.min(list.scrollHeight, LIST_MAX_REM * rem);
        const room = below >= Math.min(wanted, LIST_BELOW_REM * rem) ? below : Math.max(below, above);
        // Less the border (the 2 px placed below), or a list sized to the room
        // overflows it by those 2 px and flips above after all.
        const maxHeight = Math.max(Math.min(LIST_MAX_REM * rem, room - 2), 3 * rem);
        // Measure at the height it will have, then place that box.
        list.style.maxHeight = `${maxHeight}px`;
        panel.style.minWidth = `${r.width}px`;
        const p = placePopover(r, { width: panel.offsetWidth, height: Math.min(list.scrollHeight, maxHeight) + 2 },
            { width: window.innerWidth, height: window.innerHeight }, { gap, margin });
        setPlace({ ...p, maxHeight, minWidth: r.width });
    }, [anchorRef]);

    useLayoutEffect(() => { measure(); }, [measure]);

    // Open on the chosen row, in the middle of the list where there is room.
    const placed = place != null;
    useLayoutEffect(() => {
        if (!placed) return;
        const row = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
        scrollIntoViewWithin(row, { boundary: listRef.current, block: 'center' });
    }, [placed]);

    // Keep the lit row in view as the keys move it.
    useEffect(() => {
        if (!placed || active < 0) return;
        scrollIntoViewWithin(document.getElementById(optionId(active)), { boundary: listRef.current, block: 'nearest', padding: 4 });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- optionId is a pure function of the list's id
    }, [active, placed]);

    useEffect(() => {
        const onDown = (e: PointerEvent) => {
            const t = e.target as Node;
            if (panelRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
            // The field's <label> hands its click on to the box, which then
            // closes the list itself; closing here first would reopen it.
            if ([...(anchorRef.current?.labels ?? [])].some(l => l.contains(t))) return;
            closeRef.current(false);
        };
        const onMove = (e: Event) => {
            // Scrolling the list itself moves nothing else.
            if (e.type === 'scroll' && listRef.current?.contains(e.target as Node)) return;
            measure();
        };
        // On the DOCUMENT, in the capture phase: the keys belong to the open
        // list while the box has focus, and claiming them first means a dialog
        // under it (its Escape) or a page (its arrows) does not act on the same
        // press. A dialog's Tab trap still runs: Tab is let through.
        const onKey = (e: KeyboardEvent) => {
            if (document.activeElement !== anchorRef.current) return;
            if (keyRef.current(e)) { e.preventDefault(); e.stopPropagation(); }
        };
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('scroll', onMove, true);
        window.addEventListener('resize', onMove);
        return () => {
            document.removeEventListener('pointerdown', onDown, true);
            document.removeEventListener('keydown', onKey, true);
            window.removeEventListener('scroll', onMove, true);
            window.removeEventListener('resize', onMove);
        };
    }, [measure, anchorRef]);

    const style: CSSProperties = {
        ...accent,
        left: place?.left ?? 0,
        top: place?.top ?? 0,
        maxWidth: place?.maxWidth ?? 'min(28rem, calc(100vw - 16px))',
        minWidth: place?.minWidth,
        visibility: place ? 'visible' : 'hidden',
    };

    return (
        <>
            <span ref={accentAnchor} className="hidden" aria-hidden="true" />
            {createPortal(
                <div
                    ref={panelRef}
                    data-select-list=""
                    style={style}
                    // A press inside the list must not take focus off the box,
                    // which holds the keys and the screen reader's place.
                    onMouseDown={e => e.preventDefault()}
                    className={cx('fixed z-[110] flex w-max flex-col overflow-hidden', MENU_SURFACE)}
                >
                    <div
                        ref={listRef}
                        id={listId}
                        role="listbox"
                        aria-label={label || undefined}
                        style={{ maxHeight: place?.maxHeight }}
                        onScroll={checkMore}
                        className="list-scroll min-h-0 overflow-y-auto overscroll-contain px-1 pt-1"
                    >
                        <Rows {...props} roomy={false} />
                        {/* The bottom inset as content, not padding: a sticky
                            cue stops at the padding edge and a row showed under it. */}
                        <div aria-hidden="true" className="h-1" />
                        {more && <MoreBelow from="from-white dark:from-slate-700" />}
                    </div>
                </div>,
                document.body,
            )}
        </>
    );
}

function SelectSheet(props: ListProps & { close: () => void; title: string }) {
    const { t } = useTranslation();
    const { listId, optionId, active, close, onListKey, title } = props;
    const dialogRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const titleId = useId();
    const [shown, setShown] = useState(false);
    const { anchor: accentAnchor, accent } = usePortalAccent(true);
    const { more, check: checkMore } = useMoreBelow(listRef);

    useDialogFocus(true, dialogRef, { onEscape: e => { e.preventDefault(); close(); }, initialFocus: listRef });

    // Slide up once mounted (a frame later, so the start position is painted).
    useEffect(() => {
        const f = requestAnimationFrame(() => setShown(true));
        return () => cancelAnimationFrame(f);
    }, []);

    // Pulled down by its header, as a phone's own sheets are: it follows the
    // finger, and let go past a fifth of its height (or 6rem) it closes.
    const drag = useRef<{ id: number; y: number } | null>(null);
    const [pulled, setPulled] = useState(0);
    const onPullStart = (e: ReactPointerEvent<HTMLDivElement>) => {
        // The close button keeps its own tap (a capture would retarget it).
        if (e.pointerType === 'mouse' || (e.target as Element).closest('button')) return;
        drag.current = { id: e.pointerId, y: e.clientY };
        e.currentTarget.setPointerCapture?.(e.pointerId);
    };
    const onPullMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (drag.current?.id === e.pointerId) setPulled(Math.max(0, e.clientY - drag.current.y));
    };
    const onPullEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (drag.current?.id !== e.pointerId) return;
        const d = e.type === 'pointercancel' ? 0 : e.clientY - drag.current.y;
        drag.current = null;
        const h = dialogRef.current?.offsetHeight ?? 0;
        if (d > Math.min(96, h / 5 || 96)) close(); else setPulled(0);
    };

    useLayoutEffect(() => {
        const row = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
        scrollIntoViewWithin(row, { boundary: listRef.current, block: 'center' });
    }, []);

    useEffect(() => {
        if (active < 0) return;
        scrollIntoViewWithin(document.getElementById(optionId(active)), { boundary: listRef.current, block: 'nearest', padding: 4 });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- optionId is a pure function of the list's id
    }, [active]);

    return (
        <>
            <span ref={accentAnchor} className="hidden" aria-hidden="true" />
            {createPortal(
                <div className="fixed inset-0 z-[110] flex items-end justify-center" style={accent} data-select-list="">
                    <div
                        className={cx('absolute inset-0 bg-black/50 transition-opacity duration-200 motion-reduce:transition-none', shown ? 'opacity-100' : 'opacity-0')}
                        onClick={close}
                        aria-hidden="true"
                    />
                    <div
                        ref={dialogRef}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby={title ? titleId : undefined}
                        aria-label={title ? undefined : t("Choose one")}
                        tabIndex={-1}
                        className={cx(
                            // The home-indicator inset is the sheet's, outside the
                            // list, so the "more below" cue never sits in it.
                            'relative flex w-full max-w-lg max-h-[min(80dvh,40rem)] flex-col pb-[env(safe-area-inset-bottom)] outline-none',
                            'rounded-t-2xl border border-b-0 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 shadow-xl',
                            'transition-transform duration-200 ease-out motion-reduce:transition-none',
                            shown ? 'translate-y-0' : 'translate-y-full',
                        )}
                        style={pulled ? { transform: `translateY(${pulled}px)`, transition: 'none' } : undefined}
                    >
                        <div
                            data-sheet-handle=""
                            className="shrink-0 touch-none select-none"
                            onPointerDown={onPullStart}
                            onPointerMove={onPullMove}
                            onPointerUp={onPullEnd}
                            onPointerCancel={onPullEnd}
                        >
                            <div aria-hidden="true" className="mx-auto mt-2 h-1 w-10 rounded-full bg-slate-300 dark:bg-slate-600" />
                            <div className="flex items-center justify-between gap-3 pl-5 pr-3 pt-1 pb-2">
                                <h2 id={titleId} className="min-w-0 text-base font-semibold text-slate-900 dark:text-white">
                                    {title || t("Choose one")}
                                </h2>
                                <IconButton
                                    size="md"
                                    onClick={close}
                                    label={t("Close dialog")}
                                    tooltip={false}
                                    icon={<X className="w-5 h-5" />}
                                />
                            </div>
                        </div>
                        <div
                            ref={listRef}
                            id={listId}
                            role="listbox"
                            tabIndex={0}
                            aria-labelledby={title ? titleId : undefined}
                            aria-activedescendant={active >= 0 ? props.optionId(active) : undefined}
                            onKeyDown={e => { if (onListKey(e)) { e.preventDefault(); e.stopPropagation(); } }}
                            onScroll={checkMore}
                            className="list-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 outline-none"
                        >
                            <Rows {...props} roomy />
                            {/* The list's bottom gap as content, not padding: a
                                sticky cue stops at the padding edge and rows showed under it. */}
                            <div aria-hidden="true" className="h-3" />
                            {more && <MoreBelow from="from-white dark:from-slate-800" />}
                        </div>
                    </div>
                </div>,
                document.body,
            )}
        </>
    );
}

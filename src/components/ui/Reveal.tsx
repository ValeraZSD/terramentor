import { useRef } from 'react';

/**
 * Something that appears by GROWING into its room, and leaves by giving the
 * room back — instead of popping in and shoving its neighbours a whole
 * control's width (or a line's height) in one frame.
 *
 * The animated value is a grid track, `0fr` ↔ `1fr`, so the size is the
 * content's own and is never measured or guessed. While it closes it keeps
 * drawing what it last held: a parent that has already dropped the thing (a
 * course untraced, a replay finished) would otherwise collapse an empty box,
 * which is a jump with extra steps. Closed, it is `inert`, so a button folded
 * to nothing is not still a Tab stop.
 *
 * `axis="x"` is for a control joining a row — the field beside it gives way.
 * The slot overhangs by the focus ring's width so the ring is not clipped by
 * the overflow the animation needs.
 */
export default function Reveal({ open, axis = 'y', children, className = '' }: {
    open: boolean;
    axis?: 'x' | 'y';
    children: React.ReactNode;
    className?: string;
}) {
    const last = useRef<React.ReactNode>(children);
    if (open) last.current = children;
    const x = axis === 'x';
    return (
        <div
            className={`grid transition-[grid-template-columns,grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${x
                ? (open ? 'grid-cols-[1fr] opacity-100' : 'grid-cols-[0fr] opacity-0')
                : (open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')} ${className}`}
            aria-hidden={!open}
        >
            <div
                className={x ? 'min-w-0 overflow-hidden -my-[3px] py-[3px]' : 'min-h-0 overflow-hidden -mx-[3px] px-[3px]'}
                ref={el => {
                    if (!el) return;
                    if (open) el.removeAttribute('inert');
                    else el.setAttribute('inert', '');
                }}
            >
                {open ? children : last.current}
            </div>
        </div>
    );
}

import type { ReactNode } from 'react';
import { cx } from './vocabulary';

/**
 * One line of course or learner text (a course name, a topic title) inside
 * the interface. It reads in its own direction: an English title in the
 * Arabic interface keeps its question mark at the end and is cut at its
 * end, not its start. The line still sits on the interface's start edge.
 *
 * Use it INSIDE the element that truncates. Setting dir="auto" on that
 * element instead would move short English titles to the far side of a
 * right-to-left row, and `unicode-bidi: plaintext` on it would also reverse
 * interface sentences that begin with a product name.
 * Inside a `data-larger-wraps` element it wraps with it (index.css).
 */
export default function OwnLine({ children, className }: { children: ReactNode; className?: string }) {
    return <span dir="auto" data-own-line className={cx('inline-block max-w-full truncate align-bottom', className)}>{children}</span>;
}

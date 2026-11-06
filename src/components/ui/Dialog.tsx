import type { ReactNode } from 'react';

/*
 * The three parts every dialog is built from, so its buttons cannot scroll away.
 *
 * A dialog that scrolled as ONE box carried its Cancel / Save / Next row at the
 * bottom of the scrolled content: a long explanation, a long form or a short
 * window pushed the row past the dialog's edge, and the learner saw text and no
 * way on (at 1280x800 the placement probe's explanation hid "Next").
 * Now the head and the foot stay put and only the body between them scrolls.
 *
 *   <div className={`${DIALOG_SHELL} …width, colours, radius…`} role="dialog">
 *     <header className="shrink-0 …">…</header>
 *     <div className={DIALOG_BODY}>…</div>
 *     <DialogFooter>…buttons…</DialogFooter>
 *   </div>
 *
 * `Modal` is built from them; a dialog with its own frame uses them directly.
 * `tools/dialog-footer-gates.mjs` fails a dialog whose last row of buttons sits
 * inside its scrolling body.
 */

/**
 * The frame. `modal-shell` caps it at 90% of the window in `vh`, then `dvh` (a
 * phone's address bar otherwise hides the foot; two Tailwind classes cannot
 * carry the pair, since `vh` is emitted after `dvh` and would win). The frame's
 * own scroll is a fallback for a window too short for even the head, a sliver of
 * body and the foot (a phone on its side, a zoomed page): the body gives up its
 * height first, down to `min-h-24`, and only then does the frame scroll, so the
 * foot is reached rather than clipped.
 */
export const DIALOG_SHELL = 'modal-shell flex flex-col overflow-y-auto';

/*
 * Clear of a phone's covered edges (the status bar, the home indicator, the
 * corners held sideways; the `safe-*` utilities in tailwind.config.js). The
 * overlay is the full-screen layer a dialog is centred in, the panel the dialog.
 *
 * A dialog that is a bottom SHEET on a phone and a card from `sm` up: the sheet
 * keeps its colour down to the screen's edge and lifts its buttons above the
 * home indicator, rather than floating over a strip of dimmed page.
 */
export const SHEET_OVERLAY = 'safe-pt-0 safe-px-0 sm:safe-p-4';
export const SHEET_PANEL = 'max-sm:safe-pb-0';
/** A dialog that FILLS a phone and is a card from `sm` up: the same, on all four sides. */
export const FILL_OVERLAY = 'sm:safe-p-4';
export const FILL_PANEL = 'max-sm:safe-p-0';

/** The one region that scrolls. Padding is the caller's. */
export const DIALOG_BODY = 'min-h-24 flex-1 overflow-y-auto overscroll-contain';

interface FooterProps {
    children: ReactNode;
    /** The dialog's horizontal inset, so the buttons line up with the body's
     *  content: `Modal` pads 1.5rem, the hand-built dialogs 1.25rem. */
    inset?: 'px-5' | 'px-6';
    className?: string;
}

/**
 * The dialog's foot: its action row, outside the scroll. Buttons sit at the
 * right; a control that belongs at the left (Delete, Finish now) takes
 * `mr-auto`, or a group takes `ml-auto`.
 */
export function DialogFooter({ children, inset = 'px-5', className = '' }: FooterProps) {
    return (
        <div className={`flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-slate-200 py-3 dark:border-slate-700 ${inset} ${className}`}>
            {children}
        </div>
    );
}

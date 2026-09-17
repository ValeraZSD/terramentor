import { useEffect, useRef } from 'react';

/**
 * The review keyboard: Space flips, 1-4 rate.
 *
 * ## Why this is a capture-phase listener on `document`
 *
 * It was an ordinary `document.addEventListener('keydown', …)`, which looks
 * global and is not. React attaches its own listeners at the ROOT CONTAINER,
 * which sits below `document`, and a React handler calling `stopPropagation()`
 * stops the underlying native event too — so any subtree that swallows keydown
 * swallows Space before `document` ever sees it. The card's audio buttons do
 * exactly that (deliberately: pressing Enter on "play" must not also flip the
 * card), so the moment the learner clicked a clip — which puts focus ON that
 * button — Space stopped working and there was no way to get it back except
 * clicking elsewhere. That is the "space fails when something else takes focus"
 * bug, and it cannot be fixed inside the tree, because the tree is exactly what
 * is eating it. Capture at `document` runs BEFORE anything in the tree.
 *
 * Being first also means being responsible: the handler both `preventDefault`s
 * (or Space would scroll the page and activate whatever button holds focus) and
 * `stopPropagation`s (or the card's own flip handler would fire second and flip
 * it back). For the keys it does not claim, it does nothing at all.
 *
 * Enter is deliberately NOT claimed. Space is the flip in Anki and belongs to
 * the session; Enter is how a keyboard user activates the control they have
 * focused, and taking it would break every button on the card.
 *
 * Undo takes BOTH `z` and Ctrl/Cmd+Z. Ctrl+Z is what Anki uses and what a hand
 * reaches for; bare `z` is what the other session keys look like (Space, 1-4 —
 * no modifiers), and a review session is one hand on a phone as often as two on
 * a keyboard. Neither is claimed inside a typing target, where Ctrl+Z is the
 * browser's own undo and belongs to the text.
 */
export interface FlashcardKeyHandlers {
    /** Off while a dialog owns the keyboard (the card editor, a confirm). */
    enabled?: boolean;
    onFlip: () => void;
    /** 1-4, in the order the rating buttons are drawn. Only called when flipped. */
    onRate?: (index: number) => void;
    /** Take back the last rating. `z` or Ctrl/Cmd+Z. */
    onUndo?: () => void;
    flipped?: boolean;
}

/** A key press that belongs to whatever the learner is typing into. */
function isTypingTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || typeof el.tagName !== 'string') return false;
    if (el.isContentEditable) return true;
    return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

export function useFlashcardKeys({ enabled = true, onFlip, onRate, onUndo, flipped = false }: FlashcardKeyHandlers) {
    // The handler is read from a ref so the listener is attached once and never
    // re-bound mid-session: re-attaching on every flip is how a listener ends up
    // running twice for one press.
    const latest = useRef({ enabled, onFlip, onRate, onUndo, flipped });
    latest.current = { enabled, onFlip, onRate, onUndo, flipped };

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            const { enabled: on, onFlip: flip, onRate: rate, onUndo: undo, flipped: isFlipped } = latest.current;
            if (!on || e.defaultPrevented) return;
            if (isTypingTarget(e.target)) return;
            // A modal owns the keyboard while it is open, and a review session
            // can still be mounted underneath one (the card editor, the Boss
            // Fight). Claiming Space there would swallow it from whatever the
            // dialog has focused.
            if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;

            const claim = () => { e.preventDefault(); e.stopPropagation(); };

            // Before the modifier bail-out: this is the one key that wants them.
            if (undo && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
                claim();
                undo();
                return;
            }
            if (e.metaKey || e.ctrlKey || e.altKey) return;

            if (e.key === ' ' || e.key === 'Spacebar') {
                claim();
                flip();
                return;
            }
            if (isFlipped && rate && /^[1-4]$/.test(e.key)) {
                claim();
                rate(Number(e.key) - 1);
            }
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
    }, []);
}

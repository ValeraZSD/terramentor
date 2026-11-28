import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/Button';

/**
 * The answers the assistant offered under its question (utils/assistantChoices.ts),
 * one button each. A press hands back that answer's text for the drawer to send
 * as the learner's reply; nothing else happens on it.
 *
 * Only while they are live: once a newer turn exists the learner's own message
 * under the question says what they answered, so the buttons are not drawn at
 * all rather than left as greyed copies of it (Messenger and Bot Framework drop
 * theirs the same way, so an old one is never pressed by mistake).
 *
 * One column of equal buttons, so no answer looks recommended by its place or
 * size, capped at a reading width when the drawer is wide, with room below so
 * a card under them does not read as one more answer. Every label is the
 * model's, in the conversation's language, and reads in its own direction.
 */
export function ChoiceButtons({ choices, live, onPick }: {
    choices: string[];
    live: boolean;
    /** `byKeyboard`: pressed with Enter or Space, so focus has somewhere to go once the buttons are gone. */
    onPick: (answer: string, byKeyboard: boolean) => void;
}) {
    const { t } = useTranslation();
    const byKey = useRef(false);
    if (!live || choices.length === 0) return null;
    return (
        <div role="group" aria-label={t("Answers to choose from")} data-row="choices" className="mb-3 flex w-full max-w-sm flex-col gap-1.5">
            {choices.map(answer => (
                // Keyboard only when Enter or Space went down on the button itself:
                // a screen reader's activation also clicks with no pointer, and on
                // a phone focusing the composer would raise the on-screen keyboard.
                <Button
                    key={answer}
                    block
                    wrap
                    onKeyDown={e => { byKey.current = e.key === 'Enter' || e.key === ' '; }}
                    onPointerDown={() => { byKey.current = false; }}
                    onClick={() => { const k = byKey.current; byKey.current = false; onPick(answer, k); }}
                >
                    <span dir="auto" className="min-w-0 break-words">{answer}</span>
                </Button>
            ))}
        </div>
    );
}

import CardText from './CardText';
import { AudioClipButton, type CardMediaRef } from './CardMedia';

/**
 * The supporting lines under a card's answer: a word's reading, an example
 * sentence, that sentence's translation.
 *
 * Answer-side only, and that is not a styling choice. An example sentence
 * contains the word in context, so showing it on the question side hands over
 * the answer — which is exactly why Anki's own templates put it here too.
 *
 * Deliberately quieter than the answer. The answer is what the learner is being
 * asked to produce; everything here is what confirms they were right and shows
 * the word doing its job in a real sentence. Same size and weight for both would
 * make a five-line block with no shape, which is the "wall of text" failure.
 *
 * `whitespace-pre-line` because the lines arrive newline-separated — a sentence
 * that was itself multi-line in the deck (Anki's `<br>`) keeps its breaks.
 *
 * With `clipsFor`, each line is rendered on its own so the clip the deck wrote
 * on that line can sit right after it: "Hasta luego ▶". The line is the clip's
 * label; nothing else could be.
 */
export default function CardExtra({ text, size = 'review', className = '', clipsFor }: {
    text?: string | null;
    size?: 'feed' | 'review';
    className?: string;
    /** The clips anchored to a given line of text, if any. */
    clipsFor?: (line: string) => CardMediaRef[];
}) {
    const value = (text ?? '').trim();
    if (!value) return null;
    // In a session these lines are the ones that carry furigana, and ruby is a
    // FRACTION of its base size — at the old uniform `text-sm` the reading
    // rendered at 7.7px, which is not small type, it is unreadable type. The
    // feed keeps the compact size: a feed card is one item in a scrolling
    // stream, not the thing being stared at.
    // The supporting lines are where the furigana lives, and a reading is a
    // fraction of the base it sits on — so the BASE size is what decides
    // whether the reading is legible. In a session (read at arm's length, for
    // an hour) that means these lines are set only a step below the answer;
    // anything smaller and the ruby is back under 12px. Beyond this the lever
    // is the global UI scale, which moves base and reading together.
    const body = size === 'review' ? 'text-lg sm:text-xl' : 'text-sm';
    const base = `w-full min-w-0 ${body} leading-relaxed text-slate-600 dark:text-slate-300 ${className}`;

    if (!clipsFor) {
        return (
            <div className={`whitespace-pre-line ${base}`}>
                <CardText content={value} />
            </div>
        );
    }

    return (
        <div className={base}>
            {value.split('\n').map((line, i) => {
                if (!line.trim()) return <div key={i} className="h-3" aria-hidden="true" />;
                const clips = clipsFor(line);
                return (
                    <div key={i} className="flex flex-wrap items-center justify-center gap-x-2">
                        <span><CardText content={line} /></span>
                        {clips.map((c, j) => <AudioClipButton key={`${c.hash}-${j}`} item={c} label={line} compact />)}
                    </div>
                );
            })}
        </div>
    );
}

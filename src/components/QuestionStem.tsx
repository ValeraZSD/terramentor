import { memo, useMemo } from 'react';
import MathText from './MathText';
import Markdown from './Markdown';
import CardMedia, { parseMediaList, type CardMediaRef } from './CardMedia';
import { getVisualKind } from './visuals/registry';

/** Does this stem carry a fenced visual spec the app can render? */
export function hasVisual(text: string): boolean {
    if (typeof text !== 'string' || !text.includes('```')) return false;
    for (const m of text.matchAll(/```([\w-]+)/g)) {
        if (getVisualKind(m[1].toLowerCase())) return true;
    }
    return false;
}

interface Props {
    content: string;
    className?: string;
    /** The node this question tests — lets a visual repair itself in context. */
    nodeId?: number;
    /**
     * Where this stem is being read (`quiz`, `boss-fight`, `feed-question`,
     * `placement`). Carried only so a visual-feedback report can say which
     * surface produced a bad drawing; nothing here changes what is rendered.
     */
    surface?: string;
    /**
     * Persist a repaired spec. A stem drawn from a row that can be written back
     * passes this; one that cannot (a placement probe is transient) leaves it
     * out, and the fix then lasts for the session only — never `autoRepair`
     * without it, which is an LLM call on every load.
     */
    onRepaired?: (originalCode: string, repairedCode: string) => void;
    /**
     * Pictures the question is asked ABOUT (`QuizQuestion.media`). Drawn under
     * the words, where a card draws them, so a photo question reads the same
     * whichever surface it is met on.
     */
    media?: CardMediaRef[];
    /** Picture size — `review` for a full-screen assessment, `feed` inline. */
    mediaSize?: 'feed' | 'review';
}

/**
 * A question stem, which may be a drawing or a photograph.
 *
 * Two different things can illustrate a question and they arrive by different
 * routes, because they have different authors:
 *
 *   - a DRAWN visual is written by the question's author as a fenced spec in
 *     the stem text (```mermaid / ```plot / ```vega-lite / ```smiles — see
 *     QUIZ_VISUALS_GUIDE in server/ai.js), and is rendered by taking the whole
 *     stem through the markdown pipeline;
 *   - a PHOTOGRAPH is a file, and arrives as structured `media` beside the
 *     stem, exactly as it does on a flashcard.
 *
 * The second is why `media` exists: a graded question in a photo-based
 * subject (a driving theory exam, a radiograph, a specimen) must not be
 * demoted to a self-marked flashcard, the surface that cannot clear the
 * mastery gate. Nothing else stands in the way: `markdownSanitize.ts` already
 * allows `img`, and `quizzes.questions` is a free JSON column.
 *
 * Text-only questions are plain and basic for whole subjects. So: if the stem
 * carries a visual fence it goes through the full Markdown pipeline and renders
 * as a real diagram; otherwise it takes the cheap KaTeX-only path that every
 * quiz string has always used. Either way, attached media is drawn underneath.
 *
 * The branch matters: `Markdown` pulls in GFM, code highlighting and the visual
 * registry, and injects block margins that would wreck the compact quiz layout.
 * Only a stem that actually needs it pays for it.
 *
 * `autoBuild` is deliberately absent (defaults to `autoRepair`, false here): a
 * graded question must never sit there compiling a widget while the learner
 * waits — and widgets aren't offered to question writers in the first place.
 */
const QuestionStem = memo(({ content, className = '', nodeId, surface, onRepaired, media, mediaSize = 'feed' }: Props) => {
    // Validated here rather than trusted: this list reaches an `<img src>` and
    // it was written by whatever imported the course.
    const pictures = useMemo(() => parseMediaList(media), [media]);

    const words = hasVisual(content)
        ? (
            <Markdown
                content={content}
                nodeId={nodeId}
                surface={surface}
                onRepaired={onRepaired}
                className={`[&>p:first-child]:mt-0 [&>p:last-child]:mb-0 ${className}`}
            />
        )
        : <MathText content={content} className={className} />;

    if (!pictures.length) return words;
    return (
        <div className="flex flex-col gap-3">
            {words}
            {/* The picture is BELOW the question, not above it: the words say
                what is being asked, and a learner who meets the photo first has
                to hold it in mind with no question to hold it for. Same order
                as a flashcard, which is the surface these came from. */}
            <CardMedia media={pictures} size={mediaSize} />
        </div>
    );
});

QuestionStem.displayName = 'QuestionStem';
export default QuestionStem;

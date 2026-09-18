import { useTranslation } from 'react-i18next';

/**
 * The one line every chat surface prints under its input: the learner is
 * talking to a language model, and it can be wrong.
 *
 * Two reasons it exists, and they pull in the same direction. The honesty
 * claim (CoreIdea.md): a mastery tool whose tutor hallucinates and says
 * nothing about it teaches the learner to trust the wrong thing. And EU AI Act
 * Article 50(1): an AI system that interacts directly with people must make
 * sure they know it is one, "unless this is obvious" — the model badge in the
 * header is arguably obvious to someone who chose the model, and not to
 * someone who was handed the app. One sentence removes the argument.
 *
 * The wording follows the shape the mainstream chat products converged on by
 * 2026 (checked 2026-09-09: Gemini prints "Gemini is an AI. It can make
 * mistakes…" under its input, ChatGPT "ChatGPT is an AI…"): a persistent line
 * next to the composer that names AI in its first clause, then the caveat. One
 * difference: it says "an AI", not a product name, because here the model is
 * whatever the learner configured, and the badge in the header already names
 * it.
 *
 * IT STOPS AFTER THE CAVEAT, and two longer versions were tried and cut.
 *
 * "check anything that matters" is what a general assistant can say, because
 * most of a chat is chatter. Here it selects nothing: everything the tutor says
 * is the thing the learner came to learn, so the sentence reads as a lawyer's
 * hedge rather than advice.
 *
 * "check its answers against your material" looks like the fix and is worse,
 * because it names a source that does not exist. In THIS app the answer IS the
 * material — the tutor writes the lesson, the question and the explanation. The
 * learner has nothing to hold it against, and telling them otherwise implies a
 * second opinion the product does not ship.
 *
 * "including about people" (Google's clause, kept in their Russian build) was
 * also cut: it earns its place where the product is asked about named people
 * all day, and here it spends a quarter of the line on the failure this tutor
 * is least likely to have. What is left is the shape ChatGPT and Claude settled
 * on — name the thing, state the caveat, stop.
 *
 * Deliberately not a toast, a banner or a first-run dialog: those get
 * dismissed once and then are gone for the person who needs them a month
 * later. A persistent line at the size of a caption is what the products
 * above converged on, and it costs one row.
 */
export default function AiDisclosure({ className = '' }: { className?: string }) {
    const { t } = useTranslation();
    return (
        <p className={`text-[11px] leading-snug text-center text-slate-500 dark:text-slate-400 select-none ${className}`}>
            {t('This is an AI. It can make mistakes.')}
        </p>
    );
}

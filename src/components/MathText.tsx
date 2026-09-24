import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { bindMathPunctuation, bindUnitsToMath, promoteInlineDisplay, sanitizeMathText } from '../utils/mathText';

/**
 * Inline KaTeX renderer for short quiz strings — question stems, options, the
 * correct answer, and explanations. Unlike the full `Markdown` component (GFM +
 * code + the visual pipeline, built for tutor chat), this deliberately runs ONLY
 * remark-math + rehype-katex so `$…$` / `$$…$$` render as equations while
 * everything else stays plain text. The paragraph wrapper is unwrapped to a
 * fragment so the math flows inline inside option buttons and result rows without
 * injecting block margins into the compact quiz UI.
 *
 * Every string is run through `sanitizeMathText` first: this is the ONE funnel
 * all quiz text passes through (mastery check, practice quiz, feed questions), so
 * the mechanical repair of undelimited LaTeX and text-mode scripts lives here
 * rather than being mirrored across the server's three question normalizers.
 */
const components: Components = {
    // Render paragraphs inline — no <p> block/margins inside buttons & labels.
    p: ({ children }) => <>{children}</>,
};

/**
 * KaTeX defaults render a parse failure as the raw source in alarm-red, which
 * reads as "the app is broken" rather than "this equation is malformed" — and
 * the learner can do nothing about it either way. Fail quietly in the ambient
 * text colour instead, and don't reject the many small non-conformances
 * (`strict`) a local model produces on otherwise-renderable math.
 */
const KATEX_OPTIONS = {
    throwOnError: false,
    errorColor: 'currentColor',
    strict: 'ignore' as const,
};

const MathText = memo(({ content, className = '' }: { content: string; className?: string }) => {
    // Quiz fields are typed as string but ultimately come from AI-generated JSON,
    // which a local model can malform — coerce so a bad payload degrades to text
    // rather than throwing (mirrors the guard in Markdown.tsx).
    // Both binders, in the same order as the markdown pipeline: a unit or a
    // sentence's punctuation must never be the first thing on a wrapped line.
    // KaTeX emits inline-BLOCK spans, so the line-breaker will happily break
    // between `$f$` and the full stop with no whitespace involved — which is
    // what put a lone "." on its own line under a true/false stem.
    // `promoteInlineDisplay` sits after the sanitizer (which is what turns bare
    // LaTeX into a span in the first place, so a whole-string formula the model
    // wrote undelimited is promoted too) and before the binders, which look for
    // text either side of a span and find none on a string that is only math.
    const safe = bindMathPunctuation(bindUnitsToMath(promoteInlineDisplay(sanitizeMathText(
        typeof content === 'string' ? content
        : content == null ? ''
        : String(content),
    ))));

    return (
        <span className={className}>
            <ReactMarkdown
                remarkPlugins={[remarkMath]}
                rehypePlugins={[[rehypeKatex, KATEX_OPTIONS]]}
                components={components}
            >
                {safe}
            </ReactMarkdown>
        </span>
    );
});

MathText.displayName = 'MathText';
export default MathText;

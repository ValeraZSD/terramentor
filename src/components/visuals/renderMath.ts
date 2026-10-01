import type { VisualRenderer } from './registry';

/**
 * Display-mode LaTeX math via KaTeX, for ```math fences. (Inline $…$ and block
 * $$…$$ are already handled by remark-math/rehype-katex in Markdown.tsx — this
 * covers the GitHub-style fenced variant that models also like to emit.)
 */
const renderMath: VisualRenderer = async (el, code) => {
    const katex = (await import('katex')).default;
    el.innerHTML = katex.renderToString(code.trim(), {
        displayMode: true,
        throwOnError: true,
    });
};

export default renderMath;

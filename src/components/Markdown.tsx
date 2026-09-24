import { createContext, memo, useContext, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkBreaks from 'remark-breaks';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
// PrismLight with a registered set, not Prism and not PrismAsyncLight: the full
// build registers every grammar up front (~1 MB of the main bundle), and the
// async build reaches all ~300 of them through dynamic imports, which costs
// nothing at runtime and most of the build (see `codeLanguages.ts`).
// Deep imports on purpose: the package root re-exports the full Prism build,
// whose grammar registration is a side effect tree-shaking cannot remove, and
// the bundled styles file carries every theme when two are used.
import SyntaxHighlighter, { highlightLanguage } from './codeLanguages';
import oneDark from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark';
import oneLight from 'react-syntax-highlighter/dist/esm/styles/prism/one-light';
import { Check, ChevronRight, Copy, Loader2 } from 'lucide-react';
import VisualBlock from './visuals/VisualBlock';
import { markdownSchema } from '../utils/markdownSanitize';
import { copyText } from '../utils/clipboard';
import { fixMarkdownMathTypography } from '../utils/mathText';
import { expandTimelineTags } from '../utils/timeline';
import { expandDetailsTags } from '../utils/details';
import { Timeline, TimelineEvent } from './Timeline';
import { getVisualKind, VISUAL_KIND_LABELS } from './visuals/registry';
import { DrillLauncher } from './drills/DrillLauncher';
import { getDrillLang } from './drills/parseDrill';
import { useStore, isDarkTheme } from '../store';
import 'katex/dist/katex.min.css';
import { useTranslation } from 'react-i18next';
import { useNumberFormat } from '../hooks/useNumberFormat';

/** Fence languages held back / labelled while streaming: visuals + the drill tier. */
const PENDING_KIND_LABELS: Record<string, string> = { ...VISUAL_KIND_LABELS, drill: 'Practice' };
const pendingKindOf = (language: string): string | null => getVisualKind(language) || getDrillLang(language);

/**
 * While a message streams in, the trailing ``` fence may still be open — its
 * spec is half-written. Rendering that partial spec every token causes the
 * jitter/flicker (and spurious parse errors) we want to avoid. So if the last
 * fence is unclosed AND it's a visual language, we hold the incomplete block
 * back from ReactMarkdown and show a "Generating…" placeholder instead. Once
 * the closing fence arrives the block moves into the rendered body and renders
 * exactly once. Non-visual code (plain ```js, …) is left to stream normally.
 */
function splitPendingVisual(
    content: string,
    streaming: boolean,
): { body: string; pending: { kind: string; language: string; chars: number } | null } {
    if (!streaming) return { body: content, pending: null };
    const fences = content.match(/```/g);
    if (!fences || fences.length % 2 === 0) return { body: content, pending: null };

    // Odd count → the last ``` opens a block that hasn't been closed yet.
    const openIdx = content.lastIndexOf('```');
    const afterFence = content.slice(openIdx + 3);
    const language = (afterFence.match(/^([\w-]+)/)?.[1] || '').toLowerCase();
    const kind = pendingKindOf(language);
    if (!kind) return { body: content, pending: null }; // ordinary code — let it stream

    // Spec chars streamed so far (everything past the ```language line) — the
    // live ticker that shows the model is still emitting the visual.
    const chars = afterFence.slice(language.length).replace(/^\r?\n/, '').length;
    return { body: content.slice(0, openIdx).replace(/\s+$/, ''), pending: { kind, language, chars } };
}

/** Fence info strings that mean "this block is just a wrapper", not real code. */
const WRAPPER_INFO = /^(markdown|md|text|txt)?$/i;
const BARE_FENCE = /^\s*```\s*$/;

/**
 * Unwrap a visual fence the model nested inside another fence.
 *
 * Small local models regularly "helpfully" wrap their answer in a code block,
 * producing:
 *
 *     ```                ← bare wrapper fence, no language
 *     ```mermaid
 *     mindmap …
 *     ```                ← closes the WRAPPER (the inner fence never closed)
 *
 * remark then sees one language-less block whose literal text is "```mermaid…",
 * so the diagram never reaches VisualBlock — it renders as dead source. Same
 * class of failure as a bad Mermaid label, so it gets the same treatment: fix it
 * mechanically before parsing rather than hoping the model stops doing it.
 *
 * Deliberately narrow — we only unwrap when the inner fence is a VISUAL language
 * (the case that actually breaks something), so a lesson legitimately showing
 * fenced markdown inside a fence is left alone. Runs before splitPendingVisual,
 * so a half-streamed wrapped visual still gets the "Generating…" placeholder.
 */
export function unwrapWrappedVisualFences(content: string): string {
    if (!content.includes('```')) return content;
    const lines = content.split('\n');
    const drop = new Set<number>();

    for (let i = 0; i < lines.length; i++) {
        const outer = lines[i].match(/^\s*```(.*)$/);
        if (!outer || drop.has(i)) continue;
        const inner = (lines[i + 1] ?? '').match(/^\s*```([\w-]+)\s*$/);
        if (!WRAPPER_INFO.test(outer[1].trim()) || !inner || !getVisualKind(inner[1].toLowerCase())) continue;

        // The wrapper's opening line always goes — including mid-stream, before
        // any closer exists: that leaves an odd fence count, which is exactly
        // what splitPendingVisual reads as "visual still streaming" (placeholder
        // instead of a flash of raw spec).
        drop.add(i);

        // Find the first closing fence after the inner one. It closes the visual
        // (whether the model meant it as the inner or the outer closer). If the
        // very next non-blank line is ANOTHER bare fence, that's the wrapper's
        // now-orphaned closer — it would open a spurious block, so drop it too.
        let k = i + 2;
        while (k < lines.length && !BARE_FENCE.test(lines[k])) k++;
        if (k >= lines.length) continue; // nothing closed yet (still streaming)
        let n = k + 1;
        while (n < lines.length && !lines[n].trim()) n++;
        if (n < lines.length && BARE_FENCE.test(lines[n])) drop.add(n);
        i = k;
    }

    if (!drop.size) return content;
    return lines.filter((_, i) => !drop.has(i)).join('\n');
}

/** Header-only placeholder shown while a visual block is still streaming in. */
const PendingVisual = memo(({ kind, language, chars }: { kind: string; language: string; chars: number }) => {
    const { t } = useTranslation();
    const num = useNumberFormat();
    const label = PENDING_KIND_LABELS[kind] ?? kind;
    return (
        <div className="visual-block my-4 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between px-4 py-1.5 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 text-xs font-mono border-b border-slate-200 dark:border-slate-700">
                <span>{label}</span>
                <span className="lowercase">{language}</span>
            </div>
            <div className="flex items-center gap-2 px-4 py-6 text-sm text-slate-500 dark:text-slate-400 justify-center">
                <Loader2 size={14} className="animate-spin" />
                {t("Generating {{label}}…", { label: label.toLowerCase() })}{' '}{chars > 0 && <span className="tabular-nums text-slate-500 dark:text-slate-300">{t("{{chars}} chars", { count: chars, chars: num(chars) })}</span>}
            </div>
        </div>
    );
});
PendingVisual.displayName = 'PendingVisual';

interface MarkdownProps {
    content: string;
    className?: string;
    /**
     * True while `content` is still streaming in. Forwarded to visual blocks so
     * they don't try to auto-repair a spec that isn't finished yet.
     */
    streaming?: boolean;
    /**
     * True only for a message freshly generated in this session. Lets its visual
     * blocks auto-repair a failed render once; false (the default, e.g. history
     * messages) means a broken visual waits for the user to click "Fix with AI".
     */
    autoRepair?: boolean;
    /**
     * Whether a visual may start an expensive LLM build unprompted (widgets
     * only). Defaults to autoRepair. The feed passes false — it pre-compiles its
     * widgets in the background, so a card never blocks on a build mid-scroll.
     */
    autoBuild?: boolean;
    /**
     * Called when a visual block in this message is repaired, with the original
     * and fixed spec text. AIPanel uses it to splice the fix into the message and
     * persist it, so reopening the chat renders the corrected spec.
     */
    onRepaired?: (originalCode: string, repairedCode: string) => void;
    /**
     * The node this content teaches. A ```drill fence uses it to record a
     * completed round's result as mastery evidence for the node.
     */
    nodeId?: number;
    /**
     * Where this content is being read, and which stored row it belongs to.
     * Carried only so a visual-feedback report can say which surface produced
     * the drawing — a lesson card, the node tutor, the assistant. Nothing here
     * changes what is rendered.
     */
    surface?: string;
    messageId?: number;
}

const CodeBlock = memo(({ language, value }: { language: string; value: string }) => {
    const { t } = useTranslation();
    const num = useNumberFormat();
    const [copied, setCopied] = useState(false);
    // A Prism theme is INLINE styles, so `dark:` variants can't reach it — the
    // theme object itself has to be chosen per mode, or a light page renders
    // dark strips of code on white. Two of its rules carry a background (the
    // `pre` and the `code` inside it) and both are overridden to transparent
    // so the wrapper below owns the surface: leaving the code tag's background
    // in place painted a black box per LINE, sized to that line's text, since
    // the tag is inline.
    const dark = isDarkTheme(useStore(s => s.theme));

    const handleCopy = async () => {
        // `copyText`, not `navigator.clipboard`: the latter is undefined over
        // plain http, which is how a phone on the LAN reaches this.
        if (!await copyText(value)) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="relative group overflow-hidden rounded-lg my-4 border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900">
            <div className="flex items-center justify-between px-4 py-1.5 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 text-xs font-mono border-b border-slate-200 dark:border-slate-700">
                <span className="text-xs lowercase">{language || t("text")}</span>
                <button
                    onClick={handleCopy}
                    className="flex items-center gap-1.5 hover:text-accent-fg transition-colors"
                    type="button"
                >
                    {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                    {copied ? t("Copied!") : t("Copy")}
                </button>
            </div>
            <SyntaxHighlighter
                style={dark ? oneDark : oneLight}
                language={highlightLanguage(language)}
                PreTag="div"
                customStyle={{
                    margin: 0,
                    padding: '1rem',
                    fontSize: '0.85rem',
                    background: 'transparent',
                }}
                codeTagProps={{ style: { background: 'transparent' } }}
            >
                {value}
            </SyntaxHighlighter>
        </div>
    );
});

/**
 * Whether the surrounding message is still streaming in. Delivered via context
 * (not a closure) so the `components` map below can live at module scope with
 * stable identities. If the map were rebuilt per render, every mapped element
 * would be a NEW component type each token → React unmounts/remounts the whole
 * message subtree on every token, re-running every visual renderer (the
 * stream-time jitter bug).
 */
const StreamingContext = createContext(false);

/**
 * Whether visual blocks in this message may auto-repair a failed render. True
 * only for a message freshly generated in the current session; false for
 * messages loaded from chat history (so reopening the app never silently
 * repairs an old broken visual — the user clicks "Fix with AI" instead).
 * Delivered via context for the same stable-identity reason as StreamingContext.
 */
const AutoRepairContext = createContext(false);

/** See MarkdownProps.autoBuild — delivered via context for stable component identity. */
const AutoBuildContext = createContext(false);

/**
 * Callback for persisting a repaired visual spec, delivered via context (same
 * stable-identity reason as StreamingContext). Bound per message by the Markdown
 * instance, so the `code` renderer needn't know which message it belongs to.
 */
const RepairContext = createContext<((originalCode: string, repairedCode: string) => void) | undefined>(undefined);

/**
 * True for a <code> that sits inside a <pre> — i.e. a fenced or indented BLOCK,
 * as opposed to inline `code` in a sentence. react-markdown v10 removed the
 * `inline` prop, and inferring it from the language class (`isInline = !match`)
 * was wrong: a fence with no info string (```\n…\n```) has no language class,
 * so a full code block was rendered with the inline pill styling — cramped,
 * unwrapped, unreadable. The pre renderer below flips this on instead, which is
 * exactly what the HTML nesting already tells us.
 */
const BlockContext = createContext(false);

/**
 * The node a drill fence in this message practises, so a completed round can
 * record mastery for it. Delivered via context (stable component identity, like
 * the others); undefined in surfaces with no single node (e.g. global chat).
 */
const NodeIdContext = createContext<number | undefined>(undefined);
// Provenance for a feedback report: which surface, which stored row.
const VisualOriginContext = createContext<{ surface?: string; messageId?: number }>({});

/**
 * Renderers for element names that are not HTML, so `Components` (keyed by the
 * known tag names) has no slot for them. Kept in their own object and merged
 * with a cast below, rather than casting the whole map, so every standard tag
 * above keeps its real prop types.
 */
const customElements = {
    // Chronologies (see src/utils/timeline.ts). Tag names arrive lowercased and
    // hyphenated because rehype-raw parses the raw HTML with parse5.
    timeline: ({ children }: { children?: React.ReactNode }) => <Timeline>{children}</Timeline>,
    'timeline-event': ({ children, time, title }: { children?: React.ReactNode; time?: string; title?: string }) => (
        <TimelineEvent time={time} title={title}>{children}</TimelineEvent>
    ),
};

const htmlComponents: Components = {
    // Blocks own their chrome (CodeBlock / VisualBlock render their own <div>),
    // so <pre> only marks its child as a block and gets out of the way —
    // otherwise every block was a <div> inside a <pre>, which is invalid nesting
    // and leaks `white-space: pre` + monospace into rendered diagrams.
    pre: ({ children }) => <BlockContext.Provider value={true}>{children}</BlockContext.Provider>,

    code({ node, className, children, ...props }) {
        const streaming = useContext(StreamingContext);
        const autoRepair = useContext(AutoRepairContext);
        const autoBuild = useContext(AutoBuildContext);
        const onRepaired = useContext(RepairContext);
        const isBlock = useContext(BlockContext);
        const nodeId = useContext(NodeIdContext);
        const origin = useContext(VisualOriginContext);
        const match = /language-([\w-]+)/.exec(className || '');
        const value = String(children).replace(/\n$/, '');

        // A ```drill fence is DATA, not code: render the native practice-drill
        // launcher (a button that opens the game in a modal) instead of the spec.
        // Block-only — inline `drill` in a sentence stays literal.
        if (isBlock && getDrillLang(match?.[1])) {
            return <DrillLauncher code={value} nodeId={nodeId} />;
        }

        // Visual languages (mermaid, vega-lite, plot, smiles, math, …) render
        // as live inline visuals instead of highlighted source.
        const visualKind = getVisualKind(match?.[1]);
        if (visualKind) {
            return <VisualBlock kind={visualKind} language={match![1]} code={value} live={streaming} autoRepair={autoRepair} autoBuild={autoBuild} onRepaired={onRepaired} surface={origin.surface} nodeId={nodeId} messageId={origin.messageId} />;
        }

        if (!isBlock) {
            return (
                <code
                    className="bg-slate-100 dark:bg-slate-800 text-accent-fg px-1.5 py-0.5 rounded text-[0.9em] font-mono font-medium"
                    {...props}
                >
                    {children}
                </code>
            );
        }

        return <CodeBlock language={match?.[1] ?? ''} value={value} />;
    },

    p: ({ children, node }) => {
        // Check if paragraph is inside a list item
        const isInListItem = node?.position && node.position.start.column > 1;
        if (isInListItem) {
            return <>{children}</>;
        }
        return <p className="mb-4 last:mb-0 leading-relaxed">{children}</p>;
    },
    h1: ({ children }) => <h1 className="text-xl font-bold mb-4 mt-6 text-slate-900 dark:text-slate-100">{children}</h1>,
    h2: ({ children }) => <h2 className="text-lg font-semibold mb-3 mt-5 text-slate-900 dark:text-slate-100">{children}</h2>,
    h3: ({ children }) => <h3 className="text-base font-semibold mb-2 mt-4 text-slate-900 dark:text-slate-100">{children}</h3>,

    ul: ({ children }) => <ul className="list-disc pl-6 mb-4 space-y-2">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal pl-6 mb-4 space-y-2">{children}</ol>,
    // The `marker:` prefix must be repeated per variant — `dark:text-slate-400`
    // (without it) greyed the whole item's TEXT in dark mode, not just the
    // bullet, costing contrast on every list the tutor writes.
    li: ({ children }) => <li className="marker:text-slate-500 dark:marker:text-slate-400 leading-relaxed">{children}</li>,

    /**
     * A collapsible step (see utils/details.ts). Native `<details>`, so the
     * browser owns the open/close state and the keyboard and screen-reader
     * behaviour come for free — there is nothing here to get wrong.
     *
     * Never `open`: the attribute is dropped by the expander, because a
     * collapsible that starts open is just prose with a border, and the point
     * of the element is that the learner attempts the step before reading it.
     * The chevron is the only affordance and it turns with `group-open`, so an
     * open block reads as open with no JavaScript in the loop.
     */
    details: ({ children }) => (
        <details className="details-block group my-4 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40">
            {children}
        </details>
    ),
    summary: ({ children }) => (
        <summary
            className="flex cursor-pointer list-none items-start gap-2 px-4 py-3 font-medium text-slate-800 dark:text-slate-100
                       can-hover:hover:bg-slate-100 dark:can-hover:hover:bg-slate-800/60
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset
                       [&::-webkit-details-marker]:hidden [&>p]:mb-0 [&>p]:flex-1"
        >
            <ChevronRight
                size={16}
                aria-hidden
                className="mt-1 shrink-0 text-slate-500 transition-transform duration-200 group-open:rotate-90 dark:text-slate-400
                           motion-reduce:transition-none"
            />
            {children}
        </summary>
    ),

    blockquote: ({ children }) => (
        <blockquote className="border-l-4 border-accent bg-slate-50 dark:bg-slate-900/40 pl-4 py-1 my-4 italic text-slate-700 dark:text-slate-300">
            {children}
        </blockquote>
    ),

    table: ({ children }) => (
        <div className="my-4 overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
            <table className="w-full border-collapse text-sm">{children}</table>
        </div>
    ),
    thead: ({ children }) => <thead className="bg-slate-50 dark:bg-slate-900/40">{children}</thead>,
    th: ({ children }) => <th className="border-b border-slate-200 dark:border-slate-700 px-4 py-2 text-left font-semibold">{children}</th>,
    td: ({ children }) => <td className="border-b border-slate-200 dark:border-slate-700 px-4 py-2">{children}</td>,

    hr: () => <hr className="my-6 border-slate-200 dark:border-slate-700" />,

    a: ({ href, children }) => {
        const isExternal = href?.startsWith('http');
        return (
            <a
                href={href}
                target={isExternal ? '_blank' : undefined}
                rel={isExternal ? 'noopener noreferrer' : undefined}
                className="text-accent-fg hover:underline font-medium"
            >
                {children}
            </a>
        );
    },
};

const components = { ...htmlComponents, ...customElements } as Components;

const Markdown = memo(({ content, className = '', streaming = false, autoRepair = false, autoBuild = autoRepair, onRepaired, nodeId, surface, messageId }: MarkdownProps) => {
    // Safety net: `content` is typed as string, but it's frequently sourced from
    // AI-generated JSON (insights, chat) that a local model can malform — e.g. a
    // `message` field that arrives as an object/array/number. A non-string here
    // used to throw `content.split is not a function` and take down the whole
    // workspace via the error boundary. Coerce instead so a bad payload degrades
    // to readable text rather than crashing the view.
    const safeContent =
        typeof content === 'string' ? content
        : content == null ? ''
        : typeof content === 'object' ? JSON.stringify(content, null, 2)
        : String(content);
    // Repair layers, in order: unwrap a visual fence the model nested inside
    // another, fix math typography, then the two content tags. `streaming` is
    // passed to the collapsible expander so an unclosed <details> never hides
    // the tokens still arriving under it (see utils/details.ts).
    const { body, pending } = splitPendingVisual(
        expandDetailsTags(
            expandTimelineTags(fixMarkdownMathTypography(unwrapWrappedVisualFences(safeContent))),
            { streaming },
        ),
        streaming,
    );

    return (
        <StreamingContext.Provider value={streaming}>
            <AutoRepairContext.Provider value={autoRepair}>
                <AutoBuildContext.Provider value={autoBuild}>
                    <RepairContext.Provider value={onRepaired}>
                      <NodeIdContext.Provider value={nodeId}>
                       <VisualOriginContext.Provider value={{ surface, messageId }}>
                        <div className={`prose prose-sm dark:prose-invert max-w-none break-words ${className}`}>
                            <ReactMarkdown
                                remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]}
                                // Order is load-bearing: raw HTML must be parsed before it can be
                                // sanitized, and KaTeX must run after the sanitizer or its rendered
                                // maths is stripped off every card. See utils/markdownSanitize.ts.
                                rehypePlugins={[rehypeRaw, [rehypeSanitize, markdownSchema], rehypeKatex]}
                                components={components}
                            >
                                {body}
                            </ReactMarkdown>
                            {pending && <PendingVisual kind={pending.kind} language={pending.language} chars={pending.chars} />}
                        </div>
                       </VisualOriginContext.Provider>
                      </NodeIdContext.Provider>
                    </RepairContext.Provider>
                </AutoBuildContext.Provider>
            </AutoRepairContext.Provider>
        </StreamingContext.Provider>
    );
});

Markdown.displayName = 'Markdown';
export default Markdown;
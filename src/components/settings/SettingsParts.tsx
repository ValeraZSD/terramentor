import type { LucideIcon } from 'lucide-react';
import { SettingNote, GROUP_CAPTION } from '../ui/SettingRow';

// The small shapes more than one settings section is built from.

// Animated show/hide for the content "owned" by an enable toggle (CSS
// grid-rows trick — no height measuring). While closed the content is made
// `inert` so it drops out of tab order and the accessibility tree.
export function Collapse({ open, children }: { open: boolean; children: React.ReactNode }) {
    return (
        <div
            className={`grid transition-[grid-template-rows] duration-300 ease-out ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
            aria-hidden={!open}
        >
            <div
                className="overflow-hidden min-h-0"
                ref={el => {
                    if (!el) return;
                    if (open) el.removeAttribute('inert');
                    else el.setAttribute('inert', '');
                }}
            >
                {children}
            </div>
        </div>
    );
}

/**
 * The two shapes every block on this page is made of.
 *
 * Thirteen sections had been hand-rolling the identical header markup and the
 * identical white card, which is how a page drifts: each new block is copied
 * from whichever neighbour was open at the time, and a small deviation becomes
 * permanent. A reader learns a settings page by its repetition — same heading
 * weight, same explanatory paragraph, same card underneath — so the template is
 * worth more here than any individual block's styling.
 *
 * `description` takes nodes, not a string, because several of these paragraphs
 * carry <code> and inline emphasis.
 */
export function SectionHeader({ title, icon: Icon, children }: {
    title: React.ReactNode;
    icon?: LucideIcon;
    children?: React.ReactNode;
}) {
    // The same caption `SettingGroup` draws, so a page built from both reads as
    // one page: a quiet label for the card under it, not a chapter heading. It
    // was `text-lg` semibold in near-black, which on a phone made every section
    // announce itself as loudly as the page's own title.
    return (
        <>
            <h2 className={`${GROUP_CAPTION} flex items-center gap-2`}>
                {Icon && <Icon className="w-4 h-4 text-accent-fg" />}{title}
            </h2>
            {/* The section's paragraph is READ, not demoted. It used to collapse
                behind an unnamed "More" above twenty words, which is how the
                Search links tab came to show two identical chevrons 150px
                apart, the second one inside the card the first was about. */}
            {children && (
                <div className="mb-2 px-1">
                    <SettingNote>{children}</SettingNote>
                </div>
            )}
        </>
    );
}

/** The card every section's controls sit on. `flush` drops the padding so the
 *  card can hold its own divided rows. */
export function Panel({ flush = false, className = '', children }: {
    flush?: boolean;
    className?: string;
    children: React.ReactNode;
}) {
    return (
        <div className={`bg-white dark:bg-slate-800 rounded-xl shadow-sm ${flush ? '' : 'p-4'} ${className}`}>
            {children}
        </div>
    );
}

/**
 * The dot-and-word the app says "connected" with. One shape for the model
 * endpoint and for each hosted search key — the second hand-written copy of a
 * control shape becomes a component, and a status dot is a control shape.
 *
 * `idle` is the state that matters: a key saved in an earlier session has never
 * been asked anything, and a grey "Not checked" says that honestly where a
 * green dot would be a guess.
 */
export function StatusDot({ tone, title, children }: {
    tone: 'ok' | 'bad' | 'busy' | 'idle';
    title?: string;
    children: React.ReactNode;
}) {
    const text = tone === 'ok' ? 'text-emerald-700 dark:text-emerald-400'
        : tone === 'bad' ? 'text-red-700 dark:text-red-400'
            : tone === 'busy' ? 'text-amber-700 dark:text-amber-400'
                : 'text-slate-500 dark:text-slate-400';
    const dot = tone === 'ok' ? 'bg-emerald-500'
        : tone === 'bad' ? 'bg-red-500'
            : tone === 'busy' ? 'bg-amber-500 animate-pulse'
                : 'bg-slate-300 dark:bg-slate-600';
    return (
        <span className={`flex items-center gap-1.5 text-xs font-medium ${text}`} title={title}>
            <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
            {children}
        </span>
    );
}

/**
 * Long prose steps aside here: one line of what a thing decides on the
 * surface, the reasoning behind a disclosure — but only where the reasoning is
 * genuinely optional reading, and only behind a NAME. `Explain` is that one
 * shape, shared with every other panel (see ui/Disclosure.tsx). This file used
 * to carry its own bordered version of it plus two hand-written near-copies in
 * the AI tab that differed by a tint and a missing marker reset.
 */

import { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { EMOJI_CATEGORIES, EmojiEntry } from './emojiData';
import { useTranslation } from 'react-i18next';

interface EmojiPickerProps {
    value: string;
    onSelect: (emoji: string) => void;
    onClose?: () => void;
}

export default function EmojiPicker({ value, onSelect, onClose }: EmojiPickerProps) {
    const { t } = useTranslation();
    const [query, setQuery] = useState('');
    const [activeCat, setActiveCat] = useState(EMOJI_CATEGORIES[0].name);

    const trimmed = query.trim();
    const q = trimmed.toLowerCase();

    // Offer the typed text as a custom icon when it looks like a single
    // character/emoji rather than a search word — i.e. it's short, or contains a
    // non-ASCII glyph (an emoji or a letter like 漢 / é).
    const looksLikeCustom = trimmed.length > 0 && (trimmed.length <= 2 || /[^\x00-\x7F]/.test(trimmed));

    const results = useMemo<EmojiEntry[] | null>(() => {
        if (!q) return null;
        const seen = new Set<string>();
        const out: EmojiEntry[] = [];
        for (const c of EMOJI_CATEGORIES) {
            for (const em of c.emojis) {
                if ((em.k.includes(q) || em.e === trimmed) && !seen.has(em.e)) {
                    seen.add(em.e);
                    out.push(em);
                }
            }
        }
        return out;
    }, [q, trimmed]);

    const shownCategory = EMOJI_CATEGORIES.find(c => c.name === activeCat) ?? EMOJI_CATEGORIES[0];

    // Dedupe by emoji so the grid never has two buttons with the same React key.
    // Some category arrays list the same glyph twice (e.g. 📡/🔭 in Objects);
    // colliding keys break reconciliation and the duplicates accumulate on every
    // tab switch instead of being replaced.
    const shownEmojis = useMemo<EmojiEntry[]>(() => {
        const list = results ?? shownCategory.emojis;
        const seen = new Set<string>();
        return list.filter(em => {
            if (seen.has(em.e)) return false;
            seen.add(em.e);
            return true;
        });
    }, [results, shownCategory]);

    const gridButton = (em: EmojiEntry) => (
        <button
            key={em.e}
            type="button"
            title={em.k.split(' ')[0]}
            onClick={() => onSelect(em.e)}
            className={`w-9 h-9 rounded-lg flex items-center justify-center text-xl transition ${value === em.e
                ? 'bg-accent/20 dark:bg-accent/25 ring-2 ring-accent'
                : 'hover:bg-slate-100 dark:hover:bg-slate-700'
                }`}
        >
            {em.e}
        </button>
    );

    return (
        <div className="mt-2 border border-slate-200 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 overflow-hidden">
            {/* Search / custom input */}
            <div className="p-2 border-b border-slate-200 dark:border-slate-600">
                <div className="relative">
                    <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder={t("Search emoji, or type/paste any character…")}
                        className="w-full pl-9 pr-9 py-2 text-sm border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white focus:ring-2 focus:ring-accent focus:border-accent"
                        autoFocus
                    />
                    {query && (
                        <button
                            type="button"
                            onClick={() => setQuery('')}
                            aria-label={t("Clear search")}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    )}
                </div>

                {/* Use whatever the user typed/pasted as a custom icon (any letter or emoji). */}
                {looksLikeCustom && (
                    <button
                        type="button"
                        onClick={() => onSelect(trimmed)}
                        className="mt-2 w-full flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-lg border border-dashed border-accent/40 text-accent-fg hover:bg-accent/10 dark:hover:bg-accent/20 transition"
                    >
                        {t("Use")}{' '}<span className="text-lg leading-none">{trimmed}</span> {t("as a custom icon")}
                    </button>
                )}
            </div>

            {/* Category tabs (hidden while searching) */}
            {!results && (
                <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-slate-200 dark:border-slate-600 overflow-x-auto">
                    {EMOJI_CATEGORIES.map(c => (
                        <button
                            key={c.name}
                            type="button"
                            title={c.name}
                            onClick={() => setActiveCat(c.name)}
                            className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-lg transition ${c.name === activeCat
                                ? 'bg-accent/20 dark:bg-accent/25'
                                : 'hover:bg-slate-100 dark:hover:bg-slate-700'
                                }`}
                        >
                            {c.tab}
                        </button>
                    ))}
                </div>
            )}

            {/* Emoji grid */}
            <div className="p-2 max-h-56 overflow-y-auto">
                {!results && (
                    <div className="text-xs font-medium text-slate-500 dark:text-slate-400 px-1 pb-1.5">
                        {shownCategory.name}
                    </div>
                )}
                {shownEmojis.length > 0 ? (
                    <div className="grid grid-cols-8 gap-0.5">
                        {shownEmojis.map(gridButton)}
                    </div>
                ) : (
                    <div className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
                        {t("No emoji found")}{looksLikeCustom ? t("— use it as a custom icon above") : t("for that search")}.
                    </div>
                )}
            </div>

            {onClose && (
                <div className="px-2 py-1.5 border-t border-slate-200 dark:border-slate-600 text-right">
                    <button
                        type="button"
                        onClick={onClose}
                        className="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 px-2 py-1"
                    >
                        {t("Close")}
                    </button>
                </div>
            )}
        </div>
    );
}

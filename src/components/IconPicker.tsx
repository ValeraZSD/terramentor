import { useState } from 'react';
import { Plus } from 'lucide-react';
import EmojiPicker from './EmojiPicker';
import { hexToRgba } from '../utils/color';
import { Button } from './ui/Button';
import { cx, FOCUS_RING } from './ui/vocabulary';
import { useRovingGrid } from './ui/useRovingGrid';
import { useTranslation } from 'react-i18next';

export const ICON_MAP: Record<string, string> = {
    // General & Foundation
    folder: '📁',
    book: '📚',
    graduation: '🎓',
    idea: '💡',
    target: '🎯',
    star: '⭐',
    heart: '❤️',
    smile: '😊',
    zap: '⚡',
    fire: '🔥',
    check: '✅',
    trophy: '🏆',

    // Science, Tech & Math
    brain: '🧠',
    code: '💻',
    calculator: '🔢',
    testtube: '🧪',
    microscope: '🔬',
    dna: '🧬',
    planet: '🪐',
    rocket: '🚀',
    tools: '🛠️',
    robot: '🤖',

    // Arts, Humanities & Communication
    palette: '🎨',
    camera: '📷',
    music: '🎵',
    theater: '🎭',
    museum: '🏛️',
    globe: '🌍',
    leaf: '🌿',
    pen: '✍️',
    history: '📜',

    // Career, Law & Life Skills
    briefcase: '💼',
    chart: '📈',
    money: '💰',
    car: '🚗',
    hospital: '🏥',
    scale: '⚖️',
    chef: '🍳',

    // Physical & Recreation
    strenght: '💪',
    gamepad: '🎮'
};

// An icon is stored as either a legacy preset key ('folder', 'brain', …) or a
// raw character — any emoji or letter the user chose. Map known keys; otherwise
// pass the value through so custom emoji/letters render as-is.
export function getIconEmoji(icon: string): string {
    if (!icon) return '📁';
    return ICON_MAP[icon] || icon;
}


export const ALL_ICONS = Object.keys(ICON_MAP);

interface IconPickerProps {
    value: string;
    onChange: (icon: string) => void;
    label?: string;
    /** When set, the selected icon's border/background use this colour (the chosen
     *  project colour) so you can preview the colour + emoji together. */
    color?: string;
}

export default function IconPicker({ value, onChange, label, color }: IconPickerProps) {
    const { t } = useTranslation();
    const [showMore, setShowMore] = useState(false);

    // Presets now store the real emoji, so compare/select by emoji (this also
    // keeps the highlight working for projects still holding a legacy key).
    const selectedEmoji = getIconEmoji(value);
    const isCustom = !ALL_ICONS.some(icon => getIconEmoji(icon) === selectedEmoji);

    // The chosen tile is tinted with the project's own colour (falling back to
    // the theme accent) — the one place in the dialog where the two choices are
    // shown TOGETHER at the size they are actually read.
    const selectedTint = color ? { backgroundColor: hexToRgba(color, 0.18) } : undefined;

    const index = isCustom ? -1 : ALL_ICONS.findIndex(i => getIconEmoji(i) === selectedEmoji);
    const { itemProps } = useRovingGrid({
        count: ALL_ICONS.length, index, columns: 8,
        onSelect: i => onChange(getIconEmoji(ALL_ICONS[i])),
    });

    return (
        <div className="min-w-0">
            {label && <p className="text-sm font-medium text-slate-900 dark:text-white mb-1">{label}</p>}
            {/* EIGHT COLUMNS, the same eight the colour grid above uses, so the
                two grids share a rhythm instead of reading as two unrelated
                blocks. Fixed at every width for the same reason: `sm:` is a
                viewport query, and this dialog is 448px wide on a 1200px screen.
                Forty icons divide by eight into five flush rows. */}
            <div role="radiogroup" aria-label={typeof label === 'string' ? label : t("Icon")} className="grid grid-cols-8 gap-2">
                {ALL_ICONS.map((icon, i) => {
                    const emoji = getIconEmoji(icon);
                    const selected = !isCustom && selectedEmoji === emoji;
                    return (
                        <button
                            key={icon}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            aria-label={icon}
                            onClick={() => onChange(emoji)}
                            {...itemProps(i)}
                            style={selected ? selectedTint : undefined}
                            className={cx(
                                'aspect-square w-full rounded-lg flex items-center justify-center text-lg',
                                'transition-[background-color,outline-color]', FOCUS_RING,
                                // The SAME mark as a colour swatch — an outline whose
                                // offset gap is transparent, so it is right on all four
                                // themes — but no tick: a tick on a 40px tile covers the
                                // emoji, which is the only thing there is to look at.
                                selected
                                    ? cx('outline outline-2 outline-offset-2 outline-slate-900 dark:outline-white',
                                        !color && 'bg-accent/10 dark:bg-accent/20')
                                    : 'bg-slate-100 dark:bg-slate-700/60 can-hover:hover:bg-slate-200 dark:can-hover:hover:bg-slate-700',
                            )}
                        >
                            {emoji}
                        </button>
                    );
                })}
            </div>

            <Button
                type="button"
                variant={isCustom ? 'subtle' : 'neutral'}
                onClick={() => setShowMore(v => !v)}
                block
                className="mt-2"
                style={isCustom ? selectedTint : undefined}
            >
                {isCustom
                    ? <><span className="text-lg leading-none">{selectedEmoji}</span> {t("Custom icon — choose another")}</>
                    : <><Plus className="w-4 h-4" /> {t("Choose another icon…")}</>}
            </Button>

            {showMore && (
                <EmojiPicker
                    value={selectedEmoji}
                    onSelect={emoji => { onChange(emoji); setShowMore(false); }}
                    onClose={() => setShowMore(false)}
                />
            )}
        </div>
    );
}
import { hexToRgba } from '../utils/color';
import { cx, FOCUS_RING } from './ui/vocabulary';
import { useRovingGrid } from './ui/useRovingGrid';
import { useTranslation } from 'react-i18next';
import { PROJECT_ICONS, iconName } from './ProjectIcon';

interface IconPickerProps {
    value: string;
    onChange: (icon: string) => void;
    label?: string;
    /** When set, the selected tile is tinted with this colour (the chosen
     *  project colour) so the two choices are seen together. */
    color?: string;
}

/** A project's icon, from our own drawings (`ProjectIcon.tsx`). There is no
 *  "choose another" any more: it opened an emoji picker, and an emoji is a
 *  different picture on every operating system. */
export default function IconPicker({ value, onChange, label, color }: IconPickerProps) {
    const { t } = useTranslation();
    const selected = iconName(value);
    const index = PROJECT_ICONS.findIndex(d => d.name === selected);
    const { itemProps } = useRovingGrid({
        count: PROJECT_ICONS.length, index, columns: 8,
        onSelect: i => onChange(PROJECT_ICONS[i].name),
    });
    const selectedTint = color ? { backgroundColor: hexToRgba(color, 0.18) } : undefined;

    return (
        <div className="min-w-0">
            {label && <p className="text-sm font-medium text-slate-900 dark:text-white mb-1">{label}</p>}
            {/* EIGHT COLUMNS at every width, the colour grid's own count, so
                the two grids share a rhythm; `sm:` is a viewport query and
                this grid also sits in a 304px popover on a wide screen.
                Sixty-four icons make eight flush rows. */}
            <div role="radiogroup" aria-label={label || t("Icon")} className="grid grid-cols-8 gap-1.5">
                {PROJECT_ICONS.map(({ name, Icon, label: iconLabel }, i) => {
                    const on = name === selected;
                    return (
                        <button
                            key={name}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            aria-label={iconLabel}
                            title={iconLabel}
                            onClick={() => onChange(name)}
                            {...itemProps(i)}
                            style={on ? selectedTint : undefined}
                            className={cx(
                                'aspect-square w-full rounded-lg flex items-center justify-center',
                                'text-slate-700 dark:text-slate-200 transition-[background-color,outline-color]', FOCUS_RING,
                                // The SAME mark as a colour swatch: an outline whose
                                // offset gap is transparent, right on every theme.
                                on
                                    ? cx('outline outline-2 outline-offset-2 outline-slate-900 dark:outline-white',
                                        !color && 'bg-accent/10 dark:bg-accent/20')
                                    : 'can-hover:hover:bg-slate-100 dark:can-hover:hover:bg-slate-600',
                            )}
                        >
                            <Icon className="h-5 w-5" aria-hidden="true" />
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

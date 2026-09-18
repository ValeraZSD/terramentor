import { useEffect, useState } from 'react';
import ColorField, { PROJECT_COLORS, sameColor } from './ui/ColorField';
import { Field, TextInput, TextArea, Select } from './ui/Field';
import IconPicker, { getIconEmoji } from './IconPicker';
import { accentSolidTriplet, hexToRgba, parseCssColor } from '../utils/color';
import { useStore } from '../store';
import { api } from '../api';
import { useTranslation } from 'react-i18next';

interface Language {
    code: string;
    name: string;
    endonym: string;
}

// Module-level so the catalog is fetched once per session rather than on every
// open of the create/edit modal. It never changes at runtime.
let languageCache: Language[] | null = null;

interface Props {
    name: string;
    setName: (v: string) => void;
    description: string;
    setDescription: (v: string) => void;
    color: string;
    setColor: (v: string) => void;
    icon: string;
    setIcon: (v: string) => void;
    /** Declared study language ('' = follow the material). Omit both language
     *  props to hide the picker entirely. */
    language?: string;
    setLanguage?: (v: string) => void;
    descriptionRows?: number;
    namePlaceholder?: string;
    descriptionPlaceholder?: string;
    nameAutoFocus?: boolean;
    /** The project being edited, so it does not mark its own colour as taken. */
    projectId?: number;
}

/**
 * WHAT THIS PROJECT WILL LOOK LIKE, while you are choosing it.
 *
 * The colour, the icon and the name are picked in three separate controls and
 * are only ever SEEN together afterwards, on the project card. Settings has
 * solved this for years — its theme cards are a rendered example rather than a
 * word — and the project dialog had nothing.
 *
 * It also carries the one fact the swatches cannot: a project's colour becomes
 * `--accent-rgb` through `accentSolidTriplet`, which darkens it until white
 * label text clears AA, so the button is a different colour from the chip in all
 * sixteen cases. Showing the real button is more honest than a sentence about
 * it, and it is the only place a badly-chosen custom value announces itself
 * before it is saved.
 */
function AppearancePreview({ name, color, icon, placeholder }: {
    name: string; color: string; icon: string; placeholder: string;
}) {
    const { t } = useTranslation();
    const hex = parseCssColor(color) || '#0e7490';
    const solid = accentSolidTriplet(hex);
    return (
        <div className="flex items-center gap-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 p-3">
            <span
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-xl"
                style={{ backgroundColor: hexToRgba(hex, 0.18), border: `1px solid ${hexToRgba(hex, 0.45)}` }}
                aria-hidden="true"
            >
                {getIconEmoji(icon)}
            </span>
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-slate-900 dark:text-white">
                    {name.trim() || placeholder}
                </p>
                <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{t("How this project will look")}</p>
            </div>
            {/* Not a control: it is the primary button this project will draw,
                shown at the size it is drawn. `aria-hidden` and inert so it is
                neither tabbable nor announced as something to press. */}
            <span
                className="inline-flex h-8 shrink-0 items-center rounded-lg px-3 text-xs font-semibold text-white"
                style={{ backgroundColor: `rgb(${solid})` }}
                aria-hidden="true"
            >
                {t("Continue")}
            </span>
        </div>
    );
}

export default function ProjectFormFields({
    name,
    setName,
    description,
    setDescription,
    color,
    setColor,
    icon,
    setIcon,
    language,
    setLanguage,
    descriptionRows = 5,
    namePlaceholder,
    descriptionPlaceholder,
    nameAutoFocus = true,
    projectId,
}: Props) {
    const { t } = useTranslation();
    // Defaulted here rather than in the parameter list: the default is a
    // sentence the reader sees, so it can only be resolved once `t` exists.
    const namePh = namePlaceholder ?? t("e.g., Machine Learning, Japanese N3…");
    const descriptionPh = descriptionPlaceholder ?? t("Describe what you want to learn…");
    const [languages, setLanguages] = useState<Language[]>(languageCache || []);
    const projects = useStore(s => s.projects);

    useEffect(() => {
        if (!setLanguage || languageCache) return;
        let cancelled = false;
        api.getLanguages()
            .then(list => {
                languageCache = list;
                if (!cancelled) setLanguages(list);
            })
            // The picker is an enhancement: without it the project simply keeps
            // the default "follow the material" behaviour.
            .catch(() => { });
        return () => { cancelled = true; };
    }, [setLanguage]);

    // Which colours the rest of the library already carries, and the colours it
    // carries that this palette cannot reach (seeded, imported, or chosen before
    // the palette changed — six of them here, and until now unrecoverable).
    const others = projects.filter(p => p.id !== projectId && p.color);
    const inUse: Record<string, string> = {};
    for (const p of others) {
        const hex = parseCssColor(p.color);
        if (!hex) continue;
        const key = Object.keys(inUse).find(k => sameColor(k, hex)) || hex;
        // First name wins; the tile says "used by X" and a list of nine would not
        // fit a tooltip, so the rest are told by the dot alone.
        if (!inUse[key]) inUse[key] = p.name;
    }
    const library = Object.keys(inUse).filter(hex => !PROJECT_COLORS.some(c => sameColor(c, hex)));

    return (
        <div className="space-y-4">
            <AppearancePreview name={name} color={color} icon={icon} placeholder={namePh} />

            <Field label={t("Name")}>
                {id => (
                    <TextInput
                        id={id}
                        value={name}
                        onChange={e => setName(e.target.value)}
                        placeholder={namePh}
                        autoFocus={nameAutoFocus}
                    />
                )}
            </Field>

            <Field label={t("Description")}>
                {id => (
                    <TextArea
                        id={id}
                        value={description}
                        onChange={e => setDescription(e.target.value)}
                        placeholder={descriptionPh}
                        rows={descriptionRows}
                        className="resize-none"
                    />
                )}
            </Field>

            {setLanguage && (
                <Field
                    label={t("Study language")}
                    hint={t("Lessons, questions and paper exercises are written in this language. The app's own menus stay in English.")}
                >
                    {id => (
                        <Select id={id} value={language || ''} onChange={e => setLanguage(e.target.value)}>
                            <option value="">{t("Follow the material")}</option>
                            {languages.map(l => (
                                <option key={l.code} value={l.code}>
                                    {l.endonym === l.name ? l.name : `${l.name} — ${l.endonym}`}
                                </option>
                            ))}
                        </Select>
                    )}
                </Field>
            )}

            <ColorField
                label={t("Colour")}
                value={color}
                onChange={setColor}
                colors={PROJECT_COLORS}
                inUse={inUse}
                library={library}
                hint={t("Buttons use a darker shade of it so their labels stay readable.")}
            />
            <IconPicker label={t("Icon")} value={icon} onChange={setIcon} color={color} />
        </div>
    );
}

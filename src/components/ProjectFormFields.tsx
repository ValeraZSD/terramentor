import { useEffect, useState, type ReactNode } from 'react';
import ColorField, { PROJECT_COLORS, sameColor } from './ui/ColorField';
import { Field, TextInput, TextArea, Select } from './ui/Field';
import IconPicker from './IconPicker';
import { ProjectIcon } from './ProjectIcon';
import { accentSolidTriplet, parseCssColor } from '../utils/color';
import { useStore } from '../store';
import { api } from '../api';
import { useTranslation } from 'react-i18next';
import { uiLocale } from '../utils/locale';

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
    /** A NEW project has no material to follow: the server resolves '' from
     *  the language the name and description are written in, else the app's. */
    isNew?: boolean;
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
            {/* The tile the project card draws: the button's colour, a white
                drawing on it. */}
            <span
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-xl text-white"
                style={{ backgroundColor: `rgb(${solid})` }}
                aria-hidden="true"
            >
                <ProjectIcon icon={icon} className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-slate-900 dark:text-white">
                    {name.trim() || placeholder}
                </p>
                <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{t("How this project will look")}</p>
            </div>
            {/* Not a control: it is the primary button this project will draw,
                shown at the size it is drawn, and wearing the word the project
                card's own button wears (a "Continue" here read as this dialog's
                next step). `aria-hidden` and inert so it is neither tabbable
                nor announced as something to press. */}
            <span
                className="inline-flex h-8 shrink-0 items-center rounded-lg px-3 text-xs font-semibold text-white"
                style={{ backgroundColor: `rgb(${solid})` }}
                aria-hidden="true"
            >
                {t("Study")}
            </span>
        </div>
    );
}

/** The study-language catalog, fetched once per session. */
export function useLanguages(enabled: boolean): Language[] {
    const [languages, setLanguages] = useState<Language[]>(languageCache || []);
    useEffect(() => {
        if (!enabled || languageCache) return;
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
    }, [enabled]);
    return languages;
}

/** A language's name in the interface's own language ("Dutch", "нидерландский"),
 *  asked of `Intl`; the catalog's English name where `Intl` has none. */
function languageName(code: string, languages: Language[]): string {
    try {
        const name = new Intl.DisplayNames([uiLocale()], { type: 'language' }).of(code);
        if (name && name !== code) return name;
    } catch { /* an unknown code: the catalog's name below */ }
    return languages.find(l => l.code === code)?.name || '';
}

/** `languageName` as a hook: re-renders when the interface language moves. */
export function useLanguageName(code: string | null | undefined): string {
    useTranslation();
    const languages = useLanguages(!!code);
    return code ? languageName(code, languages) : '';
}

/** The project's study language. `isNew`: the empty choice is "Automatic", and
 *  `automaticAs` (a catalog code) is what Automatic will pick, said in it. */
export function StudyLanguageField({ language, setLanguage, isNew = false, automaticAs = null }: {
    language: string; setLanguage: (v: string) => void; isNew?: boolean; automaticAs?: string | null;
}) {
    const { t } = useTranslation();
    const languages = useLanguages(true);
    const automaticName = automaticAs ? languageName(automaticAs, languages) : '';
    const options = (
        <>
            {/* New: the learner's own language — what they typed, the app
                language they chose, their browser's, their profile's — and
                the files' only when their words name it
                (server/creationLanguage.js resolveCreationLanguage). The
                option names it plainly even when the creation's AI check may
                still weigh the learner's signals, because "probably Russian"
                reads as an app unsure which language the lessons will be in. */}
            <option value="">{isNew
                ? (automaticName ? t("Automatic ({{language}})", { language: automaticName }) : t("Automatic"))
                : t("Follow the material")}</option>
            {languages.map(l => (
                <option key={l.code} value={l.code}>
                    {l.endonym === l.name ? l.name : `${l.name} — ${l.endonym}`}
                </option>
            ))}
        </>
    );
    // NEW, it is one line that says what it decides — "Lessons written in
    // [Automatic]" — with a select as wide as its longest option. "Study
    // language" left a learner with a Dutch book unsure whether the LESSONS
    // would be Dutch, and a full-width field with a line under it, for a value
    // almost nobody changes, was the clutter (2026-10-02). "Automatic — from
    // your text and files" was cut off on a phone.
    // Label ABOVE, as every other field in the dialog: beside the select it was
    // a second label style in one short form.
    if (isNew) {
        return (
            <Field label={t("Lessons written in")}>
                {fieldId => <Select id={fieldId} fit value={language || ''} onChange={e => setLanguage(e.target.value)}>{options}</Select>}
            </Field>
        );
    }
    return (
        <Field label={t("Study language")} hint={t("Lessons and questions are written in this language.")}>
            {fieldId => (
                <Select id={fieldId} value={language || ''} onChange={e => setLanguage(e.target.value)}>{options}</Select>
            )}
        </Field>
    );
}

/** The colours other projects carry that the palette cannot reach (seeded,
 *  imported, or chosen before the palette changed), each once. */
function useLibraryColours(projectId?: number): string[] {
    const projects = useStore(s => s.projects);
    const library: string[] = [];
    for (const p of projects) {
        if (p.id === projectId) continue;
        const hex = parseCssColor(p.color);
        if (!hex || PROJECT_COLORS.some(c => sameColor(c, hex)) || library.some(c => sameColor(c, hex))) continue;
        library.push(hex);
    }
    return library;
}

/** The project's colour, with the library's own colours offered. No swatch is
 *  marked as taken: unexplained, the dots read as noise, and explaining them
 *  added clutter. */
export function ProjectColorField({ color, setColor, projectId, hint }: {
    color: string; setColor: (v: string) => void; projectId?: number; hint?: ReactNode;
}) {
    const { t } = useTranslation();
    const library = useLibraryColours(projectId);
    return (
        <ColorField
            label={t("Colour")}
            value={color}
            onChange={setColor}
            colors={PROJECT_COLORS}
            library={library}
            hint={hint}
        />
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
    isNew = false,
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
                <StudyLanguageField language={language || ''} setLanguage={setLanguage} isNew={isNew} />
            )}

            <ProjectColorField color={color} setColor={setColor} projectId={projectId} />
            <IconPicker label={t("Icon")} value={icon} onChange={setIcon} color={color} />
        </div>
    );
}

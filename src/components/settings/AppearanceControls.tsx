import { Check, Moon, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore, type Theme } from '../../store';
import { LANGUAGES, k } from '../../i18n';
import { themeRamp } from '../../utils/themeRamp';
import { Select } from '../ui/Field';

// Shared by Settings → General and the welcome screen (components/welcome/),
// which asks the same two questions of a new learner.

/**
 * The theme pair and the language select. Extracted from Settings so another
 * surface can offer the same controls without a second hand-written copy — one
 * component per control, which is the rule that produced ui/Field and friends.
 * Both read their answer from the store, so neither carries state of its own.
 *
 * THE FOUR NAMED THEMES ARE GONE. There are two cards, not four, and they are
 * the two answers to the only question a card can ask — light or dark. What
 * COLOUR the app is is the tint below them, a value like the accent rather than
 * a name somebody has to have been told, and the two cards redraw in it as it
 * is chosen. `Warm` and `Black` were the two tints anybody actually wanted, and
 * they are still one press away; every tint between them was unreachable.
 *
 * The previews must be literal hex (not `bg-slate-*`) because one of the two
 * always shows a mode OTHER than the one currently applied, so it cannot ride
 * the live CSS variables. They are generated from the same function the app
 * itself is painted by (`themeRamp`) rather than transcribed, which is what
 * makes a preview a preview instead of a picture of one.
 */
const THEME_META: { id: Theme; label: string; icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }> }[] = [
    { id: 'light', label: k("Light"), icon: Sun },
    { id: 'dark', label: k("Dark"), icon: Moon },
];

/** Which rung each part of the preview is drawn from. `page` is the CANVAS
 *  (slate-100 / slate-900), not the inset one: a canvas and an inset sharing
 *  one value in light mode is exactly the collision the surface ladder in
 *  index.css exists to prevent. */
const PREVIEW_RUNGS = {
    light: { page: '100', surface: 'white', border: '200', text: '900', muted: '500', code: '100' },
    dark: { page: '900', surface: '800', border: '700', text: '50', muted: '400', code: '700' },
} as const;

function themePreview(mode: Theme, tint: string) {
    const ramp = themeRamp(mode, tint);
    const r = PREVIEW_RUNGS[mode];
    return {
        page: ramp[r.page], surface: ramp[r.surface], border: ramp[r.border],
        text: ramp[r.text], muted: ramp[r.muted], code: ramp[r.code],
    };
}

/** The two mode cards. The whole card — preview AND name row — sits on that
 *  mode's own palette at the tint currently chosen, so each box reads as what
 *  pressing it would give you. */
export function ThemeCards() {
    const { t: tr } = useTranslation();
    const theme = useStore(s => s.theme);
    const themeTint = useStore(s => s.themeTint);
    const setTheme = useStore(s => s.setTheme);
    return (
        <div className="grid grid-cols-2 gap-3">
            {THEME_META.map(({ id, label, icon: Icon }) => {
                const p = themePreview(id, themeTint);
                const selected = theme === id;
                return (
                    <button
                        key={id}
                        type="button"
                        onClick={() => setTheme(id)}
                        aria-pressed={selected}
                        aria-label={tr("{{label}} theme", { label: tr(label) })}
                        // The selected card is always the CURRENT mode's, so its mark
                        // is the accent as solved for this page (`accent-fg`), never
                        // the solid: the solid is only ever darkened, and a near-black
                        // accent drew the Dark card's border and tick black on black.
                        className={`text-left rounded-xl border-2 overflow-hidden transition ${selected
                            ? 'border-accent-fg ring-2 ring-accent-fg/30'
                            : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'}`}
                    >
                        {/* Sized for a card that spans half the row: at 10px
                            type a card that wide is mostly empty paper. */}
                        <div className="p-3 space-y-2.5" style={{ backgroundColor: p.page }}>
                            {/* Rendered example — the same content in both, styled per mode. */}
                            <div className="rounded-lg border p-3 space-y-2" style={{ backgroundColor: p.surface, borderColor: p.border }}>
                                <div className="flex items-center gap-2">
                                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: 'rgb(var(--accent-rgb))' }} />
                                    <span className="text-sm font-semibold leading-none" style={{ color: p.text }}>{tr("Cell biology")}</span>
                                </div>
                                <p className="text-xs leading-snug" style={{ color: p.muted }}>{tr("How lessons & notes look.")}</p>
                                <div className="text-xs leading-snug" style={{ color: p.text }}>
                                    {tr("• Mitochondria make")}{' '}
                                    <span className="px-1 py-px rounded font-mono" style={{ backgroundColor: p.code, color: p.text }}>{tr("ATP")}</span>
                                </div>
                                <span className="inline-block text-2xs font-medium px-2 py-0.5 rounded-full text-white" style={{ backgroundColor: 'rgb(var(--accent-rgb))' }}>{tr("Mastered")}</span>
                            </div>
                            {/* Name row — themed to match its card. */}
                            <div className="flex items-center justify-between px-0.5">
                                <span className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: p.text }}>
                                    <Icon className="w-4 h-4" style={{ color: p.muted }} /> {tr(label)}
                                </span>
                                {selected && <Check className="w-4 h-4 text-accent-fg" />}
                            </div>
                        </div>
                    </button>
                );
            })}
        </div>
    );
}

/** The interface-language select alone; the row supplies the label it points at. */
export function LanguageRow({ id = 'ui-language' }: { id?: string }) {
    const { t: tr } = useTranslation();
    const uiLanguage = useStore(s => s.uiLanguage);
    const setUiLanguage = useStore(s => s.setUiLanguage);
    return (
        <Select
            id={id}
            fit
            value={uiLanguage}
            onChange={e => void setUiLanguage(e.target.value)}
        >
            <option value="auto">{tr("Same as the browser")}</option>
            {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
        </Select>
    );
}

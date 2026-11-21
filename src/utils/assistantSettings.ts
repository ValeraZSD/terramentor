import { THEME_CHOICES, MIN_UI_SCALE, MAX_UI_SCALE, type ThemeChoice } from '../store';
import { MIN_SPEECH_RATE, MAX_SPEECH_RATE } from './accessibility';
import i18n, { LANGUAGES, isSupportedLanguage, k } from '../i18n';
import { NUMBER_STYLES, AUTO as NUMBER_AUTO } from './numberFormat';

/**
 * The assistant's second marker: `[[set:key:value]]`.
 *
 * WHY A MARKER AND NOT A TOOL. The assistant is read-only at the API — it
 * receives a snapshot and writes nothing — and that is a deliberate property,
 * not an omission: a model that can write to the database on a misread is a
 * model whose mistakes are permanent. But "I can't change the theme from here,
 * you do it yourself" is a bad answer to "switch to the light theme", and the
 * learner is right to find it obtuse.
 *
 * So the same contract the `[[open:…]]` marker already uses is stretched by
 * exactly one step. The model names a SETTING AND A VALUE; it never performs
 * the change and never writes SQL. It is TOLD what each setting holds and what
 * its own recent changes replaced (server/assistantSettings.js), so "undo" is
 * a marker it can write rather than a button it has to point at. The APP
 * validates the pair against the table below and applies it through the store
 * setter the Settings screen itself calls. A key that is not on this list, or a
 * value outside its range, does nothing at all and renders nothing — the same
 * failure mode as an invented node id: silence, never a wrong action.
 *
 * WHY THIS LIST AND NOTHING ELSE. Every setting here is (a) visible the instant
 * it lands (or, for the number format, on the next screen that shows a
 * number, and named in the chip meanwhile), so a
 * wrong one is self-reporting rather than discovered weeks later,
 * and (b) undone by a single tap, which the chip beside the answer offers. That
 * pair is what makes applying it immediately better than asking first: a
 * confirmation dialog for "make the text bigger" is friction with nothing on
 * the other side of it.
 *
 * What is deliberately NOT here is anything that changes what the engine
 * MEASURES or teaches — the mastery gate, the FSRS parameters, the daily new-card
 * limit, the AI endpoint, the auth gate. Those are not presentation: getting one
 * wrong corrupts a record of what the learner knows, or quietly changes how much
 * they are asked to do, and neither announces itself. They stay in Settings,
 * where a person chooses them on purpose.
 */

// Spelled out, not built from the tables below: tools/settings-registry-gates.mjs
// reads this line to check every key is a client ui row.
export type SettingKey = 'theme' | 'theme_tint' | 'accent_color' | 'ui_scale' | 'ui_language' | 'number_format'
    | 'contrast' | 'motion' | 'letter_spacing' | 'word_spacing' | 'line_spacing'
    | 'reading_line' | 'read_aloud' | 'card_audio_autoplay' | 'confirm_answers' | 'key_shortcuts' | 'speech_rate'
    | 'larger_ui';

/**
 * The accessibility rows (Settings → Accessibility), each a short list of
 * words: presentation only, visible the moment it lands, and one tap back —
 * the same two properties as the rest of this list. The drill time limit is
 * not here: it is a learning row (what a drill serves), set in Settings.
 */
const CHOICE_SETTINGS = {
    contrast: { name: k("Contrast"), values: { system: k("System"), standard: k("Standard"), more: k("Higher") } },
    motion: { name: k("Motion"), values: { system: k("System"), full: k("Full"), reduce: k("Reduced") } },
    letter_spacing: { name: k("Letter spacing"), values: { normal: k("Normal"), wider: k("Wider"), widest: k("Widest") } },
    word_spacing: { name: k("Word spacing"), values: { normal: k("Normal"), wider: k("Wider"), widest: k("Widest") } },
    line_spacing: { name: k("Line spacing"), values: { normal: k("Normal"), wider: k("Wider"), widest: k("Widest") } },
} as const satisfies Partial<Record<SettingKey, { name: string; values: Record<string, string> }>>;
type ChoiceKey = keyof typeof CHOICE_SETTINGS;

/** The on/off rows. The value is `on` or `off`, which is also what Undo restores. */
const SWITCH_SETTINGS = {
    reading_line: k("Reading line"),
    read_aloud: k("Read aloud"),
    card_audio_autoplay: k("Play card recordings by themselves"),
    confirm_answers: k("Confirm before grading"),
    larger_ui: k("Larger text and buttons"),
    key_shortcuts: k("Single-key shortcuts"),
} as const satisfies Partial<Record<SettingKey, string>>;
type SwitchKey = keyof typeof SWITCH_SETTINGS;

/** Other words for a value, tried in order against the key's own list. */
const CHOICE_ALIASES: Record<string, string[]> = {
    default: ['system', 'normal'], auto: ['system'], automatic: ['system'],
    normal: ['normal', 'standard'], standard: ['standard', 'normal'], high: ['more'], higher: ['more'],
    reduced: ['reduce'], less: ['reduce'], none: ['reduce'],
};
const ON_WORDS = ['on', 'true', 'yes', '1', 'enabled'];
const OFF_WORDS = ['off', 'false', 'no', '0', 'disabled'];

const isChoiceKey = (key: string): key is ChoiceKey => Object.prototype.hasOwnProperty.call(CHOICE_SETTINGS, key);
const isSwitchKey = (key: string): key is SwitchKey => Object.prototype.hasOwnProperty.call(SWITCH_SETTINGS, key);

export interface SettingChange {
    key: SettingKey;
    /** The validated value, in the shape the store setter takes. */
    value: string | number;
    /** What the chip says: "Theme → Dark". */
    label: string;
}

/**
 * Accent presets the model can name in words — the SIXTEEN the picker draws,
 * in its order, with its hexes.
 *
 * Deliberately not imported from `ColorField.tsx`: this module is a leaf that
 * the store and the api client must not pull a React component through. So it
 * is a mirror, and `palette-order-gates.mjs` pins it to `ACCENT_COLORS` name by
 * name and hex by hex — it already reads the name off the comment beside each
 * swatch, which is what makes that check possible.
 *
 * It had drifted: fourteen entries, with `cyan` and `slate` that the picker has
 * no swatch for, and NO `sky` or `fuchsia`, which it does. A learner asking for
 * a sky accent got silence — `validateSettingChange` returned null, no chip, no
 * change — right after a model that was told to say what it had changed.
 */
const ACCENT_NAMES: Record<string, string> = {
    sky: '#0369a1', blue: '#1d4ed8', indigo: '#4338ca', violet: '#6d28d9',
    purple: '#7e22ce', fuchsia: '#a21caf', pink: '#be185d', rose: '#be123c',
    red: '#b91c1c', orange: '#c2410c', amber: '#b45309', green: '#15803d',
    emerald: '#047857', teal: '#0f766e', ink: '#0f172a', paper: '#64748b',
};

const THEME_LABELS: Record<ThemeChoice, string> = {
    system: k("Match your system"), light: k("Light"), dark: k("Dark"),
};

/**
 * Page tints the model can name in words, "warm" and "black" among them: those
 * two were the app's own vocabulary for two years, and a learner asking for
 * either means something exact, so the words land on the setting that carries
 * them rather than on nothing.
 *
 * Deliberately the tints' own names plus those two, not the whole spectrum: a
 * word this table does not hold returns null and the chip is not drawn, which
 * is the same silence an invented node id gets.
 */
const TINT_NAMES: Record<string, string> = {
    warm: '#f0e1d0', cream: '#f0e1d0', sepia: '#f0e1d0',
    black: '#000000', oled: '#000000', ink: '#000000',
    none: '#ffffff', paper: '#ffffff', white: '#ffffff', neutral: '#ffffff',
    sky: '#bae6fd', blue: '#bfdbfe', indigo: '#c7d2fe', violet: '#ddd6fe',
    purple: '#e9d5ff', fuchsia: '#f5d0fe', pink: '#fbcfe8', rose: '#fecdd3',
    red: '#fecaca', orange: '#fed7aa', amber: '#fde68a', green: '#bbf7d0',
    emerald: '#a7f3d0', teal: '#99f6e4',
};

/**
 * Validate one key/value pair. Returns null for anything not on the list — the
 * caller then renders nothing, so a hallucinated setting is inert rather than
 * an error the learner has to interpret.
 */
export function validateSettingChange(rawKey: string, rawValue: string): SettingChange | null {
    const key = rawKey.trim().toLowerCase().replace(/[\s-]+/g, '_');
    const value = rawValue.trim();
    if (!value) return null;

    if (key === 'theme') {
        const v = value.toLowerCase();
        const t = (v === 'auto' || v === 'automatic' ? 'system' : v) as ThemeChoice;
        if (!THEME_CHOICES.includes(t)) return null;
        return { key: 'theme', value: t, label: i18n.t("Theme → {{name}}", { name: i18n.t(THEME_LABELS[t]) }) };
    }

    const alias = key === 'reduce_motion' ? 'motion'
        : key === 'shortcuts' ? 'key_shortcuts' : key === 'reading_speed' || key === 'speech_speed' ? 'speech_rate' : key;
    if (isChoiceKey(alias)) {
        const values: Record<string, string> = CHOICE_SETTINGS[alias].values;
        const v = value.toLowerCase().replace(/\s+/g, ' ');
        // "reduce_motion: on" is the one switch-shaped way to name a choice.
        const word = alias === 'motion' && key === 'reduce_motion'
            ? (ON_WORDS.includes(v) ? 'reduce' : OFF_WORDS.includes(v) ? 'full' : v)
            : v;
        const stored = word in values ? word : CHOICE_ALIASES[word]?.find(c => c in values);
        if (!stored) return null;
        return {
            key: alias, value: stored,
            label: i18n.t("{{setting}} → {{value}}", { setting: i18n.t(CHOICE_SETTINGS[alias].name), value: i18n.t(values[stored]) }),
        };
    }
    if (isSwitchKey(alias)) {
        const v = value.toLowerCase();
        const on = ON_WORDS.includes(v) ? true : OFF_WORDS.includes(v) ? false : null;
        if (on === null) return null;
        return {
            key: alias, value: on ? 'on' : 'off',
            label: i18n.t("{{setting}} → {{value}}", { setting: i18n.t(SWITCH_SETTINGS[alias]), value: on ? i18n.t("On") : i18n.t("Off") }),
        };
    }
    if (alias === 'speech_rate') {
        const n = Math.round(Number(value.replace('%', '')));
        if (!Number.isFinite(n) || n < MIN_SPEECH_RATE || n > MAX_SPEECH_RATE) return null;
        return { key: 'speech_rate', value: n, label: i18n.t("Reading speed → {{percent}}%", { percent: n }) };
    }

    if (key === 'theme_tint' || key === 'page_colour' || key === 'page_color' || key === 'tint') {
        const named = TINT_NAMES[value.toLowerCase()];
        const hex = named ?? (/^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null);
        if (!hex) return null;
        const pretty = named ? value.toLowerCase().replace(/^./, c => c.toUpperCase()) : hex;
        return { key: 'theme_tint', value: hex, label: i18n.t("Page colour → {{name}}", { name: pretty }) };
    }

    if (key === 'accent_color' || key === 'accent') {
        const named = ACCENT_NAMES[value.toLowerCase()];
        const hex = named ?? (/^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : null);
        if (!hex) return null;
        const pretty = named ? value.toLowerCase().replace(/^./, c => c.toUpperCase()) : hex;
        return { key: 'accent_color', value: hex, label: i18n.t("Accent → {{name}}", { name: pretty }) };
    }

    if (key === 'ui_scale' || key === 'scale' || key === 'text_size') {
        const n = Math.round(Number(value.replace('%', '')));
        if (!Number.isFinite(n) || n < MIN_UI_SCALE || n > MAX_UI_SCALE) return null;
        return { key: 'ui_scale', value: n, label: i18n.t("Interface size → {{percent}}%", { percent: n }) };
    }

    // The interface language. The clearest case there is for any of this: a
    // learner whose app is in the wrong language is the one least able to find
    // the setting that fixes it, and most able to ASK — in their own language,
    // which is itself the answer. Matched on the code and on the endonym, so
    // "Nederlands" works as well as "nl".
    if (key === 'ui_language' || key === 'language' || key === 'interface_language') {
        const v = value.toLowerCase();
        const byCode = isSupportedLanguage(v) ? v : null;
        const byName = LANGUAGES.find(l => l.name.toLowerCase() === v)?.code ?? null;
        // `auto` is a real value here (follow the browser), not a missing one.
        const code = v === 'auto' ? 'auto' : (byCode ?? byName);
        if (!code) return null;
        const name = code === 'auto' ? i18n.t("Automatic") : LANGUAGES.find(l => l.code === code)?.name ?? code;
        return { key: 'ui_language', value: code, label: i18n.t("Language → {{name}}", { name }) };
    }

    // How numbers are written. The option IS its own example (`1 234,5`), so
    // the model names one of those strings — and whitespace is normalised
    // before matching, because two of the five carry a NON-BREAKING space that
    // nothing outside this app would type.
    if (key === 'number_format' || key === 'numbers' || key === 'number_separator') {
        const flat = (x: string) => x.replace(/\s+/g, ' ');
        const v = flat(value).toLowerCase();
        const style = v === 'auto' ? NUMBER_AUTO : NUMBER_STYLES.find(s => flat(s.id) === flat(value))?.id ?? null;
        if (!style) return null;
        return { key: 'number_format', value: style, label: i18n.t("Numbers → {{style}}", { style: style === NUMBER_AUTO ? i18n.t("Automatic") : style }) };
    }

    return null;
}

/** `[[set:theme:dark]]` — tolerant of case and inner spacing, like the other markers. */
const SET_MARKER_RE = /\[\[\s*set\s*:\s*([a-z_ -]+?)\s*:\s*([^\]]+?)\s*\]\]/gi;
/** A marker still mid-stream (`[[set:the`), stripped so the scaffolding never flashes. */
const PARTIAL_MARKER_RE = /\[\[[a-z0-9:#%_ -]*\]?$/i;

/**
 * Split `[[set:…]]` markers out of an assistant message.
 *
 * Capped at three and deduped by key: a model that decides to restyle the whole
 * app in one turn is not being helpful, and the cap is a guard against that
 * rather than a design limit.
 */
export function splitSettingChanges(
    content: string,
    streaming = false,
): { body: string; changes: SettingChange[] } {
    if (!content.includes('[[')) return { body: content, changes: [] };

    const changes: SettingChange[] = [];
    let body = content.replace(SET_MARKER_RE, (_m, key: string, value: string) => {
        const change = validateSettingChange(key, value);
        if (change && changes.length < 3 && !changes.some(c => c.key === change.key)) {
            changes.push(change);
        }
        return '';
    });

    if (streaming) body = body.replace(PARTIAL_MARKER_RE, '');
    body = body.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');

    return { body, changes };
}

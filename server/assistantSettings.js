/**
 * What the assistant is told about the settings it may change.
 *
 * The CLIENT validates and applies a `[[set:key:value]]` marker
 * (src/utils/assistantSettings.ts); the server applies nothing. It only READS,
 * so the model can be told two things it had no way to know: what each setting
 * holds right now, and what its own recent changes replaced. Without the
 * second, a request to undo cannot be met: putting a setting back is an
 * ordinary marker, but only for a model that knows what "back" is.
 *
 * A leaf: `getSetting` is passed in, so a gate can drive every function here
 * against a plain object.
 */

/** The whitelist, mirrored from the client's `SettingKey`. */
export const SETTABLE_KEYS = ['theme', 'theme_tint', 'accent_color', 'ui_scale', 'ui_language', 'number_format',
    'contrast', 'motion', 'letter_spacing', 'word_spacing', 'line_spacing', 'reading_line',
    'read_aloud', 'speech_rate', 'card_audio_autoplay', 'confirm_answers', 'key_shortcuts', 'larger_ui'];

/** The on/off rows, stored 'true'/'false', each with what an absent row means
 *  (the client's readers in accessibility.ts and store.ts). */
const SWITCHES = { reading_line: false, read_aloud: false, card_audio_autoplay: true, confirm_answers: false, key_shortcuts: true, larger_ui: false };
/** The choice rows and what an absent (or unknown) row reads as. */
const CHOICES = {
    contrast: ['system', 'standard', 'more'], motion: ['system', 'full', 'reduce'],
    letter_spacing: ['normal', 'wider', 'widest'], word_spacing: ['normal', 'wider', 'widest'],
    line_spacing: ['normal', 'wider', 'widest'],
};

/** The client's key aliases, so a marker it accepts is one recorded here. */
const ALIASES = {
    page_colour: 'theme_tint', page_color: 'theme_tint', tint: 'theme_tint',
    accent: 'accent_color', scale: 'ui_scale', text_size: 'ui_scale',
    language: 'ui_language', interface_language: 'ui_language',
    numbers: 'number_format', number_separator: 'number_format',
    reduce_motion: 'motion', shortcuts: 'key_shortcuts', reading_speed: 'speech_rate', speech_speed: 'speech_rate',
};

/** The client's defaults (store.ts), so an absent row reads as what the app shows. */
const DEFAULT_ACCENT = '#0E7490';
const NO_TINT = '#ffffff';

const SET_MARKER_RE = /\[\[\s*set\s*:\s*([a-z_ -]+?)\s*:\s*([^\]]+?)\s*\]\]/gi;

/**
 * The values the client's `validateSettingChange` accepts, mirrored so a marker
 * it refuses (and so never applies) is not recorded here as a change either:
 * a recorded one would tell the model it replaced a value it never touched.
 * tools/assistant-gates.mjs runs both over the same markers and holds them equal.
 */
const THEME_WORDS = ['system', 'light', 'dark', 'auto', 'automatic'];
const ON_WORDS = ['on', 'true', 'yes', '1', 'enabled'];
const OFF_WORDS = ['off', 'false', 'no', '0', 'disabled'];
const CHOICE_ALIASES = {
    default: ['system', 'normal'], auto: ['system'], automatic: ['system'],
    normal: ['normal', 'standard'], standard: ['standard', 'normal'], high: ['more'], higher: ['more'],
    reduced: ['reduce'], less: ['reduce'], none: ['reduce'],
};
const ACCENT_WORDS = ['sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
    'red', 'orange', 'amber', 'green', 'emerald', 'teal', 'ink', 'paper'];
const TINT_WORDS = ['warm', 'cream', 'sepia', 'black', 'oled', 'ink', 'none', 'paper', 'white', 'neutral',
    'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
    'red', 'orange', 'amber', 'green', 'emerald', 'teal'];
/** The interface languages (src/i18n/index.ts LANGUAGES), code and own name. */
const UI_LANGUAGES = [['en', 'English'], ['de', 'Deutsch'], ['es', 'Español'], ['fr', 'Français'],
    ['it', 'Italiano'], ['ja', '日本語'], ['nl', 'Nederlands'], ['pl', 'Polski'], ['pt', 'Português'],
    ['ru', 'Русский'], ['uk', 'Українська'], ['zh', '中文']];
/** src/utils/numberFormat.ts NUMBER_STYLES ids, whitespace flattened. */
const NUMBER_STYLE_IDS = ['1,234.5', '1.234,5', '1 234,5', '1 234.5', '1234.5'];
const HEX6 = /^#[0-9a-f]{6}$/i;
const flat = s => s.replace(/\s+/g, ' ');
const percentIn = (value, min, max) => {
    const n = Math.round(Number(value.replace('%', '')));
    return Number.isFinite(n) && n >= min && n <= max;
};

/** Whether the client would apply `[[set:<raw key>:<value>]]`; the canonical key or null. */
function acceptedKey(rawKey, rawValue) {
    const raw = rawKey.trim().toLowerCase().replace(/[\s-]+/g, '_');
    // Own properties only: `constructor` is a word the marker's key can spell.
    const key = SETTABLE_KEYS.includes(raw) ? raw : Object.hasOwn(ALIASES, raw) ? ALIASES[raw] : null;
    const value = rawValue.trim();
    if (!key || !value) return null;
    const v = value.toLowerCase();
    if (key === 'theme') return THEME_WORDS.includes(v) ? key : null;
    if (Object.hasOwn(CHOICES, key)) {
        const spaced = flat(v);
        const word = raw === 'reduce_motion'
            ? (ON_WORDS.includes(spaced) ? 'reduce' : OFF_WORDS.includes(spaced) ? 'full' : spaced)
            : spaced;
        const values = CHOICES[key];
        const aliases = Object.hasOwn(CHOICE_ALIASES, word) ? CHOICE_ALIASES[word] : [];
        return values.includes(word) || aliases.some(c => values.includes(c)) ? key : null;
    }
    if (Object.hasOwn(SWITCHES, key)) return ON_WORDS.includes(v) || OFF_WORDS.includes(v) ? key : null;
    if (key === 'speech_rate') return percentIn(value, 50, 200) ? key : null;
    if (key === 'ui_scale') return percentIn(value, 80, 160) ? key : null;
    if (key === 'theme_tint') return TINT_WORDS.includes(v) || HEX6.test(value) ? key : null;
    if (key === 'accent_color') return ACCENT_WORDS.includes(v) || HEX6.test(value) ? key : null;
    if (key === 'ui_language') return v === 'auto' || UI_LANGUAGES.some(([code, name]) => code === v || name.toLowerCase() === v) ? key : null;
    if (key === 'number_format') return v === 'auto' || NUMBER_STYLE_IDS.includes(flat(value)) ? key : null;
    return null;
}

/**
 * Every settable value as the app currently shows it, each written as a value
 * the marker accepts — so "put it back" can copy one verbatim.
 */
export function readSettable(getSetting) {
    const theme = String(getSetting('theme', '') || '');
    const tint = String(getSetting('theme_tint', '') || '').toLowerCase();
    const scale = Number(getSetting('ui_scale', null));
    const rate = Number(getSetting('speech_rate', null));
    const switches = Object.fromEntries(Object.entries(SWITCHES).map(([key, dflt]) => {
        const raw = getSetting(key, null);
        const on = raw == null || raw === '' ? dflt : dflt ? raw !== 'false' : raw === 'true';
        return [key, on ? 'on' : 'off'];
    }));
    const choices = Object.fromEntries(Object.entries(CHOICES).map(([key, values]) => {
        const raw = String(getSetting(key, '') ?? '');
        return [key, values.includes(raw) ? raw : values[0]];
    }));
    return {
        // `warm` and `black` were themes before a theme became a mode and a
        // tint; a library that never re-saved still carries the name. No row
        // at all follows the system.
        theme: theme === 'dark' || theme === 'black' ? 'dark' : !theme || theme === 'system' ? 'system' : 'light',
        theme_tint: !tint || tint === NO_TINT ? 'none' : tint,
        accent_color: getSetting('accent_color', null) || DEFAULT_ACCENT,
        ui_scale: Number.isFinite(scale) && scale > 0 ? Math.round(scale) : 100,
        ui_language: getSetting('ui_language', null) || 'auto',
        number_format: getSetting('number_format', null) || 'auto',
        ...choices,
        ...switches,
        speech_rate: Number.isFinite(rate) && rate >= 50 && rate <= 200 ? Math.round(rate) : 100,
    };
}

/**
 * The settable keys an answer's markers change, canonical and once each: the
 * ones the client applies, so a value it refuses is skipped and, like its
 * `splitSettingChanges`, at most three.
 */
export function settingKeysIn(content) {
    const keys = [];
    for (const m of String(content || '').matchAll(SET_MARKER_RE)) {
        const key = acceptedKey(m[1], m[2]);
        if (key && keys.length < 3 && !keys.includes(key)) keys.push(key);
    }
    return keys;
}

/**
 * What the keys an answer is about to change hold NOW. Called as the answer is
 * stored, which is before the client applies it (it applies at settle), so
 * these are the values the change replaces. Null when the answer sets nothing.
 */
export function settingsBefore(content, getSetting) {
    const keys = settingKeysIn(content);
    if (!keys.length) return null;
    const now = readSettable(getSetting);
    return Object.fromEntries(keys.map(k => [k, now[k]]));
}

/**
 * The prompt block. `recent` is newest first: `{ minutesAgo, before }` per
 * earlier answer that changed something.
 */
export function assistantSettingsBlock({ now, recent = [] }) {
    const current = SETTABLE_KEYS.map(k => `${k}: ${now[k]}`).join(' · ');
    const lines = recent.map(r => {
        const when = r.minutesAgo < 1 ? 'just now' : r.minutesAgo < 90 ? `${r.minutesAgo} min ago` : `${Math.round(r.minutesAgo / 60)} h ago`;
        const was = Object.entries(r.before).map(([k, v]) => `${k} was ${v}`).join('; ');
        return `- ${when}: ${was}`;
    });
    return `THE SETTINGS YOU CAN CHANGE, AS THEY ARE RIGHT NOW (read from the app this turn):
${current}
${lines.length
        ? `YOUR OWN RECENT CHANGES, newest first — what each key held BEFORE you changed it:
${lines.join('\n')}
UNDOING: "undo", "put it back" or "change it back" means setting those keys to what they held before, with ordinary markers — e.g. [[set:theme:light]]. You CAN do this; never send them to a button instead. A key whose value right now already equals what it held before has been put back already (there is an Undo beside each change you make): say so rather than setting it again.`
        : 'You have not changed any setting recently, so there is nothing of yours to undo; if they ask, say so and offer to set whatever they want.'}`;
}

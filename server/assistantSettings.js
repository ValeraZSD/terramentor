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
export const SETTABLE_KEYS = ['theme', 'theme_tint', 'accent_color', 'ui_scale', 'week_start_day', 'ui_language', 'number_format',
    'contrast', 'motion', 'letter_spacing', 'word_spacing', 'line_spacing', 'reading_line',
    'read_aloud', 'speech_rate', 'card_audio_autoplay', 'confirm_answers', 'key_shortcuts'];

/** The on/off rows, stored 'true'/'false', each with what an absent row means
 *  (the client's readers in accessibility.ts and store.ts). */
const SWITCHES = { reading_line: false, read_aloud: false, card_audio_autoplay: true, confirm_answers: false, key_shortcuts: true };
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
    numbers: 'number_format', number_separator: 'number_format', week_start: 'week_start_day',
    reduce_motion: 'motion', shortcuts: 'key_shortcuts', reading_speed: 'speech_rate', speech_speed: 'speech_rate',
};

/** The client's defaults (store.ts), so an absent row reads as what the app shows. */
const DEFAULT_ACCENT = '#0E7490';
const NO_TINT = '#ffffff';

const SET_MARKER_RE = /\[\[\s*set\s*:\s*([a-z_ -]+?)\s*:\s*([^\]]+?)\s*\]\]/gi;

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
        week_start_day: String(getSetting('week_start_day', '')) === '0' ? 'sunday' : 'monday',
        ui_language: getSetting('ui_language', null) || 'auto',
        number_format: getSetting('number_format', null) || 'auto',
        ...choices,
        ...switches,
        speech_rate: Number.isFinite(rate) && rate >= 50 && rate <= 200 ? Math.round(rate) : 100,
    };
}

/** The settable keys an answer's markers name, canonical and once each. */
export function settingKeysIn(content) {
    const keys = [];
    for (const m of String(content || '').matchAll(SET_MARKER_RE)) {
        const raw = m[1].trim().toLowerCase().replace(/[\s-]+/g, '_');
        const key = SETTABLE_KEYS.includes(raw) ? raw : ALIASES[raw];
        if (key && !keys.includes(key)) keys.push(key);
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

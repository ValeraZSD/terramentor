import { THEME_IDS, MIN_UI_SCALE, MAX_UI_SCALE, type Theme } from '../store';
import i18n, { LANGUAGES, isSupportedLanguage, k } from '../i18n';
import { weekdayName } from './locale';
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
 * the change, never writes SQL, and never learns what the setting was. The APP
 * validates the pair against the table below and applies it through the store
 * setter the Settings screen itself calls. A key that is not on this list, or a
 * value outside its range, does nothing at all and renders nothing — the same
 * failure mode as an invented node id: silence, never a wrong action.
 *
 * WHY THIS LIST AND NOTHING ELSE. Every setting here is (a) visible the instant
 * it lands, so a wrong one is self-reporting rather than discovered weeks later,
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

export type SettingKey = 'theme' | 'accent_color' | 'ui_scale' | 'week_start_day' | 'ui_language' | 'number_format';

export interface SettingChange {
    key: SettingKey;
    /** The validated value, in the shape the store setter takes. */
    value: string | number;
    /** What the chip says: "Theme → Dark". */
    label: string;
}

/** Accent presets the model can name in words. Matches Settings → Appearance. */
const ACCENT_NAMES: Record<string, string> = {
    cyan: '#0E7490', teal: '#0F766E', blue: '#1D4ED8', indigo: '#4338CA',
    violet: '#6D28D9', purple: '#7E22CE', pink: '#BE185D', rose: '#BE123C',
    red: '#B91C1C', orange: '#C2410C', amber: '#B45309', green: '#15803D',
    emerald: '#047857', slate: '#334155',
};

const THEME_LABELS: Record<Theme, string> = {
    light: k("Light"), warm: k("Warm"), dark: k("Dark"), black: k("Black"),
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
        const t = value.toLowerCase() as Theme;
        if (!THEME_IDS.includes(t)) return null;
        return { key: 'theme', value: t, label: i18n.t("Theme → {{name}}", { name: i18n.t(THEME_LABELS[t]) }) };
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

    if (key === 'week_start_day' || key === 'week_start') {
        const v = value.toLowerCase();
        const day = v === 'monday' || v === 'mon' || v === '1' ? 1
            : v === 'sunday' || v === 'sun' || v === '0' ? 0 : null;
        if (day === null) return null;
        return { key: 'week_start_day', value: day, label: i18n.t("Week starts → {{day}}", { day: weekdayName(day === 1 ? 1 : 7) }) };
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

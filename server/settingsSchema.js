// Every row of the `settings` table, named once: who may write it, what a value
// must look like, and what it touches.
//
// `PUT /api/settings/:key` (server/routes/settings.js) used to write any key a
// short list did not refuse, so every NEW row was client-writable by default:
// the update check's answer, the fitted scheduler parameters, the desktop
// switches that have their own guarded routes, the addresses the app sends the
// learner's prompts and documents to. The writer now reads this table instead
// and takes only what it lists as `client`, stored in the shape `validate`
// returns; anything it does not list is refused. tools/settings-registry-gates.mjs
// fails when the server names a row that is not here, and when the client
// writes one that is not `client`, so a new row has to be decided on.
//
// Each entry:
//   writable     'client' — the generic writer takes it;
//                'server' — the app writes it itself, or a dedicated route does
//                           (with its own checks), and the generic writer refuses it.
//   sensitivity  'ui'       how the app looks; nothing measured or sent changes;
//                'learning' what is scheduled, served or measured;
//                'ai'       which model answers, and how;
//                'network'  where the app sends requests — only from this
//                           computer or with the password (`ownerPresent`), as
//                           the desktop's own controls are;
//                'desktop'  the computer's own behaviour (routes under /api/desktop);
//                'internal' bookkeeping no person sets.
//   validate     value → the string to store; throws a SettingValueError for a
//                value the reader would not understand. Only on `client` rows.
//   apiOnly      a `client` row no screen writes (an operator's knob, set through
//                the API); the gate does not expect to find it in src/.
//
// Credentials are not here: `isSecretSettingKey` (server/auth.js) owns those
// names, and the writer refuses them before it looks at this table.

export class SettingValueError extends Error {}

const refuse = (why) => { throw new SettingValueError(why); };

/** A value arrives as JSON; a client sends strings, a script may send a number or a boolean. */
const asText = (value) => {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return String(value);
    return refuse('The value must be text');
};

// Control characters other than a line break or a tab have no business in a
// preference, and a NUL in a row is a trap for every later reader.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const text = (max, { lines = false } = {}) => (value) => {
    // Word and some PDFs paste a vertical tab or a form feed where a line ends.
    const s = lines ? asText(value).replace(/[\u000b\u000c]/g, '\n') : asText(value);
    if (s.length > max) refuse(`At most ${max} characters`);
    if (CONTROL.test(s) || (!lines && /[\r\n]/.test(s))) refuse('The value holds characters a setting cannot');
    return s;
};

const oneOf = (...allowed) => (value) => {
    const s = asText(value);
    return allowed.includes(s) ? s : refuse(`One of: ${allowed.map(a => a || '(empty)').join(', ')}`);
};

const bool = oneOf('true', 'false');

const int = (min, max) => (value) => {
    const s = asText(value).trim();
    if (!/^-?\d+$/.test(s)) refuse('A whole number');
    const n = Number(s);
    return n >= min && n <= max ? String(n) : refuse(`A whole number from ${min} to ${max}`);
};

const fraction = (value) => {
    const s = asText(value).trim();
    const n = Number(s);
    return s !== '' && Number.isFinite(n) && n >= 0 && n <= 1 ? String(n) : refuse('A number from 0 to 1');
};

const hex = (value) => {
    const s = asText(value).trim();
    // Six digits: the readers (appIcon.js hex6) take nothing shorter, and the
    // colour field always writes six (utils/color.ts toHex).
    return /^#[0-9a-fA-F]{6}$/.test(s) ? s : refuse('A colour written #rrggbb');
};

const json = (max, isShape) => (value) => {
    const s = asText(value);
    if (s.length > max) refuse(`At most ${max} characters`);
    let parsed;
    try { parsed = JSON.parse(s); } catch { refuse('Not valid JSON'); }
    return isShape(parsed) ? s : refuse('Not the expected shape');
};
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * An address the app will send requests to: http or https, parseable, no
 * user name or password inside it (a credential in a URL travels in every log
 * line and every error that quotes it), at most 2048 characters. Stored as
 * typed (trimmed), because the readers already normalise a trailing slash or a
 * missing `/v1` (normalizeOpenAIBaseUrl).
 */
const address = ({ allowEmpty = false } = {}) => (value) => {
    const s = asText(value).trim();
    if (s === '' && allowEmpty) return '';
    if (s.length > 2048) refuse('That address is too long');
    let u;
    try { u = new URL(s); } catch { refuse('Enter a full address starting with http:// or https://'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') refuse('Enter a full address starting with http:// or https://');
    if (u.username || u.password) refuse('Put the key in its own field, not inside the address');
    return s;
};

const FEED_NUMBERS = {
    // The bounds Settings → Feed clamps to (FeedSettingsPanel.tsx NUMBER_BOUNDS).
    feed_focus_total: [1, 20],
    feed_focus_per_project: [1, 10],
    feed_due_per_day: [0, 500],
    feed_new_per_project: [0, 100],
    feed_recall_per_batch: [0, 10],
    feed_max_parts: [1, 5],
};

const client = (sensitivity, validate, extra = {}) => ({ writable: 'client', sensitivity, validate, ...extra });
const server = (sensitivity) => ({ writable: 'server', sensitivity });

const MODEL_ID = text(256);

/** @type {Record<string, { writable: 'client'|'server', sensitivity: string, validate?: (v: unknown) => string, apiOnly?: boolean }>} */
export const SETTINGS = {
    // ---- How the app looks ------------------------------------------------------
    theme: client('ui', oneOf('light', 'dark')),
    theme_tint: client('ui', hex),
    // What the splash paints before the app loads (store.ts rememberPaintedSurfaces).
    theme_surfaces: client('ui', json(1024, isPlainObject)),
    accent_color: client('ui', hex),
    app_icon_style: client('ui', oneOf('full', 'simple')),
    app_icon_bg: client('ui', hex),
    app_icon_radius: client('ui', int(0, 50)),
    ui_scale: client('ui', int(80, 160)),
    ui_language: client('ui', (value) => {
        const s = asText(value).trim();
        return s === '' || s === 'auto' || /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,3}$/.test(s) ? s : refuse('A language code such as en or pt-BR');
    }),
    number_format: client('ui', text(16)),
    // 0 = Sunday, 1 = Monday (types.ts WeekStartDay); readers take anything else as Monday.
    week_start_day: client('ui', oneOf('0', '1')),
    // The bounds the store clamps the drag to (store.ts setSidebarWidth / setDetailPanelWidth).
    sidebarWidth: client('ui', int(200, 600)),
    detailPanelWidth: client('ui', int(300, 600)),
    atlas_color_mode: client('ui', oneOf('course', 'mastery')),
    atlas_surface: client('ui', oneOf('map', 'globe')),
    atlas_viewer: client('ui', json(4096, isPlainObject)),
    welcome_done: client('ui', bool),
    ai_setup_dismissed: client('ui', bool),
    // The library folder the notice was dismissed for, or '' to show it again.
    library_notice_dismissed: client('ui', text(4096)),
    activity_log_enabled: client('ui', bool),

    // ---- What is taught, scheduled and measured -----------------------------------
    user_profile: client('learning', text(20000, { lines: true })),
    mastery_gate_mode: client('learning', oneOf('off', 'advisory', 'enforced')),
    mastery_threshold: client('learning', fraction),
    mastery_check_pass: client('learning', fraction),
    mastery_check_size: client('learning', int(4, 30)),
    decay_days: client('learning', int(1, 365)),
    ...Object.fromEntries(Object.entries(FEED_NUMBERS).map(([k, [lo, hi]]) => [k, client('learning', int(lo, hi))])),
    feed_practice: client('learning', bool),
    feed_widgets: client('learning', bool),
    feed_prepare_check: client('learning', bool),
    feed_prepare_cards: client('learning', bool),
    creation_find_resources: client('learning', bool),
    // A practice drill's time per item: as written, double, triple or no clock
    // (src/components/drills/parseDrill.ts, DRILL_TIME_SCALES).
    drill_time_scale: client('learning', oneOf('1', '2', '3', 'off')),
    visual_kinds_off: client('learning', (value) => {
        const s = text(1000)(value);
        return /^[a-z0-9_,-]*$/.test(s) ? s : refuse('A comma-separated list of visual kinds');
    }),
    visual_tier: client('learning', oneOf('auto', 'basic', 'full')),
    pdf_math_recovery: client('learning', oneOf('auto', 'off')),
    pdf_recovery_vision: client('learning', oneOf('auto', 'always', 'never')),
    paper_vision: client('learning', oneOf('auto', 'always', 'never'), { apiOnly: true }),
    // The library-wide default; a project's own number has its own route.
    deck_new_per_day: client('learning', int(0, 9999), { apiOnly: true }),

    // ---- Which model answers ------------------------------------------------------
    ai_enabled: client('ai', bool),
    ai_model: client('ai', MODEL_ID),
    ai_openai_model: client('ai', MODEL_ID),
    ai_reasoning_effort: client('ai', text(32)),
    ai_provider_sort: client('ai', oneOf('', 'price', 'throughput', 'latency')),
    ai_provider_order: client('ai', json(4096, (v) => Array.isArray(v) && v.every(x => typeof x === 'string'))),
    pdf_recovery_vision_model: client('ai', MODEL_ID),
    paper_vision_model: client('ai', MODEL_ID, { apiOnly: true }),
    atlas_naming_model: client('ai', MODEL_ID),
    ai_web_search: client('ai', oneOf('on', 'off')),

    // ---- Where requests go ----------------------------------------------------------
    ai_provider: client('network', oneOf('ollama', 'openai')),
    ai_openai_base_url: client('network', address()),
    ai_ollama_url: client('network', address()),
    searxng_url: client('network', address({ allowEmpty: true })),
    // Embeddings are set through /api/embeddings/*, which re-indexes on a change.
    embedding_provider: server('network'),
    embedding_model: server('ai'),
    embedding_enabled: server('ai'),
    embedding_dim: server('internal'),
    embedding_space: server('internal'),

    // ---- The computer's own behaviour (/api/desktop/*, guarded there) ---------------
    desktop_keep_running: server('desktop'),
    desktop_window_mode: server('desktop'),
    desktop_autostart_window: server('desktop'),

    // ---- Updates (/api/updates/*; the answer is what the desktop updater acts on) ---
    update_latest: server('desktop'),
    update_last_check: server('desktop'),
    update_last_error: server('desktop'),
    update_answer_channel: server('desktop'),
    update_channel: server('desktop'),
    update_check: server('desktop'),
    update_check_asked: server('desktop'),

    // ---- Written by the app itself --------------------------------------------------
    bkt_params: server('learning'),
    bkt_params_meta: server('learning'),
    fsrs_params: server('learning'),
    fsrs_params_meta: server('learning'),
    onboarding_dismissed: server('ui'),
    placement_dismissed: server('learning'),
    celebrated_projects: server('ui'),
    first_lesson_read_at: server('internal'),
    inbox_project_id: server('internal'),
    node_roles_backfilled: server('internal'),
    study_time_since: server('internal'),
    today_briefing: server('internal'),
    app_version: server('internal'),
    openai_address_migration_done: server('internal'),
};

/**
 * Rows named at run time from a fixed prefix (a project id, an operation).
 * All are written by the server or by a route of their own.
 */
export const SETTING_FAMILIES = [
    { prefix: 'deck_new_per_day_', writable: 'server', sensitivity: 'learning' },
    { prefix: 'teach_topics_', writable: 'server', sensitivity: 'learning' },
    { prefix: 'creation_avg_ms_', writable: 'server', sensitivity: 'internal' },
    { prefix: 'bulk_avg_ms_', writable: 'server', sensitivity: 'internal' },
];

/** The entry for `key`, or null for a name this table does not know. */
export function settingSpec(key) {
    if (typeof key !== 'string') return null;
    if (Object.hasOwn(SETTINGS, key)) return SETTINGS[key];
    return SETTING_FAMILIES.find(f => key.startsWith(f.prefix) && key.length > f.prefix.length) ?? null;
}

/** The names the generic writer takes. */
export const CLIENT_SETTING_KEYS = Object.keys(SETTINGS).filter(k => SETTINGS[k].writable === 'client');

/**
 * The settings rows this page may write through `PUT /api/settings/:key`.
 *
 * The server refuses every other name (server/settingsSchema.js, the rows it
 * lists as `client`), so a write to a key missing there would fail only at run
 * time, as a "Couldn't save" toast. Typing `api.setSetting` with this list
 * moves that failure to `tsc`; tools/settings-registry-gates.mjs keeps the two
 * lists equal (the server's `apiOnly` rows aside, which no screen writes).
 */
export const CLIENT_SETTING_KEYS = [
    // How the app looks
    'theme', 'theme_tint', 'theme_surfaces', 'accent_color',
    'app_icon_style', 'app_icon_bg', 'app_icon_radius',
    'ui_scale', 'ui_language', 'number_format', 'week_start_day',
    'sidebarWidth', 'detailPanelWidth',
    'atlas_color_mode', 'atlas_surface', 'atlas_viewer',
    'welcome_done', 'ai_setup_dismissed', 'library_notice_dismissed', 'activity_log_enabled',
    // What is taught, scheduled and measured
    'user_profile', 'mastery_gate_mode', 'mastery_threshold', 'mastery_check_pass', 'mastery_check_size', 'decay_days',
    'feed_focus_total', 'feed_focus_per_project', 'feed_due_per_day', 'feed_new_per_project', 'feed_recall_per_batch', 'feed_max_parts',
    'feed_practice', 'feed_widgets', 'feed_prepare_check', 'feed_prepare_cards',
    'creation_find_resources', 'visual_kinds_off', 'visual_tier', 'pdf_math_recovery', 'pdf_recovery_vision',
    // Which model answers
    'ai_enabled', 'ai_model', 'ai_openai_model', 'ai_reasoning_effort', 'ai_provider_sort', 'ai_provider_order',
    'pdf_recovery_vision_model', 'atlas_naming_model', 'ai_web_search',
    // Where requests go (only on the computer, or with the password)
    'ai_provider', 'ai_openai_base_url', 'ai_ollama_url', 'searxng_url',
] as const;

export type ClientSettingKey = typeof CLIENT_SETTING_KEYS[number];

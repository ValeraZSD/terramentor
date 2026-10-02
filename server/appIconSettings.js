// The app icon and splash colours, read from the settings rows that choose them.
import { manifestColors } from './appIcon.js';
import { appIconFromSettings, ICON_SETTING_KEYS } from './iconArt.js';
import { getSetting } from './settingsStore.js';
const currentAppIcon = () => appIconFromSettings({
    [ICON_SETTING_KEYS.style]: getSetting(ICON_SETTING_KEYS.style, null),
    [ICON_SETTING_KEYS.background]: getSetting(ICON_SETTING_KEYS.background, null),
    [ICON_SETTING_KEYS.radius]: getSetting(ICON_SETTING_KEYS.radius, null),
});
// The splash an installed app paints before the first frame, and the strip
// above it: the app's own page and header, written by the client that painted
// them and ignored here unless they still match the theme settings below them.
const currentManifestColors = () => manifestColors({
    mode: getSetting('theme', null),
    tint: getSetting('theme_tint', null),
    painted: getSetting('theme_surfaces', null),
});

export { currentAppIcon, currentManifestColors };

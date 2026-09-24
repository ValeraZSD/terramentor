/**
 * The app's icon, on the client: the live preview in Settings, and the tags in
 * the document head that decide what a tab, a bookmark and an install actually
 * show.
 *
 * The drawing itself is `server/iconArt.js` — one module, imported by the build
 * tool that writes the shipped files, by the server that renders PNGs for an
 * install, and here. It has no dependencies and touches nothing platform-
 * specific, which is what lets the same file run in Node and in the bundle; the
 * alternative was a second copy of the geometry in TypeScript, and a logo kept
 * in two files is two logos within a release or two.
 *
 * WHAT A CHANGE REACHES, and what it does not:
 *
 *   the browser tab            immediately, here (a data: URL, no round trip)
 *   an "Install app" from now  immediately — the manifest is generated per
 *                              request and its link is re-stamped below
 *   an ALREADY installed PWA   when the platform next refreshes it. Android
 *                              re-reads the manifest on its own schedule and
 *                              rebuilds the launcher icon; iOS never does.
 *                              Reinstalling is the only way to see it at once.
 *   the packaged desktop app   its .exe/.icns icon is baked by
 *                              `tools/build-desktop.mjs` at PACKAGING time and
 *                              cannot be changed by a setting. The window's own
 *                              icon follows the favicon, because the window is
 *                              a Chromium `--app` window showing this page.
 *
 * Settings says all three of those in one sentence rather than promising
 * "everywhere" and being wrong twice.
 */
import {
    DEFAULT_BACKGROUND, DEFAULT_RADIUS, DEFAULT_STYLE, ICON_SETTING_KEYS, ICON_STYLES,
    MAX_RADIUS, MIN_RADIUS,
    appIconHash, appIconSvg, iconContrast, inkFor, normalizeAppIcon,
} from '../../server/iconArt.js';

export type IconStyle = 'full' | 'simple';
export type IconVariant = 'favicon' | 'tile' | 'maskable';

export interface AppIcon {
    style: IconStyle;
    background: string;
    radius: number;
}

export const ICON_STYLE_IDS = ICON_STYLES as IconStyle[];
export const DEFAULT_APP_ICON: AppIcon = {
    style: DEFAULT_STYLE as IconStyle,
    background: DEFAULT_BACKGROUND,
    radius: DEFAULT_RADIUS,
};
export { MIN_RADIUS, MAX_RADIUS };
/** The three settings rows, named where the server names them. */
export const ICON_KEYS = ICON_SETTING_KEYS as { style: string; background: string; radius: string };

/**
 * Whatever came back from the settings endpoint, as something drawable.
 *
 * The input is deliberately `unknown` per field, not `Partial<AppIcon>`: this is
 * the boundary between three TEXT rows in a kv table — writable by an older
 * build, by the settings endpoint, by hand — and a picture. A radius arrives as
 * the string "40".
 */
export type RawAppIcon = { style?: unknown; background?: unknown; radius?: unknown };

export const normalizeIcon = (raw: RawAppIcon | null | undefined): AppIcon =>
    normalizeAppIcon(raw) as AppIcon;

export const iconSvg = (icon: AppIcon, variant: IconVariant = 'tile', size = 64): string =>
    appIconSvg(icon, variant, size);

export const iconHash = (icon: AppIcon): string => appIconHash(icon);

/** How legible the mark is on the chosen tile, so the picker can say so. */
export const iconLegibility = (background: string): number => iconContrast(background);
export const iconInk = (background: string): string => inkFor(background);

/**
 * An SVG as a URL a `<link>` or an `<img>` can take.
 *
 * `encodeURIComponent`, not base64: it is smaller, it stays readable in the
 * devtools network panel, and `#` in a colour is the one character that must not
 * survive unescaped — a raw `#0b1220` in a data: URL is a FRAGMENT, and the
 * document then renders a mark with no tile at all.
 */
export const svgDataUrl = (svg: string): string =>
    `data:image/svg+xml,${encodeURIComponent(svg)}`;

/** The URL the server renders one PNG at. */
export const iconPngUrl = (name: string, hash: string): string => `/api/icon/${name}?v=${hash}`;

/**
 * Replace a head link rather than re-point it.
 *
 * Setting `href` on an existing `<link rel="icon">` is honoured by some browsers
 * and quietly ignored by others once the icon has been fetched; removing the
 * element and appending a new one is the spelling every engine treats as a new
 * icon. Cheap enough to do the reliable thing.
 */
function setHeadLink(selector: string, attrs: Record<string, string>) {
    document.head.querySelectorAll(selector).forEach((el) => el.remove());
    const link = document.createElement('link');
    Object.entries(attrs).forEach(([k, v]) => link.setAttribute(k, v));
    document.head.appendChild(link);
}

/**
 * Put the chosen icon on the document: the tab, the bookmark, the touch icon
 * and the manifest a fresh install would read.
 */
export function applyAppIcon(raw: RawAppIcon | null | undefined) {
    const icon = normalizeIcon(raw);
    const hash = iconHash(icon);
    const href = svgDataUrl(iconSvg(icon, 'favicon', 64));

    setHeadLink('link[rel="icon"][type="image/svg+xml"]', { rel: 'icon', type: 'image/svg+xml', href });
    // The PNG fallbacks are what a browser with no SVG-favicon support uses, and
    // they are rendered by the server rather than drawn here: a data: URL cannot
    // be a PNG without a canvas round trip, and these are asked for once.
    setHeadLink('link[rel="icon"][sizes="32x32"]', {
        rel: 'icon', type: 'image/png', sizes: '32x32', href: iconPngUrl('favicon-32.png', hash),
    });
    setHeadLink('link[rel="icon"][sizes="16x16"]', {
        rel: 'icon', type: 'image/png', sizes: '16x16', href: iconPngUrl('favicon-16.png', hash),
    });
    setHeadLink('link[rel="apple-touch-icon"]', {
        rel: 'apple-touch-icon', href: iconPngUrl('apple-touch-180.png', hash),
    });
    // The manifest's CONTENT is generated per request, so this only has to make
    // the browser ask again — which it does for a URL it has not seen.
    setHeadLink('link[rel="manifest"]', { rel: 'manifest', href: `/manifest.webmanifest?v=${hash}` });

    return { hash, href };
}

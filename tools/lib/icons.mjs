// The .ico / .icns builders moved to `server/iconContainers.js` on 2026-09-21,
// because the RUNNING app now builds an .ico too: changing the app icon in
// Settings rewrites the file the Windows tray and every shortcut read, and a
// packaged install contains `server/` and not `tools/`.
//
// This file stays as the build's door so `brand.mjs`, `build-desktop.mjs` and
// `desktop-gates.mjs` keep one import between them.
export {
    rgbaAt, dibEntry, ICO_SIZES, buildIco, ICNS_TYPES, buildIcns, readIcoTable,
} from '../../server/iconContainers.js';

// Where a packaged copy runs from, and whether that place lets it behave as an
// installed app.
//
// On macOS the package is an app bundle and the app lives INSIDE it, at
// `Terramentor.app/Contents/Resources/app` (tools/build-desktop.mjs puts it
// there, desktop/wrappers/app-bundle-main.sh starts it from there). Two places
// a bundle can be opened from are not somewhere it can stay:
//
//   * a TRANSLOCATED copy. A downloaded app opened where it was unpacked is run
//     by macOS from a read-only copy at a random path under
//     /private/var/folders/…/AppTranslocation/<id>/d/, which disappears when
//     the app quits. Nothing written there survives, a login item naming that
//     path stops working at the next restart, and an update cannot be staged.
//     Moving the app with the Finder (into Applications) ends it.
//   * a bundle in a folder this account cannot write to: a disk image, a
//     shared Applications folder on an account that is not an administrator.
//
// The server reads this for the update panel (server/appUpdate.js) and the
// desktop info (server/desktop.js); the launcher reads it to decide whether a
// login item can name this copy. Node built-ins only, no side effects.

import { accessSync, constants } from 'node:fs';

/** The app's folder inside a macOS bundle, below `<Name>.app/`. */
export const MAC_APP_IN_BUNDLE = 'Contents/Resources/app';

/** The bundle a packaged copy at `appRoot` lives in (`/Applications/Terramentor.app`),
 *  or null when `appRoot` is not the app folder of a bundle (Windows, Linux, a
 *  checkout). Judged on the path alone, so any name the bundle was given counts.
 *  Backslashes read as separators so the gates can ask on any machine. */
export function macBundleOf(appRoot) {
    const p = String(appRoot || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const m = /^(.+\.app)\/Contents\/Resources\/app$/.exec(p);
    return m ? m[1] : null;
}

/** Whether `path` is inside a copy macOS translocated (see above). */
export function isTranslocated(path) {
    return /\/AppTranslocation\/[^/]+\//.test(String(path || '').replace(/\\/g, '/'));
}

/** Whether this account may write into `dir`, asked of the permissions alone.
 *  Never by writing: inside an app bundle a write by the app itself can be
 *  refused by macOS's App Management protection, and a probe that raised that
 *  refusal every time the update panel opened would put a system notice on
 *  screen for nothing. The first real write is the download the person asked for. */
export function mayWrite(dir) {
    try { accessSync(dir, constants.W_OK); return true; } catch { return false; }
}

/**
 * Where a packaged copy runs from, when that matters: null on anything but a
 * macOS bundle, else `{ bundle, problem }` where `problem` is 'translocated',
 * 'read-only' or null (the bundle is somewhere it can stay and update itself).
 */
export function appPlacement({ appRoot, platform = process.platform, writable = mayWrite } = {}) {
    if (platform !== 'darwin') return null;
    const bundle = macBundleOf(appRoot);
    if (!bundle) return null;
    if (isTranslocated(bundle)) return { bundle, problem: 'translocated' };
    if (!writable(appRoot)) return { bundle, problem: 'read-only' };
    return { bundle, problem: null };
}

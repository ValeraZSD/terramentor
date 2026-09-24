// THE ICON THE OPERATING SYSTEM READS, kept in step with the one the learner chose.
//
// `appIcon.js` answers the browser: the tab, the manifest, an installed PWA.
// None of that reaches Windows' own idea of what this app looks like — the
// Start Menu entry, the desktop and Startup shortcuts, the tray icon sitting in
// the notification area. Those read ONE file: `<install>/Terramentor.ico`,
// written once when the folder was packaged.
//
// So this module rewrites that file whenever the choice changes. It is a small
// module because the packaging already arranged everything else:
//
//   · all three shortcuts already carry `IconLocation = <install>\Terramentor.ico,0`
//     (`shortcutScript` in desktop/lib.js has always passed it), so they follow
//     the file rather than the executable;
//   · `Launcher.cs` loads its `NotifyIcon` from that same path at start, so the
//     tray follows it at the next launch;
//   · the launcher hands the path over in `TERRAMENTOR_LAUNCH_ICON`, so this
//     process does not have to work out where it was installed.
//
// WHAT IT CANNOT REACH, and there is no version of this that does: the icon
// compiled INTO `Terramentor.exe` by `/win32icon` at package time. That is a
// resource inside a running image — Windows holds the file open, and rewriting
// a program's own bytes is what a virus does. Explorer therefore keeps drawing
// the built-in mark for the .exe FILE itself; everything a person actually
// presses is a shortcut, and shortcuts follow. The panel says so.
//
// The app WINDOW needs nothing from here: it is a Chromium `--app` window, so
// its taskbar button draws the page's favicon, which is already rendered from
// the setting (measured on Windows 10, 2026-09-21 — the taskbar showed the
// mark, not Edge's logo).
//
// Everything here fails quietly. A read-only install folder, a machine with no
// icon at all, a rasteriser that throws: the app keeps the icon it had, which
// is a cosmetic outcome. Nothing in here is allowed to be the reason a setting
// will not save.

import { writeFile, readFile, utimes } from 'node:fs/promises';
import { appIconHash, appIconSvg, normalizeAppIcon } from './iconArt.js';
import { pngFromSvg } from './iconRaster.js';
import { buildIco } from './iconContainers.js';

/** The tile cut at the largest size an .ico entry uses; every smaller entry is
 *  resampled from it, which is what `buildIco` does. */
const SOURCE_SIZE = 256;

/** Where the launcher said this install keeps the file, or null off the desktop
 *  (Docker, `npm run dev`, a server someone runs by hand — none of which has a
 *  Start Menu entry to keep in step). */
export const desktopIconPath = (env = process.env) =>
    (process.platform === 'win32' && env.TERRAMENTOR_LAUNCH_ICON) || null;

/** Build the .ico bytes for one icon choice. Exported for the gate, which reads
 *  the table back out rather than trusting the length. */
export async function icoFor(icon) {
    const png = await pngFromSvg(appIconSvg(normalizeAppIcon(icon), 'tile', SOURCE_SIZE), SOURCE_SIZE);
    return buildIco(png);
}

// The hash of what is currently on disk, so a settings write that did not change
// the picture costs nothing. Starts null: the first call after a boot always
// writes, which is also how an install whose icon predates this module catches up.
let writtenHash = null;

/** A second write while the first is in flight would race on one path. */
let inFlight = null;

/**
 * Put the current icon on disk, if this is a desktop install and it moved.
 *
 * Returns what happened, for the gate and for the log — never throws.
 */
export async function refreshDesktopIcon(icon, { env = process.env, write = writeFile } = {}) {
    const path = desktopIconPath(env);
    if (!path) return { written: false, why: 'not a desktop install' };
    const hash = appIconHash(icon);
    if (hash === writtenHash) return { written: false, why: 'unchanged' };
    if (inFlight) await inFlight.catch(() => {});
    inFlight = (async () => {
        const ico = await icoFor(icon);
        // Byte-compare before writing. A tray icon is read at launch, so a
        // rewrite costs nothing on its own — but Windows keys its shortcut icon
        // cache on the file's path and timestamp, so touching a file whose
        // contents did not change is how you make Explorer redraw for no reason.
        try {
            const current = await readFile(path);
            if (current.equals(ico)) return { written: false, why: 'already that picture' };
        } catch { /* missing or unreadable: write it */ }
        await write(path, ico);
        // …and when it DID change, make sure the timestamp moved with it, because
        // that is the only thing the shell's icon cache looks at.
        try { const now = new Date(); await utimes(path, now, now); } catch { /* cosmetic */ }
        return { written: true, path };
    })();
    try {
        const result = await inFlight;
        writtenHash = hash;
        return result;
    } catch (err) {
        return { written: false, why: err?.message || 'could not write the icon' };
    } finally {
        inFlight = null;
    }
}

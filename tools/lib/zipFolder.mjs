// The desktop packages' zip writer (tools/build-desktop.mjs), apart so a gate
// can read back what it writes.
import { createReadStream, createWriteStream, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import JSZip from 'jszip';

/**
 * The mode a zip entry is stored with for a package built for `platform`: the
 * full mode, regular-file type bits included, as Info-ZIP writes it. macOS
 * `ditto` (and so Archive Utility) unpacks an entry whose mode carries no
 * type as -rw-r--r--, dropping the executable bit an app cannot start without.
 */
export function zipEntryMode(statMode, platform) {
    return platform !== 'win32' && (statMode & 0o111) !== 0 ? 0o100755 : 0o100644;
}

/** Zip a folder under `rootName/`, streaming, keeping executable bits for macOS/Linux readers. */
export async function zipFolder(folder, zipPath, rootName, platform) {
    const zip = new JSZip();
    const walk = (d) => {
        for (const f of readdirSync(d)) {
            const p = join(d, f);
            const rel = `${rootName}/${relative(folder, p).split(sep).join('/')}`;
            const st = statSync(p);
            if (st.isDirectory()) { walk(p); continue; }
            zip.file(rel, createReadStream(p), { unixPermissions: zipEntryMode(st.mode, platform), date: st.mtime });
        }
    };
    walk(folder);
    await new Promise((res, rej) => {
        zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, platform: platform === 'win32' ? 'DOS' : 'UNIX', compression: 'DEFLATE', compressionOptions: { level: 6 } })
            .pipe(createWriteStream(zipPath))
            .on('finish', res)
            .on('error', rej);
    });
}

// Platform icon containers from the app's PNGs — no dependency, because both
// formats are a header, a table, and the PNG bytes.
//
// Under `server/` rather than `tools/` for the same reason `iconArt.js` is: the
// packaged desktop folder ships `dist`, `server`, `desktop` and `node_modules`,
// and the Docker image ships less than that. This is no longer only a BUILD
// step — a running app rewrites its own `Terramentor.ico` when the learner
// changes the icon (`desktopIcon.js`), and a module the package does not
// contain cannot do that. `tools/lib/icons.mjs` re-exports it so the build and
// its gate keep their old import.
//
//   ICO  the Windows launcher's embedded icon and the Start Menu shortcut's.
//        Every entry here is a classic 32-bit DIB rather than an embedded PNG:
//        Vista+ reads PNG entries, but the C# compiler's `/win32icon` and the
//        shell's shortcut icon reader are pickier, and a DIB is what every reader
//        since Windows 95 understands. Sizes 16/24/32/48/64/128/256.
//   ICNS macOS reads PNG data inside the container directly (since 10.7), so
//        the entries ARE the PNGs, typed by size.
//
// `@napi-rs/canvas` is already a dependency (PDF recovery renders pages with
// it), so decoding and resizing costs nothing new.

import { createCanvas, loadImage } from '@napi-rs/canvas';

/** Decode a PNG buffer and render it at `size`×`size` as RGBA, top-down. */
export async function rgbaAt(pngBuffer, size) {
    const img = await loadImage(pngBuffer);
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, size, size);
    return { rgba: Buffer.from(ctx.getImageData(0, 0, size, size).data), png: canvas.toBuffer('image/png') };
}

/** One ICO image entry as a DIB: BITMAPINFOHEADER + BGRA bottom-up + AND mask. */
export function dibEntry(rgba, size) {
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);            // biSize
    header.writeInt32LE(size, 4);           // biWidth
    header.writeInt32LE(size * 2, 8);       // biHeight: XOR + AND masks
    header.writeUInt16LE(1, 12);            // biPlanes
    header.writeUInt16LE(32, 14);           // biBitCount
    header.writeUInt32LE(0, 16);            // BI_RGB
    header.writeUInt32LE(size * size * 4, 20);
    const xor = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
        const src = (size - 1 - y) * size * 4;    // bottom-up
        const dst = y * size * 4;
        for (let x = 0; x < size; x++) {
            const s = src + x * 4, d = dst + x * 4;
            xor[d] = rgba[s + 2];       // B
            xor[d + 1] = rgba[s + 1];   // G
            xor[d + 2] = rgba[s];       // R
            xor[d + 3] = rgba[s + 3];   // A
        }
    }
    const rowBytes = Math.ceil(size / 32) * 4;    // 1 bpp rows padded to 4 bytes
    const and = Buffer.alloc(rowBytes * size);    // all zero: alpha decides
    return Buffer.concat([header, xor, and]);
}

export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** Build an .ico from a source PNG at every standard size. */
export async function buildIco(pngBuffer, sizes = ICO_SIZES) {
    const entries = [];
    for (const size of sizes) {
        const { rgba } = await rgbaAt(pngBuffer, size);
        entries.push({ size, data: dibEntry(rgba, size) });
    }
    const dir = Buffer.alloc(6);
    dir.writeUInt16LE(0, 0);                // reserved
    dir.writeUInt16LE(1, 2);                // type: icon
    dir.writeUInt16LE(entries.length, 4);
    const table = Buffer.alloc(16 * entries.length);
    let offset = 6 + table.length;
    entries.forEach((e, i) => {
        const at = i * 16;
        table.writeUInt8(e.size === 256 ? 0 : e.size, at);       // 0 means 256
        table.writeUInt8(e.size === 256 ? 0 : e.size, at + 1);
        table.writeUInt8(0, at + 2);        // palette
        table.writeUInt8(0, at + 3);        // reserved
        table.writeUInt16LE(1, at + 4);     // planes
        table.writeUInt16LE(32, at + 6);    // bpp
        table.writeUInt32LE(e.data.length, at + 8);
        table.writeUInt32LE(offset, at + 12);
        offset += e.data.length;
    });
    return Buffer.concat([dir, table, ...entries.map((e) => e.data)]);
}

/** ICNS type codes for PNG entries, by pixel size. */
export const ICNS_TYPES = { 16: 'icp4', 32: 'icp5', 64: 'icp6', 128: 'ic07', 256: 'ic08', 512: 'ic09', 1024: 'ic10' };

/** Build an .icns from a source PNG: PNG bytes at each size, typed. */
export async function buildIcns(pngBuffer, sizes = [16, 32, 64, 128, 256, 512]) {
    const chunks = [];
    for (const size of sizes) {
        const { png } = await rgbaAt(pngBuffer, size);
        const head = Buffer.alloc(8);
        head.write(ICNS_TYPES[size], 0, 'ascii');
        head.writeUInt32BE(8 + png.length, 4);
        chunks.push(head, png);
    }
    const body = Buffer.concat(chunks);
    const head = Buffer.alloc(8);
    head.write('icns', 0, 'ascii');
    head.writeUInt32BE(8 + body.length, 4);
    return Buffer.concat([head, body]);
}

/** Read the entries back out of an .ico — for the gate, and for nothing else. */
export function readIcoTable(ico) {
    const n = ico.readUInt16LE(4);
    const out = [];
    for (let i = 0; i < n; i++) {
        const at = 6 + i * 16;
        const w = ico.readUInt8(at) || 256;
        out.push({ size: w, bpp: ico.readUInt16LE(at + 6), bytes: ico.readUInt32LE(at + 8), offset: ico.readUInt32LE(at + 12) });
    }
    return out;
}

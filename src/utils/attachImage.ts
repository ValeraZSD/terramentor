/**
 * A picture made ready to attach, in the browser, before it is uploaded.
 *
 *   - A phone photo is redrawn as a JPEG no larger than `MAX_EDGE` on its
 *     long edge. Three things come of that: a 12-megapixel photo uploads as a
 *     few hundred kilobytes instead of several megabytes; the photo's own
 *     rotation is baked in (`imageOrientation: 'from-image'`), where a model
 *     reading the raw bytes would read a sideways page sideways; and the
 *     camera's metadata — the place it was taken — is not sent anywhere.
 *   - A HEIC photo copied off an iPhone is converted the same way when the
 *     browser can draw it (Safari can); when it cannot, the caller refuses it
 *     with the reason, because no model here is sent HEIC.
 *   - A screenshot (PNG, WebP) small enough is sent untouched, so its text
 *     stays sharp; a GIF is never redrawn (that would drop its frames).
 *
 * Returns null when the browser cannot draw the picture at all.
 */
export const MAX_EDGE = 2048;
/** A PNG or WebP above this is redrawn even when it is not too wide. */
const REDRAW_BYTES = 4 * 1024 * 1024;

const isHeic = (f: File) => /\.(heic|heif)$/i.test(f.name) || /image\/hei[cf]/i.test(f.type);
const isJpeg = (f: File) => /\.jpe?g$/i.test(f.name) || f.type === 'image/jpeg';
const isGif = (f: File) => /\.gif$/i.test(f.name) || f.type === 'image/gif';

function jpegName(name: string): string {
    return `${name.replace(/\.[^.]+$/, '') || 'photo'}.jpg`;
}

export async function prepareImage(file: File): Promise<{ blob: Blob; name: string } | null> {
    if (isGif(file)) return { blob: file, name: file.name };
    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
        return isHeic(file) ? null : { blob: file, name: file.name };
    }
    try {
        const long = Math.max(bitmap.width, bitmap.height);
        const redraw = isHeic(file) || isJpeg(file) || long > MAX_EDGE || file.size > REDRAW_BYTES;
        if (!redraw) return { blob: file, name: file.name };
        const scale = Math.min(1, MAX_EDGE / long);
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return { blob: file, name: file.name };
        // A transparent screenshot drawn onto JPEG would go black behind it.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(bitmap, 0, 0, w, h);
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.88));
        return blob ? { blob, name: jpegName(file.name) } : { blob: file, name: file.name };
    } finally {
        bitmap.close();
    }
}

import { useEffect, useRef, useState } from 'react';
import { Camera, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Modal from './Modal';
import { Button } from './ui/Button';

/** How often a live frame is read. A code is held steady for a second or more; four reads a second is plenty and keeps a phone cool. */
const READ_EVERY_MS = 250;

/** The one-time code inside a scanned Settings QR (`…/#pair=<code>`), or null for any other code. */
export function pairCodeFrom(text: string): string | null {
    const m = /[#&]pair=([A-Za-z0-9_-]{16,})/.exec(String(text || ''));
    return m ? m[1] : null;
}

/** A live camera needs a secure page (the Tailscale address is one; plain-http home Wi-Fi is not) and the camera API. */
export const canScanLive = () => typeof window !== 'undefined' && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;

type Source = HTMLVideoElement | HTMLCanvasElement | ImageBitmap;

/**
 * Read a QR code off a picture: the browser's own BarcodeDetector where it has
 * one (Chrome and Samsung Internet on Android), else jsQR, loaded only now.
 */
async function readQr(source: Source): Promise<string | null> {
    const Detector = (window as any).BarcodeDetector;
    if (Detector) {
        try {
            const found = await new Detector({ formats: ['qr_code'] }).detect(source);
            if (found?.length) return String(found[0].rawValue || '');
            return null;
        } catch { /* fall through to jsQR */ }
    }
    const w = 'videoWidth' in source ? source.videoWidth : source.width;
    const h = 'videoHeight' in source ? source.videoHeight : source.height;
    if (!w || !h) return null;
    const scale = Math.min(1, 1024 / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(source as CanvasImageSource, 0, 0, canvas.width, canvas.height);
    const { default: jsQR } = await import('jsqr');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(data.data, data.width, data.height)?.data ?? null;
}

/**
 * The phone's own camera app, for a photo of the code: what Scan code opens
 * where there is no live camera, and the way on when the camera was refused.
 * `open()` must run inside the press itself, or the browser blocks the picker.
 */
export function usePhotoScan(onCode: (code: string) => void, onError: (message: string) => void) {
    const { t } = useTranslation();
    const ref = useRef<HTMLInputElement>(null);
    const read = async (f: File | undefined) => {
        if (!f) return;
        try {
            const text = await readQr(await createImageBitmap(f));
            const code = text && pairCodeFrom(text);
            if (code) onCode(code);
            else if (text) onError(t("That is not a Terramentor code. Scan the one in Settings → Data → Other devices on the computer."));
            else onError(t("No code found in that photo. Hold the phone closer, keep the whole code in the picture, and try again."));
        } catch {
            onError(t("That photo could not be read. Try again."));
        }
    };
    const input = (
        <input
            ref={ref}
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={e => { void read(e.target.files?.[0]); e.target.value = ''; }}
        />
    );
    return { input, open: () => ref.current?.click() };
}

/**
 * Scan the code Settings shows on the computer, live, from inside the app.
 *
 * A phone's own camera app reads the code too, but it opens the BROWSER, and an
 * app installed to the home screen (iOS above all) keeps its own sign-in apart
 * from the browser's — so the connection would land in the wrong place. Here
 * the code is read and spent by the page that is asking. Opened only where a
 * live camera can work (`canScanLive`); a refused camera offers a photo.
 */
export default function QrScanner({ open, onClose, onCode }: { open: boolean; onClose: () => void; onCode: (code: string) => void }) {
    const { t } = useTranslation();
    const video = useRef<HTMLVideoElement>(null);
    const [live, setLive] = useState<'starting' | 'on' | 'off'>('starting');
    const [note, setNote] = useState('');
    const done = useRef(false);
    const photo = usePhotoScan((code) => { done.current = true; onCode(code); }, setNote);

    const accept = (text: string | null) => {
        if (done.current || !text) return false;
        const code = pairCodeFrom(text);
        if (!code) { setNote(t("That is not a Terramentor code. Scan the one in Settings → Data → Other devices on the computer.")); return false; }
        done.current = true;
        onCode(code);
        return true;
    };

    useEffect(() => {
        if (!open) return;
        done.current = false;
        setNote('');
        setLive('starting');
        let stream: MediaStream | null = null;
        let timer: number | undefined;
        let stopped = false;
        navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
            .then(async (s) => {
                if (stopped) { s.getTracks().forEach(tr => tr.stop()); return; }
                stream = s;
                const v = video.current;
                if (!v) return;
                v.srcObject = s;
                await v.play().catch(() => { });
                setLive('on');
                const tick = async () => {
                    if (stopped || done.current) return;
                    try { if (v.readyState >= 2 && accept(await readQr(v))) return; } catch { /* the next frame */ }
                    timer = window.setTimeout(tick, READ_EVERY_MS);
                };
                void tick();
            })
            .catch(() => { if (!stopped) { setLive('off'); setNote(t("The camera could not be opened here. Take a photo of the code instead.")); } });
        return () => {
            stopped = true;
            if (timer) clearTimeout(timer);
            stream?.getTracks().forEach(tr => tr.stop());
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    return (
        <Modal isOpen={open} onClose={onClose} title={t("Scan the code")} maxWidth="max-w-md">
            <div className="space-y-4">
                {live !== 'off' && (
                    <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-black">
                        <video ref={video} playsInline muted className="h-full w-full object-cover" />
                        {/* The frame to aim with, the rest of the picture dimmed
                            so the frame holds on a bright camera image. */}
                        <div className="pointer-events-none absolute inset-[22%] rounded-2xl ring-4 ring-white shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]" aria-hidden="true" />
                        <p className="absolute inset-x-0 top-0 bg-gradient-to-b from-black/70 to-transparent px-4 pb-6 pt-3 text-center text-sm font-medium text-white">
                            {t("Point the camera at the code on the computer.")}
                        </p>
                        {live === 'starting' && (
                            <div className="absolute inset-0 flex items-center justify-center text-white">
                                <Loader2 className="h-8 w-8 animate-spin" aria-hidden="true" />
                            </div>
                        )}
                    </div>
                )}
                {note && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{note}</p>}
                {live === 'off' && (
                    <>
                        {photo.input}
                        <Button block variant="primary" icon={<Camera className="h-4 w-4" aria-hidden="true" />} onClick={photo.open}>
                            {t("Open camera")}
                        </Button>
                    </>
                )}
            </div>
        </Modal>
    );
}

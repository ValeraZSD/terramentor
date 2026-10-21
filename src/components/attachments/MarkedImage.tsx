import { CSSProperties, useEffect, useRef, useState } from 'react';

/** A box in fractions of the picture: `[x0, y0, x1, y1]`. */
export type ImageBox = [number, number, number, number];

/** The label's height above the box, gap included, in px (text-xs + padding). */
const LABEL_ROOM_PX = 26;

/**
 * A picture with one part of it boxed and the rest dimmed, the box drawn in
 * fractions of the PICTURE. So the element the box is positioned in must be
 * exactly the picture: a frame wider or taller than it (an `<img>` capped in
 * height keeps its width and letterboxes the picture inside) puts the box
 * beside what it marks. The frame is therefore sized here, from the picture's
 * own shape, as the smallest of its natural width, the room it is given and
 * the width at which it reaches its height cap; never left to `object-contain`.
 *
 * `maxWidth` and `maxHeight` are CSS lengths. The shape comes from the stored
 * width and height until the file has loaded, then from the file.
 */
export default function MarkedImage({ src, width, height, box, label, maxWidth = '100%', maxHeight, alt = '', className = '' }: {
    src: string;
    width?: number | null;
    height?: number | null;
    box?: ImageBox | null;
    label?: string;
    maxWidth?: string;
    maxHeight: string;
    alt?: string;
    className?: string;
}) {
    const [loaded, setLoaded] = useState<{ src: string; w: number; h: number } | null>(null);
    const [failed, setFailed] = useState<string | null>(null);
    const frameRef = useRef<HTMLSpanElement>(null);
    const [drawn, setDrawn] = useState<{ w: number; h: number } | null>(null);
    useEffect(() => {
        const el = frameRef.current;
        if (!el || !box || !label) return;
        const measure = () => setDrawn({ w: el.clientWidth, h: el.clientHeight });
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [box, label]);
    // The file's own shape once it has loaded: a stored size that disagrees
    // with the pixels (an orientation the server did not read) must not skew
    // the box. Both numbers come from one source, never one from each.
    const own = loaded?.src === src && loaded.w > 0 && loaded.h > 0 ? loaded : null;
    const w = own ? own.w : width;
    const h = own ? own.h : height;
    const frame: CSSProperties = w && h
        ? { width: `min(${maxWidth}, ${w}px, calc(${maxHeight} * ${w / h}))`, aspectRatio: `${w} / ${h}` }
        // Shape not known yet: the picture sizes itself until it loads.
        : { maxWidth, maxHeight };
    if (failed === src) {
        return (
            <span className={`flex items-center justify-center p-4 text-sm text-slate-500 dark:text-slate-400 ${className}`} style={{ ...frame, minHeight: '4rem' }}>
                {alt}
            </span>
        );
    }
    // The label sits on the box's top edge, or inside it when the picture
    // drawn this size has no room above the box. It hangs from whichever end
    // of the box leaves it more of the picture, and is never wider than that.
    let labelInside = box ? box[1] < 0.08 : false;
    let labelRight = box ? box[0] > 0.5 : false;
    let labelMax = '16rem';
    if (box && drawn && drawn.w > 0) {
        labelInside = box[1] * drawn.h < LABEL_ROOM_PX;
        const roomRight = (1 - box[0]) * drawn.w;
        const roomLeft = box[2] * drawn.w;
        labelRight = roomLeft > roomRight;
        labelMax = `min(16rem, ${Math.max(0, Math.floor(Math.max(roomLeft, roomRight)) - 4)}px)`;
    }
    return (
        <span ref={frameRef} className={`relative block overflow-hidden ${className}`} style={frame}>
            <img
                src={src}
                alt={alt}
                onLoad={e => setLoaded({ src, w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                onError={() => setFailed(src)}
                className={w && h ? 'absolute inset-0 block w-full h-full' : 'block max-w-full h-auto'}
                style={w && h ? undefined : { maxHeight }}
            />
            {box && (
                <span
                    aria-hidden="true"
                    data-marked-box
                    className="absolute rounded-md border-[3px] border-accent shadow-[0_0_0_9999px_rgba(15,23,42,0.16)]"
                    style={{
                        left: `${box[0] * 100}%`,
                        top: `${box[1] * 100}%`,
                        width: `${(box[2] - box[0]) * 100}%`,
                        height: `${(box[3] - box[1]) * 100}%`,
                    }}
                >
                    {label && (
                        <span
                            className={`absolute ${labelRight ? 'right-[-3px]' : 'left-[-3px]'} truncate rounded-md bg-accent px-1.5 py-0.5 text-xs font-medium text-white ${labelInside ? 'top-0' : 'bottom-full mb-1'}`}
                            style={{ maxWidth: labelMax }}
                        >
                            {label}
                        </span>
                    )}
                </span>
            )}
        </span>
    );
}

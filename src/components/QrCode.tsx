import { useMemo } from 'react';
import { encode } from 'uqr';

/**
 * A QR code drawn as one SVG path, black on white whatever the theme: a
 * scanner reads dark modules on a light ground, and a dark theme's inverted
 * code is one some phone cameras refuse. `shape-rendering: crispEdges` keeps
 * the modules square when the box is not a whole multiple of them.
 */
export default function QrCode({ text, label, className = '' }: { text: string; label: string; className?: string }) {
    const { size, path } = useMemo(() => {
        const { data, size } = encode(text, { ecc: 'M', border: 2 });
        let d = '';
        data.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x} ${y}h1v1h-1z`; }));
        return { size, path: d };
    }, [text]);
    return (
        <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges" className={className}>
            <rect width={size} height={size} fill="#fff" />
            <path d={path} fill="#000" />
        </svg>
    );
}

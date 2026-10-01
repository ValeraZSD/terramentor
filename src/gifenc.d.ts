// gifenc ships no types. Only the surface exportVisual.ts uses is declared.
declare module 'gifenc' {
    export type PaletteFormat = 'rgb565' | 'rgb444' | 'rgba4444';
    export type Palette = number[][];
    export interface WriteFrameOptions {
        palette?: Palette;
        delay?: number;
        repeat?: number;
        transparent?: boolean;
        transparentIndex?: number;
        dispose?: number;
        first?: boolean;
    }
    export interface Encoder {
        writeFrame(index: Uint8Array, width: number, height: number, opts?: WriteFrameOptions): void;
        finish(): void;
        bytes(): Uint8Array;
        bytesView(): Uint8Array;
        reset(): void;
    }
    export function GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): Encoder;
    export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, opts?: { format?: PaletteFormat; oneBitAlpha?: boolean | number; clearAlpha?: boolean; clearAlphaThreshold?: number; clearAlphaColor?: number }): Palette;
    export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: PaletteFormat): Uint8Array;
    export default GIFEncoder;
}

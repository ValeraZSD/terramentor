// smiles-drawer ships no TypeScript types; minimal shim for what we use.
declare module 'smiles-drawer' {
    interface SvgDrawerOptions {
        width?: number;
        height?: number;
        [key: string]: unknown;
    }

    class SvgDrawer {
        constructor(options?: SvgDrawerOptions);
        draw(tree: unknown, target: SVGElement | HTMLElement | string, theme?: string, infoOnly?: boolean): void;
    }

    const SmilesDrawer: {
        SvgDrawer: typeof SvgDrawer;
        parse(
            smiles: string,
            onSuccess: (tree: unknown) => void,
            onError?: (error: unknown) => void
        ): void;
    };

    export default SmilesDrawer;
}

import plugin from 'tailwindcss/plugin';

/** @type {import('tailwindcss').Config} */
export default {
    content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
    darkMode: 'class',
    theme: {
        extend: {
            colors: {
                // Theme accent — resolves to the current project's colour inside a
                // workspace, and to a neutral blue-cyan everywhere else. Driven by the
                // `--accent-rgb` CSS variable (space-separated RGB triplet) so every
                // Tailwind opacity modifier (bg-accent/10, ring-accent/60, …) works.
                accent: 'rgb(var(--accent-rgb) / <alpha-value>)',
                // Accent for *text* — same as `accent` on light surfaces, lightened in
                // dark mode (see index.css / Layout) so accent text always clears AA.
                'accent-fg': 'rgb(var(--accent-fg-rgb) / <alpha-value>)',
                // Surface palette is variable-driven so the 4 themes (light / warm /
                // dark / black) can retint the app without touching the ~1200 hardcoded
                // `slate`/`white` sites. Defaults (index.css `:root`) are EXACTLY the
                // stock Tailwind values, so Light + Dark render byte-identical to before;
                // only `[data-theme="warm"]` and `[data-theme="black"]` override them.
                // Triplets (space-separated RGB) keep every opacity modifier working.
                white: 'rgb(var(--c-white) / <alpha-value>)',
                slate: {
                    50: 'rgb(var(--c-slate-50) / <alpha-value>)',
                    100: 'rgb(var(--c-slate-100) / <alpha-value>)',
                    200: 'rgb(var(--c-slate-200) / <alpha-value>)',
                    300: 'rgb(var(--c-slate-300) / <alpha-value>)',
                    400: 'rgb(var(--c-slate-400) / <alpha-value>)',
                    500: 'rgb(var(--c-slate-500) / <alpha-value>)',
                    600: 'rgb(var(--c-slate-600) / <alpha-value>)',
                    700: 'rgb(var(--c-slate-700) / <alpha-value>)',
                    800: 'rgb(var(--c-slate-800) / <alpha-value>)',
                    900: 'rgb(var(--c-slate-900) / <alpha-value>)',
                },
            },
            animation: {
                'glow-pulse': 'glow-pulse 2s ease-in-out infinite',
            },
            keyframes: {
                'glow-pulse': {
                    '0%, 100%': { boxShadow: '0 0 8px rgba(16, 185, 129, 0.4), 0 0 20px rgba(16, 185, 129, 0.2)' },
                    '50%': { boxShadow: '0 0 16px rgba(16, 185, 129, 0.6), 0 0 40px rgba(16, 185, 129, 0.4)' },
                },
            },
        },
    },
    plugins: [
        // Input-capability variants. A width breakpoint is NOT a proxy for
        // "has a mouse": a phone rotated to landscape clears `sm:`, so any
        // affordance hidden until `:hover` became unreachable there. Gate those
        // on the pointer itself instead.
        //   can-hover:  a precise, hovering pointer (mouse/trackpad)
        //   touch:      no hover at all (finger/pen) — show controls outright
        plugin(({ addVariant }) => {
            addVariant('can-hover', '@media (hover: hover) and (pointer: fine)');
            addVariant('touch', '@media (hover: none)');
        }),
    ],
};
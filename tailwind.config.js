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
                // Surface palette is variable-driven so a theme can retint the app
                // without touching the ~1200 hardcoded `slate`/`white` sites. A theme
                // is a MODE and a TINT (`src/utils/themeRamp.ts`), and the twelve
                // variables are GENERATED from that pair and written as an inline style
                // on `<html>` — there are no per-theme stylesheet overrides, which
                // `theme-ramp-gates.mjs` asserts. `index.css`'s `:root` holds the
                // untinted ramp as the pre-script fallback and nothing else.
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
            // The small print under Tailwind's `xs` (12px): badges, keycaps,
            // eyebrows, captions. In REM so `ui_scale` reaches it — written as
            // `text-[11px]` / `text-[10px]` it stayed 11px at 160% beside 22px
            // body text. A bare size with no line-height,
            // exactly what the arbitrary class set, so 100% renders unchanged.
            // `typography-gates.mjs` refuses a px font size in a class name.
            fontSize: {
                '2xs': '0.6875rem', // 11px at 100%
                '3xs': '0.625rem',  // 10px at 100%
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
        // Safe-area insets: the status bar, the island, the home indicator and,
        // held sideways, the rounded corners of a phone. `index.html` asks for
        // the whole screen (`viewport-fit=cover`, a translucent status bar), so
        // a surface that touches an edge draws under them unless it pads.
        //   safe-p{,x,y,t,r,b,l}-N   padding of at least N, more where a
        //                            screen edge is covered: max(N, inset)
        //   safe-{top,bottom}-N      an offset N clear of the covered strip:
        //                            N + inset (a floating chip, a toast)
        // The insets are `--safe-*` in `index.css` (env(), 0px on a plain
        // screen), so off a phone every one of these is exactly its base.
        // `safe-area-gates.mjs` fails a fixed surface on an edge without one.
        plugin(({ matchUtilities, theme }) => {
            // Widest first, so `safe-p-4 safe-pb-0` lets the one side win, the
            // way `p-4 pb-0` does.
            const side = { '': ['top', 'right', 'bottom', 'left'], x: ['left', 'right'], y: ['top', 'bottom'], t: ['top'], r: ['right'], b: ['bottom'], l: ['left'] };
            const cap = s => s[0].toUpperCase() + s.slice(1);
            const values = theme('spacing');
            for (const [key, edges] of Object.entries(side)) {
                matchUtilities({
                    [`safe-p${key}`]: v => Object.fromEntries(edges.map(e => [`padding${cap(e)}`, `max(${v}, var(--safe-${e}))`])),
                }, { values });
            }
            for (const e of ['top', 'bottom']) {
                matchUtilities({ [`safe-${e}`]: v => ({ [e]: `calc(${v} + var(--safe-${e}))` }) }, { values });
            }
        }),
    ],
};
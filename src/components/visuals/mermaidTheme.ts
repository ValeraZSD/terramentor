import { contrastRatio, ensureContrast, mixColors, parseColor, readableOn, rgbToHex, type VisualPalette } from './palette';

/**
 * The theme variables handed to Mermaid, derived from this app's own palette.
 *
 * WHY THIS IS A MODULE AND NOT A LITERAL AT THE CALL SITE. Mermaid's colour
 * model is not one ramp but three, and each is read by different diagram kinds:
 *
 *   - `primaryColor` / `mainBkg` and friends — the single node surface a
 *     flowchart, sequence, class, state or ER diagram paints every box with.
 *   - `cScale0…11` / `cScaleLabel0…11` / `cScaleInv0…11` — the CATEGORICAL ramp
 *     a mindmap, timeline, journey or pie uses to tell its branches apart.
 *   - `git0…7` / `gitBranchLabel0…7` — the git graph's own ramp, which the
 *     mindmap ALSO reuses for its root node (`.section-root` is filled with
 *     `git0` and lettered with `gitBranchLabel0`).
 *
 * Two live bugs came out of not knowing that. Passing `theme: 'neutral'` for
 * the light themes handed every light-theme diagram Mermaid's GREYSCALE
 * categorical ramp, so a mindmap of six branches drew six identical grey boxes
 * — a diagram whose whole job is to distinguish things, drawing them all alike.
 * And on the dark themes the root node came out as a saturated blob with dark
 * text on it, because `git0` was being re-tinted by the base theme while
 * `gitBranchLabel0` was not: the fill and its label were being decided by two
 * different rules.
 *
 * So the rule here is one rule, applied everywhere: A FILL IS NEVER CHOSEN
 * WITHOUT ITS LABEL. Every surface below is paired with `readableOn(...)`, so
 * whatever the theme does to the fill, the text on it stays legible. The base
 * theme is `'base'` for all four themes — the only one that takes these
 * variables as given rather than re-deriving a ramp from them.
 */

/** How many steps of each categorical ramp Mermaid asks for. */
const SCALE_STEPS = 12;

/**
 * Twelve hues for the categorical ramp, evenly spread around the wheel and
 * ordered so ADJACENT steps are far apart — a mindmap hands its branches
 * consecutive indices, so a ramp that walks the wheel in order gives the two
 * branches most likely to sit side by side the two colours hardest to tell
 * apart. Fixed and validated rather than tints of the learner's accent, for the
 * reason `SERIES_SEED` gives: an accent ramp cannot separate twelve classes,
 * and it would change what a branch MEANS when they change their accent.
 */
const SCALE_SEED = [
    '#3b82f6', // blue
    '#f97316', // orange
    '#10b981', // emerald
    '#a855f7', // purple
    '#ef4444', // red
    '#14b8a6', // teal
    '#eab308', // yellow
    '#6366f1', // indigo
    '#ec4899', // pink
    '#84cc16', // lime
    '#06b6d4', // cyan
    '#f43f5e', // rose
];

/**
 * One categorical step as a node SURFACE.
 *
 * A saturated hue is right for a 2px stroke and wrong for a filled box the size
 * of a word: twelve fully saturated boxes read as a warning, not a diagram. So
 * the hue is mixed toward the page — far on a light theme (a pastel), less far
 * on a dark one (a deep tint) — which keeps the hues distinguishable while
 * letting the surfaces sit quietly on the page. `ensureContrast` against the
 * page afterwards is what stops a pastel disappearing into white.
 */
function scaleSurface(hue: string, palette: VisualPalette): string {
    const towardPage = palette.dark ? 0.62 : 0.82;
    const mixed = mixColors(hue, palette.bg, towardPage);
    const rgb = parseColor(mixed) ?? { r: 1, g: 1, b: 1 };
    const bg = parseColor(palette.bg) ?? { r: 1, g: 1, b: 1 };
    // 1.35:1 — a surface is not a graphic object and does not owe 3:1; it only
    // has to be visible as a distinct shape. Its BORDER and its LABEL carry the
    // contrast, and both are derived from it below.
    return rgbToHex(ensureContrast(rgb, bg, 1.35));
}

/** The stroke for a step: the hue itself, pushed until it clears 3:1 on the page. */
function scaleStroke(hue: string, palette: VisualPalette): string {
    const rgb = parseColor(hue) ?? { r: 0, g: 0, b: 0 };
    const bg = parseColor(palette.bg) ?? { r: 1, g: 1, b: 1 };
    return rgbToHex(ensureContrast(rgb, bg, 3));
}

/**
 * Mermaid's `themeVariables` for the theme currently on screen.
 *
 * Exported as a pure function of the palette so `tools/visual-theme-gates.mjs`
 * can drive it across all four themes and assert the one property that matters:
 * every fill it names has a label beside it that is readable on that fill.
 */
export function mermaidThemeVariables(palette: VisualPalette): Record<string, string> {
    const p = palette;

    // The single node surface for the structural diagrams. Quiet on purpose:
    // a flowchart is read as shapes and arrows, and colouring every box says
    // nothing that the arrows do not already say.
    const nodeFill = p.dark ? mixColors(p.bg, '#ffffff', 0.09) : mixColors(p.bg, p.accent, 0.06);
    const nodeInk = readableOn(nodeFill);
    const altFill = p.dark ? mixColors(p.bg, '#ffffff', 0.16) : mixColors(p.bg, p.accent, 0.12);
    const clusterFill = p.dark ? mixColors(p.bg, '#ffffff', 0.04) : mixColors(p.bg, p.accent, 0.03);

    const vars: Record<string, string> = {
        darkMode: p.dark ? 'true' : 'false',
        background: p.bg,

        primaryColor: nodeFill,
        primaryTextColor: nodeInk,
        primaryBorderColor: p.accent,
        secondaryColor: altFill,
        secondaryTextColor: readableOn(altFill),
        secondaryBorderColor: p.border,
        tertiaryColor: clusterFill,
        tertiaryTextColor: readableOn(clusterFill),
        tertiaryBorderColor: p.border,

        mainBkg: nodeFill,
        nodeBorder: p.accent,
        nodeTextColor: nodeInk,
        titleColor: p.fg,
        textColor: p.fg,
        lineColor: p.muted,
        // An edge label sits ON the connector, so it needs the page behind it or
        // the line runs through the middle of the word.
        edgeLabelBackground: p.bg,
        labelBackground: p.bg,
        labelTextColor: p.fg,

        clusterBkg: clusterFill,
        clusterBorder: p.border,

        // Sequence diagrams: the actor boxes, the lifelines and the notes.
        actorBkg: nodeFill,
        actorBorder: p.accent,
        actorTextColor: nodeInk,
        actorLineColor: p.muted,
        signalColor: p.fg,
        signalTextColor: p.fg,
        labelBoxBkgColor: altFill,
        labelBoxBorderColor: p.border,
        loopTextColor: p.fg,
        activationBkgColor: altFill,
        activationBorderColor: p.accent,
        sequenceNumberColor: readableOn(p.accent),
        noteBkgColor: altFill,
        noteTextColor: readableOn(altFill),
        noteBorderColor: p.border,

        // State / class / ER.
        altBackground: clusterFill,
        attributeBackgroundColorOdd: nodeFill,
        attributeBackgroundColorEven: altFill,

        // Gantt.
        taskBkgColor: nodeFill,
        taskTextColor: nodeInk,
        taskTextOutsideColor: p.fg,
        taskTextDarkColor: readableOn(p.accent),
        taskBorderColor: p.accent,
        activeTaskBkgColor: p.accent,
        activeTaskBorderColor: p.accent,
        doneTaskBkgColor: altFill,
        doneTaskBorderColor: p.border,
        gridColor: p.border,
        sectionBkgColor: clusterFill,
        sectionBkgColor2: p.bg,
        todayLineColor: p.accent2,

        errorBkgColor: '#b91c1c',
        errorTextColor: '#ffffff',
    };

    // THE CATEGORICAL RAMP. Every step names three things at once — the surface,
    // the ink that goes on it, and the connector drawn in its colour — because a
    // step whose fill and label are chosen apart is exactly the bug this replaced.
    for (let i = 0; i < SCALE_STEPS; i++) {
        const hue = SCALE_SEED[i % SCALE_SEED.length];
        const fill = scaleSurface(hue, p);
        vars[`cScale${i}`] = fill;
        vars[`cScaleLabel${i}`] = readableOn(fill);
        vars[`cScaleInv${i}`] = scaleStroke(hue, p);
        vars[`cScalePeer${i}`] = scaleStroke(hue, p);
        vars[`surface${i}`] = fill;
        vars[`surfacePeer${i}`] = scaleStroke(hue, p);
        vars[`pie${i + 1}`] = scaleStroke(hue, p);
    }
    vars.pieTitleTextColor = p.fg;
    vars.pieSectionTextColor = readableOn(scaleStroke(SCALE_SEED[0], p));
    vars.pieLegendTextColor = p.fg;
    vars.pieStrokeColor = p.bg;
    vars.pieOuterStrokeColor = p.border;

    // A MINDMAP'S ROOT NODE READS `git0` / `gitBranchLabel0`, not `cScale0`.
    // That is the whole of the unreadable-centre bug: the fill came from the
    // git ramp and the label from a variable nothing had set for this theme.
    // The root is the one node that should carry the accent — it is the subject
    // of the diagram — so it is filled with the learner's own accent and
    // lettered with whatever can be read on it.
    for (let i = 0; i < 8; i++) {
        const fill = i === 0 ? p.accent : scaleSurface(SCALE_SEED[i % SCALE_SEED.length], p);
        vars[`git${i}`] = fill;
        vars[`gitBranchLabel${i}`] = readableOn(fill);
    }
    vars.gitInv0 = readableOn(p.accent);
    vars.commitLabelColor = p.fg;
    vars.commitLabelBackground = p.bg;
    vars.tagLabelColor = readableOn(p.accent);
    vars.tagLabelBackground = p.accent;
    vars.tagLabelBorder = p.border;

    return vars;
}

/**
 * Every (fill, label) pair this module produces, for the gate to assert over.
 * Kept beside the builder rather than in the tool: a variable added above and
 * not listed here is a fill nothing is checking, and the two lists drifting
 * apart is how the original bug survived being looked at.
 */
export const MERMAID_FILL_LABEL_PAIRS: Array<[string, string]> = [
    ['primaryColor', 'primaryTextColor'],
    ['secondaryColor', 'secondaryTextColor'],
    ['tertiaryColor', 'tertiaryTextColor'],
    ['mainBkg', 'nodeTextColor'],
    ['actorBkg', 'actorTextColor'],
    ['noteBkgColor', 'noteTextColor'],
    ['taskBkgColor', 'taskTextColor'],
    ...Array.from({ length: SCALE_STEPS }, (_, i): [string, string] => [`cScale${i}`, `cScaleLabel${i}`]),
    ...Array.from({ length: 8 }, (_, i): [string, string] => [`git${i}`, `gitBranchLabel${i}`]),
];

/** Minimum contrast a Mermaid label must reach on the fill it is printed on. */
export const MERMAID_MIN_LABEL_CONTRAST = 4.5;

/** True when every pair above clears the floor — the gate's whole assertion. */
export function mermaidLabelsAreReadable(vars: Record<string, string>): string[] {
    const failures: string[] = [];
    for (const [fillKey, labelKey] of MERMAID_FILL_LABEL_PAIRS) {
        const fill = parseColor(vars[fillKey]);
        const label = parseColor(vars[labelKey]);
        if (!fill || !label) { failures.push(`${fillKey}/${labelKey}: unparseable`); continue; }
        const ratio = contrastRatio(fill, label);
        if (ratio < MERMAID_MIN_LABEL_CONTRAST) {
            failures.push(`${fillKey} (${vars[fillKey]}) vs ${labelKey} (${vars[labelKey]}): ${ratio.toFixed(2)}:1`);
        }
    }
    return failures;
}

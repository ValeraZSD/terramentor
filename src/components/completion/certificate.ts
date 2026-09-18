/**
 * The finished-project poster — the thing you keep.
 *
 * A course ends once. The screen that says so is the only time the app ever
 * shows it, and "take a screenshot" is a poor answer on a phone: the card
 * scrolls, the browser chrome is in the shot, and what comes out is a picture of
 * an app rather than a picture of the achievement. So the download button paints
 * its own picture — a fixed 1080px-wide poster with the same numbers, laid out
 * for a camera roll rather than for a viewport.
 *
 * WHY THIS IS NOT html2canvas. Two reasons, and the second is the real one.
 * A DOM rasteriser is a dependency that re-implements layout and gets it subtly
 * wrong (web fonts, `currentColor`, emoji, dark mode), and the app already
 * paints images by hand for exactly this reason (`utils/exportVisual.ts`). But
 * the poster also should not BE the screen: the screen is scrollable, tappable
 * and sized to a phone, while the poster is one still frame with margins. Two
 * shapes of the same facts.
 *
 * The LAYOUT half is pure — it takes a text measurer and returns coordinates —
 * so `tools/completion-gates.mjs` can lay the poster out for a Russian title
 * three times the English length, or a project called "A", and assert that
 * nothing lands outside the frame. The PAINT half is twenty lines of canvas
 * calls over those coordinates, and runs unchanged in the browser and under
 * `@napi-rs/canvas` in the gate, which is how there is a real PNG to look at.
 */

export interface CertificateStat {
    /** Already formatted in the reader's number convention. */
    value: string;
    label: string;
}

export interface CertificateChart {
    /** One value per bucket, in order. Empty buckets are real and stay. */
    buckets: number[];
    startLabel: string;
    endLabel: string;
}

export interface CertificateContent {
    emoji: string;
    /** "Course complete" — the small line above the name. */
    eyebrow: string;
    title: string;
    /** The date it was finished. */
    subtitle: string;
    stats: CertificateStat[];
    /** One or two sentences: the span, and how it sat against the plan. */
    story: string;
    chart: CertificateChart | null;
    /** Under the chart: the busiest day, or whatever is worth one line. */
    caption: string;
}

export interface CertificatePalette {
    bg: string;
    fg: string;
    muted: string;
    border: string;
    /** The project's own colour: the band, the disc, the bars. */
    accent: string;
    /** Legible ON the accent. */
    accentFg: string;
}

export const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

export const WIDTH = 1080;
const PAD = 84;
const BAND = 16;
const DISC = 148;
/** Tried biggest-first. Exported so the gate can assert that a name is shrunk
 *  all the way down before any of it is cut. */
export const TITLE_SIZES = [66, 56, 46, 38];
const TITLE_MAX_LINES = 3;
const EYEBROW_SIZE = 26;
const SUBTITLE_SIZE = 32;
const STAT_VALUE_SIZE = 56;
const STAT_LABEL_SIZE = 26;
const STAT_ROW_H = 128;
/** The tick on the corner of the disc, which is what says "finished" at a glance. */
const BADGE_R = 30;
const CHART_H = 200;
/** Widest a single bucket may be drawn. Three buckets across the full width are
 *  three slabs; past this they read as a chart again. */
const MAX_BAR_W = 56;
const AXIS_SIZE = 24;
const CAPTION_SIZE = 26;
const STORY_SIZE = 29;
const STORY_MAX_LINES = 3;
const RULE_GAP = 52;

export type Measure = (text: string, px: number, weight: number) => number;

/** Greedy word wrap. A word wider than the line stays on its own line rather
 *  than being cut — a long German compound is ugly, a truncated one is wrong. */
export function wrap(text: string, maxWidth: number, measure: (s: string) => number): string[] {
    const out: string[] = [];
    for (const para of String(text || '').split(/\r?\n/)) {
        const words = para.trim().split(/\s+/).filter(Boolean);
        if (!words.length) continue;
        let line = '';
        for (const word of words) {
            const trial = line ? `${line} ${word}` : word;
            if (measure(trial) <= maxWidth || !line) line = trial;
            else { out.push(line); line = word; }
        }
        if (line) out.push(line);
    }
    return out;
}

/** Shorten to fit, with an ellipsis. Only ever reached by a single unbreakable
 *  word longer than the poster is wide, which is a name, not a sentence. */
function ellipsize(text: string, maxWidth: number, measure: (s: string) => number): string {
    if (measure(text) <= maxWidth) return text;
    let cut = text;
    while (cut.length > 1 && measure(`${cut}…`) > maxWidth) cut = cut.slice(0, -1);
    return `${cut}…`;
}

export interface StatBox { x: number; y: number; w: number; value: string; label: string }
export interface BarBox { x: number; y: number; w: number; h: number; empty: boolean }

export interface CertificateLayout {
    width: number;
    height: number;
    inner: { x: number; w: number };
    disc: { cx: number; cy: number; r: number };
    eyebrowY: number;
    titleSize: number;
    titleLines: string[];
    titleY: number;
    /** Trimmed to the frame — paint this, not `content.subtitle`. */
    subtitle: string;
    subtitleY: number;
    /** Likewise. */
    caption: string;
    rules: number[];
    stats: StatBox[];
    chart: { x: number; y: number; w: number; h: number; bars: BarBox[] } | null;
    axisY: number;
    captionY: number;
    storyLines: string[];
    storyY: number;
}

/**
 * Where everything goes. Top to bottom, each block adding its own height — so a
 * poster with no chart and two stats is short rather than mostly empty, and one
 * with a six-word name in Polish is tall rather than clipped.
 */
export function layoutCertificate(content: CertificateContent, measure: Measure): CertificateLayout {
    const inner = { x: PAD, w: WIDTH - PAD * 2 };
    let y = BAND;

    y += 64;
    const disc = { cx: WIDTH / 2, cy: y + DISC / 2, r: DISC / 2 };
    y += DISC;

    y += 46;
    const eyebrowY = y;
    y += EYEBROW_SIZE;

    // The name gets three lines at the biggest size that fits. "Fits" is BOTH
    // tests: few enough lines, and no line wider than the frame. Checking only
    // the line count is what let a single unbreakable word — one long German
    // compound, one pasted deck name with no spaces — print at full size
    // straight off both edges of the poster, which is how this was found.
    y += 28;
    let titleSize = TITLE_SIZES[0];
    let titleLines: string[] = [];
    for (const size of TITLE_SIZES) {
        titleSize = size;
        titleLines = wrap(content.title, inner.w, s => measure(s, size, 600));
        const fits = titleLines.length <= TITLE_MAX_LINES
            && titleLines.every(line => measure(line, size, 600) <= inner.w);
        if (fits) break;
    }
    // At the smallest size, whatever is still too big gets cut — every line, not
    // only the last: a word that does not fit at 38px does not fit on any line.
    titleLines = titleLines
        .slice(0, TITLE_MAX_LINES)
        .map(line => ellipsize(line, inner.w, s => measure(s, titleSize, 600)));
    const titleY = y;
    const titleLine = Math.round(titleSize * 1.16);
    y += titleLines.length * titleLine;

    y += 20;
    const subtitleY = y;
    y += SUBTITLE_SIZE;

    const rules: number[] = [];
    y += RULE_GAP;
    rules.push(y);
    y += RULE_GAP;

    // Two columns, always — three fit the width but read as a table, and the
    // phone screen this mirrors is two columns. An odd count leaves the last
    // tile centred rather than orphaned against the left margin.
    const stats: StatBox[] = [];
    const columns = 2;
    const cellW = inner.w / columns;
    content.stats.forEach((stat, i) => {
        const row = Math.floor(i / columns);
        const last = i === content.stats.length - 1 && content.stats.length % columns === 1;
        stats.push({
            x: last ? inner.x + inner.w / 2 : inner.x + cellW * (i % columns) + cellW / 2,
            y: y + row * STAT_ROW_H,
            w: cellW,
            value: stat.value,
            label: ellipsize(stat.label, cellW - 24, s => measure(s, STAT_LABEL_SIZE, 400)),
        });
    });
    if (content.stats.length) y += Math.ceil(content.stats.length / columns) * STAT_ROW_H;

    let chart: CertificateLayout['chart'] = null;
    let axisY = y;
    if (content.chart && content.chart.buckets.length) {
        y += RULE_GAP;
        rules.push(y);
        y += RULE_GAP;
        const values = content.chart.buckets;
        const peak = Math.max(1, ...values);
        // Gap scales down with the bar count so thirty buckets do not become
        // more gap than bar — the same widest-first rule the deck strip uses.
        const gap = values.length > 24 ? 5 : values.length > 14 ? 8 : 12;
        // A three-day project drawn across the full width is three slabs, not a
        // chart. Bars have a ceiling, and a short series is centred rather than
        // stretched — the same rule the screen's own chart follows.
        const barW = Math.min(MAX_BAR_W, (inner.w - gap * (values.length - 1)) / values.length);
        const used = barW * values.length + gap * (values.length - 1);
        const left = inner.x + Math.max(0, (inner.w - used) / 2);
        const bars: BarBox[] = values.map((value, i) => {
            // A bucket with nothing in it still draws a hairline, so the axis
            // reads as a continuous span rather than as bars with gaps of
            // unknown width — see DeckForecast, which learned this the hard way.
            const h = value > 0 ? Math.max(8, (value / peak) * CHART_H) : 3;
            return { x: left + i * (barW + gap), y: y + CHART_H - h, w: barW, h, empty: value <= 0 };
        });
        chart = { x: inner.x, y, w: inner.w, h: CHART_H, bars };
        y += CHART_H + 16;
        axisY = y;
        y += AXIS_SIZE;
    }

    y += content.caption ? 30 : 0;
    const captionY = y;
    y += content.caption ? CAPTION_SIZE : 0;

    y += content.story ? 36 : 0;
    const storyY = y;
    const storyLines = content.story
        ? wrap(content.story, inner.w, s => measure(s, STORY_SIZE, 400))
            .slice(0, STORY_MAX_LINES)
            .map(line => ellipsize(line, inner.w, s => measure(s, STORY_SIZE, 400)))
        : [];
    y += storyLines.length * Math.round(STORY_SIZE * 1.45);

    return {
        width: WIDTH,
        height: Math.round(y + PAD),
        inner, disc, eyebrowY, titleSize, titleLines, titleY,
        subtitle: ellipsize(content.subtitle, inner.w, s => measure(s, SUBTITLE_SIZE, 400)),
        subtitleY,
        caption: content.caption ? ellipsize(content.caption, inner.w, s => measure(s, CAPTION_SIZE, 400)) : '',
        rules, stats, chart, axisY, captionY, storyLines, storyY,
    };
}

/** A 2D context, of either the browser's or `@napi-rs/canvas`'s flavour. */
type Ctx = CanvasRenderingContext2D;

const centred = (ctx: Ctx, text: string, x: number, y: number) => ctx.fillText(text, x, y);

function roundedTop(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
    const radius = Math.max(0, Math.min(r, w / 2, h));
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
    ctx.fill();
}

/** A tick drawn as a path, not as a glyph: the fallback when the emoji font is
 *  missing has to render on every machine, and a missing glyph is a tofu box. */
function tick(ctx: Ctx, cx: number, cy: number, size: number, colour: string) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = Math.max(4, size * 0.13);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - size * 0.32, cy + size * 0.02);
    ctx.lineTo(cx - size * 0.08, cy + size * 0.26);
    ctx.lineTo(cx + size * 0.34, cy - size * 0.26);
    ctx.stroke();
}

export function paintCertificate(ctx: Ctx, layout: CertificateLayout, content: CertificateContent, palette: CertificatePalette) {
    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, layout.width, layout.height);

    ctx.fillStyle = palette.accent;
    ctx.fillRect(0, 0, layout.width, BAND);

    // The disc, in the project's colour at a low alpha so a saturated red and a
    // pale yellow both stay a backdrop rather than becoming the subject.
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = palette.accent;
    ctx.beginPath();
    ctx.arc(layout.disc.cx, layout.disc.cy, layout.disc.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const glyphSize = Math.round(layout.disc.r * 1.05);
    ctx.font = `${glyphSize}px ${EMOJI_FONT}`;
    const drawable = content.emoji && ctx.measureText(content.emoji).width > glyphSize * 0.3;
    if (drawable) {
        ctx.fillStyle = palette.fg;
        ctx.fillText(content.emoji, layout.disc.cx, layout.disc.cy);
        // A solid tick on the corner of the disc. The eyebrow says "complete" in
        // words, and the words are the ones that get translated and skimmed
        // past; this is the mark you recognise before reading anything.
        const bx = layout.disc.cx + layout.disc.r * 0.72;
        const by = layout.disc.cy + layout.disc.r * 0.72;
        ctx.fillStyle = palette.bg;
        ctx.beginPath();
        ctx.arc(bx, by, BADGE_R + 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = palette.accent;
        ctx.beginPath();
        ctx.arc(bx, by, BADGE_R, 0, Math.PI * 2);
        ctx.fill();
        tick(ctx, bx, by, BADGE_R, palette.accentFg);
    } else {
        // No emoji to draw (or no emoji font on this machine): the tick IS the
        // picture, at full size, rather than a tofu box with a badge on it.
        tick(ctx, layout.disc.cx, layout.disc.cy, layout.disc.r, palette.accent);
    }

    ctx.textBaseline = 'top';
    ctx.fillStyle = palette.muted;
    ctx.font = `600 ${EYEBROW_SIZE}px ${FONT}`;
    centred(ctx, content.eyebrow.toUpperCase(), layout.width / 2, layout.eyebrowY);

    ctx.fillStyle = palette.fg;
    ctx.font = `600 ${layout.titleSize}px ${FONT}`;
    const titleLine = Math.round(layout.titleSize * 1.16);
    layout.titleLines.forEach((line, i) => centred(ctx, line, layout.width / 2, layout.titleY + i * titleLine));

    ctx.fillStyle = palette.muted;
    ctx.font = `400 ${SUBTITLE_SIZE}px ${FONT}`;
    centred(ctx, layout.subtitle, layout.width / 2, layout.subtitleY);

    ctx.fillStyle = palette.border;
    for (const y of layout.rules) ctx.fillRect(layout.inner.x, y, layout.inner.w, 2);

    for (const stat of layout.stats) {
        ctx.fillStyle = palette.fg;
        ctx.font = `600 ${STAT_VALUE_SIZE}px ${FONT}`;
        centred(ctx, stat.value, stat.x, stat.y);
        ctx.fillStyle = palette.muted;
        ctx.font = `400 ${STAT_LABEL_SIZE}px ${FONT}`;
        centred(ctx, stat.label, stat.x, stat.y + STAT_VALUE_SIZE + 12);
    }

    if (layout.chart && content.chart) {
        for (const bar of layout.chart.bars) {
            ctx.fillStyle = bar.empty ? palette.border : palette.accent;
            roundedTop(ctx, bar.x, bar.y, bar.w, bar.h, 6);
        }
        ctx.fillStyle = palette.muted;
        ctx.font = `400 ${AXIS_SIZE}px ${FONT}`;
        ctx.textAlign = 'left';
        ctx.fillText(content.chart.startLabel, layout.inner.x, layout.axisY);
        ctx.textAlign = 'right';
        ctx.fillText(content.chart.endLabel, layout.inner.x + layout.inner.w, layout.axisY);
        ctx.textAlign = 'center';
    }

    if (layout.caption) {
        ctx.fillStyle = palette.muted;
        ctx.font = `400 ${CAPTION_SIZE}px ${FONT}`;
        centred(ctx, layout.caption, layout.width / 2, layout.captionY);
    }

    ctx.fillStyle = palette.muted;
    ctx.font = `400 ${STORY_SIZE}px ${FONT}`;
    const storyLine = Math.round(STORY_SIZE * 1.45);
    layout.storyLines.forEach((line, i) => centred(ctx, line, layout.width / 2, layout.storyY + i * storyLine));
}

/** Measure with a real context — the only way font metrics are ever right. */
export function measurerFor(ctx: Ctx): Measure {
    return (text, px, weight) => {
        ctx.font = `${weight} ${px}px ${FONT}`;
        return ctx.measureText(text).width;
    };
}

/** The poster as PNG bytes. Browser-side; the gate calls the two halves itself. */
export async function renderCertificate(content: CertificateContent, palette: CertificatePalette): Promise<Blob> {
    const canvas = document.createElement('canvas');
    const probe = canvas.getContext('2d');
    if (!probe) throw new Error('no 2D canvas available.');
    const layout = layoutCertificate(content, measurerFor(probe));
    canvas.width = layout.width;
    canvas.height = layout.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2D canvas available.');
    paintCertificate(ctx, layout, content, palette);
    return new Promise((resolve, reject) => {
        canvas.toBlob(b => (b ? resolve(b) : reject(new Error('the picture could not be encoded.'))), 'image/png');
    });
}

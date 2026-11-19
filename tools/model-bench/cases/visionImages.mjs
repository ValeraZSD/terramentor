/**
 * The pictures the vision cases read, drawn with @napi-rs/canvas from generic
 * font families at large sizes. Same code, same pixels (for one set of
 * installed fonts), no file on disk.
 */
import { createCanvas } from '@napi-rs/canvas';

const INK = '#111111';
const SANS = 'sans-serif';

function sheet(w, h, paint, paper = '#ffffff') {
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, w, h);
    ctx.textBaseline = 'alphabetic';
    paint(ctx, w, h);
    return canvas.toBuffer('image/png');
}

/** Lines of text, left aligned, each at `lineHeight` below the last. */
function lines(ctx, rows, { x = 40, y = 70, size = 36, lineHeight = 54, weight = '' } = {}) {
    ctx.fillStyle = INK;
    ctx.font = `${weight} ${size}px ${SANS}`.trim();
    rows.forEach((r, i) => ctx.fillText(r, x, y + i * lineHeight));
}

export const MATH_LINES = ['Question 7 (4 points)', 'A train travels 150 km in 2.5 hours.', 'Solve 3x² - 12x + 9 = 0.'];
export const mathProblem = () => sheet(980, 300, (ctx) => {
    lines(ctx, [MATH_LINES[0]], { size: 38, weight: 'bold', y: 75 });
    lines(ctx, MATH_LINES.slice(1), { size: 38, y: 150, lineHeight: 70 });
});

export const DUTCH_LINES = [
    'Een fiets is voor veel Nederlanders meer dan een vervoermiddel.',
    'In Nederland en België fietsen kinderen vaak zelf naar school,',
    'ook als het regent. Eén op de vijf reizen gaat per fiets.',
];
export const dutchParagraph = () => sheet(1180, 260, (ctx) => lines(ctx, DUTCH_LINES, { size: 34, y: 70, lineHeight: 64 }));

export const CYRILLIC_LINES = [
    'Україна - це держава в Східній Європі.',
    'Її столиця - місто Київ, що розташоване на Дніпрі.',
    'Тут живе понад три мільйони людей.',
];
export const cyrillicParagraph = () => sheet(1180, 260, (ctx) => lines(ctx, CYRILLIC_LINES, { size: 36, y: 70, lineHeight: 64 }));

export const TABLE_ROWS = [['Mon', 12, 19], ['Tue', 9, 15], ['Wed', 11, 22], ['Thu', 7, 13]];
export const numberTable = () => sheet(620, 420, (ctx) => {
    const colW = [180, 150, 150], rowH = 64, x0 = 60, y0 = 40;
    const rows = [['Day', 'Min', 'Max'], ...TABLE_ROWS.map(r => r.map(String))];
    ctx.strokeStyle = INK; ctx.lineWidth = 2;
    rows.forEach((row, r) => {
        let x = x0;
        row.forEach((cell, c) => {
            if (r === 0) { ctx.fillStyle = '#d9dde3'; ctx.fillRect(x, y0 + r * rowH, colW[c], rowH); }
            ctx.strokeRect(x, y0 + r * rowH, colW[c], rowH);
            ctx.fillStyle = INK; ctx.font = `${r === 0 ? 'bold ' : ''}34px ${SANS}`; ctx.textAlign = 'center';
            ctx.fillText(cell, x + colW[c] / 2, y0 + r * rowH + 43);
            x += colW[c];
        });
    });
    ctx.textAlign = 'start';
});

/** A written answer: every letter on its own wobbly baseline, tilt and size, drawn in pen blue on ruled paper. */
export const HANDWRITTEN_TEXT = 'x = 3 and x = 1';
export const handwritten = () => sheet(900, 300, (ctx, w, h) => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    ctx.strokeStyle = '#c9d3e6'; ctx.lineWidth = 2;
    for (let y = 90; y < h; y += 70) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    ctx.save();
    ctx.translate(60, 190); ctx.rotate(-0.05);
    ctx.fillStyle = '#1d3b8b'; ctx.strokeStyle = '#1d3b8b'; ctx.lineWidth = 1.6;
    let x = 0;
    for (const ch of HANDWRITTEN_TEXT) {
        const size = 84 * (0.88 + rnd() * 0.26);
        ctx.font = `italic ${size}px ${SANS}`;
        ctx.save();
        ctx.translate(x, (rnd() - 0.5) * 14);
        ctx.rotate((rnd() - 0.5) * 0.3);
        ctx.fillText(ch, 0, 0); ctx.strokeText(ch, 0, 0);
        ctx.restore();
        x += ctx.measureText(ch).width + (ch === ' ' ? 6 : (rnd() - 0.3) * 8);
    }
    ctx.restore();
}, '#fbf8ee');

export const SHAPES = { red: 'square', blue: 'circle', green: 'triangle' };
export const SHAPES_WORD = 'TULIP';
export const shapesPicture = () => sheet(800, 520, (ctx) => {
    ctx.fillStyle = '#dc2626'; ctx.fillRect(70, 110, 190, 190);
    ctx.fillStyle = '#2563eb'; ctx.beginPath(); ctx.arc(400, 205, 100, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#16a34a'; ctx.beginPath(); ctx.moveTo(620, 110); ctx.lineTo(540, 300); ctx.lineTo(700, 300); ctx.closePath(); ctx.fill();
    ctx.fillStyle = INK; ctx.font = `bold 120px ${SANS}`; ctx.textAlign = 'center';
    ctx.fillText(SHAPES_WORD, 400, 450);
});

export const BARS = [['Apples', 40], ['Pears', 75], ['Plums', 120], ['Figs', 60]];
export const barChart = () => sheet(800, 520, (ctx) => {
    const x0 = 110, y0 = 430, top = 70, maxV = 150, bw = 100, gap = 40;
    ctx.fillStyle = INK; ctx.font = `bold 34px ${SANS}`; ctx.textAlign = 'center';
    ctx.fillText('Kilos sold', 400, 44);
    ctx.strokeStyle = INK; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x0, top); ctx.lineTo(x0, y0); ctx.lineTo(760, y0); ctx.stroke();
    ctx.font = `24px ${SANS}`; ctx.textAlign = 'right';
    for (const t of [0, 50, 100, 150]) {
        const y = y0 - (t / maxV) * (y0 - top);
        ctx.fillText(String(t), x0 - 12, y + 8);
        ctx.beginPath(); ctx.moveTo(x0 - 6, y); ctx.lineTo(x0, y); ctx.stroke();
    }
    ctx.textAlign = 'center';
    BARS.forEach(([name, v], i) => {
        const x = x0 + gap + i * (bw + gap);
        const h = (v / maxV) * (y0 - top);
        ctx.fillStyle = '#2563eb'; ctx.fillRect(x, y0 - h, bw, h);
        ctx.fillStyle = INK; ctx.font = `26px ${SANS}`; ctx.fillText(name, x + bw / 2, y0 + 40);
    });
});

function arrow(ctx, x1, y1, x2, y2) {
    ctx.strokeStyle = INK; ctx.fillStyle = INK; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    const a = Math.atan2(y2 - y1, x2 - x1), s = 20;
    ctx.beginPath(); ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - s * Math.cos(a - 0.45), y2 - s * Math.sin(a - 0.45));
    ctx.lineTo(x2 - s * Math.cos(a + 0.45), y2 - s * Math.sin(a + 0.45));
    ctx.closePath(); ctx.fill();
}
export const flowDiagram = () => sheet(900, 380, (ctx) => {
    ctx.strokeStyle = INK; ctx.lineWidth = 4;
    ctx.fillStyle = '#dbeafe'; ctx.fillRect(40, 110, 220, 160); ctx.strokeRect(40, 110, 220, 160);
    ctx.fillStyle = '#dcfce7'; ctx.fillRect(640, 110, 220, 160); ctx.strokeRect(640, 110, 220, 160);
    ctx.fillStyle = INK; ctx.font = `bold 38px ${SANS}`; ctx.textAlign = 'center';
    ctx.fillText('Browser', 150, 202); ctx.fillText('Server', 750, 202);
    arrow(ctx, 270, 150, 630, 150);
    arrow(ctx, 630, 240, 270, 240);
    ctx.font = `34px ${SANS}`;
    ctx.fillText('request', 450, 125); ctx.fillText('response', 450, 295);
});

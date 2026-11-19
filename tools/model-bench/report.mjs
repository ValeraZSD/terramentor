#!/usr/bin/env node
/**
 * Turns a results folder from run.mjs into a table and a chart.
 *
 *   node tools/model-bench/report.mjs --out <dir> [--md report.md] [--png chart.png]
 *        [--noise <label>]      compare <model>.jsonl with <model>@<label>.jsonl
 *        [--profile file.json]  calls per active day by category, for $/month
 *        [--title text]         the chart's title
 *
 * Score: passed / scored cases x 100, where scored = cases the model could
 * take (vision cases are N/A for a text-only model, never 0). A row that
 * ended in a transient upstream error counts as a fail and is shown in the
 * `errors` column, because a learner would have seen that failure too.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (k, d = '') => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const OUT = opt('out');
if (!OUT) { console.error('--out <dir> is required'); process.exit(2); }

const { loadFamilies } = await import('./cases/index.mjs');
const families = await loadFamilies();
const caseCount = families.reduce((n, f) => n + f.cases.length, 0);
const label = Object.fromEntries(families.map(f => [f.category, f.label]));

const readRows = (file) => {
    const rows = new Map();
    for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { const r = JSON.parse(line); rows.set(r.case, r); } catch { /* torn line */ }
    }
    return [...rows.values()];
};
const pct = (xs, p) => {
    const s = xs.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
    if (!s.length) return null;
    return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
};

const meta = existsSync(path.join(OUT, 'models.json')) ? JSON.parse(readFileSync(path.join(OUT, 'models.json'), 'utf8')) : {};
// <model>.jsonl is a model's run; <model>@<label>.jsonl is a repeat of it
// ("@" never occurs in a model id, "." does: "ling-3.2-flash", "gpt-5.1").
const files = readdirSync(OUT).filter(f => f.endsWith('.jsonl') && !f.includes('@'));
const models = files.map((f) => {
    const rows = readRows(path.join(OUT, f));
    const id = rows.find(r => r.model)?.model || f.replace('.jsonl', '').replace(/__/g, '/');
    const scored = rows.filter(r => !r.na);
    const passed = scored.filter(r => r.pass);
    const cats = {};
    for (const r of scored) {
        const c = cats[r.category] ||= { n: 0, pass: 0 };
        c.n++; if (r.pass) c.pass++;
    }
    // Time the app waited on the model (request time, the app's own retries
    // included), not the benchmark's queue or scoring. A case that timed out
    // counts at the time it took.
    const secs = scored.filter(r => r.calls).map(r => r.modelMs / 1000);
    return {
        id, zdr: meta[id]?.zdr ?? null, vision: meta[id]?.vision ?? rows.some(r => r.category === 'vision' && !r.na),
        done: rows.length, scored: scored.length, passed: passed.length,
        score: scored.length ? Math.round(1000 * passed.length / scored.length) / 10 : null,
        cats, median: pct(secs, 0.5), p90: pct(secs, 0.9),
        firstToken: pct(scored.map(r => r.firstTokenMs).filter(Boolean).map(x => x / 1000), 0.5),
        errors: scored.filter(r => r.error || (r.callErrors || []).length).length,
        transient: scored.filter(r => r.transient).length,
        // Every attempt's spend, retries included.
        cost: scored.reduce((s, r) => s + (r.spent?.cost ?? r.cost ?? 0), 0),
        tokensIn: scored.reduce((s, r) => s + (r.spent?.promptTokens ?? r.promptTokens ?? 0), 0),
        tokensOut: scored.reduce((s, r) => s + (r.spent?.completionTokens ?? r.completionTokens ?? 0), 0),
        requests: scored.reduce((s, r) => s + (r.spent?.calls ?? r.calls ?? 0), 0),
        providers: [...new Set(scored.flatMap(r => r.providers || []))],
        rows,
    };
}).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

const cats = families.map(f => f.category);
const fmt = (x, d = 1) => x == null ? '–' : Number(x).toFixed(d);
let md = `# Model benchmark results\n\n${caseCount} cases in ${families.length} categories. Score = cases passed / cases the model could take x 100.\n\n`;
md += 'Seconds are the time the app waited on the model per case.\n\n';
md += '| model | ZDR | score | done | median s | p90 s | first token s | $ total | $/case | errors |\n|---|---|---|---|---|---|---|---|---|---|\n';
for (const m of models) {
    md += `| ${m.id} | ${m.zdr == null ? '?' : m.zdr ? 'yes' : 'no'} | **${m.score == null ? '–' : `${Math.round(m.score)}/100`}** | ${m.scored}/${m.vision ? caseCount : caseCount - (families.find(f => f.category === 'vision')?.cases.length || 0)}${m.vision ? '' : ' (text)'} | ${fmt(m.median)} | ${fmt(m.p90)} | ${fmt(m.firstToken)} | ${m.cost.toFixed(4)} | ${(m.cost / Math.max(1, m.scored)).toFixed(5)} | ${m.errors} |\n`;
}
md += '\n## Per category (passed / scored)\n\n| model | ' + cats.map(c => label[c] || c).join(' | ') + ' |\n|---|' + cats.map(() => '---').join('|') + '|\n';
for (const m of models) md += `| ${m.id} | ` + cats.map(c => m.cats[c] ? `${m.cats[c].pass}/${m.cats[c].n}` : 'N/A').join(' | ') + ' |\n';

// Run-to-run noise: the same model, the same cases, a second time.
const noise = opt('noise');
if (noise) {
    md += `\n## Run-to-run noise (repeat label "${noise}")\n\n| model | first | repeat | cases compared | verdicts that flipped |\n|---|---|---|---|---|\n`;
    for (const f of readdirSync(OUT).filter(x => x.endsWith(`@${noise}.jsonl`))) {
        const rep = readRows(path.join(OUT, f)).filter(r => !r.na);
        const base = models.find(m => m.id === rep[0]?.model);
        if (!base) continue;
        const b = new Map(base.rows.map(r => [r.case, r]));
        const both = rep.filter(r => b.has(r.case) && !b.get(r.case).na);
        const flips = both.filter(r => r.pass !== b.get(r.case).pass);
        const s1 = both.filter(r => b.get(r.case).pass).length, s2 = both.filter(r => r.pass).length;
        md += `| ${base.id} | ${s1}/${both.length} | ${s2}/${both.length} | ${both.length} | ${flips.length} (${flips.map(r => r.case).join(', ')}) |\n`;
    }
}

// $/month for one learner: an ESTIMATE from a usage profile (calls per active
// day by category) and each model's measured tokens per case.
const profilePath = opt('profile');
if (profilePath) {
    const prof = JSON.parse(readFileSync(profilePath, 'utf8'));
    md += `\n## Estimated $/month for one learner (estimate: ${prof.note || 'profile'})\n\n| model | $/month |\n|---|---|\n`;
    for (const m of models) {
        let perDay = 0;
        for (const [cat, n] of Object.entries(prof.callsPerDay || {})) {
            const rs = m.rows.filter(r => r.category === cat && !r.na && r.calls);
            if (!rs.length) continue;
            perDay += n * rs.reduce((s, r) => s + r.cost / r.calls, 0) / rs.length;
        }
        md += `| ${m.id} | ${(perDay * (prof.activeDaysPerMonth || 20)).toFixed(3)} |\n`;
    }
}

const mdOut = opt('md', path.join(OUT, 'report.md'));
writeFileSync(mdOut, md);
writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(models.map(({ rows, ...m }) => m), null, 1));
console.log(md);

// Chart: score bars with median seconds beside each model.
const pngOut = opt('png', path.join(OUT, 'chart.png'));
try {
    const { createCanvas } = await import('@napi-rs/canvas');
    const W = 1400, rowH = 46, top = 110, H = top + rowH * models.length + 60;
    const cv = createCanvas(W, H); const g = cv.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#111827'; g.font = 'bold 30px sans-serif';
    g.fillText(opt('title', `Terramentor model benchmark (${caseCount} cases)`), 30, 50);
    g.font = '20px sans-serif'; g.fillStyle = '#4b5563';
    g.fillText('Bar: score out of 100.   Right: median seconds the app waited per case (p90), then $ per 100 cases.', 30, 84);
    const x0 = 520, barW = 520;
    models.forEach((m, i) => {
        const y = top + i * rowH;
        g.fillStyle = '#111827'; g.font = '20px sans-serif';
        g.fillText(m.id.length > 44 ? m.id.slice(0, 43) + '…' : m.id, 30, y + 28);
        g.fillStyle = '#e5e7eb'; g.fillRect(x0, y + 8, barW, 28);
        g.fillStyle = m.zdr == null ? '#6b7280' : m.zdr ? '#0f766e' : '#2563eb'; g.fillRect(x0, y + 8, barW * (m.score || 0) / 100, 28);
        g.fillStyle = '#111827'; g.font = 'bold 20px sans-serif';
        g.fillText(m.score == null ? '–' : String(Math.round(m.score)), x0 + barW + 14, y + 30);
        g.font = '20px sans-serif'; g.fillStyle = '#4b5563';
        g.fillText(`${fmt(m.median)} s (${fmt(m.p90)})`, x0 + barW + 80, y + 30);
        const per100 = 100 * m.cost / Math.max(1, m.scored);
        g.fillText(per100 === 0 ? '$0' : `$${per100 < 1 ? per100.toFixed(2) : per100.toFixed(1)}`, x0 + barW + 290, y + 30);
    });
    g.fillStyle = '#4b5563'; g.font = '18px sans-serif';
    g.fillText('Teal: has a zero-data-retention endpoint.   Blue: has none.   Grey: called on the vendor\'s own API, retention per that account.', 30, H - 22);
    writeFileSync(pngOut, cv.toBuffer('image/png'));
    console.log(`chart: ${pngOut}`);
} catch (e) { console.error(`no chart: ${e.message}`); }

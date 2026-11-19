#!/usr/bin/env node
/**
 * tools/plan-views-gates.mjs — a course's plan is shown in one place.
 *
 *   node tools/plan-views-gates.mjs                 the checks below, in the built app
 *   node tools/plan-views-gates.mjs --browser <p>   a Chromium-based browser (default: Edge or Chrome)
 *
 * The plan is the pace verdict in the course header and the plan dialog it
 * opens. The course Timeline and Calendar tabs, the Calendar in the top bar
 * and the second pace line under Next up are gone: each one repeated the plan,
 * and the two date views gave every topic a day of its own, which stops being
 * true on the first day a learner misses. The verdict speaks in weeks and does
 * not.
 *
 * Asserted in a headless browser on the invented course from
 * tools/docs-fixture.mjs, re-planned so that its date misses (the case where
 * the Dashboard used to say the verdict a second time):
 *
 *  - a dated course's views are Study, Dashboard, Outline and Vault, and none
 *    of them is a Timeline or a Calendar;
 *  - the top bar is Today, Projects and Atlas;
 *  - an old address lands on a screen that exists: /calendar on Projects,
 *    /project/:id/timeline and /project/:id/calendar, with or without a topic,
 *    on that course's Dashboard;
 *  - on the Dashboard of a course that misses its date, the verdict is on
 *    screen once.
 *
 * Each check also asserts what IS there, so a page that never drew passes
 * nothing. On the code before the change every check but those fails.
 *
 * No model and no network. Without Edge or Chrome it is SKIPPED locally and
 * fails in CI.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

delete process.env.__COMPAT_LAYER;

const { visit, findBrowser, removeScratch } = await import(pathToFileURL(join(ROOT, 'tools', 'docs-shots.mjs')).href);
const { prepare: prepareFixture } = await import(pathToFileURL(join(ROOT, 'tools', 'docs-fixture.mjs')).href);

let browserPath;
try {
    browserPath = findBrowser(value('--browser'));
} catch {
    if (process.env.CI) { console.log('  FAIL  no Edge or Chrome to run the screens in'); console.log('0 passed, 1 failed'); process.exit(1); }
    console.log('SKIPPED: no Edge or Chrome found (pass --browser <path>)');
    process.exit(0);
}

// dist/, built from the sources being checked (as axe-gates does).
function newest(path) {
    if (!existsSync(path)) return 0;
    const st = statSync(path);
    if (!st.isDirectory()) return st.mtimeMs;
    let most = 0;
    for (const name of readdirSync(path)) most = Math.max(most, newest(join(path, name)));
    return most;
}
const built = existsSync(join(ROOT, 'dist', 'index.html')) ? statSync(join(ROOT, 'dist', 'index.html')).mtimeMs : 0;
const sources = Math.max(...['src', 'public', 'index.html', 'vite.config.ts', 'tailwind.config.js', 'postcss.config.js'].map((p) => newest(join(ROOT, p))));
if (sources > built) {
    console.log(built ? 'dist/ is older than the sources: building it' : 'no dist/: building it');
    const run = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit' });
    if (run.status !== 0) { console.log('  FAIL  vite build'); console.log('0 passed, 1 failed'); process.exit(1); }
}

const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
/** The bands where the date does not fit the learner's pace (src/components/plan/verdict.tsx MISSES). */
const MISSES = new Set(['under_pace', 'tight', 'out_of_reach']);

/**
 * The fixture course, then a record and a date that miss: three more topics
 * finished in the weeks before, so the verdict has a pace to judge by rather
 * than "learning your pace", and the date a week away.
 */
async function prepare(ctx) {
    const ids = await prepareFixture(ctx);
    const Database = require('better-sqlite3');
    const db = new Database(ctx.dbPath);
    try {
        db.pragma('busy_timeout = 5000');
        const open = db.prepare(`
            SELECT n.id FROM nodes n
            WHERE n.project_id = ? AND n.is_note = 0 AND n.status = 'not_started' AND n.id NOT IN (?, ?, ?)
              AND NOT EXISTS (SELECT 1 FROM nodes c WHERE c.parent_id = n.id AND c.is_note = 0)
            ORDER BY n.id LIMIT 3
        `).all(ids.project, ids.study, ids.prove, ids.cards);
        if (open.length < 3) throw new Error(`fixture: only ${open.length} open topics to finish`);
        const finish = db.prepare("UPDATE nodes SET status = 'completed', completed_at = ? WHERE id = ?");
        open.forEach(({ id }, i) => finish.run(`${day(-(19 + 7 * i))}T09:00:00.000Z`, id));
    } finally {
        db.close();
    }
    const planned = await ctx.api.post(`/api/projects/${ids.project}/schedule`, { startDate: day(-40), deadline: day(7), studyDays: [1, 2, 3, 4, 5, 6, 7] });
    if (planned.status !== 200) throw new Error(`fixture: schedule ${planned.status} ${JSON.stringify(planned.json)}`);
    const band = (await ctx.api.get(`/api/projects/${ids.project}/pace`)).json?.verdict?.band;
    if (!MISSES.has(band)) throw new Error(`fixture: the course's date reads "${band}", not a date it misses`);
    return ids;
}

const tabsIn = (nav) => `[...document.querySelectorAll('nav[aria-label="${nav}"] [data-tab]')].map((e) => e.dataset.tab)`;
/** Verdict marks a reader can see: the pill (`VerdictPill`) and the dot on the plan button (`VerdictDot`). */
const SHOWN_VERDICTS = `[...document.querySelectorAll('[data-verdict]')]
    .filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')
    .map((e) => e.textContent.trim() || \`dot on "\${(e.closest('button')?.textContent ?? '').trim().slice(0, 40)}"\`)`;

const states = {
    async 'plan views'(page, { ids }) {
        const course = `/project/${ids.project}`;

        console.log('\nthe top bar:');
        await page.go('/projects', null);
        await page.waitFor(`${tabsIn('Main')}.includes('projects')`, 'the top bar');
        const top = await page.evaluate(`${tabsIn('Main')}.join()`);
        check('the top bar has Today, Projects and Atlas', ['today', 'projects', 'atlas'].every((k) => top.split(',').includes(k)), top);
        check('...and no Calendar', !top.split(',').includes('calendar'), top);

        console.log('\na dated course:');
        await page.go(`${course}/dashboard`, 'Next up');
        await page.waitFor(`${tabsIn('Project views')}.includes('dashboard')`, 'the course views');
        const views = await page.evaluate(`${tabsIn('Project views')}.join()`);
        check('its views are Study, Dashboard, Outline and Vault', ['study', 'dashboard', 'tree', 'vault'].every((k) => views.split(',').includes(k)), views);
        check('...and neither a Timeline nor a Calendar', !/\b(timeline|calendar)\b/.test(views), views);

        console.log('\nthe Dashboard of a course that misses its date:');
        // The header's verdict comes with the pace; the Dashboard's own sections
        // with the dashboard. Both have arrived once the Tools section is drawn
        // and the verdict is on screen; then the page is given time to settle.
        await page.waitFor(`document.body.innerText.includes('Tools') && ${SHOWN_VERDICTS}.length > 0`, 'the Dashboard and its verdict');
        await new Promise((r) => setTimeout(r, 1500));
        const shown = await page.evaluate(SHOWN_VERDICTS);
        check('the verdict is on screen', shown.length >= 1, JSON.stringify(shown));
        check('...once', shown.length === 1, JSON.stringify(shown));

        console.log('\nold addresses:');
        const OLD = [
            ['/schedule', '/projects'],
            ['/calendar', '/projects'],
            [`${course}/timeline/${ids.study}`, `${course}/dashboard/${ids.study}`],
            [`${course}/calendar/${ids.study}`, `${course}/dashboard/${ids.study}`],
            [`${course}/timeline`, `${course}/dashboard`],
            [`${course}/calendar`, `${course}/dashboard`],
        ];
        for (const [from, to] of OLD) {
            await page.go(from, null);
            let landed;
            try {
                await page.waitFor(`location.pathname === ${JSON.stringify(to)}`, to, 5000);
                landed = to;
            } catch {
                landed = await page.evaluate('location.pathname');
            }
            check(`${from} lands on ${to}`, landed === to, `still at ${landed}`);
        }
        // Where it landed is a screen that drew, not an address alone.
        await page.waitFor(`${tabsIn('Project views')}.includes('dashboard')`, 'the course views after a redirect');
        const current = await page.evaluate(`document.querySelector('nav[aria-label="Project views"] [aria-current="page"]')?.dataset.tab ?? ''`);
        check('...and the Dashboard is the view on screen', current === 'dashboard', current);
    },
};

const scratch = mkdtempSync(join(tmpdir(), 'plan-views-gates-'));
try {
    await visit('fixture', scratch, [{ states: Object.keys(states) }], { width: 1280, height: 800, scale: 1 }, browserPath, async () => { }, prepare, states);
} finally {
    removeScratch(scratch);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

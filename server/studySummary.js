// server/studySummary.js — how much the learner studied, as numbers, for the
// top of the activity-log download.
//
// The log records what the software did and keeps only its newest rows, so it
// cannot say whether someone studied for a month. The study tables can, and
// they hold the learner's work, so this reads them at the moment the file is
// made and writes COUNTS only: no title, note, card, question, answer or name
// of a course is ever selected here, so none can reach the file.
//
// Days are the learner's days (server/studyDay.js), in the calendar the
// finished-project screen counts in (server/completion.js), with a finished
// mock exam counted as well: a review at
// 20:05 UTC on a Sunday is Monday's for a learner in Auckland. The week lines
// are Monday weeks in that calendar, empty ones included, because a gap is
// the thing a reader of this file is looking for.

import db from './database.js';
import { WORK_LEAF } from './today.js';
import { estimateProven, PROVING_EVIDENCE_TYPES } from './mastery.js';
import { getSetting } from './settingsStore.js';
import { learnerTimeZone, localDate, minuteDates, mondayOf } from './studyDay.js';
import { hourDate } from './studyTime.js';
import { streamActivityLog, logActivity, failureFacts } from './activityLog.js';

/** Week lines kept: a year of them, newest last. */
const MAX_WEEKS = 52;
const DAY_MS = 86_400_000;

const MINUTE = (col) => `strftime('%Y-%m-%dT%H:%M', ${col})`;

let stmts = null;
function statements() {
    if (stmts) return stmts;
    const types = PROVING_EVIDENCE_TYPES.map(t => `'${t}'`).join(', ');
    stmts = {
        // Each row: a minute, and what happened in it. Card reviews done in
        // this app only (an imported deck's history is someone else's
        // studying); evidence other than card ratings, which the reviews
        // already count; a topic marked done; a mock exam handed in.
        // server/completion.js counts the same rows for one course; the
        // activity-log gate holds the two to the same answer on one course.
        events: db.prepare(`
            SELECT ${MINUTE('reviewed_at')} AS at, COUNT(*) AS reviews, 0 AS answers, 0 AS checks
            FROM review_log WHERE source = 'app' GROUP BY at
          UNION ALL
            SELECT ${MINUTE('created_at')} AS at, 0, SUM(total),
                   SUM(CASE WHEN evidence_type IN (${types}) THEN 1 ELSE 0 END)
            FROM mastery_evidence WHERE evidence_type != 'flashcard' GROUP BY at
          UNION ALL
            SELECT ${MINUTE('completed_at')} AS at, 0, 0, 0
            FROM live_nodes nodes WHERE completed_at IS NOT NULL AND is_note = 0 GROUP BY at
          UNION ALL
            SELECT ${MINUTE('finished_at')} AS at, 0, 0, 0
            FROM mock_sittings WHERE status = 'done' AND finished_at IS NOT NULL GROUP BY at
        `),
        time: db.prepare('SELECT hour, SUM(active_ms) AS ms FROM study_time GROUP BY hour'),
        checks: db.prepare(`
            SELECT evidence_type AS type, COUNT(*) AS n FROM mastery_evidence
            WHERE evidence_type IN (${types}) GROUP BY evidence_type
        `),
        reviews: db.prepare("SELECT COUNT(*) AS n FROM review_log WHERE source = 'app'"),
        answers: db.prepare("SELECT COALESCE(SUM(total), 0) AS n FROM mastery_evidence WHERE evidence_type != 'flashcard'"),
        mocks: db.prepare("SELECT COUNT(*) AS n FROM mock_sittings WHERE status = 'done'"),
        courses: db.prepare('SELECT COUNT(*) AS n FROM live_projects projects'),
        // Over the line on the stored estimate; `estimateProven` then takes
        // out what cards and drills lifted, which never prove a topic.
        provenCandidates: db.prepare(`
            SELECT m.node_id FROM node_mastery m
            JOIN live_nodes n ON n.id = m.node_id
            WHERE ${WORK_LEAF} AND m.mastery_score >= ? AND m.total_attempts > 0
        `),
    };
    return stmts;
}

const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/**
 * The counts, as numbers. `now` is the instant "this week" is read at.
 *
 * @returns {{ studyDays, studyMinutes, proven, checks, checksBy, answers,
 *   reviews, mocksFinished, courses, firstDay, weeks }}
 */
export function studySummary({ now = Date.now(), timeZone = learnerTimeZone() } = {}) {
    const s = statements();
    const days = new Map(); // date → { ms, reviews, answers, checks }
    const day = (date) => {
        let d = days.get(date);
        if (!d) days.set(date, d = { ms: 0, reviews: 0, answers: 0, checks: 0 });
        return d;
    };
    const dayOf = minuteDates(timeZone);
    for (const r of s.events.all()) {
        if (!r.at) continue;
        const d = day(dayOf(r.at));
        d.reviews += r.reviews || 0;
        d.answers += r.answers || 0;
        d.checks += r.checks || 0;
    }
    let totalMs = 0;
    for (const r of s.time.all()) {
        if (!(r.ms > 0)) continue;
        day(hourDate(r.hour, timeZone)).ms += r.ms;
        totalMs += r.ms;
    }

    const checksBy = Object.fromEntries(PROVING_EVIDENCE_TYPES.map(t => [t, 0]));
    for (const r of s.checks.all()) checksBy[r.type] = r.n;
    const threshold = parseFloat(getSetting('mastery_threshold') || '0.85') || 0.85;
    const proven = s.provenCandidates.all(threshold).filter(r => estimateProven(r.node_id, threshold)).length;

    const dates = [...days.keys()].sort();
    const weeks = [];
    let weeksCut = false;
    if (dates.length) {
        const thisWeek = mondayOf(localDate(now, timeZone));
        const firstWeek = mondayOf(dates[0]);
        const floor = addDays(thisWeek, -7 * (MAX_WEEKS - 1));
        weeksCut = firstWeek < floor;
        // Rows that all lie after this week fold into it, so it still starts here.
        let week = weeksCut ? floor : (firstWeek > thisWeek ? thisWeek : firstWeek);
        const byWeek = new Map();
        for (const date of dates) {
            // A day after this week (a clock flush near midnight, a restored
            // row) folds into this week: the lines end now, whatever is stored.
            const monday = mondayOf(date);
            const w = monday > thisWeek ? thisWeek : monday;
            const row = byWeek.get(w) || { days: 0, ms: 0, checks: 0, answers: 0, reviews: 0 };
            const d = days.get(date);
            row.days++;
            row.ms += d.ms;
            row.checks += d.checks;
            row.answers += d.answers;
            row.reviews += d.reviews;
            byWeek.set(w, row);
        }
        for (; week <= thisWeek; week = addDays(week, 7)) {
            const row = byWeek.get(week) || { days: 0, ms: 0, checks: 0, answers: 0, reviews: 0 };
            weeks.push({ week, days: row.days, minutes: Math.round(row.ms / 60000), checks: row.checks, answers: row.answers, reviews: row.reviews });
        }
    }

    return {
        studyDays: dates.length,
        studyMinutes: Math.round(totalMs / 60000),
        proven,
        checks: Object.values(checksBy).reduce((a, b) => a + b, 0),
        checksBy,
        answers: s.answers.get().n,
        reviews: s.reviews.get().n,
        mocksFinished: s.mocks.get().n,
        courses: s.courses.get().n,
        firstDay: dates[0] || null,
        weeks,
        weeksCut,
    };
}

/** The summary as `#` lines, so a reader of events per line skips it. */
export function studySummaryLines(summary) {
    const field = (label, value) => `#  ${label.padEnd(22)}${value}\n`;
    const c = summary.checksBy;
    const lines = [
        '# Study summary: how much and when, as counts only, read from the study record when this file was made. Days follow your own time zone.\n',
        field('study days', summary.studyDays),
        field('study minutes', summary.studyMinutes),
        field('proven topics', summary.proven),
        field('checks', `${summary.checks} (mastery checks ${c.mastery_check}, quizzes ${c.quiz}, paper exercises ${c.paper})`),
        field('questions answered', summary.answers),
        field('card reviews', summary.reviews),
        field('mock exams finished', summary.mocksFinished),
        field('courses', summary.courses),
        field('first study day', summary.firstDay || 'none yet'),
    ];
    if (summary.weeks.length) {
        // The totals above cover all of it; without this line a library older
        // than a year has rows that do not add up to them.
        if (summary.weeksCut) lines.push(`#  weeks: the latest ${MAX_WEEKS} only; the totals above cover every week\n`);
        const cols = ['days', 'minutes', 'checks', 'answers', 'reviews'];
        // "days" is days studied in that week; the date is the week's Monday.
        lines.push(`#  ${'week (Mon)'.padEnd(10)}${cols.map(h => h.padStart(9)).join('')}\n`);
        for (const w of summary.weeks) {
            lines.push(`#  ${w.week}${cols.map(k => String(w[k]).padStart(9)).join('')}\n`);
        }
    }
    lines.push('#\n');
    return lines;
}

/**
 * The file behind Settings → Activity log → Download: the log's header, the
 * study summary, then the events. The summary is worked out whatever state
 * the log is in (empty, cleared, switched off, at its cap): it never reads it.
 */
export function* activityExport({ now = Date.now(), timeZone } = {}) {
    let preamble;
    try {
        preamble = studySummaryLines(studySummary({ now, timeZone }));
    } catch (e) {
        // The events still go out: a summary that cannot be read must not
        // cost the file that worked before it existed. The error's name only,
        // never its message, in the file; the log gets its facts.
        logActivity({ area: 'server', level: 'warn', event: 'activity.summary_failed', detail: failureFacts(e) });
        preamble = [`# Study summary: could not be worked out (${String(e?.name || 'Error').replace(/[^\w]/g, '')}).\n`, '#\n'];
    }
    yield* streamActivityLog({ now, preamble });
}

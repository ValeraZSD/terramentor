// /api/onboarding: the first-run checklist.
import db from '../database.js';
import { getSetting } from '../settingsStore.js';
import { routeTable } from './routeTable.js';

const app = routeTable('onboarding');

// ONBOARDING
//
// There was no first-run experience at all: a new install got a seeded tutorial
// project and nothing that said what the feed, the gate or the vault were for.
// This is deliberately NOT a tour — no coach marks, no "next" buttons over a UI
// nobody asked to be walked through. It is a checklist of the five things that
// make the loop work, each one satisfied by DOING it, computed from real data.
// Uploading your own material is not one of them: many learners never do, and
// the card retires only when every step is done.
// So it disappears by being used, and it cannot claim you did something you
// didn't. The copy lives on the client; the server only answers "done or not".
app.get('/api/onboarding', (req, res) => {
    try {
        const count = (sql, ...args) => db.prepare(sql).get(...args)?.c ?? 0;
        const inboxId = Number(getSetting('inbox_project_id', '')) || -1;

        // "A project of your own" — the Inbox is ours, not theirs, so it does
        // not tick this box. There was a seeded tutorial project excluded here
        // by name too; a new library now starts empty, so the only project
        // anyone has is one they made.
        const ownProjects = count('SELECT COUNT(*) c FROM projects WHERE id != ?', inboxId);

        res.json({
            dismissed: getSetting('onboarding_dismissed', 'false') === 'true',
            steps: {
                project: ownProjects > 0,
                schedule: count('SELECT COUNT(*) c FROM projects WHERE start_date IS NOT NULL AND deadline IS NOT NULL') > 0,
                lesson: count("SELECT COUNT(*) c FROM feed_items WHERE kind = 'lesson' AND consumed_at IS NOT NULL") > 0,
                answer: count('SELECT COUNT(*) c FROM mastery_evidence') > 0,
                prove: count("SELECT COUNT(*) c FROM mastery_evidence WHERE evidence_type = 'mastery_check'")
                    + count("SELECT COUNT(*) c FROM nodes WHERE status = 'completed'") > 0,
            },
        });
    } catch (err) {
        console.error('[Onboarding] status failed:', err.message);
        res.json({ dismissed: true, steps: {} }); // never block the feed on this
    }
});

app.post('/api/onboarding/dismiss', (req, res) => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('onboarding_dismissed', ?)")
        .run(req.body?.dismissed === false ? 'false' : 'true');
    res.json({ success: true });
});

export const routes = app.takeRoutes();

// One creation run's activity log: which server frame becomes which line.
// Pure, so the run store (creationRuns.ts) can fold frames into a run without
// importing any component.
import i18n, { k } from '../../i18n';

// The creation-status sentences the SERVER authors (the send() sites in
// server/routes/createProject.js). The log and the progress panel now write their own lines
// from the frame's structure, so no client call site names most of these — but
// a step the client does not know is still rendered as t(messageKey), and the
// extractor would prune an unnamed key from en.json. i18n-source-gates asserts
// the server's whole messageKey list against en.json.
export const SERVER_CREATION_MESSAGE_KEYS = [
    k("Analyzing project scope"),
    k("Checking the AI model..."),
    k('Model "{{model}}" is ready.'),
    k("Creating project…"),
    k("Generating project summary…"),
    k("Generating phases…"),
    k('Generating topics for "{{category}}"…'),
    k('Expanding "{{title}}"…'),
    k('Generating details for "{{title}}"…'),
    k('Finding links for "{{title}}"…'),
];

// ACTIVITY LOG
export interface LogEntry {
    id: string;
    message: string;
    status: 'running' | 'success' | 'error' | 'warning';
    task?: string;
    error?: string;
}

export function eventToLogEntry(event: any): LogEntry | null {
    const phase = event.phase;
    const cat = event.currentCategory;
    const el = event.currentElement;
    const se = event.currentSubElement;

    // Determine a stable ID for deduplication
    let id = phase;
    if (cat) id += `-${cat}`;
    if (el) id += `-${el}`;
    if (se) id += `-${se}`;

    // Map to concise message
    let message = event.message || '';
    let status: LogEntry['status'] = 'success';

    // Each step logs twice — once when it starts, once when it lands — and the
    // two share an id on purpose, so the second upsert turns the spinner into a
    // tick instead of leaving a stalled row above its own result.
    switch (phase) {
        case 'thinking':
            //Skip thinking-phase events — they're not useful milestones
            return null;

        case 'init':
            // The server's init frames carry their own messageKey (model check,
            // model ready, shell created); the raw English `message` is a
            // fallback for a frame that predates the keys.
            // The shell frame carries the new project's id: that step is DONE,
            // and "Creating project…" beside a tick read as still going.
            message = event.projectId
                ? i18n.t("Project created")
                : event.messageKey
                    ? i18n.t(event.messageKey, event.params || undefined)
                    : i18n.t("Creating project…");
            // The model check is a step STARTING, so it is running until the
            // "ready" frame; a tick here would stand beside the check's failure.
            status = event.messageKey === 'Checking the AI model...' ? 'running' : 'success';
            id = 'init';
            break;

        case 'summary':
            // Two events carry this phase: the one announcing the work has a
            // message, the one delivering the result has the summary text.
            if (event.summary) {
                message = i18n.t("Project summary written");
                status = 'success';
            } else {
                message = event.messageKey
                    ? i18n.t(event.messageKey, event.params || undefined)
                    : i18n.t("Generating project summary…");
                status = 'running';
            }
            id = 'summary';
            break;

        case 'planned':
        case 'generating_categories':
        case 'categories_generated':
            id = 'categories';
            if (phase === 'categories_generated') {
                const count = event.categories?.length || 0;
                message = count > 0 ? i18n.t("{{count}} phases created", { count }) : message;
                status = 'success';
            } else {
                message = i18n.t("Generating phases…");
                status = 'running';
            }
            break;

        // The app's own words for the three levels: a PHASE, the SECTIONS
        // inside it, and the TOPICS — the leaves the learner studies. The
        // progress line's "42 of 120 topics" counts leaves, so the log beneath
        // it must use "topics" for leaves too, or one name counts two things.
        case 'generating_elements':
        case 'elements_generated':
            id = `elements-${cat}`;
            if (phase === 'elements_generated') {
                const count = event.elements?.length || 0;
                const label = cat || i18n.t("Phase");
                // The count is rendered even at 0 — an English `message` leak is
                // worse than an honest "0 sections".
                message = i18n.t("{{label}}: {{count}} sections", { label, count });
                status = 'success';
            } else {
                message = cat ? i18n.t('Writing the sections of “{{title}}”…', { title: cat }) : i18n.t("Writing sections…");
                status = 'running';
            }
            break;

        case 'generating_sub_elements':
        case 'sub_elements_generated':
            // A whole phase can be expanded in one batched call, which reports
            // no section of its own — that run is its own row, settled by
            // `sub_elements_batched` below.
            id = el ? `sub_elements-${cat}-${el}` : `sub_elements-${cat}`;
            if (phase === 'sub_elements_generated') {
                const count = event.subElements?.length || 0;
                const label = el || se || i18n.t("Section");
                message = i18n.t("{{label}}: {{count}} topics", { label, count });
                status = 'success';
            } else {
                const title = el || cat;
                message = title ? i18n.t('Writing the topics of “{{title}}”…', { title }) : i18n.t("Writing topics…");
                status = 'running';
            }
            break;

        case 'sub_elements_batched':
            // The server's prose here is English (`Category: N topics expanded`);
            // the count travels on the frame, so the translated key renders it.
            message = event.batched > 0
                ? i18n.t("{{label}}: topics for {{count}} sections", { label: cat || i18n.t("Phase"), count: event.batched })
                : i18n.t("Writing topics section by section…");
            status = event.batched > 0 ? 'success' : 'warning';
            id = `sub_elements-${cat}`;
            break;

        case 'finding_resources':
        case 'resources_saved':
            id = `resources-${cat}-${el}-${se}`;
            if (phase === 'resources_saved') {
                // No search ran, so there is nothing to report — the event still
                // drives the live tree, it just doesn't belong in the log.
                if (event.curated === false) return null;
                const rc = event.resourceCount || 0;
                const label = se || el || i18n.t("Topic");
                message = rc > 0 ? i18n.t("{{label}}: {{count}} links found", { label, count: rc })
                    : i18n.t("{{label}}: resources checked", { label });
                status = 'success';
            } else {
                message = se ? i18n.t('Finding links for "{{title}}"…', { title: se }) : i18n.t("Finding links…");
                status = 'running';
            }
            break;

        case 'complete':
            message = event.messageKey
                ? i18n.t(event.messageKey, event.params || undefined)
                : i18n.t("Project complete!");
            status = 'success';
            id = 'complete';
            break;

        case 'error':
            // The banner states the error; the log marks the step it stopped
            // (`settleRunningLogEntries('error')`) rather than printing the
            // same sentence a third time.
            return null;

        case 'cancelled':
            message = i18n.t("Cancelled by user");
            status = 'warning';
            id = 'cancelled';
            break;

        case 'sources': {
            // What the course is built from, once, at the start.
            const files = event.sources || [];
            const first = files[0];
            message = files.length === 1 && first
                ? (first.sections > 0
                    ? i18n.t("Building from “{{title}}”: {{count}} sections", { title: first.title, count: first.sections })
                    : i18n.t("Building from “{{title}}”", { title: first.title }))
                : i18n.t("Building from {{count}} files", { count: files.length });
            status = 'success';
            id = 'sources';
            break;
        }

        case 'queued':
        case 'thinking_done':
            // The progress panel states the wait; neither is a step.
            return null;

        default:
            // A step this list does not know (a newer server's) is logged only
            // when it carries a translatable key — its raw `message` is English
            // prose, and printing it put English lines into every language.
            if (!event.messageKey) return null;
            message = i18n.t(event.messageKey, event.params || undefined);
            id = `misc-${id}`;
            break;
    }

    return { id, message, status, task: event.task, error: event.error };
}

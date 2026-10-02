import type { AppVersion } from '../types';
import { k } from '../i18n';

/**
 * The bug-report builder — the half of a good issue a non-programmer cannot
 * write.
 *
 * A report that says "it broke on the latest version" is unactionable, and the
 * facts that would make it actionable (which commit, which model, which Node,
 * whether this is Docker) are ones the person reporting has no way to look up.
 * The app knows all of them, so it assembles the block and the person writes
 * only the part they are the expert in: what they were doing and what happened.
 *
 * Two rules govern what may go in here, and they are the whole design:
 *
 *  1. NOTHING PERSONAL. No project names, no topic titles, no notes, no model
 *     output, no file names, no paths. Everything below is a fact about the
 *     software and the machine, never about what is being studied. A diagnostic
 *     block is pasted into a public issue tracker by someone who will not read
 *     it first, so the safe set is the one that cannot embarrass anyone. (What
 *     the person TYPES into a field is theirs, and the dialog shows it to them
 *     in an editable box before anything opens.)
 *
 *  2. NOTHING IS SENT. `reportUrl` builds a link that opens GitHub's own compose
 *     form with the fields pre-filled. The app makes no request; GitHub receives
 *     the text when — and only when — the person presses Submit there. That is
 *     also what keeps this compatible with SECURITY.md: a report is a link the
 *     user clicks, not a call the app makes.
 */

/** Cap on the diagnostics block alone; the whole link has its own budget below. */
const MAX_BODY = 6000;

/**
 * The longest link this builds, in characters of the ENCODED url.
 *
 * Measured 2026-09-28 against github.com/…/issues/new with one long field:
 * signed out, the page redirects to /login with the whole link inside
 * `return_to`, and that round trip fails (HTTP 500) between 6,990 and 7,090
 * characters; signed in, the composer itself answers 414 from about 8,240. A
 * link has to survive the sign-in hop, because a person who is not signed in
 * is exactly who files a first report. 6,000 leaves room for both.
 *
 * Counted encoded because that is what travels: one Cyrillic letter is six
 * characters of URL (`%D0%B0`), so a Russian description reaches the cap at a
 * sixth of the length of an English one.
 */
export const URL_MAX = 6000;

export interface ReportContext {
    version: AppVersion | null;
    aiProvider: string | null;
    aiModel: string | null;
    /** Optional: a failed background task's record, already redacted by
     *  `describeFailure` on the server, which formats it for exactly this. */
    failure?: string | null;
}

/** The facts table. Absent facts are omitted rather than guessed — the same rule
 *  `plainCause` follows on the server: a gap beats an invented value. */
export function diagnostics(ctx: ReportContext): Record<string, string> {
    const v = ctx.version;
    const out: Record<string, string> = {};
    if (v) {
        out.Version = v.version;
        if (v.commitShort) out.Commit = v.commitShort;
        out.Install = v.deployment;
        out.Node = v.node;
        out.Platform = v.platform;
        if (v.builtAt) out.Built = v.builtAt;
    }
    if (ctx.aiProvider) out['AI provider'] = ctx.aiProvider;
    if (ctx.aiModel) out['AI model'] = ctx.aiModel;
    if (typeof navigator !== 'undefined' && navigator.userAgent) {
        out.Browser = navigator.userAgent;
    }
    if (typeof window !== 'undefined' && window.screen) {
        out.Screen = `${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio || 1}x`;
    }
    return out;
}

/** The block a person pastes, or that pre-fills the issue form's environment
 *  field. Fenced so GitHub renders it verbatim rather than reflowing it. */
export function diagnosticsBlock(ctx: ReportContext): string {
    const rows = Object.entries(diagnostics(ctx)).map(([k, v]) => `${k}: ${v}`);
    let block = rows.join('\n');
    if (ctx.failure) block += `\n\n--- last failed task ---\n${ctx.failure}`;
    return block.length > MAX_BODY ? `${block.slice(0, MAX_BODY)}\n… truncated` : block;
}

export type ReportKind = 'bug' | 'content' | 'idea';

const TEMPLATE: Record<ReportKind, string> = {
    bug: 'bug_report.yml',
    content: 'ai_content.yml',
    idea: 'feature_request.yml',
};

/**
 * One text field of an issue form, as the app asks it.
 *
 * `id` and `label` are the form's own, word for word — `tools/report-gates.mjs`
 * reads `.github/ISSUE_TEMPLATE/*.yml` and fails on any drift, because the id
 * is the URL parameter GitHub pre-fills by and a parameter with no matching
 * field is dropped without a word: a renamed field silently empties its box.
 * `help` is the app's own line, shorter than the form's description.
 */
export interface ReportField {
    id: string;
    label: string;
    help?: string;
    type: 'textarea' | 'input';
    required: boolean;
    /** Filled by the app, never typed: the diagnostics block. */
    auto?: 'environment';
    rows?: number;
}

export interface ReportForm {
    kind: ReportKind;
    /** The form's `name:` — also what the dialog calls the kind. */
    name: string;
    fields: ReportField[];
    /**
     * The form's lists and tick-boxes. GitHub pre-fills `input` and `textarea`
     * from a link and nothing else: its schema docs name the id as "the
     * canonical identifier for the field in URL query parameter prefills", and
     * a dropdown or a checkbox passed the same way is ignored (option text and
     * index both tried and reported in community discussion #5288). So the app
     * does not ask these — asking would make the person answer twice — and says
     * instead that GitHub will.
     */
    onGitHub: { id: string; label: string; type: 'dropdown' | 'checkboxes' }[];
    /** One sentence telling the person what GitHub's page will still ask. */
    githubAsks: string;
}

// `k()` marks each shown string as a key (the dialog renders it through `t()`);
// it is identity at runtime, so a label here is still the form's label to the
// letter, which is what the gate compares. The environment's label is not
// shown — the dialog heads the machine report "These details go with it" — so
// it is the form's English only, for Copy report and the parity gate.
const ENVIRONMENT: ReportField = {
    id: 'environment', label: 'Version and environment', type: 'textarea', required: true, auto: 'environment',
};

export const REPORT_FORMS: Record<ReportKind, ReportForm> = {
    bug: {
        kind: 'bug',
        name: k("Something is broken"),
        fields: [
            { id: 'what-happened', label: k("What happened?"), type: 'textarea', required: true, rows: 4,
                help: k("What you were doing, and what the app did instead of what you expected.") },
            { id: 'steps', label: k("How can we make it happen again?"), type: 'textarea', required: false,
                help: k("Step by step, as far as you can. “I don't know” is a fine answer.") },
            ENVIRONMENT,
            { id: 'extra', label: k("Screenshot or anything else"), type: 'textarea', required: false, rows: 2,
                help: k("A screenshot is added on GitHub: drag it into this box there.") },
        ],
        onGitHub: [
            { id: 'area', label: 'Which part of the app?', type: 'dropdown' },
            { id: 'frequency', label: 'How often?', type: 'dropdown' },
        ],
        githubAsks: k("On GitHub you will also pick which part of the app it was and how often it happens."),
    },
    content: {
        kind: 'content',
        name: k("The AI got something wrong"),
        fields: [
            { id: 'content', label: k("What did it say?"), type: 'textarea', required: true, rows: 4,
                help: k("The wrong part. For a question, include the options and which one it marked correct.") },
            { id: 'correct', label: k("What is actually correct, and how do you know?"), type: 'textarea', required: true,
                help: k("Name a source if you can, so someone else can check it.") },
            { id: 'subject', label: k("Subject and language"), type: 'input', required: true,
                help: k("The field of study, and the language the content was in.") },
            ENVIRONMENT,
        ],
        onGitHub: [
            { id: 'surface', label: 'Where did you see it?', type: 'dropdown' },
        ],
        githubAsks: k("On GitHub you will also pick where you saw it."),
    },
    idea: {
        kind: 'idea',
        name: k("An idea or request"),
        fields: [
            { id: 'problem', label: k("What are you trying to do?"), type: 'textarea', required: true, rows: 4,
                help: k("In your own words: what is awkward, slow or impossible right now.") },
            { id: 'idea', label: k("What do you think would help?"), type: 'textarea', required: false,
                help: k("A rough idea is fine.") },
            { id: 'workaround', label: k("What do you do instead today?"), type: 'textarea', required: false },
        ],
        onGitHub: [
            { id: 'roadmap', label: 'Before you post', type: 'checkboxes' },
        ],
        githubAsks: k("On GitHub you will also tick a box to say you have read the roadmap."),
    },
};

export const REPORT_KINDS: ReportKind[] = ['bug', 'content', 'idea'];

/** The template file a kind opens. */
export const templateOf = (kind: ReportKind) => TEMPLATE[kind];

/** What the person has written: a title and the text fields by the form's id. */
export interface ReportDraft {
    kind: ReportKind;
    title: string;
    fields: Record<string, string>;
}

/** A field that did not fit in the link and was cut. */
export interface Shortened {
    id: string;
    label: string;
}

/** Appended where a field was cut, so the reader on GitHub sees it too. */
export const CUT_NOTE = '\n\n… (cut to fit the link: paste the rest from "Copy report" in the app)';

/** A field too long to cut further; below this, the next-longest one gives way. */
const CUT_FLOOR = 200;

const repoBase = (repoUrl: string) => repoUrl.replace(/\/+$/, '');

/**
 * Every parameter the link carries, in the form's own order: the template, the
 * title, each text field, then the machine report. An empty field is left out
 * — GitHub shows its own empty box, and a blank parameter is noise in a link
 * someone may read.
 *
 * NOT sent, on purpose: `labels`, `assignees`, `milestone`. Each needs triage
 * permission on the repository, and GitHub answers a link that asks for an
 * action its visitor may not take with a 404 — a first-time reporter has
 * none. The forms set their own labels.
 */
function reportParams(draft: ReportDraft, ctx: ReportContext, override: Record<string, string> = {}): [string, string][] {
    const form = REPORT_FORMS[draft.kind];
    const out: [string, string][] = [['template', TEMPLATE[draft.kind]]];
    const title = (override.title ?? draft.title).trim();
    if (title) out.push(['title', title]);
    for (const f of form.fields) {
        const value = (override[f.id] ?? (f.auto ? diagnosticsBlock(ctx) : draft.fields[f.id] ?? '')).trim();
        if (value) out.push([f.id, value]);
    }
    return out;
}

const linkOf = (repoUrl: string, params: [string, string][]) =>
    `${repoBase(repoUrl)}/issues/new?${new URLSearchParams(params).toString()}`;

/** `s` cut to its first `n` characters without splitting a surrogate pair. */
const firstChars = (s: string, n: number) => Array.from(s).slice(0, n).join('');

/**
 * The link to GitHub's issue composer, pre-filled from the draft, and which
 * fields (if any) had to be cut to keep it under `URL_MAX`.
 *
 * The longest field gives way first, and only as much as it must; a field is
 * never cut below `CUT_FLOOR` characters while a longer one is left whole. A
 * cut field ends in `CUT_NOTE`, and the dialog names it, so a person who
 * wrote more than a link can hold knows to paste the rest — never a 414 on a
 * page they cannot debug.
 */
export function reportUrl(repoUrl: string, draft: ReportDraft, ctx: ReportContext): { url: string; shortened: Shortened[] } {
    const form = REPORT_FORMS[draft.kind];
    const override: Record<string, string> = {};
    const shortened: Shortened[] = [];
    let url = linkOf(repoUrl, reportParams(draft, ctx));
    // Title first in the running for nothing: it is one line, and cutting it is
    // the last thing that helps. Text fields by encoded size, longest first.
    for (let guard = 0; url.length > URL_MAX && guard < 8; guard++) {
        const params = reportParams(draft, ctx, override);
        const sizes = params
            .filter(([k]) => k !== 'template')
            .map(([k, v]) => ({ k, v, enc: new URLSearchParams([[k, v]]).toString().length }))
            .filter(p => Array.from(p.v).length > CUT_FLOOR && !override[p.k]?.endsWith(CUT_NOTE))
            .sort((a, b) => b.enc - a.enc);
        const target = sizes[0];
        if (!target) break;
        // Binary search on characters: the longest prefix that brings the
        // whole link under the cap (encoded widths vary per character).
        const chars = Array.from(target.v);
        let lo = CUT_FLOOR, hi = chars.length - 1, best = CUT_FLOOR;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const trial = linkOf(repoUrl, reportParams(draft, ctx, { ...override, [target.k]: firstChars(target.v, mid).trimEnd() + CUT_NOTE }));
            if (trial.length <= URL_MAX) { best = mid; lo = mid + 1; } else hi = mid - 1;
        }
        override[target.k] = firstChars(target.v, best).trimEnd() + CUT_NOTE;
        const field = form.fields.find(f => f.id === target.k);
        shortened.push({ id: target.k, label: field?.label ?? 'Title' });
        url = linkOf(repoUrl, reportParams(draft, ctx, override));
    }
    return { url, shortened };
}

/**
 * The whole report as text, never cut — what "Copy report" puts on the
 * clipboard, in the shape GitHub renders an issue form (`### label`, then the
 * answer), so a paste into the composer or anywhere else reads the same.
 */
export function reportText(draft: ReportDraft, ctx: ReportContext): string {
    const form = REPORT_FORMS[draft.kind];
    const parts: string[] = [];
    const title = draft.title.trim();
    if (title) parts.push(title);
    for (const f of form.fields) {
        const value = (f.auto ? diagnosticsBlock(ctx) : draft.fields[f.id] ?? '').trim();
        if (value) parts.push(`### ${f.label}\n\n${value}`);
    }
    return parts.join('\n\n');
}

/**
 * The older entry point: a link carrying only the machine report. Kept for
 * callers that have no draft; it is `reportUrl` with every field empty, so the
 * two cannot drift. `environment` is the forms' own id.
 */
export function issueUrl(repoUrl: string, kind: ReportKind, ctx: ReportContext): string {
    return reportUrl(repoUrl, { kind, title: '', fields: {} }, ctx).url;
}

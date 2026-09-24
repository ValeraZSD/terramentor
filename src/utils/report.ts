import type { AppVersion } from '../types';

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
 *     it first, so the safe set is the one that cannot embarrass anyone.
 *
 *  2. NOTHING IS SENT. `issueUrl` builds a link that opens GitHub's own compose
 *     form with the fields pre-filled. The app makes no request; GitHub receives
 *     the text when — and only when — the person presses Submit there. That is
 *     also what keeps this compatible with SECURITY.md: a report is a link the
 *     user clicks, not a call the app makes.
 */

/** A GitHub URL is capped around 8k before servers start rejecting it; the
 *  template plus a generous description stays far inside this. Truncating is
 *  better than a silent 414 on a page the user cannot debug. */
const MAX_BODY = 6000;

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
 * A link to GitHub's issue composer with the template chosen and the
 * environment field filled in.
 *
 * The `template` parameter selects one of the YAML issue FORMS, so the person
 * lands on labelled fields with dropdowns rather than an empty markdown box —
 * which is the actual difference between a report a non-programmer can file and
 * one they abandon. `environment` is the form's own field id; a parameter that
 * does not match a field is ignored by GitHub, so a renamed field degrades to an
 * empty box rather than an error page.
 */
export function issueUrl(repoUrl: string, kind: ReportKind, ctx: ReportContext): string {
    const params = new URLSearchParams({ template: TEMPLATE[kind] });
    // Only the two forms that HAVE an environment field get one. An idea is not
    // about a build, and its form asks nothing about one — GitHub would ignore
    // the parameter, but sending a machine report along with a feature request
    // is noise in a thread that is meant to be a conversation.
    if (kind !== 'idea') params.set('environment', diagnosticsBlock(ctx));
    return `${repoUrl.replace(/\/+$/, '')}/issues/new?${params.toString()}`;
}

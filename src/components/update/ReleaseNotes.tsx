import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import type { ReleaseNote, ReleaseNotes as Notes } from '../../types';
import { uiLocale } from '../../utils/locale';
import { ButtonLink } from '../ui/Button';
import { unbroken } from './updateView';

/**
 * What changed, in the app: one section per release, newest first, each a
 * short list. The check already holds these lines (server/version.js
 * `notesSince`), so reading them asks nothing of the network; GitHub is the
 * link at the end, for the rest.
 *
 * `limit` is for the header's hover card: the first lines of the newest
 * release and a count of the rest, never a scroll inside a tooltip. A
 * release with a headline (a stable one) stands there as its headline: its
 * sentences are paragraphs, too long for a card read in passing.
 */
export default function ReleaseNotesList({ notes, repoUrl, limit }: { notes: Notes; repoUrl: string; limit?: number }) {
    const { t } = useTranslation();
    if (limit != null) {
        const lines = notes.releases.flatMap((r) => (r.title ? [r.title] : r.items));
        const shown = lines.slice(0, limit);
        const rest = lines.length - shown.length
            + notes.releases.reduce((n, r) => n + r.more + (r.title ? r.items.length : 0), 0);
        return (
            <>
                <ul className="list-disc pl-4 space-y-1">
                    {/* The clamp sits on a span: on the li it would replace
                        list-item display and drop the bullet. */}
                    {shown.map((item, i) => <li key={i} className="break-words"><span className="line-clamp-2">{item}</span></li>)}
                </ul>
                {rest > 0 && <p className="mt-1 text-slate-500 dark:text-slate-400">{t("and {{count}} more change", { count: rest })}</p>}
            </>
        );
    }
    return (
        <div className="space-y-4">
            {notes.releases.map((release) => (
                <Release key={release.version} release={release} repoUrl={repoUrl} />
            ))}
            {notes.omitted > 0 && (
                <NotesLink href={`${repoUrl}/releases`}>{t("{{count}} earlier release on GitHub", { count: notes.omitted })}</NotesLink>
            )}
        </div>
    );
}

function Release({ release, repoUrl }: { release: ReleaseNote; repoUrl: string }) {
    const { t } = useTranslation();
    const date = release.publishedAt ? formatDay(release.publishedAt) : null;
    // A nightly's number is a date stamp; the date it was published reads
    // better as the heading, with the number beside it for a bug report.
    const version = unbroken(release.version);
    const heading = release.title || (release.version.includes('-') && date ? date : version);
    const under = [version, date].filter((s) => s && s !== heading).join(' · ');
    return (
        <section>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{heading}</h3>
            {under && <p className="text-xs text-slate-500 dark:text-slate-400">{under}</p>}
            {release.items.length > 0 && (
                <ul className="mt-2 list-disc pl-5 space-y-1.5 text-sm text-slate-700 dark:text-slate-200">
                    {release.items.map((item, i) => <li key={i} className="break-words">{item}</li>)}
                </ul>
            )}
            {release.libraries > 0 && (
                <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">{t("Updated {{count}} library the app is built on", { count: release.libraries })}</p>
            )}
            {release.more > 0 && (
                <NotesLink href={`${repoUrl}/releases/tag/v${release.version}`}>{t("{{count}} more change on GitHub", { count: release.more })}</NotesLink>
            )}
        </section>
    );
}

/** A link out to GitHub. Inside the list it is inset by its own padding, so
 *  its text lines up with the lines above it. */
export function NotesLink({ href, children, inList = true }: { href: string; children: string; inList?: boolean }) {
    return (
        <ButtonLink href={href} target="_blank" rel="noopener noreferrer" variant="quiet" size="sm" className={inList ? 'mt-1 -ml-2.5' : ''} trailing={<ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />}>
            {children}
        </ButtonLink>
    );
}

/** "26 October 2026" in the interface language. */
function formatDay(iso: string): string | null {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return new Intl.DateTimeFormat(uiLocale(), { day: 'numeric', month: 'long', year: 'numeric' }).format(d);
}

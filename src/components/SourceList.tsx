import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Globe } from 'lucide-react';
import { api } from '../api';
import type { CitedFile } from '../types';
import type { SourceEntry } from '../utils/citations';
import { planLink } from '../utils/sameOrigin';
import { Chip, ChipLink } from './ui/Chip';
import DocumentTextDialog, { TextDocument } from './DocumentTextDialog';

/** What GET /api/documents/cited takes per request (server/routes/documents.js). */
const ENTRIES_PER_REQUEST = 20;
const ENTRY_MAX_CHARS = 500;

/** What the lookup said about one answer's entries; entries it did not answer (yet) are in none. */
interface LookUp {
    /** The answer's entries, joined: a result belongs to the answer it was asked for. */
    key: string;
    found: ReadonlyMap<string, CitedFile>;
    /** No document has that name now. */
    missing: ReadonlySet<string>;
    /** Two different files have that name: neither is opened. */
    shared: ReadonlySet<string>;
}

/**
 * Looks every entry up, twenty to a request. An entry longer than the server
 * takes is not asked about (it stays its title), so one long title cannot
 * cost the rest of the line its lookup; a request that fails leaves its
 * entries unanswered, never "missing".
 */
async function lookUp(key: string): Promise<LookUp> {
    const ask = [...new Set(key.split('\n'))].filter(e => e && e.length <= ENTRY_MAX_CHARS);
    const batches: string[][] = [];
    for (let i = 0; i < ask.length; i += ENTRIES_PER_REQUEST) batches.push(ask.slice(i, i + ENTRIES_PER_REQUEST));
    const settled = await Promise.allSettled(batches.map(b => api.citedDocuments(b)));
    const found = new Map<string, CitedFile>();
    const missing = new Set<string>();
    const shared = new Set<string>();
    for (const s of settled) {
        if (s.status !== 'fulfilled') continue;
        for (const row of s.value) {
            if (row.id != null) found.set(row.entry, row);
            else (row.shared ? shared : missing).add(row.entry);
        }
    }
    return { key, found, missing, shared };
}

/** The original as the browser opens it, at the cited page when there is one (PDF viewers read `#page=`). */
const originalHref = (doc: CitedFile) =>
    `${api.documentOriginalUrl(doc.id)}${doc.page ? `#page=${doc.page}` : ''}`;

const ICON = 'w-3.5 h-3.5 shrink-0';
/** The page or the site after a name: a colour, not an opacity, so it keeps 4.5:1 on the chip. */
const QUIET = 'shrink-0 font-normal text-slate-500 dark:text-slate-400';
/** An entry that opens nothing, in the same box as a chip so nothing moves when a lookup lands. */
const PLAIN = 'inline-flex min-h-6 min-w-0 max-w-full items-center gap-1 border border-transparent px-2.5 py-0.5 font-medium';

/**
 * The line of sources under an answer, each one something to open: a page
 * from the web where it lives, a document from the learner's library as the
 * file itself, at the page the answer read, or as its extracted text when the
 * browser cannot show the file. An entry no document answers to any more (the
 * file was removed from the library) stays its title, as plain text.
 *
 * Looked up per answer, every time it mounts: a document deleted, renamed or
 * filed again since is never opened from a remembered id.
 */
export default function SourceList({ sources }: { sources: SourceEntry[] }) {
    const { t } = useTranslation();
    const docEntries = sources.flatMap(s => (s.kind === 'doc' ? [s.entry] : []));
    const key = docEntries.join('\n');
    const [result, setResult] = useState<LookUp | null>(null);
    const [textDoc, setTextDoc] = useState<TextDocument | null>(null);
    // Only the lookup of THIS line counts: a line that changed waits for its own.
    const looked = result?.key === key ? result : null;

    useEffect(() => {
        if (!key) return;
        let live = true;
        lookUp(key)
            .then(r => { if (live) setResult(r); })
            .catch(() => { /* the titles stay as text: nothing to open is not an error */ });
        return () => { live = false; };
    }, [key]);

    // A hanging list: the label in its own column, so a second row of chips
    // starts under the first chip, not under the label. Where the panel is too
    // narrow to give the chips 20rem beside it (a phone), the chips drop under
    // the label at full width instead of truncating every title.
    return (
        <div className="not-prose mt-3 flex flex-wrap items-start gap-1.5 text-xs text-slate-500 dark:text-slate-400" data-sources>
            <span className="inline-flex min-h-6 shrink-0 items-center font-medium">{t("Sources:")}</span>
            <div className="flex min-w-0 flex-1 basis-80 flex-wrap items-center gap-1.5">
            {sources.map((s, i) => {
                if (s.kind === 'web') {
                    // The same guard as every link in an answer (MarkdownLink):
                    // only an address AWAY from this app is a link; one into
                    // its own API, which a page the model read could have put
                    // here, is its label as text.
                    const plan = planLink(s.href, s.label);
                    const icon = <Globe className={ICON} aria-hidden="true" />;
                    if (plan.kind !== 'away') {
                        return <span key={i} className={PLAIN}>{icon}<span className="truncate">{s.label}</span></span>;
                    }
                    // The site after the label, unless the label already names it (planLink's rule).
                    const host = plan.shows.replace(/^www\./, '');
                    return (
                        <ChipLink key={i} shrink href={plan.href} target="_blank" rel="noopener noreferrer"
                            icon={icon} title={plan.href} className="max-w-full">
                            <span className="truncate">{s.label}</span>
                            {host && <span className={QUIET}>{host}</span>}
                        </ChipLink>
                    );
                }
                const doc = looked?.found.get(s.entry);
                const name = doc?.title || s.label;
                const page = doc?.page ? t("page {{page}}", { page: doc.page }) : '';
                const body = (
                    <>
                        <span className="truncate">{name}</span>
                        {page && <span className={QUIET}>{page}</span>}
                    </>
                );
                const icon = <FileText className={ICON} aria-hidden="true" />;
                const label = page ? `${name}, ${page}` : name;
                if (doc && doc.inline) {
                    return (
                        <ChipLink key={i} shrink href={originalHref(doc)} target="_blank" rel="noopener noreferrer"
                            icon={icon} title={label} className="max-w-full" data-source-doc={doc.id}>
                            {body}
                        </ChipLink>
                    );
                }
                if (doc) {
                    return (
                        <Chip key={i} shrink icon={icon} title={label} className="max-w-full" data-source-doc={doc.id}
                            onClick={() => setTextDoc({ id: doc.id, title: doc.title || s.label, original: doc.original })}>
                            {body}
                        </Chip>
                    );
                }
                // Not (or not yet) found: the title as text. Once the lookup
                // has said why it cannot be opened, it says so rather than
                // looking like a broken chip; while it is still being looked
                // up, or the lookup failed, it claims nothing.
                const why = looked?.missing.has(s.entry) ? t("not in your library")
                    : looked?.shared.has(s.entry) ? t("several files have this name")
                    : '';
                return (
                    <span key={i} title={label} className={PLAIN}>
                        {icon}
                        {body}
                        {why && <span className={QUIET}>{why}</span>}
                    </span>
                );
            })}
            </div>
            <DocumentTextDialog doc={textDoc} onClose={() => setTextDoc(null)} />
        </div>
    );
}

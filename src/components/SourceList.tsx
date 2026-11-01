import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Globe } from 'lucide-react';
import { api } from '../api';
import type { CitedDocument } from '../types';
import type { SourceEntry } from '../utils/citations';
import { Chip, ChipLink } from './ui/Chip';
import DocumentTextDialog, { TextDocument } from './DocumentTextDialog';

/**
 * Where each stored entry points, asked once per entry for the page's life:
 * an answer is drawn again on every scroll and every re-render of the drawer.
 * Only a FOUND document is remembered, so an entry whose file is added later
 * is looked up again the next time the answer is drawn.
 */
const found = new Map<string, CitedDocument>();

/** Looks the entries up; returns the ones no document answers to. */
async function lookUp(entries: string[]): Promise<Set<string>> {
    const ask = [...new Set(entries)].filter(e => !found.has(e)).slice(0, 20);
    const missing = new Set<string>();
    if (!ask.length) return missing;
    const rows = await api.citedDocuments(ask);
    for (const row of rows) {
        if (row.id != null) found.set(row.entry, row);
        else missing.add(row.entry);
    }
    return missing;
}

const hostOf = (href: string) => {
    try { return new URL(href).host.replace(/^www\./, ''); } catch { return ''; }
};

/** The original as the browser opens it, at the cited page when there is one (PDF viewers read `#page=`). */
const originalHref = (doc: CitedDocument) =>
    `${api.documentOriginalUrl(doc.id as number)}${doc.page ? `#page=${doc.page}` : ''}`;

const ICON = 'w-3.5 h-3.5 shrink-0';
/** The page or the site after a name: a colour, not an opacity, so it keeps 4.5:1 on the chip. */
const QUIET = 'shrink-0 font-normal text-slate-500 dark:text-slate-400';

/**
 * The line of sources under an answer, each one something to open: a page
 * from the web where it lives, a document from the learner's library as the
 * file itself, at the page the answer read, or as its extracted text when the
 * browser cannot show the file. An entry no document answers to any more (the
 * file was removed from the library) stays its title, as plain text.
 */
export default function SourceList({ sources }: { sources: SourceEntry[] }) {
    const { t } = useTranslation();
    const docEntries = sources.flatMap(s => (s.kind === 'doc' ? [s.entry] : []));
    const key = docEntries.join('\n');
    // Entries the lookup ANSWERED with no document: only these say so, never
    // one still being looked up or one whose lookup failed.
    const [missing, setMissing] = useState<ReadonlySet<string>>(() => new Set());
    const [textDoc, setTextDoc] = useState<TextDocument | null>(null);

    useEffect(() => {
        if (!key) return;
        let live = true;
        lookUp(key.split('\n'))
            .then(gone => { if (live) setMissing(gone); })
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
                    const host = hostOf(s.href);
                    return (
                        <ChipLink key={i} shrink href={s.href} target="_blank" rel="noopener noreferrer"
                            icon={<Globe className={ICON} aria-hidden="true" />} title={s.href} className="max-w-full">
                            <span className="truncate">{s.label}</span>
                            {host && host !== s.label && <span className={QUIET}>{host}</span>}
                        </ChipLink>
                    );
                }
                const doc = found.get(s.entry);
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
                            onClick={() => setTextDoc({ id: doc.id as number, title: doc.title || s.label, original: doc.original })}>
                            {body}
                        </Chip>
                    );
                }
                // Not (or not yet) found: the title as text, in the same box so
                // nothing moves when the lookup turns it into something to open.
                // Once the lookup has said no document answers to it, it says why
                // it cannot be opened rather than looking like a broken chip.
                const gone = missing.has(s.entry);
                return (
                    <span key={i} title={label}
                        className="inline-flex min-h-6 min-w-0 max-w-full items-center gap-1 border border-transparent px-2.5 py-0.5 font-medium">
                        {icon}
                        {body}
                        {gone && <span className={QUIET}>{t("not in your library")}</span>}
                    </span>
                );
            })}
            </div>
            <DocumentTextDialog doc={textDoc} onClose={() => setTextDoc(null)} />
        </div>
    );
}

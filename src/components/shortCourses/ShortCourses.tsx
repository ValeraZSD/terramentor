// The Projects page's short courses: one box to paste a link or drop a file
// into, and the short courses made from such sources, one compact row each.
//
// MOCKUP (branch t3code/short-courses). Nothing here reads a link or writes a
// course yet: the states come from `mockShortCourses.ts` through the address
// (`?short=read`, `?short=unreadable`, …) so each can be looked at. What the
// real thing does is in memory `short-course-from-a-link-2026-11-01`.
import { useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
    Archive, CheckCircle2, CircleAlert, Edit2, ExternalLink, File, FileText, Globe, Inbox, Link2,
    ListTree, Loader2, MoreVertical, Paperclip, Play, Sparkles, Trash2, Type, X, Youtube,
} from 'lucide-react';
import { Button, IconButton } from '../ui/Button';
import { MenuItem, MENU_PANEL } from '../ui/Popover';
import { cx, FIELD_BASE } from '../ui/vocabulary';
import { ProjectIcon } from '../ProjectIcon';
import ProgressRing from '../ProgressRing';
import ConnectAIActions from '../ConnectAIActions';
import { useAccentVars } from '../../hooks/useAccentVars';
import { useElementWidth } from '../../hooks/useElementWidth';
import { mockFromUrl } from './mockShortCourses';
import type { ShortCourseRow, SourceKind, SourceState } from './shortCourseTypes';

/** Below this width the box and the rows stack their actions under the text. */
const NARROW_PX = 560;

const KIND_ICON: Record<SourceKind, typeof Globe> = {
    video: Youtube, page: Globe, pdf: FileText, file: File, text: Type,
};

/** The label between two rules that every section of the page uses. */
export function SectionLabel({ children }: { children: ReactNode }) {
    return (
        <div className="flex items-center gap-3 mb-4">
            <div className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">{children}</span>
            <div className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
        </div>
    );
}

function Tile({ children, tone = 'plain' }: { children: ReactNode; tone?: 'plain' | 'warn' }) {
    return (
        <div className={cx(
            'w-10 h-10 rounded-lg flex items-center justify-center shrink-0',
            tone === 'warn'
                ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
        )}>
            {children}
        </div>
    );
}

/** The fallback when a video's captions cannot be fetched: the learner copies
 *  the transcript YouTube shows them and the course is made from that. */
function TranscriptBox({ source }: { source: Extract<SourceState, { state: 'transcript' }> }) {
    const { t } = useTranslation();
    const KindIcon = KIND_ICON[source.kind];
    return (
        <div data-short="source" className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-3 space-y-3">
            <div className="flex items-center gap-3 min-w-0">
                <Tile><KindIcon className="w-5 h-5" aria-hidden="true" /></Tile>
                <div className="min-w-0 flex-1">
                    <p className="text-base font-medium text-slate-900 dark:text-white line-clamp-2">{source.title}</p>
                    <p className="text-sm text-slate-500 dark:text-slate-400">{source.detail}</p>
                </div>
            </div>
            <textarea
                aria-label={t("The video's transcript")}
                defaultValue={source.pasted}
                rows={4}
                className={cx(FIELD_BASE, 'block w-full px-3 py-2 text-sm leading-6 resize-y')}
            />
            <div className="flex flex-wrap items-center justify-end gap-2">
                <Button variant="quiet">{t("Cancel")}</Button>
                <Button variant="primary" icon={<Sparkles className="w-4 h-4" aria-hidden="true" />}>{t("Create short course")}</Button>
            </div>
        </div>
    );
}

function SourceBox({ source, narrow }: { source: SourceState; narrow: boolean }) {
    const { t } = useTranslation();
    // On a phone the forward actions need the whole line, so Clear is the
    // box's own × beside the title instead of a button in that line.
    const clear = narrow ? null : <Button variant="quiet">{t("Clear")}</Button>;
    const corner = narrow && source.state !== 'empty' && source.state !== 'reading'
        ? <IconButton label={t("Clear")} tooltip={false} icon={<X className="w-4 h-4" />} className="self-start -mr-1" />
        : null;
    const kindIcon = 'kind' in source ? KIND_ICON[source.kind] : Link2;
    const KindIcon = kindIcon;

    let tile: ReactNode;
    let first: ReactNode;
    let second: ReactNode;
    let actions: ReactNode;
    switch (source.state) {
        case 'empty':
            tile = <Tile><Link2 className="w-5 h-5" aria-hidden="true" /></Tile>;
            first = (
                <input
                    type="text"
                    aria-label={t("Paste a link or drop a file")}
                    placeholder={t("Paste a link or drop a file")}
                    className="w-full bg-transparent p-0 border-0 text-base font-medium text-slate-900 dark:text-white placeholder:text-slate-500 dark:placeholder:text-slate-400 outline-none focus:ring-0"
                />
            );
            second = t("A web page, a PDF, a YouTube video or a document");
            actions = <Button variant="neutral" icon={<Paperclip className="w-4 h-4" aria-hidden="true" />}>{t("Choose a file")}</Button>;
            break;
        case 'reading':
            tile = <Tile><Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" /></Tile>;
            first = t("Reading {{where}}", { where: source.where });
            second = `${source.step}…`;
            actions = <Button variant="quiet">{t("Cancel")}</Button>;
            break;
        case 'read':
            tile = <Tile><KindIcon className="w-5 h-5" aria-hidden="true" /></Tile>;
            first = source.title;
            second = source.detail;
            actions = <>{clear}<Button variant="primary" icon={<Sparkles className="w-4 h-4" aria-hidden="true" />}>{t("Create short course")}</Button></>;
            break;
        case 'unreadable':
            tile = <Tile tone="warn"><CircleAlert className="w-5 h-5" aria-hidden="true" /></Tile>;
            first = source.title;
            second = source.reason;
            actions = source.fix === 'transcript'
                ? <>{clear}<Button variant="primary" icon={<Type className="w-4 h-4" aria-hidden="true" />}>{t("Paste the transcript")}</Button></>
                : <>{clear}<Button variant="primary" icon={<Sparkles className="w-4 h-4" aria-hidden="true" />}>{t("Write it from the topic")}</Button></>;
            break;
        case 'transcript':
            return <TranscriptBox source={source} />;
        case 'too-big':
            tile = <Tile><KindIcon className="w-5 h-5" aria-hidden="true" /></Tile>;
            first = source.title;
            second = source.detail;
            actions = <>{clear}<Button variant="neutral" block={narrow}>{t("Pick chapters")}</Button><Button variant="primary" block={narrow}>{t("Full course")}</Button></>;
            break;
        case 'too-small':
            tile = <Tile><KindIcon className="w-5 h-5" aria-hidden="true" /></Tile>;
            first = source.title;
            second = source.detail;
            actions = <>{clear}<Button variant="primary" icon={<Inbox className="w-4 h-4" aria-hidden="true" />}>{t("Save to Inbox")}</Button></>;
            break;
        case 'no-ai':
            tile = <Tile><KindIcon className="w-5 h-5" aria-hidden="true" /></Tile>;
            first = source.title;
            second = source.detail;
            actions = <>{clear}<ConnectAIActions returnTo="/projects" /></>;
            break;
    }

    const empty = source.state === 'empty';
    return (
        <div
            data-short="source"
            className={cx(
                'rounded-xl border bg-white dark:bg-slate-800 px-4 py-3',
                empty
                    ? 'border-slate-300 dark:border-slate-600 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent'
                    : 'border-slate-200 dark:border-slate-700',
                narrow ? 'flex flex-col gap-3' : 'flex items-center gap-3 h-[4.5rem]',
            )}
        >
            <div className="flex items-center gap-3 min-w-0 flex-1">
                {tile}
                <div className="min-w-0 flex-1">
                    {empty ? first : (
                        <p className={cx('text-base font-medium text-slate-900 dark:text-white', narrow ? 'line-clamp-2' : 'truncate')}>{first}</p>
                    )}
                    <p className={cx('text-sm text-slate-500 dark:text-slate-400', narrow ? 'line-clamp-3' : 'truncate')}>{second}</p>
                </div>
                {corner}
            </div>
            <div className={cx(
                'items-center gap-2 shrink-0',
                narrow && source.state === 'too-big' ? 'grid grid-cols-2' : 'flex flex-wrap',
                narrow && 'justify-end',
            )}>
                {actions}
            </div>
        </div>
    );
}

function RowMenu() {
    const { t } = useTranslation();
    return (
        <div className={cx('absolute right-0 top-full mt-1 z-20 min-w-52 w-max', MENU_PANEL)} role="menu">
            <MenuItem roving={false} onSelect={() => { }} icon={<ListTree className="w-4 h-4" />}>{t("Make it a full course")}</MenuItem>
            <MenuItem roving={false} onSelect={() => { }} icon={<ExternalLink className="w-4 h-4" />}>{t("Open the source")}</MenuItem>
            <MenuItem roving={false} onSelect={() => { }} icon={<Edit2 className="w-4 h-4" />}>{t("Edit")}</MenuItem>
            <div className="my-1 h-px bg-slate-100 dark:bg-slate-600" />
            <MenuItem roving={false} onSelect={() => { }} icon={<Archive className="w-4 h-4" />}>{t("Archive")}</MenuItem>
            <MenuItem roving={false} tone="danger" onSelect={() => { }} icon={<Trash2 className="w-4 h-4" />}>{t("Delete")}</MenuItem>
        </div>
    );
}

function Row({ row, narrow, menuOpen }: { row: ShortCourseRow; narrow: boolean; menuOpen: boolean }) {
    const { t } = useTranslation();
    const accent = useAccentVars(row.color);
    const KindIcon = KIND_ICON[row.kind];
    const progress = row.topics ? Math.round((row.done / row.topics) * 100) : 0;

    const status = row.state === 'building' ? (
        <Button variant="subtle" size="sm" className="shrink-0 whitespace-nowrap text-accent-fg" icon={<Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}>
            {t("AI generating…")}
        </Button>
    ) : row.state === 'finished' ? (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-3xs font-medium rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 shrink-0">
            <CheckCircle2 className="w-3 h-3" aria-hidden="true" /> {t("Completed")}
        </span>
    ) : (
        <Button variant="primary" icon={<Play className="w-4 h-4" aria-hidden="true" />}>{t("Study")}</Button>
    );

    const menu = (
        <div className="relative shrink-0">
            <IconButton label={t("Course options")} tooltip={false} aria-haspopup="menu" aria-expanded={menuOpen} icon={<MoreVertical className="w-4 h-4" />} />
            {menuOpen && <RowMenu />}
        </div>
    );

    const meta = (
        <p className="text-sm text-slate-500 dark:text-slate-400 flex items-center gap-1.5 min-w-0">
            <KindIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{row.from}</span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0">{t("{{done}} / {{total}} items", { count: row.topics, done: row.done, total: row.topics })}</span>
        </p>
    );

    return (
        <div
            data-short="row"
            style={accent}
            className={cx(
                'rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-3 cursor-pointer hover:border-slate-300 dark:hover:border-slate-600',
                narrow ? 'grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 items-center' : 'flex items-center gap-3',
            )}
        >
            <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 bg-accent text-white">
                <ProjectIcon icon={row.icon} className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
                <p className={cx('font-medium text-slate-900 dark:text-white', narrow ? 'line-clamp-2' : 'truncate')}>{row.name}</p>
                {meta}
            </div>
            {/* On a phone the actions take their own line, so the title and
                its source get the whole width beside the tile; the menu
                closes that line. While a course is still being written
                there is no ring, and its slot is kept empty so the status
                lines up with the Study buttons in the rows below. */}
            {narrow ? (
                <div className="col-start-2 flex items-center gap-3">
                    {status}
                    {row.state !== 'building' && <ProgressRing progress={progress} color={progress === 100 ? '#22C55E' : row.color} size={36} />}
                    <div className="ml-auto">{menu}</div>
                </div>
            ) : (
                <>
                    {status}
                    {row.state !== 'building'
                        ? <ProgressRing progress={progress} color={progress === 100 ? '#22C55E' : row.color} size={40} />
                        : <span className="w-10 shrink-0" aria-hidden="true" />}
                    {menu}
                </>
            )}
        </div>
    );
}

export default function ShortCourses() {
    const { t } = useTranslation();
    const location = useLocation();
    const ref = useRef<HTMLElement>(null);
    const width = useElementWidth(ref);
    const narrow = width > 0 && width < NARROW_PX;
    const { source, rows, menuOpen } = mockFromUrl(location.search);

    return (
        <section ref={ref} aria-label={t("Short courses")} className="mb-10">
            <SectionLabel>{rows.length ? `${t("Short courses")} · ${rows.length}` : t("Short courses")}</SectionLabel>
            <SourceBox source={source} narrow={narrow} />
            {rows.length > 0 && (
                <div className="mt-3 space-y-2">
                    {rows.map((row, i) => <Row key={row.id} row={row} narrow={narrow} menuOpen={menuOpen === i + 1} />)}
                </div>
            )}
        </section>
    );
}

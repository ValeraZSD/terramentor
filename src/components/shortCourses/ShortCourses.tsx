// The Projects page's short courses: the courses of a few topics on one level
// that the New course window made from a small input (a video, an article,
// one short document; server/courseShape.js decides), or the assistant made
// from a link. Three small cards to a row (projects/CompactCard.tsx); a
// finished or archived one is on the page's Finished or Archived view instead,
// with the full courses. With none, the section is not drawn at all.
//
// The rows are GET /api/short-courses, owned by ProjectsGrid, which leaves
// these courses out of its own grid. A course leaves the section when it grows
// a phase (server/shortCourses.js `listShortCourses`).
import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
    Archive, CheckCircle2, CircleAlert, ExternalLink, File, FileText, Globe,
    Loader2, MoreVertical, PenLine, Play, RotateCcw, Trash2, SquarePlay,
} from 'lucide-react';
import { api } from '../../api';
import { useStore } from '../../store';
import type { Project } from '../../types';
import { Button, IconButton } from '../ui/Button';
import { MenuItem, MenuPopover, menuTriggerKeys } from '../ui/Popover';
import ProgressRing from '../ProgressRing';
import { CompactCard, COMPACT_GRID } from '../projects/CompactCard';
import { useNumberFormat } from '../../hooks/useNumberFormat';
import type { ShortCourseRow, SourceKind } from './shortCourseTypes';

const KIND_ICON: Record<SourceKind, typeof Globe> = {
    video: SquarePlay, page: Globe, pdf: FileText, file: File, topic: PenLine,
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

function ShortCard({ row, project, onChanged }: {
    row: ShortCourseRow;
    /** The same course in the store: the one progress number every surface shows. */
    project: Project | undefined;
    onChanged: () => void;
}) {
    const { t } = useTranslation();
    const num = useNumberFormat();
    const openProject = useStore(s => s.openProject);
    const studyProject = useStore(s => s.studyProject);
    const updateProject = useStore(s => s.updateProject);
    const deleteProject = useStore(s => s.deleteProject);
    const showConfirm = useStore(s => s.showConfirm);
    const addToast = useStore(s => s.addToast);
    const [menuOpen, setMenuOpen] = useState(false);
    const [retrying, setRetrying] = useState(false);
    const menuRef = useRef<HTMLButtonElement>(null);
    const KindIcon = KIND_ICON[row.kind] ?? File;

    const progress = Math.round((project?.progress_fraction ?? (row.topics ? row.done / row.topics : 0)) * 100);
    const done = project?.completed_topic_count ?? row.done;
    const total = project?.topic_count ?? row.topics;
    const building = row.state === 'building';
    const failed = row.state === 'failed';

    const retry = async () => {
        setRetrying(true);
        try {
            await api.retryShortCourse(row.id);
            onChanged();
        } catch (e) {
            const err = e as { data?: { reason?: string } } & Error;
            addToast('error', t("Could not write it"), err.data?.reason === 'no_ai' ? t("Writing it needs an AI connection.") : err.message);
        } finally {
            setRetrying(false);
        }
    };

    const setStatus = async (status: 'completed' | 'archived') => {
        setMenuOpen(false);
        if (await updateProject(row.id, { status })) onChanged();
    };

    const remove = async () => {
        setMenuOpen(false);
        const confirmed = await showConfirm({
            title: t("Delete Project"),
            message: t("Delete \"{{name}}\" and all its contents? You can bring it back from Recently deleted in Settings.", { name: row.name }),
            confirmLabel: t("Delete"),
            variant: 'danger',
        });
        if (!confirmed) return;
        await deleteProject(row.id);
        onChanged();
    };

    const menu = (
        <>
            <IconButton
                ref={menuRef}
                label={t("Course options")}
                tooltip={false}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                icon={<MoreVertical className="w-4 h-4" />}
                onClick={() => setMenuOpen(o => !o)}
                onKeyDown={menuTriggerKeys(() => setMenuOpen(true))}
            />
            <MenuPopover open={menuOpen} onClose={() => setMenuOpen(false)} anchorRef={menuRef} label={t("Course options")} align="end">
                {row.url && (
                    <MenuItem icon={<ExternalLink className="w-4 h-4" />} href={row.url} onSelect={() => setMenuOpen(false)}>
                        {t("Open the source")}
                    </MenuItem>
                )}
                {!building && !failed && (
                    <MenuItem icon={<CheckCircle2 className="w-4 h-4 text-emerald-500" />} onSelect={() => void setStatus('completed')}>{t("Mark completed")}</MenuItem>
                )}
                <MenuItem icon={<Archive className="w-4 h-4" />} onSelect={() => void setStatus('archived')}>{t("Archive")}</MenuItem>
                <div className="my-1 h-px bg-slate-100 dark:bg-slate-600" />
                <MenuItem tone="danger" icon={<Trash2 className="w-4 h-4" />} onSelect={() => void remove()}>{t("Delete")}</MenuItem>
            </MenuPopover>
        </>
    );

    const meta = failed ? (
        <>
            <CircleAlert className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{t("Its topics could not be written.")}</span>
        </>
    ) : row.from ? (
        <>
            <KindIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{row.from}</span>
            {/* Made from several sources: the first, and how many more. */}
            {row.more > 0 && <span className="shrink-0">{t("+{{n}} more", { n: num(row.more) })}</span>}
        </>
    ) : (
        <>
            <PenLine className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{t("Written from its title")}</span>
        </>
    );

    // Being written: the line that says so stands where the ring and the
    // count will be, so nothing moves when they arrive.
    const reading = building ? (
        <span className="inline-flex items-center gap-2 text-sm text-accent-fg">
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> {t("Writing the topics…")}
        </span>
    ) : failed ? null : (
        <>
            <ProgressRing progress={progress} color={progress === 100 ? '#22C55E' : row.color} size={40} />
            <span className="text-sm text-slate-500 dark:text-slate-400 min-w-0 truncate">
                {t("{{done}} / {{total}} topics", { count: total, done: num(done), total: num(total) })}
            </span>
        </>
    );

    const action = building ? undefined : failed ? (
        <Button variant="neutral" busy={retrying} icon={<RotateCcw className="w-4 h-4" aria-hidden="true" />} onClick={() => void retry()}>
            {t("Try again")}
        </Button>
    ) : (
        <Button variant="primary" icon={<Play className="w-4 h-4" aria-hidden="true" />} title={t("Study {{name}}", { name: row.name })} onClick={() => studyProject(row.id)}>
            {t("Study")}
        </Button>
    );

    return (
        <CompactCard
            data="short"
            color={row.color}
            icon={row.icon}
            name={row.name}
            meta={meta}
            metaTone={failed ? 'warn' : 'plain'}
            reading={reading}
            action={action}
            menu={menu}
            onOpen={() => void openProject(row.id)}
        />
    );
}

export default function ShortCourses({ rows, projects, onChanged }: {
    /** The short courses to show (the page has already left out the finished
     *  and the archived); null until loaded. */
    rows: ShortCourseRow[] | null;
    projects: Project[];
    onChanged: () => void;
}) {
    const { t } = useTranslation();
    const list = rows ?? [];
    const byId = new Map(projects.map(p => [p.id, p]));
    // None: no heading over nothing. Short courses are made in the New
    // course window like any other, so there is nothing to start here.
    if (!list.length) return null;

    return (
        <section aria-label={t("Short courses")} className="mb-10">
            <SectionLabel>{`${t("Short courses")} · ${list.length}`}</SectionLabel>
            <div className={COMPACT_GRID}>
                {list.map(row => <ShortCard key={row.id} row={row} project={byId.get(row.id)} onChanged={onChanged} />)}
            </div>
        </section>
    );
}

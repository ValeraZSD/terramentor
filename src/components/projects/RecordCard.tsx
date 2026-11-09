// A finished or archived course, short or full, on the Projects page's
// Finished and Archived views: the small card (CompactCard), since a record
// needs its name, what it was, when it ended and the way back, not a plan.
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    Archive, BookOpen, CheckCircle2, ExternalLink, File, FileText, Globe, MoreVertical,
    RotateCcw, Sparkles, SquarePlay, Trash2, Trophy,
} from 'lucide-react';
import { useStore } from '../../store';
import type { Project } from '../../types';
import { IconButton } from '../ui/Button';
import { MenuItem, MenuPopover, menuTriggerKeys } from '../ui/Popover';
import { useNumberFormat } from '../../hooks/useNumberFormat';
import { dayLabel } from '../../utils/locale';
import { CompactCard } from './CompactCard';

const KIND_ICON = { video: SquarePlay, page: Globe, pdf: FileText, file: File, topic: Sparkles } as const;

interface MadeFrom { kind?: keyof typeof KIND_ICON; host?: string; file?: string; url?: string }

function madeFrom(p: Project): MadeFrom | null {
    if (!p.made_from) return null;
    try { return JSON.parse(p.made_from) as MadeFrom; } catch { return null; }
}

export function RecordCard({ project, onChanged }: { project: Project; onChanged?: () => void }) {
    const { t } = useTranslation();
    const num = useNumberFormat();
    const openProject = useStore(s => s.openProject);
    const updateProject = useStore(s => s.updateProject);
    const deleteProject = useStore(s => s.deleteProject);
    const openCompletion = useStore(s => s.openCompletion);
    const showConfirm = useStore(s => s.showConfirm);
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLButtonElement>(null);

    const from = madeFrom(project);
    const archived = project.status === 'archived';
    const done = project.completed_topic_count ?? 0;
    const total = project.topic_count ?? 0;
    const allDone = total > 0 && done >= total;

    const setStatus = async (status: 'active' | 'completed' | 'archived') => {
        setMenuOpen(false);
        if (await updateProject(project.id, { status })) onChanged?.();
    };
    const remove = async () => {
        setMenuOpen(false);
        const confirmed = await showConfirm({
            title: t("Delete Project"),
            message: t("Delete \"{{name}}\" and all its contents? This action cannot be undone.", { name: project.name }),
            confirmLabel: t("Delete"),
            variant: 'danger',
        });
        if (!confirmed) return;
        await deleteProject(project.id);
        onChanged?.();
    };

    // What it was, then how it ended, a line each: a record needs no ring and
    // no button (every ring in Finished would read 100%), so the card stays
    // short. One shared line cut most sites to "howtomechatr…" beside the date.
    const KindIcon = from?.kind ? KIND_ICON[from.kind] ?? File : BookOpen;
    const what = from
        ? (from.kind === 'topic' ? t("Written from its title") : from.host || from.file || t("Short course"))
        : t("Course");
    // Finished: when, if every topic was done; how far, if it was filed early
    // or put away.
    const day = project.last_done_at ? dayLabel(project.last_done_at) : '';
    const when = !archived && allDone && day
        ? t("Finished {{date}}", { date: day })
        : t("{{done}} / {{total}} topics", { count: total, done: num(done), total: num(total) });
    const meta = (
        <span className="flex flex-col min-w-0">
            <span className="flex items-center gap-1.5 min-w-0">
                <KindIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate" title={what}>{what}</span>
            </span>
            <span className="truncate">{when}</span>
        </span>
    );

    const restore = <MenuItem icon={<RotateCcw className="w-4 h-4" />} onSelect={() => void setStatus('active')}>{t("Move to active")}</MenuItem>;
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
                {/* Archived: the way back comes first, it is why the view is opened. */}
                {archived && restore}
                {(allDone || project.status === 'completed') && (
                    <MenuItem icon={<Trophy className="w-4 h-4 text-amber-500" />} onSelect={() => { setMenuOpen(false); openCompletion(project.id); }}>{t("Summary")}</MenuItem>
                )}
                {from?.url && (
                    <MenuItem icon={<ExternalLink className="w-4 h-4" />} href={from.url} onSelect={() => setMenuOpen(false)}>{t("Open the source")}</MenuItem>
                )}
                <div className="my-1 h-px bg-slate-100 dark:bg-slate-600" />
                {!archived && restore}
                {archived
                    ? <MenuItem icon={<CheckCircle2 className="w-4 h-4 text-emerald-500" />} onSelect={() => void setStatus('completed')}>{t("Mark completed")}</MenuItem>
                    : <MenuItem icon={<Archive className="w-4 h-4" />} onSelect={() => void setStatus('archived')}>{t("Archive")}</MenuItem>}
                <div className="my-1 h-px bg-slate-100 dark:bg-slate-600" />
                <MenuItem tone="danger" icon={<Trash2 className="w-4 h-4" />} onSelect={() => void remove()}>{t("Delete")}</MenuItem>
            </MenuPopover>
        </>
    );

    return (
        <CompactCard
            data={archived ? 'archived' : 'finished'}
            color={project.color}
            icon={project.icon}
            name={project.name}
            meta={meta}
            menu={menu}
            onOpen={() => void openProject(project.id)}
        />
    );
}

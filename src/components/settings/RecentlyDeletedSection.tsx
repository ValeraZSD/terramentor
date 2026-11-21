import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw, Trash2 } from 'lucide-react';
import { useStore } from '../../store';
import { api } from '../../api';
import type { DeletedItem } from '../../types';
import { k } from '../../i18n';
import { dayLabel } from '../../utils/locale';
import { Button } from '../ui/Button';
import { SettingNote, GROUP_CAPTION } from '../ui/SettingRow';

const KIND_LABEL: Record<DeletedItem['kind'], string> = {
    course: k("Course"), deck: k("Deck"), topic: k("Topic"), note: k("Note"), link: k("Link"), card: k("Card"), quiz: k("Quiz"),
};
/** Rows drawn before "Show all": a deleted card is one row each, and there can be hundreds. */
const FIRST = 20;

/**
 * Settings → Library & about → Recently deleted. A delete anywhere in the app
 * keeps the row (server/softDelete.js); here the learner brings it back, with
 * everything that went with it, or empties the list for good.
 */
export default function RecentlyDeletedSection({ active }: { active: boolean }) {
    const { t: tr } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const showConfirm = useStore(s => s.showConfirm);
    const loadProjects = useStore(s => s.loadProjects);
    const [items, setItems] = useState<DeletedItem[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [all, setAll] = useState(false);
    const [restoring, setRestoring] = useState<string | null>(null);
    const [emptying, setEmptying] = useState(false);

    const load = useCallback(async () => {
        try {
            setItems((await api.listDeleted()).items);
            setFailed(false);
        } catch {
            setFailed(true);
        }
    }, []);
    // Read each time the section is opened: something may have been deleted since.
    useEffect(() => { if (active) void load(); }, [active, load]);

    const restore = async (item: DeletedItem) => {
        const key = `${item.table}:${item.id}`;
        setRestoring(key);
        try {
            await api.restoreDeleted(item.table, item.id);
            addToast('success', tr("Restored “{{title}}”", { title: item.title }));
            await Promise.all([load(), loadProjects({ silent: true })]);
        } catch (e: any) {
            addToast('error', tr("Could not restore “{{title}}”", { title: item.title }),
                e?.data?.code === 'parent_deleted' ? tr("What it was in is deleted too. Restore that first.") : e?.message);
            void load();
        } finally {
            setRestoring(null);
        }
    };

    const empty = async () => {
        if (!items?.length) return;
        if (!(await showConfirm({
            title: tr("Empty Recently deleted?"),
            message: tr("{{count}} items are removed for good, with everything in them. This cannot be undone.", { count: items.length }),
            confirmLabel: tr("Empty"),
            variant: 'danger',
        }))) return;
        setEmptying(true);
        try {
            await api.emptyDeleted();
            addToast('success', tr("Recently deleted is empty"));
            await load();
        } catch (e: any) {
            addToast('error', tr("Could not empty Recently deleted"), e?.message);
        } finally {
            setEmptying(false);
        }
    };

    const shown = items ? (all ? items : items.slice(0, FIRST)) : [];
    return (
        <section className={active ? 'mb-8' : 'hidden'}>
            <h2 className={GROUP_CAPTION}>{tr("Recently deleted")}</h2>
            <div className="mb-2 px-1">
                <SettingNote>
                    {tr("What you delete stays here, with everything in it, until you empty this list.")}
                </SettingNote>
            </div>
            <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm">
                {shown.length > 0 && (
                    <ul className="divide-y divide-slate-100 dark:divide-slate-700/60">
                        {shown.map(item => {
                            const key = `${item.table}:${item.id}`;
                            return (
                                <li key={key} className="flex items-center gap-4 px-4 py-3">
                                    <div className="min-w-0 flex-1">
                                        <p className="break-words font-medium text-slate-900 dark:text-white">
                                            {item.title || tr(KIND_LABEL[item.kind])}
                                        </p>
                                        <p className="text-sm text-slate-500 dark:text-slate-400">
                                            {[tr(KIND_LABEL[item.kind]), item.projectName, tr("Deleted {{date}}", { date: dayLabel(item.deletedAt) })]
                                                .filter(Boolean).join(' · ')}
                                        </p>
                                    </div>
                                    <Button
                                        className="shrink-0"
                                        busy={restoring === key}
                                        disabled={emptying || (restoring !== null && restoring !== key)}
                                        onClick={() => void restore(item)}
                                        icon={<RotateCcw className="w-4 h-4" aria-hidden="true" />}
                                    >
                                        {tr("Restore")}
                                    </Button>
                                </li>
                            );
                        })}
                    </ul>
                )}
                {items && items.length > FIRST && !all && (
                    <div className="border-t border-slate-100 dark:border-slate-700/60 px-4 py-2">
                        <Button variant="quiet" size="sm" onClick={() => setAll(true)}>
                            {tr("Show all")}
                        </Button>
                    </div>
                )}
                {/* The same foot as the records below: what is here on the left, the one action on the right. */}
                <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 ${shown.length ? 'border-t border-slate-100 dark:border-slate-700/60' : ''}`}>
                    <p className="min-w-0 flex-1 basis-48 text-sm text-slate-500 dark:text-slate-400">
                        {failed ? tr("Could not load this view")
                            : items === null ? tr("Checking…")
                                : items.length === 0 ? tr("Nothing deleted")
                                    : tr("{{count}} deleted items", { count: items.length })}
                    </p>
                    <Button
                        variant="danger"
                        className="ml-auto shrink-0"
                        busy={emptying}
                        disabled={!items?.length || restoring !== null}
                        onClick={() => void empty()}
                        icon={<Trash2 className="w-4 h-4" aria-hidden="true" />}
                    >
                        {tr("Empty")}
                    </Button>
                </div>
            </div>
        </section>
    );
}

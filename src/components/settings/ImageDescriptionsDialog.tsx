import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../Modal';
import { Button } from '../ui/Button';
import { TextArea } from '../ui/Field';
import { api } from '../../api';
import { useStore } from '../../store';
import { forgetMediaInfo } from '../CardMedia';
import { useAutoGrow } from '../../hooks/useAutoGrow';
import type { MediaDescriptionRow } from '../../types';

/**
 * Every card picture beside the words a screen reader says for it, so a
 * model's description can be checked against the picture and corrected.
 * A corrected one is the learner's from then on: no model overwrites it
 * (`setLearnerDescription` in server/mediaDescribe.js). Model-written rows
 * come first, since those are the ones that need checking.
 */
/** Rows per request: the server's default page. */
const PAGE = 50;

export default function ImageDescriptionsDialog({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void }) {
    const { t } = useTranslation();
    const showConfirm = useStore(s => s.showConfirm);
    const [rows, setRows] = useState<MediaDescriptionRow[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [more, setMore] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const askingRef = useRef(false);

    useEffect(() => {
        if (!open) return;
        let live = true;
        setRows(null);
        setFailed(false);
        setDrafts({});
        api.listMediaDescriptions()
            .then(r => { if (live) { setRows(r.items); setMore(r.items.length === PAGE); } })
            .catch(() => { if (live) setFailed(true); });
        return () => { live = false; };
    }, [open]);

    const showMore = async () => {
        setLoadingMore(true);
        try {
            const r = await api.listMediaDescriptions(rows?.length ?? 0);
            setRows(rs => [...(rs ?? []), ...r.items.filter(n => !rs?.some(o => o.hash === n.hash))]);
            setMore(r.items.length === PAGE);
        } catch {
            setFailed(true);
        } finally {
            setLoadingMore(false);
        }
    };

    const dirty = rows?.some(r => r.hash in drafts && drafts[r.hash] !== (r.description ?? '')) ?? false;

    const close = useCallback(async () => {
        if (askingRef.current) return;
        if (dirty) {
            askingRef.current = true;
            const discard = await showConfirm({
                title: t("Discard your changes?"),
                message: t("A description you changed has not been saved."),
                confirmLabel: t("Discard"),
                cancelLabel: t("Keep editing"),
                variant: 'warning',
            });
            askingRef.current = false;
            if (!discard) return;
        }
        onClose();
    }, [dirty, onClose, showConfirm, t]);

    const saved = (hash: string, row: Pick<MediaDescriptionRow, 'description' | 'described_by'>) => {
        forgetMediaInfo(hash);
        setRows(rs => rs?.map(r => (r.hash === hash ? { ...r, ...row, generated_by: null } : r)) ?? rs);
        setDrafts(({ [hash]: _done, ...rest }) => rest);
        onChanged();
    };

    return (
        <Modal isOpen={open} onClose={() => void close()} title={t("Picture descriptions")} maxWidth="max-w-2xl" fill>
            <div className="px-5 py-4 space-y-4">
                <p className="text-sm text-slate-600 dark:text-slate-300">
                    {t("A screen reader reads these out instead of the pictures. Fix any that are wrong: what you write is kept and never replaced.")}
                </p>
                {failed ? (
                    <p className="text-sm text-red-700 dark:text-red-300">{t("The pictures could not be loaded.")}</p>
                ) : rows === null ? (
                    <p className="text-sm text-slate-500 dark:text-slate-400">{t("Loading…")}</p>
                ) : rows.length === 0 ? (
                    <p className="text-sm text-slate-500 dark:text-slate-400">{t("No card has a picture yet.")}</p>
                ) : (
                    <ul className="space-y-4">
                        {rows.map(row => (
                            <DescriptionRow
                                key={row.hash}
                                row={row}
                                draft={drafts[row.hash]}
                                onDraft={value => setDrafts(d => ({ ...d, [row.hash]: value }))}
                                onSaved={next => saved(row.hash, next)}
                            />
                        ))}
                    </ul>
                )}
                {rows && more && !failed && (
                    <Button onClick={() => void showMore()} busy={loadingMore}>{t("Show more pictures")}</Button>
                )}
            </div>
        </Modal>
    );
}

function DescriptionRow({ row, draft, onDraft, onSaved }: {
    row: MediaDescriptionRow;
    draft: string | undefined;
    onDraft: (value: string) => void;
    onSaved: (next: Pick<MediaDescriptionRow, 'description' | 'described_by'>) => void;
}) {
    const { t } = useTranslation();
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [justSaved, setJustSaved] = useState(false);
    const value = draft ?? row.description ?? '';
    const changed = draft !== undefined && draft !== (row.description ?? '');
    const fieldId = `picture-description-${row.hash.slice(0, 12)}`;
    // A description is checked against its picture, so the whole of it has to
    // be visible: a fixed two rows cut a model's sentence in half on a phone.
    const fieldRef = useAutoGrow(value, { rows: 6 });

    const source = row.described_by === 'vision'
        ? (row.generated_by ? t("Written by AI ({{model}}). Check it.", { model: row.generated_by }) : t("Written by AI. Check it."))
        : row.described_by === 'learner' ? t("Written by you")
            : row.described_by === 'author' ? t("Written by the deck's author")
                : t("Not described yet");

    const save = async () => {
        setSaving(true);
        setError('');
        setJustSaved(false);
        try {
            const next = await api.setMediaDescription(row.hash, value);
            onSaved(next);
            setJustSaved(true);
        } catch (e: any) {
            setError(e?.message || t("Could not save"));
        } finally {
            setSaving(false);
        }
    };

    return (
        <li className="flex gap-3 items-start" data-picture-row={row.described_by ?? 'none'}>
            <img
                src={`/api/media/${row.hash}`}
                // The picture is shown to be compared, and the field beside it
                // already reads its description: said twice, it is noise.
                alt=""
                loading="lazy"
                className="w-20 h-20 shrink-0 rounded-lg object-contain bg-slate-100 dark:bg-slate-800"
            />
            <div className="min-w-0 flex-1 space-y-1.5">
                <label htmlFor={fieldId} className="block text-sm font-medium text-slate-800 dark:text-slate-100 truncate" title={row.filename}>
                    {row.filename}
                </label>
                <TextArea
                    ref={fieldRef}
                    id={fieldId}
                    rows={2}
                    value={value}
                    maxLength={600}
                    readOnly={saving}
                    placeholder={t("Say what the picture shows")}
                    onChange={e => { onDraft(e.target.value); setJustSaved(false); }}
                    // Who wrote it is read with the box, not left as a line a
                    // screen reader in forms mode never reaches; the box grows
                    // by itself, so the drag grip is only a target to miss.
                    aria-describedby={`${fieldId}-source`}
                    className="resize-none"
                />
                <div className="flex items-center justify-between gap-3 flex-wrap">
                    <p id={`${fieldId}-source`} role="status" className={`text-xs ${row.described_by === 'vision' ? 'text-amber-700 dark:text-amber-300' : 'text-slate-500 dark:text-slate-400'}`}>
                        {error ? <span className="text-red-700 dark:text-red-300">{error}</span> : justSaved ? t("Saved") : source}
                    </p>
                    {changed && (
                        <Button size="sm" variant="neutral" busy={saving} onClick={() => void save()}>
                            {error ? t("Retry") : t("Save")}
                        </Button>
                    )}
                </div>
            </div>
        </li>
    );
}

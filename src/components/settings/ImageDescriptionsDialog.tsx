import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../Modal';
import { Button } from '../ui/Button';
import { TextArea } from '../ui/Field';
import { api } from '../../api';
import { useStore } from '../../store';
import { forgetMediaInfo } from '../CardMedia';
import type { MediaDescriptionRow } from '../../types';

/**
 * Every card picture beside the words a screen reader says for it, so a
 * model's description can be checked against the picture and corrected.
 * A corrected one is the learner's from then on: no model overwrites it
 * (`setLearnerDescription` in server/mediaDescribe.js). Model-written rows
 * come first, since those are the ones that need checking.
 */
export default function ImageDescriptionsDialog({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void }) {
    const { t } = useTranslation();
    const showConfirm = useStore(s => s.showConfirm);
    const [rows, setRows] = useState<MediaDescriptionRow[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const askingRef = useRef(false);

    useEffect(() => {
        if (!open) return;
        let live = true;
        setRows(null);
        setFailed(false);
        setDrafts({});
        api.listMediaDescriptions()
            .then(r => { if (live) setRows(r.items); })
            .catch(() => { if (live) setFailed(true); });
        return () => { live = false; };
    }, [open]);

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
                    {t("This is what a screen reader says instead of each picture, and what the AI reads. Check the ones your model wrote against the picture and correct them: a description you write is kept, and no model replaces it.")}
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
                    id={fieldId}
                    rows={2}
                    value={value}
                    maxLength={600}
                    readOnly={saving}
                    placeholder={t("Say what the picture shows")}
                    onChange={e => { onDraft(e.target.value); setJustSaved(false); }}
                />
                <div className="flex items-center justify-between gap-3 flex-wrap">
                    <p className={`text-xs ${row.described_by === 'vision' ? 'text-amber-700 dark:text-amber-300' : 'text-slate-500 dark:text-slate-400'}`}>
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

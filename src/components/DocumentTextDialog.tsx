import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Loader2 } from 'lucide-react';
import Modal from './Modal';
import { ButtonLink } from './ui/Button';
import { api } from '../api';
import { useStore } from '../store';

/** The document a dialog shows: its id, its title, and whether its original file can be opened. */
export interface TextDocument {
    id: number;
    title: string;
    original?: boolean;
}

/**
 * A library document's extracted text, exactly what the AI reads of it: from
 * the vault's eye button, and from a Sources entry whose file the browser
 * cannot show itself (a Word file, a slide deck) or that has no file at all.
 * Built on `Modal`, so it portals out of a drawer and owns focus and Escape.
 */
export default function DocumentTextDialog({ doc, onClose }: { doc: TextDocument | null; onClose: () => void }) {
    const { t } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const [loaded, setLoaded] = useState<{ id: number; text: string } | null>(null);
    const id = doc?.id;
    // The text of the document open NOW, or null while it loads: the one
    // shown last time is never drawn under another document's title.
    const text = loaded && loaded.id === id ? loaded.text : null;

    useEffect(() => {
        if (id == null) return;
        let live = true;
        api.getDocumentText(id)
            .then(({ content }) => { if (live) setLoaded({ id, text: content ?? '' }); })
            .catch((e: any) => {
                if (!live) return;
                addToast('error', t("Failed to load extracted text"), e?.message);
                setLoaded({ id, text: '' });
            });
        return () => { live = false; };
    }, [id, addToast, t]);

    return (
        <Modal isOpen={!!doc} onClose={onClose} title={doc?.title ?? ''} maxWidth="max-w-2xl" fill>
            <div className="flex shrink-0 items-center gap-3 px-6 py-2 border-b border-slate-200 dark:border-slate-700">
                {/* Said for a learner, not a developer: what this text IS, with
                    no character count (the vault's list carries the size). */}
                <span className="min-w-0 flex-1 text-sm text-slate-500 dark:text-slate-400">
                    {t("Text the assistant reads")}
                </span>
                {doc?.original && (
                    <ButtonLink
                        size="sm"
                        href={api.documentOriginalUrl(doc.id)}
                        target="_blank"
                        rel="noreferrer"
                        icon={<ExternalLink className="w-4 h-4" />}
                    >
                        {t("Open original")}
                    </ButtonLink>
                )}
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
                {text == null ? (
                    <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                        <Loader2 className="w-4 h-4 animate-spin" /> {t("Loading…")}
                    </div>
                ) : text ? (
                    // The reading font, not a log's: line breaks kept, nothing monospaced.
                    <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                        {text}
                    </div>
                ) : (
                    <p className="text-sm text-slate-500 dark:text-slate-400">{t("No text was extracted from this file.")}</p>
                )}
            </div>
        </Modal>
    );
}

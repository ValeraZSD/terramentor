import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import type { ChatAttachment } from '../../types';
import { useNumberFormat } from '../../hooks/useNumberFormat';
import { FileGlyph, fileFacts } from './AttachmentChips';
import { shortName } from '../../utils/attachments';

/**
 * The files a question was sent with, above its bubble: a picture as itself
 * (a thumbnail that opens the original), anything else as a card with its name
 * and what it is. The way the five big chat apps show them — the file stays in
 * the conversation, where it was asked about.
 */
export default function MessageAttachments({ attachments }: { attachments: ChatAttachment[] }) {
    const { t } = useTranslation();
    const num = useNumberFormat();
    if (!attachments?.length) return null;
    return (
        <ul className="flex flex-wrap justify-end gap-1.5 max-w-[85%] ml-auto" aria-label={t("Attached files")}>
            {attachments.map(a => (
                <li key={a.id}>
                    {a.kind === 'image' ? (
                        <a
                            data-attachment-link
                            href={api.attachmentFileUrl(a.id)}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={a.name}
                            className="block rounded-xl overflow-hidden border border-slate-200 dark:border-slate-600 bg-slate-100 dark:bg-slate-700 outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        >
                            <img
                                src={api.attachmentFileUrl(a.id)}
                                alt={a.name}
                                loading="lazy"
                                width={a.width ?? undefined}
                                height={a.height ?? undefined}
                                className="block h-28 w-auto max-w-[14rem] object-cover"
                            />
                        </a>
                    ) : (
                        <a
                            data-attachment-link
                            href={api.attachmentFileUrl(a.id)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-2 w-64 h-14 pl-2 pr-3 rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 can-hover:hover:bg-slate-50 dark:can-hover:hover:bg-slate-700 outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        >
                            <span className="flex items-center justify-center w-9 h-9 shrink-0 rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-200">
                                <FileGlyph fileType={a.fileType} name={a.name} />
                            </span>
                            <span className="min-w-0">
                                <span className="block truncate text-sm font-medium text-slate-800 dark:text-slate-100" title={a.name}>{shortName(a.name, 22)}</span>
                                <span className="block truncate text-xs text-slate-500 dark:text-slate-400">{fileFacts(t, num, a)}</span>
                            </span>
                        </a>
                    )}
                </li>
            ))}
        </ul>
    );
}

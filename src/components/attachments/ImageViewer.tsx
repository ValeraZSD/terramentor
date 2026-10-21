import { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Download, X } from 'lucide-react';
import { api } from '../../api';
import type { ChatAttachment } from '../../types';
import { useDialogFocus } from '../../hooks/useDialogFocus';
import { usePortalAccent } from '../../hooks/usePortalAccent';
import { useStudyClock } from '../../hooks/useStudyClock';
import { useTapGuard } from '../../hooks/useTapGuard';
import { IconButton, IconLink } from '../ui/Button';
import MarkedImage, { type ImageBox } from './MarkedImage';

/**
 * A picture from the chat as large as the screen allows (never past its own
 * size, which would only blur a screenshot), over the app rather than in a new
 * tab: the raw file URL is the server's, not a page anyone should land on. Its
 * name and a download along the top, the picture fitted below (with the part
 * an answer marked still boxed), closed by ✕, Escape or a tap beside it — the
 * way the chat apps open a picture.
 */
export default function ImageViewer({ attachment, box, label, onClose }: {
    attachment: ChatAttachment | null;
    box?: ImageBox | null;
    label?: string | null;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const open = !!attachment;
    const titleId = useId();
    const dialogRef = useRef<HTMLDivElement>(null);
    useDialogFocus(open, dialogRef, { onEscape: onClose });
    const backdrop = useTapGuard(onClose, true);
    const { anchor, accent } = usePortalAccent(open);
    useStudyClock(null, { enabled: open, layer: 'dialog' });
    if (!attachment) return null;
    const url = api.attachmentFileUrl(attachment.id);
    // A portal's events still bubble through the React tree, into the chat
    // panel's file drop; a file dragged over the viewer is not one for it.
    const noDrop = (e: React.DragEvent) => {
        e.stopPropagation();
        e.preventDefault();
        e.dataTransfer.dropEffect = 'none';
    };
    return (
        <>
            <span ref={anchor} className="hidden" aria-hidden="true" />
            {createPortal((
                <div
                    ref={dialogRef}
                    tabIndex={-1}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={titleId}
                    // Always on black, whatever the theme: `dark` gives the
                    // controls their dark-surface colours inside it. The blur
                    // keeps the app's own words behind it from reading through
                    // beside the file name.
                    // The safe-area padding keeps ✕ out from under a notch.
                    className="dark fixed inset-0 z-[58] flex flex-col bg-black/85 backdrop-blur-md outline-none pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
                    style={accent}
                    onDragEnter={noDrop}
                    onDragOver={noDrop}
                    onDragLeave={noDrop}
                    onDrop={noDrop}
                >
                    <div className="flex shrink-0 items-center gap-2 pl-4 pr-2 py-2 text-white" {...backdrop}>
                        <h2 id={titleId} className="min-w-0 mr-auto truncate text-sm font-medium" title={attachment.name}>
                            {attachment.name}
                        </h2>
                        <IconLink
                            href={url}
                            download={attachment.name}
                            label={t("Download")}
                            icon={<Download className="w-5 h-5" aria-hidden="true" />}
                        />
                        <IconButton
                            label={t("Close")}
                            icon={<X className="w-5 h-5" aria-hidden="true" />}
                            onClick={onClose}
                        />
                    </div>
                    <div className="flex min-h-0 flex-1 items-center justify-center px-4 pb-4" {...backdrop}>
                        <MarkedImage
                            src={url}
                            alt={attachment.name}
                            width={attachment.width}
                            height={attachment.height}
                            box={box}
                            label={label ?? undefined}
                            maxWidth="calc(100vw - 2rem - env(safe-area-inset-left) - env(safe-area-inset-right))"
                            maxHeight="calc(100dvh - 4.75rem - env(safe-area-inset-top) - env(safe-area-inset-bottom))"
                            className="rounded-lg"
                        />
                    </div>
                </div>
            ), document.body)}
        </>
    );
}

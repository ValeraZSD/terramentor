import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import type { ChatAttachment } from '../../types';
import type { ImageMarker } from '../../utils/attachments';
import ImageViewer from './ImageViewer';
import MarkedImage from './MarkedImage';

/**
 * A picture the answer pointed into (`[[img:ID|x0,y0,x1,y1|label]]`): the
 * learner's own attachment, with the part the model named boxed and the rest
 * dimmed, drawn where the answer put it. The box is the model's — it looked
 * at the picture and wrote the numbers — so it is drawn as a pointer, not a
 * measurement. Pressed, it opens in the viewer with the box still on it. A
 * picture that is not this conversation's draws nothing.
 */
export default function AttachmentFigure({ marker, attachment }: { marker: ImageMarker; attachment: ChatAttachment | undefined }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    if (!attachment || attachment.kind !== 'image') return null;
    return (
        // The figure is the container the picture is measured against: the
        // button shrink-wraps the picture, so a percentage inside it would be
        // a percentage of itself.
        <figure className="my-1" style={{ containerType: 'inline-size' }}>
            <button
                type="button"
                data-attachment-link
                onClick={() => setOpen(true)}
                aria-haspopup="dialog"
                className="inline-block align-top overflow-hidden rounded-xl border border-slate-200 dark:border-slate-600 bg-slate-100 dark:bg-slate-700 cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-accent"
                aria-label={marker.label ? t("{{name}}, with “{{part}}” marked", { name: attachment.name, part: marker.label }) : attachment.name}
            >
                <MarkedImage
                    src={api.attachmentFileUrl(attachment.id)}
                    width={attachment.width}
                    height={attachment.height}
                    box={marker.box}
                    label={marker.label ?? undefined}
                    maxWidth="calc(100cqw - 2px)"
                    maxHeight="24rem"
                />
            </button>
            <figcaption className="mt-1 text-xs text-slate-500 dark:text-slate-400 truncate">{attachment.name}</figcaption>
            <ImageViewer
                attachment={open ? attachment : null}
                box={marker.box}
                label={marker.label}
                onClose={() => setOpen(false)}
            />
        </figure>
    );
}

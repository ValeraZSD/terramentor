import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import type { ChatAttachment } from '../../types';
import type { ImageMarker } from '../../utils/attachments';

/**
 * A picture the answer pointed into (`[[img:ID|x0,y0,x1,y1|label]]`): the
 * learner's own attachment, with the part the model named boxed and the rest
 * dimmed, drawn where the answer put it. The box is the model's — it looked
 * at the picture and wrote the numbers — so it is drawn as a pointer, not a
 * measurement. A picture that is not this conversation's draws nothing.
 */
export default function AttachmentFigure({ marker, attachment }: { marker: ImageMarker; attachment: ChatAttachment | undefined }) {
    const { t } = useTranslation();
    if (!attachment || attachment.kind !== 'image') return null;
    const box = marker.box;
    const url = api.attachmentFileUrl(attachment.id);
    // The label sits on the box's top edge, or inside it when the box starts
    // at the very top of the picture and there is no room above.
    const labelInside = box ? box[1] < 0.08 : false;
    return (
        <figure className="my-1">
            <a
                data-attachment-link
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="relative inline-block max-w-full overflow-hidden rounded-xl border border-slate-200 dark:border-slate-600 align-top outline-none focus-visible:ring-2 focus-visible:ring-accent"
                aria-label={marker.label ? t("{{name}}, with “{{part}}” marked", { name: attachment.name, part: marker.label }) : attachment.name}
            >
                <img
                    src={url}
                    alt=""
                    width={attachment.width ?? undefined}
                    height={attachment.height ?? undefined}
                    className="block max-w-full h-auto max-h-96 object-contain bg-slate-100 dark:bg-slate-700"
                />
                {box && (
                    <span
                        aria-hidden="true"
                        className="absolute rounded-md border-[3px] border-accent shadow-[0_0_0_9999px_rgba(15,23,42,0.35)]"
                        style={{
                            left: `${box[0] * 100}%`,
                            top: `${box[1] * 100}%`,
                            width: `${(box[2] - box[0]) * 100}%`,
                            height: `${(box[3] - box[1]) * 100}%`,
                        }}
                    >
                        {marker.label && (
                            <span className={`absolute left-[-3px] max-w-[16rem] truncate rounded-md bg-accent px-1.5 py-0.5 text-xs font-medium text-white ${labelInside ? 'top-0' : 'bottom-full mb-1'}`}>
                                {marker.label}
                            </span>
                        )}
                    </span>
                )}
            </a>
            <figcaption className="mt-1 text-xs text-slate-500 dark:text-slate-400 truncate">{attachment.name}</figcaption>
        </figure>
    );
}

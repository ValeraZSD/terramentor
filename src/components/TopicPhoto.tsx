import { useState, type ReactNode } from 'react';
import { ImageOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { safeHref } from '../utils/url';
import type { TopicPhoto } from '../types';

/**
 * A photo of a topic learned by sight (server/topicPhotos.js), with its credit.
 *
 * The file is the library's own copy (`/api/media/<hash>`), so it shows offline;
 * the credit names the author, links the licence and the archive's page for
 * the file, which the free licences ask of anyone who shows the photo. Nothing
 * here comes from a model but `shows`: the address is built from the stored
 * hash, never from lesson text.
 */

const HASH = /^[a-f0-9]{64}$/;

/** "Photo: Ann Lee · CC BY-SA 4.0 · Wikimedia Commons", each part a link where it has one. */
function Credit({ photo }: { photo: TopicPhoto }) {
    const { t } = useTranslation();
    const source = safeHref(photo.sourceUrl);
    const licence = safeHref(photo.licenceUrl);
    const link = (href: string | undefined, label: string) => href
        ? <a href={href} target="_blank" rel="noopener noreferrer" className="underline decoration-slate-400/60 underline-offset-2 hover:text-slate-700 dark:hover:text-slate-200">{label}</a>
        : <span>{label}</span>;
    const parts: ReactNode[] = [];
    if (photo.author) parts.push(<span key="a">{photo.author}</span>);
    if (photo.licence) parts.push(<span key="l">{link(licence, photo.licence)}</span>);
    parts.push(<span key="s">{link(source, 'Wikimedia Commons')}</span>);
    return (
        <p className="text-2xs leading-5 text-slate-500 dark:text-slate-400">
            {t("Photo:")}{' '}
            {parts.map((p, i) => <span key={i}>{i > 0 && ' · '}{p}</span>)}
        </p>
    );
}

/**
 * One photo with its example name, what to look at, and its credit. It keeps
 * its own shape (a crop or a frame could cut off what the learner is told to
 * look at), up to a height that leaves the text in view.
 */
export function TopicPhotoFigure({ photo }: { photo: TopicPhoto }) {
    const { t } = useTranslation();
    const [broken, setBroken] = useState(false);
    if (!HASH.test(photo.hash)) return null;
    const alt = photo.shows ? `${photo.subject}. ${photo.shows}` : photo.subject;
    const w = photo.width && photo.width > 0 ? photo.width : undefined;
    const h = photo.height && photo.height > 0 ? photo.height : undefined;
    return (
        <figure className="min-w-0" data-topic-photo={photo.uuid}>
            {broken ? (
                <div className="flex items-center justify-center gap-2 h-40 px-4 text-center rounded-lg bg-slate-100 dark:bg-slate-800 text-sm text-slate-500 dark:text-slate-400">
                    <ImageOff className="w-4 h-4 shrink-0" aria-hidden="true" />
                    {t("This photo could not be loaded.")}
                </div>
            ) : (
                <img
                    src={`/api/media/${photo.hash}`}
                    alt={alt}
                    width={w}
                    height={h}
                    loading="lazy"
                    decoding="async"
                    onError={() => setBroken(true)}
                    className="block w-auto h-auto max-w-full max-h-[28rem] rounded-lg bg-slate-100 dark:bg-slate-800"
                />
            )}
            <figcaption className="mt-2 space-y-0.5">
                <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{photo.subject}</p>
                {photo.shows && <p className="text-sm text-slate-600 dark:text-slate-300">{photo.shows}</p>}
                <Credit photo={photo} />
            </figcaption>
        </figure>
    );
}

/**
 * Several photos in as many columns as the container fits, each in its own
 * shape: columns, not a grid, so a tall photo does not leave a gap beside it.
 */
export function TopicPhotoGrid({ photos, className = '' }: { photos: TopicPhoto[]; className?: string }) {
    if (photos.length === 0) return null;
    return (
        <div className={`columns-[13rem] gap-4 ${className}`}>
            {photos.map(p => (
                <div key={p.uuid} className="break-inside-avoid mb-5">
                    <TopicPhotoFigure photo={p} />
                </div>
            ))}
        </div>
    );
}

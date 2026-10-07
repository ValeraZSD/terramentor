import { useRef, useState } from 'react';
import { Camera, ClipboardPaste, Images, Paperclip, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { IconButton } from '../ui/Button';
import { MenuItem, MenuPopover, menuTriggerKeys } from '../ui/Popover';
import { modShortcut, usePhysicalKeyboard } from '../../utils/platform';
import { useNumberFormat } from '../../hooks/useNumberFormat';
import { ATTACH_MAX_BYTES, ATTACH_MAX_FILES } from '../../utils/attachments';

/** Everything the composer offers to the file picker (the server decides by the bytes). */
const FILE_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,.heic,.heif,.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.json,.html,.xml,.tex,.py,.js,.ts,.java,.c,.cpp,.sql,text/*';

/**
 * The "+" beside the assistant's input, and the menu it opens — the shape all
 * five big chat apps share (researched 2026-10-07): a "+" at the start of the
 * composer, a short menu, the attached files as chips above the text.
 *
 * What the menu holds follows the INPUT, never the width
 * (`usePhysicalKeyboard`): with a finger, the three ways a phone has a picture
 * — the camera, the photo library, the files — each its own row, because one
 * `capture` input opens the camera and takes the library away; with a mouse,
 * the file picker and the clipboard, and the drop and Ctrl+V said under them.
 * The limits are written in the menu, so a file over them is never uploaded to
 * find out.
 */
export default function AttachMenu({ onFiles, onClipboardEmpty, disabled = false, full = false }: {
    onFiles: (files: File[]) => void;
    /** "Paste a screenshot" found no picture on the clipboard, or was refused. */
    onClipboardEmpty: () => void;
    disabled?: boolean;
    /** The composer already holds the most files a message may carry. */
    full?: boolean;
}) {
    const { t } = useTranslation();
    const num = useNumberFormat();
    const mouse = usePhysicalKeyboard();
    const [open, setOpen] = useState(false);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const cameraRef = useRef<HTMLInputElement>(null);
    const photosRef = useRef<HTMLInputElement>(null);
    const filesRef = useRef<HTMLInputElement>(null);
    const canReadClipboard = typeof navigator !== 'undefined' && typeof navigator.clipboard?.read === 'function';

    const pick = (input: HTMLInputElement | null) => {
        setOpen(false);
        input?.click();
    };

    const take = (e: React.ChangeEvent<HTMLInputElement>) => {
        // Copied before `value` is cleared: a FileList is a live view.
        const list = Array.from(e.target.files ?? []);
        e.target.value = '';
        if (list.length) onFiles(list);
    };

    // The clipboard as files. Chrome and Edge ask for permission the first
    // time; a refusal, or nothing but text on it, says so instead of nothing.
    const pasteFromClipboard = async () => {
        setOpen(false);
        try {
            const items = await navigator.clipboard.read();
            const out: File[] = [];
            for (const item of items) {
                const type = item.types.find(ty => ty.startsWith('image/'));
                if (!type) continue;
                const blob = await item.getType(type);
                const ext = type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
                // The clock's digits, not a locale's time format: a file name is not prose.
                const now = new Date();
                const stamp = [now.getHours(), now.getMinutes(), now.getSeconds()].map(n => String(n).padStart(2, '0')).join('.');
                out.push(new File([blob], `${t("Screenshot")} ${stamp}.${ext}`, { type }));
            }
            if (out.length) onFiles(out); else onClipboardEmpty();
        } catch {
            onClipboardEmpty();
        }
    };

    return (
        <>
            <IconButton
                ref={buttonRef}
                size="lg"
                variant="subtle"
                label={full ? t("At most {{count}} files per message", { count: ATTACH_MAX_FILES }) : t("Attach a photo or file")}
                icon={<Plus className="w-5 h-5" aria-hidden="true" />}
                disabled={disabled || full}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen(o => !o)}
                onKeyDown={menuTriggerKeys(() => setOpen(true))}
            />
            <MenuPopover open={open} onClose={() => setOpen(false)} anchorRef={buttonRef} label={t("Attach a photo or file")}>
                {mouse ? (
                    <>
                        <MenuItem icon={<Paperclip className="w-4 h-4" />} onSelect={() => pick(filesRef.current)}>{t("Add photos or files")}</MenuItem>
                        {canReadClipboard && (
                            <MenuItem icon={<ClipboardPaste className="w-4 h-4" />} onSelect={pasteFromClipboard}>{t("Paste a screenshot")}</MenuItem>
                        )}
                    </>
                ) : (
                    <>
                        <MenuItem icon={<Camera className="w-4 h-4" />} onSelect={() => pick(cameraRef.current)}>{t("Take a photo")}</MenuItem>
                        <MenuItem icon={<Images className="w-4 h-4" />} onSelect={() => pick(photosRef.current)}>{t("Photo library")}</MenuItem>
                        <MenuItem icon={<Paperclip className="w-4 h-4" />} onSelect={() => pick(filesRef.current)}>{t("Files")}</MenuItem>
                    </>
                )}
                <div className="mt-1 border-t border-slate-200 dark:border-slate-600 px-3 pt-2 pb-1.5 max-w-[17rem] space-y-1 text-xs leading-5 text-slate-500 dark:text-slate-300">
                    <p>{t("Up to {{count}} files, {{size}} MB each: photos, PDF, Word, Excel, PowerPoint, text.", { count: ATTACH_MAX_FILES, size: num(ATTACH_MAX_BYTES / 1024 / 1024) })}</p>
                    {mouse && <p>{t("Or drop files on the chat, or paste with {{keys}}.", { keys: modShortcut('V') })}</p>}
                </div>
            </MenuPopover>
            {/* Three inputs, because each is a different question to the phone:
                `capture` goes straight to the camera, `image/*` without it opens
                the photo library (with the camera offered beside it), and the
                file input opens Files. */}
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={take} />
            <input ref={photosRef} type="file" accept="image/*" multiple className="sr-only" tabIndex={-1} aria-hidden="true" onChange={take} />
            <input ref={filesRef} type="file" accept={FILE_ACCEPT} multiple className="sr-only" tabIndex={-1} aria-hidden="true" onChange={take} />
        </>
    );
}

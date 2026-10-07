import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { ChatAttachment } from '../types';
import { isPicture, preflightFiles, isHeicFile, ATTACH_MAX_BYTES, type RefusalReason } from '../utils/attachments';
import { prepareImage } from '../utils/attachImage';

/**
 * The files waiting in the assistant composer, from the moment they are picked
 * to the moment the message carrying them is sent.
 *
 * Each file is uploaded AT ONCE, on its own request, so its chip can show how
 * far it has got and fail on its own while the learner is still typing
 * (server/chatAttachments.js). What is refused before any upload — too
 * big, one too many, a format nothing here reads — never becomes a chip; it is
 * a line under the chips, with the reason. A failed upload stays a chip, with
 * Try again, and holds Send back until it is retried or removed: sending past
 * it would quietly leave a file behind.
 */
export interface ComposerFile {
    key: string;
    name: string;
    kind: 'image' | 'document';
    /** A local picture to show while it uploads (an object URL), else null. */
    preview: string | null;
    size: number;
    state: 'preparing' | 'uploading' | 'ready' | 'failed';
    progress: number;
    server: ChatAttachment | null;
    /** Why it failed, in the server's words or ours. */
    error: string | null;
    /** The file as picked, for Try again (null for one handed back by a failed turn). */
    file: File | null;
}

export interface Refusal { name: string; reason: RefusalReason | 'heic_unreadable' | 'duplicate' }

let seq = 0;
const sameFile = (a: { name: string; size: number }, b: { name: string; size: number }) => a.name === b.name && a.size === b.size;

export function useComposerAttachments() {
    const [files, setFiles] = useState<ComposerFile[]>([]);
    const [refusals, setRefusals] = useState<Refusal[]>([]);
    // The chat model is known not to take pictures (the upload says so), so
    // the composer warns before a photo is sent to a model that cannot see it.
    const [blind, setBlind] = useState(false);
    const controllers = useRef(new Map<string, AbortController>());
    const filesRef = useRef(files);
    filesRef.current = files;

    const patch = useCallback((key: string, change: Partial<ComposerFile>) => {
        setFiles(prev => prev.map(f => (f.key === key ? { ...f, ...change } : f)));
    }, []);

    const upload = useCallback(async (key: string, file: File) => {
        const controller = new AbortController();
        controllers.current.set(key, controller);
        try {
            let blob: Blob = file;
            let name = file.name;
            if (isPicture(file) || isHeicFile(file)) {
                const ready = await prepareImage(file);
                if (!ready) {
                    // The browser cannot draw it: a HEIC photo outside Safari.
                    setFiles(prev => prev.filter(f => f.key !== key));
                    setRefusals(prev => [...prev, { name: file.name, reason: 'heic_unreadable' }]);
                    return;
                }
                blob = ready.blob;
                name = ready.name;
                if (blob.size > ATTACH_MAX_BYTES) {
                    setFiles(prev => prev.filter(f => f.key !== key));
                    setRefusals(prev => [...prev, { name: file.name, reason: 'too_large' }]);
                    return;
                }
            }
            if (controller.signal.aborted) return;
            patch(key, { state: 'uploading', name, size: blob.size, progress: 0, error: null });
            const res = await api.uploadAttachment(blob, name, {
                signal: controller.signal,
                onProgress: p => patch(key, { progress: p }),
            });
            if (res.ok) {
                patch(key, { state: 'ready', progress: 1, server: res, kind: res.kind });
                if (res.kind === 'image' && typeof res.modelSees === 'boolean') setBlind(!res.modelSees);
            } else {
                patch(key, { state: 'failed', error: res.error });
            }
        } catch (e: any) {
            if (e?.name === 'AbortError' || controller.signal.aborted) return;
            patch(key, { state: 'failed', error: e?.message || 'Upload failed' });
        } finally {
            controllers.current.delete(key);
        }
    }, [patch]);

    /** Take picked, dropped or pasted files. */
    const add = useCallback((list: FileList | File[] | null | undefined) => {
        // Copied out NOW: a FileList is a live view of the input, which the
        // picker's handler clears so the same file can be chosen twice.
        const picked = Array.from(list ?? []);
        if (!picked.length) return;
        // The same file picked again is the one already here — unless that one
        // failed, which the new pick replaces.
        const held = filesRef.current;
        const again = picked.filter(f => held.some(h => h.state !== 'failed' && sameFile(h, f)));
        const replaced = held.filter(h => h.state === 'failed' && picked.some(f => sameFile(h, f))).map(h => h.key);
        const wanted = picked.filter(f => !again.includes(f));
        // A failed chip does not count against the cap: it is not going anywhere.
        const counted = held.filter(h => h.state !== 'failed').length;
        const { accepted, refused } = preflightFiles(wanted, counted, { convertHeic: true });
        // Said, not skipped in silence: a pick that seems to do nothing reads as broken.
        setRefusals([...again.map(f => ({ name: f.name, reason: 'duplicate' as const })), ...refused]);
        if (replaced.length) setFiles(prev => prev.filter(f => !replaced.includes(f.key)));
        if (!accepted.length) return;
        const fresh: ComposerFile[] = accepted.map(f => {
            const picture = isPicture(f) || isHeicFile(f);
            return {
                key: `att-${Date.now()}-${++seq}`,
                name: f.name,
                kind: picture ? 'image' : 'document',
                // HEIC: most browsers cannot draw it; the chip shows an icon.
                preview: picture && !isHeicFile(f) ? URL.createObjectURL(f) : null,
                size: f.size,
                state: picture ? 'preparing' : 'uploading',
                progress: 0,
                server: null,
                error: null,
                file: f,
            };
        });
        setFiles(prev => [...prev, ...fresh]);
        fresh.forEach((c, i) => { void upload(c.key, accepted[i]); });
    }, [upload]);

    /** A failed upload's Try again: the same file, uploaded once more. */
    const retry = useCallback((key: string) => {
        const f = filesRef.current.find(x => x.key === key);
        if (!f?.file || f.state !== 'failed') return;
        patch(key, { state: f.kind === 'image' ? 'preparing' : 'uploading', progress: 0, error: null });
        void upload(key, f.file);
    }, [patch, upload]);

    /** The chip's ✕: stop its upload, and forget it on the server. */
    const remove = useCallback((key: string) => {
        const f = filesRef.current.find(x => x.key === key);
        controllers.current.get(key)?.abort();
        if (f?.preview) URL.revokeObjectURL(f.preview);
        if (f?.server && !f.server.sent) void api.discardAttachment(f.server.id).catch(() => { });
        setFiles(prev => prev.filter(x => x.key !== key));
    }, []);

    /**
     * The message was sent: the chips leave the composer, the files stay on the
     * server (they are the message's now). Returns what was sent, so a failed
     * turn can put them back (`restore`) — the server hands them back too.
     */
    const take = useCallback((): ComposerFile[] => {
        const sent = filesRef.current.filter(f => f.state === 'ready');
        for (const f of filesRef.current) {
            if (f.state !== 'ready') { controllers.current.get(f.key)?.abort(); if (f.server) void api.discardAttachment(f.server.id).catch(() => { }); }
            if (f.preview) URL.revokeObjectURL(f.preview);
        }
        setFiles([]);
        setRefusals([]);
        return sent.map(f => ({ ...f, preview: null }));
    }, []);

    /** A turn that produced nothing: its files come back to the composer. */
    const restore = useCallback((back: ComposerFile[], missing: number[] = []) => {
        if (!back.length) return;
        setFiles(prev => [
            ...back.map(f => (f.server && missing.includes(f.server.id)
                ? { ...f, state: 'failed' as const, error: 'This file is no longer available. Remove it and attach it again.', file: null }
                : f)),
            ...prev,
        ]);
    }, []);

    const dismissRefusals = useCallback(() => setRefusals([]), []);

    // Object URLs live as long as their chip; whatever is left goes on unmount.
    useEffect(() => () => { filesRef.current.forEach(f => f.preview && URL.revokeObjectURL(f.preview)); }, []);

    const uploading = files.filter(f => f.state === 'preparing' || f.state === 'uploading');
    const failed = files.filter(f => f.state === 'failed');
    const ready = files.filter(f => f.state === 'ready');
    // A photo waiting for a model that cannot see it.
    const unseen = blind && ready.some(f => f.kind === 'image');
    return {
        files, refusals, add, retry, remove, take, restore, dismissRefusals,
        busy: uploading.length > 0, uploading, failed, ready, unseen,
    };
}

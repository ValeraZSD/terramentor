import { useEffect, useState } from 'react';
import { api } from '../api';
import type { PhotoPracticeState } from '../types';

/**
 * Whether a course offers "Tell them apart" (server/photoPractice.js): two or
 * more of its topics have a photo. Null until known, and on a failed read, so
 * nothing is offered that the course cannot hold.
 */
export function usePhotoPractice(projectId: number | null): PhotoPracticeState | null {
    const [state, setState] = useState<PhotoPracticeState | null>(null);
    useEffect(() => {
        setState(null);
        if (projectId == null) return;
        let live = true;
        api.getPhotoPractice(projectId).then(s => { if (live) setState(s); }, () => { if (live) setState(null); });
        return () => { live = false; };
    }, [projectId]);
    return state;
}

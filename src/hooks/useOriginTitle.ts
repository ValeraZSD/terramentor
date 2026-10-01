import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AITaskOrigin } from '../types';

/**
 * The title of the topic a task came from, for the sentence that says so.
 *
 * A task's origin carries the node's ID only (server/tasks.js keeps titles off
 * the record, the rule the activity log follows), so the name is looked up the
 * same way the assistant's topic chips are: `POST /api/nodes/labels`, which
 * answers for ids that exist and says nothing for ones that do not. Null while
 * it loads, when there is no node, and when the lookup fails — the sentence has
 * a form without a title for all three.
 */
export function useOriginTitle(origin: AITaskOrigin | null | undefined): string | null {
    const nodeId = origin?.nodeId ?? null;
    const [title, setTitle] = useState<string | null>(null);
    useEffect(() => {
        setTitle(null);
        if (nodeId == null) return;
        let live = true;
        api.resolveNodeLabels([nodeId])
            .then(rows => { if (live) setTitle(rows.find(r => r.id === nodeId)?.title ?? null); })
            .catch(() => { /* the sentence reads without it */ });
        return () => { live = false; };
    }, [nodeId]);
    return title;
}

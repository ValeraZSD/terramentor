import { useState } from 'react';
import { api } from '../../api';

/** The vault-embedding status, shared by the model section (a provider
 *  change re-probes it) and the Model jobs panel (which draws it). */
export function useEmbeddingStatus() {
    // Semantic search (Vault embeddings)
    const [embStatus, setEmbStatus] = useState<import('../../types').EmbeddingStatus | null>(null);
    const [embModelInput, setEmbModelInput] = useState('');

    const loadEmbStatus = async (opts: { force?: boolean; probe?: boolean } = {}) => {
        try {
            const s = await api.getEmbeddingStatus(opts);
            setEmbStatus(s);
            setEmbModelInput(s.config.model);
        } catch (e) { /* backend older / offline — section just shows nothing */ }
    };

    return { embStatus, embModelInput, setEmbModelInput, loadEmbStatus };
}

export type EmbeddingStatusHandle = ReturnType<typeof useEmbeddingStatus>;

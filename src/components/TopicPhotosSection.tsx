import { useCallback, useEffect, useState } from 'react';
import { Image as ImageIcon, Loader2, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { useStore } from '../store';
import { Button } from './ui/Button';
import { TopicPhotoGrid } from './TopicPhoto';
import type { TopicPhotos } from '../types';

/**
 * A topic's photos on its page, for a topic learned by sight
 * (server/topicPhotos.js). A topic that is not learned by sight shows nothing
 * at all. While a run is finding them the section says so and checks back;
 * when none were found it offers to look again.
 */
export default function TopicPhotosSection({ nodeId }: { nodeId: number }) {
    const { t } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const [data, setData] = useState<TopicPhotos | null>(null);
    const [failed, setFailed] = useState(false);
    const [asking, setAsking] = useState(false);

    const load = useCallback(async () => {
        try {
            setData(await api.getTopicPhotos(nodeId));
            setFailed(false);
        } catch {
            setFailed(true);
        }
    }, [nodeId]);

    useEffect(() => { setData(null); void load(); }, [load]);

    // A run has no stream of its own: check back while it works on this topic.
    const pending = data?.state === 'pending';
    useEffect(() => {
        if (!pending) return;
        const timer = setInterval(() => { void load(); }, 3000);
        return () => clearInterval(timer);
    }, [pending, load]);

    const lookAgain = async () => {
        setAsking(true);
        try {
            setData(await api.findTopicPhotos(nodeId));
        } catch (e: any) {
            addToast('error', t("Could not look for photos"), e.message);
        } finally {
            setAsking(false);
        }
    };

    // Not learned by sight, or not known yet: nothing to show.
    if (failed || !data || data.state === null) return null;

    return (
        <div className="pt-2 border-t border-slate-200 dark:border-slate-700" data-topic-photos={data.state}>
            <div className="flex items-center justify-between gap-3 mb-3 min-h-8">
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-300 flex items-center gap-1.5">
                    <ImageIcon className="w-3 h-3" aria-hidden="true" />
                    {t("Photos")}
                </span>
                {data.state === 'none' && (
                    <Button
                        size="sm"
                        variant="quiet"
                        onClick={() => void lookAgain()}
                        busy={asking}
                        icon={<Search className="w-4 h-4" aria-hidden="true" />}
                    >
                        {t("Look again")}
                    </Button>
                )}
            </div>
            {data.photos.length > 0 && <TopicPhotoGrid photos={data.photos} />}
            {data.state === 'pending' && (
                <p className={`flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400 ${data.photos.length > 0 ? 'mt-3' : ''}`} role="status">
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                    {t("Finding photos…")}
                </p>
            )}
            {data.state === 'none' && (
                <p className="text-sm text-slate-500 dark:text-slate-400">
                    {t("No photos with a free licence were found for this topic.")}
                </p>
            )}
        </div>
    );
}

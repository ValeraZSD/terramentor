import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { connectOpenRouter } from '../utils/openRouterConnect';
import { Button } from './ui/Button';
import { useTranslation } from 'react-i18next';

/**
 * The way in for a library with no model connected (`describeAIUnavailable`
 * says `connect`): OpenRouter in one press, and Settings for every other way.
 * One component so the home card and the assistant offer the same two buttons
 * with the same words. `onLeave` runs before Settings opens, for a surface that
 * would otherwise stay on top of it (the assistant as an overlay).
 */
export default function ConnectAIActions({ returnTo, onLeave }: {
    /** Where OpenRouter's sign-in comes back to. */
    returnTo: string;
    onLeave?: () => void;
}) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [connecting, setConnecting] = useState(false);

    const settings = () => { onLeave?.(); navigate('/settings#ai'); };
    const connect = async () => {
        setConnecting(true);
        try { await connectOpenRouter(returnTo); } catch { setConnecting(false); settings(); }
    };

    return (
        <div className="flex flex-wrap items-center gap-2">
            <Button
                size="sm"
                variant="primary"
                busy={connecting}
                onClick={() => void connect()}
                icon={<ExternalLink className="w-4 h-4" aria-hidden="true" />}
            >
                {t("Connect OpenRouter")}
            </Button>
            <Button size="sm" variant="quiet" onClick={settings}>
                {t("Other ways")}
            </Button>
        </div>
    );
}

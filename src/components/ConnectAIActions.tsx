import { useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { connectOpenRouter } from '../utils/openRouterConnect';
import { useElementWidth } from '../hooks/useElementWidth';
import { useRootFontSize } from '../hooks/useRootFontSize';
import { Button } from './ui/Button';
import { useTranslation } from 'react-i18next';

/**
 * The way in for a library with no model connected (`describeAIUnavailable`
 * says `connect`): OpenRouter in one press, and Settings for every other way.
 * One component so the home card and the assistant offer the same two buttons
 * with the same words. `onLeave` runs before Settings opens, for a surface that
 * would otherwise stay on top of it (the assistant as an overlay).
 *
 * `onChatbot` adds the way that needs no model at all, a course another chatbot
 * writes, as a third button of the same group (the New course form).
 */
export default function ConnectAIActions({ returnTo, onLeave, onChatbot }: {
    /** Where OpenRouter's sign-in comes back to. */
    returnTo: string;
    onLeave?: () => void;
    onChatbot?: () => void;
}) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [connecting, setConnecting] = useState(false);

    const settings = () => { onLeave?.(); navigate('/settings#ai'); };
    const connect = async () => {
        setConnecting(true);
        try { await connectOpenRouter(returnTo); } catch { setConnecting(false); settings(); }
    };

    // One row when the buttons fit the group's own width, else one even stack:
    // a row that wraps leaves one button alone on a line under the others. The
    // row's width is measured from the buttons themselves while they stand in
    // a row, again whenever what sizes them changes: the labels (a language
    // change) or the text size. A group that mounted hidden measures once it
    // has a width; until then it is the row.
    const rowRef = useRef<HTMLDivElement>(null);
    const width = useElementWidth(rowRef);
    const rootPx = useRootFontSize();
    const sizedBy = [t("Connect OpenRouter"), t("Other ways"), onChatbot ? t("Use your chatbot") : '', rootPx].join('\n');
    const [fit, setFit] = useState<{ sizedBy: string; px: number } | null>(null);
    const needPx = fit?.sizedBy === sizedBy ? fit.px : 0;
    const stacked = needPx > 0 && width > 0 && needPx > width + 0.5;
    useLayoutEffect(() => {
        const row = rowRef.current;
        if (needPx || !row) return;
        const buttons = Array.from(row.children) as HTMLElement[];
        const gap = parseFloat(window.getComputedStyle(row).columnGap) || 0;
        const px = buttons.reduce((sum, b) => sum + b.offsetWidth, 0) + gap * Math.max(0, buttons.length - 1);
        if (px > 0) setFit({ sizedBy, px });
    }, [sizedBy, needPx, width]);

    // Beside the chatbot button "Other ways" is one of two alternatives, so
    // both are outlined, and in a stack every button is framed (a quiet one
    // there reads as a line of text); beside the primary alone in a row it
    // stays quiet.
    const alternative = onChatbot || stacked ? 'neutral' : 'quiet';
    return (
        <div ref={rowRef} className={stacked ? 'flex flex-col gap-2' : 'flex flex-wrap items-center gap-2'}>
            {/* The arrow trails: it says the button leaves the app, so it is
                not an icon its neighbour must match. */}
            <Button
                variant="primary"
                block={stacked}
                busy={connecting}
                onClick={() => void connect()}
                trailing={<ExternalLink className="w-4 h-4" aria-hidden="true" />}
            >
                {t("Connect OpenRouter")}
            </Button>
            <Button variant={alternative} block={stacked} onClick={settings}>
                {t("Other ways")}
            </Button>
            {onChatbot && (
                <Button variant="neutral" block={stacked} onClick={onChatbot}>
                    {t("Use your chatbot")}
                </Button>
            )}
        </div>
    );
}

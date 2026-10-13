import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyText } from '../utils/clipboard';
import { useTranslation } from 'react-i18next';
import { IconButton } from './ui/Button';

/**
 * Copy something to the clipboard, with the "copied" tick every chat has
 * trained people to expect. One implementation for the tutor and the assistant.
 *
 * Always visible rather than hover-revealed: this app is used on a phone over
 * Tailscale, and a control that only a mouse can summon does not exist there
 * (see the input-capability rule in docs/ARCHITECTURE.md).
 */
export default function CopyButton({
    text,
    label,
    className = '',
    onFailed,
}: {
    text: string;
    /** Accessible name — "Copy answer", "Copy message". */
    label?: string;
    className?: string;
    /** Told when the copy could not happen at all, so a caller can toast. */
    onFailed?: () => void;
}) {
    const { t } = useTranslation();
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        const ok = await copyText(text);
        if (!ok) { onFailed?.(); return; }
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };

    return (
        <IconButton
            size="sm"
            onClick={handleCopy}
            label={copied ? t("Copied") : (label ?? t("Copy"))}
            className={className}
            icon={copied
                ? <Check className="w-4 h-4 text-emerald-500" aria-hidden="true" />
                : <Copy className="w-4 h-4" aria-hidden="true" />}
        />
    );
}

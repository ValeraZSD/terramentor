import { Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * The one line every chat surface prints under its input: the learner is talking
 * to a language model, and it can be wrong.
 *
 * Required by EU AI Act Article 50(1): an AI system interacting directly with
 * people must make sure they know it is one "unless this is obvious", and the
 * header's model badge is not obvious to someone who was handed the app. It is
 * also the honesty claim in CoreIdea.md.
 *
 * Wording: AI named in the first clause, then the caveat, as mainstream chat
 * products print it; "an AI" rather than a product name, since the model is
 * whatever the learner configured. It STOPS after the caveat: "check its answers
 * against your material" names a source that does not exist here, because the
 * tutor writes the material. Persistent, never a toast or first-run dialog, which
 * are dismissed once and gone for whoever needs them later.
 *
 * It also states whether this answer may search the web — STATE, not a control
 * (the model decides per question; Settings grants the permission) — joined onto
 * the same row so a 390px phone does not lose a row of conversation.
 */
export default function AiDisclosure({ web = false, className = '' }: {
    /** Answering with the web is on in Settings, so this turn may look things up. */
    web?: boolean;
    className?: string;
}) {
    const { t } = useTranslation();
    return (
        <p className={`flex flex-wrap items-center justify-center gap-x-1.5 text-[11px] leading-snug text-center text-slate-500 dark:text-slate-400 select-none ${className}`}>
            {web && (
                <>
                    <span
                        className="inline-flex items-center gap-1 whitespace-nowrap"
                        title={t('Answering with the web is on in Settings. Each answer shows what it searched for.')}
                    >
                        <Globe className="w-3 h-3 shrink-0" aria-hidden="true" />
                        {t('Can search the web')}
                    </span>
                    <span className="text-slate-300 dark:text-slate-600" aria-hidden="true">·</span>
                </>
            )}
            <span>{t('This is an AI. It can make mistakes.')}</span>
        </p>
    );
}

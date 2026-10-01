import { useTranslation } from 'react-i18next';
import { CircleHelp as HelpCircle } from 'lucide-react';
import { SectionHeader, Panel } from './SettingsParts';

/** Settings → AI & Models → Setup help. */
export default function SetupHelpSection({ active }: { active: boolean }) {
    const { t: tr } = useTranslation();
    return (
        <>
            {/* HELP — a section like the ones above it, always open. It
                was a closed disclosure at the foot of the page, "one row
                for the skim" — and a row reading "Setup help" under five
                job rows was a sixth job to most eyes. The page ends
                here, so there is nothing below it to keep short for. */}
            <section className={active ? 'mb-8' : 'hidden'}>
                <SectionHeader title={tr("Setup help")} icon={HelpCircle} />
                <Panel>
                    <div className="space-y-3 text-sm text-slate-600 dark:text-slate-300">
                        <p>
                            <strong className="text-slate-900 dark:text-white">{tr("Getting started with local AI:")}</strong>
                        </p>
                        <ol className="list-decimal list-inside pl-2 space-y-1">
                            <li>
                                {tr("Install Ollama from")}{' '}
                                <a href="https://ollama.com/download" target="_blank" rel="noopener noreferrer" className="text-accent-fg hover:underline">
                                    ollama.com
                                </a>{' '}{tr("and launch it.")}
                            </li>
                            <li>
                                {tr("In")}{' '}<strong>{tr("AI Provider")}</strong> {tr("at the top of this page, select Ollama and press the")}{' '}
                                <strong>{tr("Test")}</strong> {tr("button next to the URL — the status dot turns green when connected.")}
                            </li>
                            <li>
                                {tr("Paste any name from your provider's library into")}{' '}<strong>{tr("Install Custom Model")}</strong>{tr(". See")}{' '}<strong>{tr("Choosing a model")}</strong> {tr("below for what size to pick.")}
                            </li>
                        </ol>
                        <p className="pt-2 border-t border-slate-200 dark:border-slate-700">
                            <strong className="text-slate-900 dark:text-white">{tr("Model Selection Guide:")}</strong>
                        </p>
                        <ul className="list-disc list-inside pl-2 space-y-1">
                            <li><strong>{tr("~6 GB VRAM:")}</strong> {tr("fits a 9B at 4-bit — the smallest size worth teaching from.")}</li>
                            <li><strong>{tr("~10 GB VRAM:")}</strong> {tr("fits a 14B, or a sparse ~30B mixture-of-experts with most of it offloaded to system RAM.")}</li>
                            <li><strong>{tr("16 GB and up:")}</strong> {tr("a dense model in the recommended class fits comfortably.")}</li>
                            <li><strong>{tr("No GPU?")}</strong> {tr("Any OpenAI-compatible endpoint with your own API key.")}</li>
                        </ul>
                        <p className="pt-2 border-t border-slate-200 dark:border-slate-700">
                            <strong className="text-slate-900 dark:text-white">{tr("About Benchmarks:")}</strong>
                        </p>
                        <p className="pl-2">
                            {tr("MMLU-Pro tests broad academic knowledge (STEM, humanities, law, medicine) at a graduate level. Higher % = better general knowledge. This is the most relevant benchmark for learning applications.")}
                        </p>
                    </div>
                </Panel>
            </section>
        </>
    );
}

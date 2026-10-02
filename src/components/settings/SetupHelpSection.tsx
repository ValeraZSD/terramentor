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
                        {/* Whole sentences that NAME the controls through their own
                            keys. These steps were glued from fragments ("In" +
                            label + "at the top of this page…"), which no language
                            but English can reorder, and they named controls that
                            had since been renamed or removed ("AI Provider",
                            "Install Custom Model", a "Choosing a model" section),
                            so the help pointed at nothing (outside review,
                            1 Oct 2026). */}
                        <ol className="list-decimal list-inside pl-2 space-y-1">
                            <li>
                                {tr("Install Ollama and start it:")}{' '}
                                <a href="https://ollama.com/download" target="_blank" rel="noopener noreferrer" className="text-accent-fg hover:underline">
                                    ollama.com
                                </a>
                            </li>
                            <li>
                                {/* Says the settings OPEN under the switch: they are
                                    collapsed while AI is off, so the controls this
                                    step names are not on the page until then. */}
                                {tr("Turn on “{{switch}}” at the top of this page; the model's settings open under it. Choose Ollama under “{{where}}” and press {{test}}: the status dot turns green when it connects.", {
                                    switch: tr("Use AI features"), where: tr("Where the model runs"), test: tr("Test"),
                                })}
                            </li>
                            <li>
                                {tr("Type the name of a model from Ollama's library into “{{field}}” and press {{install}}. The guide below says which size fits your computer.", {
                                    field: tr("Install another model"), install: tr("Install"),
                                })}
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
                    </div>
                </Panel>
            </section>
        </>
    );
}

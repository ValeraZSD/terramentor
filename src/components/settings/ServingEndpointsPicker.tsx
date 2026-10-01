import { useTranslation } from 'react-i18next';
import type { ServingEndpoint } from '../../api';
import Checkbox from '../Checkbox';
import { Field } from '../ui/Field';
import SegmentedControl from '../ui/SegmentedControl';
import { Explain } from '../ui/Disclosure';
import { useNumberFormat } from '../../hooks/useNumberFormat';

/** A figure the endpoint does not publish. A dash reads as "nothing here" to
 *  anyone looking at the column and as nothing at all to a screen reader, so the
 *  words ride along out of sight. */
function NotReported({ label }: { label: string }) {
    return (
        <>
            <span className="sr-only">{label}</span>
            {/* The muted pair that still clears AA on both themes: slate-400 on
                white is 2.56:1 and slate-500 on slate-900 is 3.75:1, which is
                what the contrast audit fails. */}
            <span aria-hidden="true" className="text-slate-500 dark:text-slate-400">—</span>
        </>
    );
}

/** "Which machine serves this model": the router's endpoints for the chosen
 *  model, the learner's preferred order and the fallback sort. The state lives
 *  in AISettings, because this is drawn only for an OpenAI-compatible
 *  provider and must survive a switch to Ollama and back. */
export default function ServingEndpointsPicker({
    providerOrder, providerSort, servingEndpoints, endpointsLoading,
    loadServingEndpoints, chooseProviderSort, toggleProvider,
}: {
    providerOrder: string[];
    providerSort: string;
    servingEndpoints: ServingEndpoint[] | null;
    endpointsLoading: boolean;
    loadServingEndpoints: () => void;
    chooseProviderSort: (value: string) => void;
    toggleProvider: (slug: string) => void;
}) {
    const { t: tr } = useTranslation();
    const num = useNumberFormat();
    return (
        <Explain
            summary={<>
                {tr("Which machine serves this model")}
                {providerOrder.length > 0 && (
                    <span className="ml-2 font-normal text-slate-500 dark:text-slate-400">
                        {tr("{{fmt}} preferred providers", { count: providerOrder.length, fmt: num(providerOrder.length) })}
                    </span>
                )}
            </>}
            onToggle={e => { if ((e.currentTarget as HTMLDetailsElement).open && servingEndpoints === null) loadServingEndpoints(); }}
        >
            <div className="space-y-3">
                <p className="text-sm text-slate-500 dark:text-slate-400">
                    {tr("A model id on a router is not one machine. Several companies run the same model, and they differ in speed, in price, in how precisely they run it — and in how much the model thinks. Left alone the router picks for you, usually by price.")}
                </p>

                <Field label={tr("When you have no preference, pick by")}>
                    {() => (
                        <SegmentedControl
                            label={tr("When you have no preference, pick by")}
                            value={providerSort}
                            onChange={chooseProviderSort}
                            options={[
                                { value: '', label: tr("Router's choice") },
                                { value: 'price', label: tr("Price") },
                                { value: 'throughput', label: tr("Speed") },
                                { value: 'latency', label: tr("First word") },
                            ]}
                        />
                    )}
                </Field>

                {endpointsLoading && (
                    <p className="text-sm text-slate-500 dark:text-slate-400">{tr("Asking the endpoint who can serve it…")}</p>
                )}

                {!endpointsLoading && servingEndpoints !== null && servingEndpoints.length === 0 && (
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                        {tr("This endpoint does not publish a list of the machines behind it, so there is nothing to choose between. The setting above is all that applies.")}
                    </p>
                )}

                {!endpointsLoading && servingEndpoints !== null && servingEndpoints.length > 0 && (
                    <>
                        <p className="text-sm text-slate-500 dark:text-slate-400">
                            {tr("Tick the ones you would rather have, in the order you would rather have them. They are a preference, not a rule: if the first is busy the next is tried, because a slower answer beats a failed lesson.")}
                        </p>
                        {/* A TABLE, because the four things that
                            decide between these machines are four
                            numbers and a reader compares numbers
                            down a column. As a list of sentences
                            ("$0.25 per million tokens out · 99% up")
                            the same figures sat at a different
                            horizontal position in every row, and
                            the price that was NOT shown — what the
                            model reads, which a long lesson prompt
                            makes the bigger half of the bill — had
                            nowhere to go.

                            Ticked ones still float to the top in
                            the order they were ticked ("2." above
                            "1." made a sentence about order into a
                            puzzle). The rest are sorted by IN plus
                            OUT, since a cheap read and a dear write
                            is not a cheap machine; anything
                            reporting no price at all goes last
                            rather than leading the table as free. */}
                        <div className="overflow-x-auto">
                            <table className="w-full border-collapse">
                                <thead>
                                    <tr className="border-b border-slate-200 dark:border-slate-700 text-left text-xs font-medium text-slate-500 dark:text-slate-400">
                                        <th scope="col" className="w-0 py-1.5 pr-2.5">
                                            <span className="sr-only">{tr("Preferred")}</span>
                                        </th>
                                        <th scope="col" className="w-full py-1.5 pr-2">{tr("Provider")}</th>
                                        <th scope="col" className="py-1.5 px-1.5 text-right whitespace-nowrap">{tr("In")}</th>
                                        <th scope="col" className="py-1.5 px-1.5 text-right whitespace-nowrap">{tr("Out")}</th>
                                        <th scope="col" className="py-1.5 pl-1.5 text-right whitespace-nowrap">{tr("Uptime")}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {[...servingEndpoints].sort((a, b) => {
                                        const ra = providerOrder.indexOf(a.slug), rb = providerOrder.indexOf(b.slug);
                                        if (ra >= 0 && rb >= 0) return ra - rb;
                                        if (ra >= 0) return -1;
                                        if (rb >= 0) return 1;
                                        const pa = a.promptPrice + a.completionPrice;
                                        const pb = b.promptPrice + b.completionPrice;
                                        if ((pa > 0) !== (pb > 0)) return pa > 0 ? -1 : 1;
                                        if (pa !== pb) return pa - pb;
                                        // Two machines can carry the same name
                                        // (one endpoint lists "Sail Research"
                                        // twice), so the slug settles it.
                                        if (a.name !== b.name) return a.name < b.name ? -1 : 1;
                                        return a.slug < b.slug ? -1 : 1;
                                    }).map(ep => {
                                        const rank = providerOrder.indexOf(ep.slug);
                                        const boxId = `serving-${ep.slug}`;
                                        return (
                                            <tr key={ep.slug} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                                                <td className="py-2 touch:py-3 pr-2.5 align-middle">
                                                    <Checkbox
                                                        id={boxId}
                                                        checked={rank >= 0}
                                                        onChange={() => toggleProvider(ep.slug)}
                                                        aria-label={ep.name}
                                                    />
                                                </td>
                                                <th scope="row" className="py-2 touch:py-3 pr-2 align-middle font-normal">
                                                    {/* The name is the checkbox's label, so the
                                                        whole cell is part of the target. */}
                                                    <label htmlFor={boxId} className="flex items-baseline gap-1.5 flex-wrap cursor-pointer text-left">
                                                        {rank >= 0 && (
                                                            <span className="text-sm font-semibold text-accent-fg tabular-nums">{num(rank + 1)}.</span>
                                                        )}
                                                        <span className="text-sm font-medium text-slate-900 dark:text-white">{ep.name}</span>
                                                        {ep.quantization && (
                                                            <span className="text-xs text-slate-500 dark:text-slate-400">{ep.quantization}</span>
                                                        )}
                                                    </label>
                                                </th>
                                                <td className="py-2 touch:py-3 px-1.5 text-right align-middle text-sm tabular-nums whitespace-nowrap text-slate-600 dark:text-slate-300">
                                                    {ep.promptPrice > 0 ? `$${num(ep.promptPrice, { decimals: 2 })}` : <NotReported label={tr("Not reported")} />}
                                                </td>
                                                <td className="py-2 touch:py-3 px-1.5 text-right align-middle text-sm tabular-nums whitespace-nowrap text-slate-600 dark:text-slate-300">
                                                    {ep.completionPrice > 0 ? `$${num(ep.completionPrice, { decimals: 2 })}` : <NotReported label={tr("Not reported")} />}
                                                </td>
                                                <td className="py-2 touch:py-3 pl-1.5 text-right align-middle text-sm tabular-nums whitespace-nowrap text-slate-600 dark:text-slate-300">
                                                    {ep.uptime !== null ? `${num(Math.round(ep.uptime))}%` : <NotReported label={tr("Not reported")} />}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                        <p className="text-sm text-slate-500 dark:text-slate-400">
                            {tr("In and Out are dollars per million tokens — what the model reads, and what it writes. Uptime is the last half hour.")}
                        </p>
                    </>
                )}
            </div>
        </Explain>
    );
}

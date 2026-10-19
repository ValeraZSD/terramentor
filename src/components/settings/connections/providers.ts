import { k } from '../../../i18n';
import type { ConnectionFailure, ConnectionKind } from '../../../api';

/**
 * Every way to connect a model, as the learner meets it: a name, one line on
 * what it is, and what the form asks for. The address and key rules come from
 * the server (`CONNECTION_KINDS` in server/aiConnections.js); this is only
 * the wording and the order they are offered in.
 *
 * No logos: a brand's mark is the brand's, and a picture that is a different
 * drawing on every platform (emoji) was retired here for the same reason. A
 * hosted service is its initials on a plain tile, a machine in the room is
 * an icon.
 */
export interface ProviderInfo {
    kind: ConnectionKind;
    name: string;
    blurb: string;
    /**
     * How the learner gets in, which is how the picker groups them: an account
     * they sign in to, a key they paste, or a model they run themselves. The
     * key group is long and alike, so its rows carry the name alone; the
     * blurb is said on the form, after the choice.
     */
    group: 'signin' | 'key' | 'local';
    /** The models' own name where the company's does not say it. */
    family?: string;
    /** What the tile shows: initials for a service, or an icon name for a machine. */
    mono: string;
    tag?: string;
    keyPlaceholder?: string;
    /** Where the key is made, in words for the link. */
    keyWhere?: string;
    /** Each region's name, by the id the server's table uses. */
    regions?: Record<string, string>;
}

export const PROVIDERS: ProviderInfo[] = [
    { kind: 'openrouter', group: 'signin', name: 'OpenRouter', mono: 'OR', tag: k("Recommended"), blurb: k("Models from every major lab with one account, paid as you use them."), keyPlaceholder: 'sk-or-…', keyWhere: 'openrouter.ai' },
    { kind: 'chatgpt', group: 'signin', name: 'ChatGPT', mono: 'C', blurb: k("Sign in and use your own ChatGPT Plus or Pro plan. No key."), },
    { kind: 'anthropic', group: 'key', name: 'Anthropic', family: 'Claude', mono: 'A', blurb: k("Claude, with your own Anthropic API key and its credit."), keyPlaceholder: 'sk-ant-…', keyWhere: 'console.anthropic.com' },
    // "API" in the name: beside "ChatGPT" (a plan, signed in) a bare "OpenAI"
    // was read as the same thing.
    { kind: 'openai', group: 'key', name: 'OpenAI API', family: 'GPT', mono: 'O', blurb: k("GPT models, with your own OpenAI API key."), keyPlaceholder: 'sk-…', keyWhere: 'platform.openai.com' },
    { kind: 'gemini', group: 'key', name: 'Google Gemini', mono: 'G', blurb: k("Gemini models, with your own Google AI Studio key."), keyPlaceholder: 'AIza…', keyWhere: 'aistudio.google.com' },
    // The labs. Each region is a separate account with its own keys, which is
    // why the region is asked with the key and not later.
    { kind: 'deepseek', group: 'key', name: 'DeepSeek', mono: 'DS', blurb: k("DeepSeek's models, with your own DeepSeek API key."), keyPlaceholder: 'sk-…' },
    {
        kind: 'zai', group: 'key', name: 'Z.ai (GLM)', mono: 'Z', blurb: k("GLM models from Z.ai (Zhipu), with your own key from z.ai or bigmodel.cn."),
        regions: { global: k("International (z.ai)"), china: k("Mainland China (bigmodel.cn)") },
    },
    {
        kind: 'qwen', group: 'key', name: 'Qwen (Alibaba)', mono: 'Q', blurb: k("Qwen models from Alibaba Cloud Model Studio (Bailian), with your own key."), keyPlaceholder: 'sk-…',
        regions: { singapore: k("Singapore (international)"), virginia: k("US, Virginia (international)"), beijing: k("Beijing (mainland China)"), hongkong: k("Hong Kong (international)") },
    },
    {
        kind: 'kimi', group: 'key', name: 'Kimi (Moonshot)', mono: 'K', blurb: k("Kimi models from Moonshot AI, with your own key."), keyPlaceholder: 'sk-…',
        regions: { global: k("International (moonshot.ai)"), china: k("Mainland China (moonshot.cn)") },
    },
    { kind: 'ollama', group: 'local', name: 'Ollama', mono: 'laptop', blurb: k("Models running on this computer. Nothing leaves it.") },
    { kind: 'custom', group: 'local', name: k("Another server"), mono: 'server', blurb: k("LM Studio, llama.cpp, or any address that speaks the OpenAI API.") },
];

/** The picker's groups, in the order a newcomer should meet them. */
// The key rows carry a name only, so the group says once what they all need.
export const PROVIDER_GROUPS: { id: ProviderInfo['group']; title: string; hint?: string }[] = [
    { id: 'signin', title: k("Sign in with an account") },
    { id: 'key', title: k("Paste an API key"), hint: k("Each needs a key made on that company's website.") },
    { id: 'local', title: k("Run it yourself") },
];

export const providerOf = (kind: ConnectionKind) => PROVIDERS.find(p => p.kind === kind) ?? PROVIDERS[PROVIDERS.length - 1];

/** Said after a refused key where keys are made per region: a key from another
 *  region is refused exactly like a mistyped one. */
export const REGION_KEY_HINT = k("A key works only in the region it was made in, so check the region too.");

/** A failed test, said so the learner knows what to do next. */
export const FAILURE_TEXT: Record<ConnectionFailure, string> = {
    key: k("The key was refused, and nothing was charged. Check that you copied all of it, with nothing before or after."),
    credit: k("The key works, but the account has no credit left. Add credit on the provider's site, then test again."),
    rate: k("The provider is limiting requests from this key right now. Wait a minute and test again."),
    model: k("This key cannot use that model. Choose another one."),
    unreachable: k("Nothing answered at that address. If it is a server on this computer, is it running?"),
    timeout: k("The provider took too long to answer. Test again in a moment."),
    empty: k("The model answered with nothing. Try another model."),
    needs_model: k("This provider does not list its models. Type the model's name as its documentation writes it, then test again."),
    plan_limit: k("Your ChatGPT plan's limit for this app is used up for now. Review it in ChatGPT under Settings, Usage."),
    plan_not_eligible: k("This ChatGPT account cannot use its plan in other apps. ChatGPT Plus or Pro is needed, and a work account may not allow it."),
    other: k("The provider answered with an error."),
};

/** The thinking levels, weakest first, as the control names them. */
export const EFFORT_LABEL: Record<string, string> = {
    minimal: k("Minimal"),
    low: k("Brief"),
    medium: k("Balanced"),
    high: k("Thorough"),
    xhigh: k("Very thorough"),
    max: k("Maximum"),
};

export const EFFORT_DETAIL: Record<string, string> = {
    '': k("Balanced for chat and lessons, thorough for course outlines, questions and answer-key checks, on the nearest level this model has."),
    minimal: k("Hardly any thinking. The fastest and the weakest."),
    low: k("Fast and cheap, and the weakest. Lessons and answer keys suffer first."),
    medium: k("A middle budget for every job."),
    high: k("For curricula and answer keys, where being right matters more than being quick."),
    xhigh: k("More than thorough: slower and costlier on every job."),
    max: k("As much as the model will think. The slowest and most expensive."),
};

const ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** The level a request is actually sent, mirroring server/aiWire.js `pickEffort`. */
export function sentLevel(desired: string, levels: string[]): string {
    if (!desired || !levels.length) return desired && !levels.length ? '' : desired;
    if (levels.includes(desired)) return desired;
    const want = ORDER.indexOf(desired);
    const ranked = [...levels].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
    return ranked.find(l => ORDER.indexOf(l) >= want) ?? ranked[ranked.length - 1] ?? '';
}

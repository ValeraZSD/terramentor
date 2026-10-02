#!/usr/bin/env node
/**
 * One place that knows what an AI-attribution trailer looks like.
 *
 * GitHub's contributor list is built by parsing `Co-Authored-By:` trailers out
 * of commit messages, and it links a name to a profile only when the email
 * belongs to a real account. `noreply@anthropic.com` belongs to none, so an
 * agent-written commit puts an unclickable "claude" near the top of Insights →
 * Contributors with no commit history behind it — and worse, an address that
 * *does* happen to be registered attributes the work to an unrelated stranger.
 *
 * The project's position is simple: contributors may use whatever tools they
 * like, and the commit is theirs. Authorship is a statement about who is
 * answerable for the change, and that is a person.
 *
 * Two entry points share these patterns so they can never drift:
 *   --file <path>   the commit-msg hook: STRIPS the trailers and rewrites the
 *                   file, because rejecting a commit over a line the author did
 *                   not type is a bad trade.
 *   --range a..b    CI: REPORTS, because history is already written by then and
 *                   the fix is a rebase the author has to make.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** Matched against a whole line, case-insensitively. */
export const AI_TRAILER_PATTERNS = [
    // Co-author trailers naming an agent or an agent's no-reply address.
    /^\s*co-authored-by:.*\b(claude|anthropic|copilot|chatgpt|openai|codex|cursor|devin|aider|windsurf|gemini|google-labs-jules|sourcegraph|amp|codeium)\b/i,
    /^\s*co-authored-by:.*<[^>]*@(anthropic|openai|cursor|devin|codeium|sourcegraph)\.(com|sh|ai)>/i,
    // The "made by a tool" advert some agents append.
    /^\s*(🤖\s*)?generated with \[?(claude code|claude|cursor|copilot|codex|devin|aider|gemini)/i,
    /^\s*🤖\s*generated with/i,
];

export function isAiAttributionLine(line) {
    return AI_TRAILER_PATTERNS.some((re) => re.test(line));
}

/** Returns { cleaned, removed[] } — the message without AI trailers. */
export function stripAiAttribution(message) {
    const removed = [];
    const kept = message.split(/\r?\n/).filter((line) => {
        if (isAiAttributionLine(line)) { removed.push(line.trim()); return false; }
        return true;
    });
    // Removing a trailer usually leaves the blank line that introduced it
    // dangling at the end. Collapse trailing blanks back to a single newline.
    while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
    return { cleaned: kept.join('\n') + '\n', removed };
}

function main(argv) {
    const fileIdx = argv.indexOf('--file');
    const rangeIdx = argv.indexOf('--range');

    if (fileIdx !== -1) {
        const path = argv[fileIdx + 1];
        const original = readFileSync(path, 'utf8');
        const { cleaned, removed } = stripAiAttribution(original);
        if (removed.length) {
            writeFileSync(path, cleaned, 'utf8');
            console.error('Removed AI attribution from the commit message:');
            for (const line of removed) console.error(`  - ${line}`);
            console.error('This project attributes commits to the person responsible for them.');
        }
        return 0;
    }

    if (rangeIdx !== -1) {
        const range = argv[rangeIdx + 1];
        // %B is the raw body; the record separator keeps a multi-line message
        // from being mistaken for several commits.
        const raw = execFileSync('git', ['log', '--format=%H%x00%B%x01', range], { encoding: 'utf8' });
        const offenders = [];
        for (const entry of raw.split('\x01')) {
            if (!entry.trim()) continue;
            const [sha, body = ''] = entry.split('\x00');
            const bad = body.split(/\r?\n/).filter(isAiAttributionLine);
            if (bad.length) offenders.push({ sha: sha.trim().slice(0, 8), bad });
        }
        if (!offenders.length) {
            console.log(`No AI attribution trailers in ${range}.`);
            return 0;
        }
        console.error('These commits carry AI attribution trailers:\n');
        for (const o of offenders) {
            console.error(`  ${o.sha}`);
            for (const line of o.bad) console.error(`      ${line}`);
        }
        console.error('\nUse whatever tools you like — but the commit is yours, so the author');
        console.error('and any co-author must be a person. Rewrite with:');
        console.error('\n  git rebase -i <base> --exec "git commit --amend --no-edit"');
        console.error('\nor install the hook that strips them automatically:  npm run hooks\n');
        return 1;
    }

    console.error('usage: node tools/no-ai-attribution.mjs (--file <msg> | --range <a>..<b>)');
    return 2;
}

// Only act when run directly; the gate suite imports the patterns above.
if (process.argv[1] && process.argv[1].endsWith('no-ai-attribution.mjs')) {
    process.exit(main(process.argv.slice(2)));
}

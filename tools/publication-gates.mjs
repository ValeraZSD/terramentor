#!/usr/bin/env node
/**
 * What a push would publish — read over every file git is tracking.
 *
 * Run:  node tools/publication-gates.mjs
 *
 * Not secrets: keys, tokens and credentials are `security-gates.mjs` and
 * `.gitignore`. This is the other class — text that is ordinary in a working
 * tree and wrong on the internet, and that no other check looks at:
 *
 *  • **A private conversation left in a comment.** Design notes are often
 *    written from what someone said while using the app, and the quotation
 *    marks come along: a reader then meets a "he" they cannot identify, saying
 *    something to someone who is not in the room. The REASON belongs in the
 *    comment, the speaker does not.
 *
 *  • **A note to self about the project's own standing**, left in a document
 *    written for strangers. Whatever it says, it is addressed to one reader and
 *    undermines the document it sits in front of. Decide the question, then
 *    publish what was decided; the working note belongs where the work is
 *    planned.
 *
 *  • **The machine it was written on** — absolute paths, directory names from
 *    outside the repository, a hostname.
 *
 *  • **A document being matey at its reader.** A phrase that reassures adds
 *    nothing to the sentence and costs it authority.
 *
 * A gate rather than a careful reading, because reading is what people do
 * instead, and nobody re-reads several hundred files before a push.
 *
 * Deliberately narrow: it matches a short list of phrasings, never topics, and
 * an allowlist entry marks a file where the match is the point — a name belongs
 * in the copyright line and in a signature table. It has to quote its own
 * patterns, so it is not scanned for them; its prose is written to pass them
 * anyway, and the same is asked of anything added here.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Files git is tracking — the set that a push publishes, and nothing else. */
let tracked;
try {
    tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
        .split('\0').filter(Boolean);
} catch {
    console.log('SKIPPED: not a git checkout, so there is no published file set to read.');
    process.exit(0);
}

/** Read as text, or skip: a binary is not prose and `.png` has no sentences. */
const BINARY = /\.(png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|mp3|mp4|wav|zip|gz|br|db|pdf|apkg)$/i;
// A lockfile is 20k lines of registry URLs and is not written by anyone.
const SKIP = [/^package-lock\.json$/, /^THIRD_PARTY_NOTICES\.md$/];

const rules = [
    {
        name: 'a person referred to in the third person',
        // The tell of a note written ABOUT someone rather than for the reader.
        // A pronoun on its own is enough: a comment explaining code has no
        // unnamed third party in it.
        re: /\bhis\b|\bhe (asked|said|says|called|looked|wanted|reported|noticed|found|complained|likes|prefers)\b/i,
        why: 'Say the reason, not who gave it: "the card jiggles under the parts arriving" rather than naming whoever noticed.',
    },
    {
        name: 'private feedback quoted verbatim',
        re: /\((?:his|her|their|the maintainer's) "/i,
        why: 'A quotation from a private conversation. Keep the observation, drop the quotation marks.',
    },
    {
        name: "someone's own machine, library or window",
        // `their` is deliberately NOT here: "a learner's data never leaves their
        // machine" is the app's central promise and appears in a dozen files.
        // The fault is a measurement attributed to a particular person.
        re: /\b(?:his|her|the maintainer's) (?:own )?(?:library|window|screen|phone|machine|laptop|desktop)\b/i,
        why: 'Say the measurement ("measured at 1500px"), not whose screen it was measured on.',
    },
    {
        name: 'the maintainer named outside the places that are about him',
        re: /Valerii|valerazsd@/i,
        // The copyright line, the security contact, the signature table, the
        // package author and the trademark notice are all the point. Anywhere
        // else it is a note.
        allow: [/^README\.md$/, /^LICENSE$/, /^CLA\.md$/, /^SECURITY\.md$/,
            /^CODE_OF_CONDUCT\.md$/, /^TRADEMARKS\.md$/, /^package\.json$/, /^\.github\//],
        why: 'A design note signed with a name reads as private correspondence.',
    },
    {
        name: 'a document hedging about its own standing',
        re: /not (?:yet )?(?:been )?reviewed by (?:a )?(?:lawyer|counsel|solicitor|attorney)|treat (?:the text below|this) as a (?:working|rough) draft|\bworking draft\b|before the first external contribution/i,
        why: 'Decide the question and publish what was decided; a document that hedges about itself undermines the thing it is for. The open question belongs where the work is planned.',
    },
    {
        name: 'a path on this machine',
        // A macOS home directory, unless the name in it is a PLACEHOLDER: a
        // gate asserting where a launch agent is written has to say
        // `/Users/x/Library/…`, and an example path is the opposite of a leak.
        re: /[A-Z]:[\\/](?:Users|3 - work)[\\/]|\/Users\/(?!(?:x|you|user|username|me|name|example|someone)\/)[a-z][\w.-]*\/|DESKTOP-JRL|Hermes-Brain|StudyPlanningApp|Programming[\\/]Terramentor-data/i,
        why: 'An absolute path from the machine it was written on. Use a relative path or an example.',
    },
    {
        name: 'a public document being matey at the reader',
        // Only in prose meant for strangers, and only phrasings that add
        // nothing to the sentence they are in: an offer reads as complete
        // without a pat on the arm, and a document that reassures reads as one
        // that is unsure. Exact phrases, no register-guessing — the point is to
        // keep a known tic out, not to police tone.
        re: /no hard feelings|no worries|don'?t worry|we'?d love to|feel free to|happy to help|thanks for reading|hope you enjoy/i,
        files: /\.(md|ya?ml)$/,
        // `CoreIdea.md` quotes this register BACK at the reader — it takes
        // apart what habit-forming apps say — which is the opposite of the
        // fault, and those lines are in quotation marks.
        allow: [/^CoreIdea\.md$/],
        why: 'Cut it: the sentence says the same thing without it, and a public document that reassures reads as one that is unsure.',
    },
    {
        name: 'unfinished work left marked in the source',
        re: /\b(?:TODO|FIXME|HACK)\b(?!\.md)/,
        allow: [/^\.github\//],
        why: 'Either do it, or write what the code does instead of what it does not.',
    },
    {
        name: "a private instruction file cited as the reason",
        // `CLAUDE.md` and `.claude/` are gitignored, so a published file that
        // cites one sends the reader to something that does not exist in the
        // repository they cloned — and names the assistant while doing it.
        // Deliberately narrow: it matches a DOCUMENT being cited, not the
        // directory being named. `.dockerignore` and `dep-gates.mjs` have to
        // write `.claude/` to exclude it, and that is not a citation.
        re: /\b(?:CLAUDE|AGENTS)\.md\b|\.claude\/docs\//i,
        why: 'Move the reasoning into the sentence, or into a file that ships. A reader who cannot open the source cannot check the claim.',
    },
];

let failed = 0, scanned = 0, checks = 0;
const findings = [];

for (const file of tracked) {
    if (BINARY.test(file) || SKIP.some(re => re.test(file))) continue;
    let text;
    try {
        if (statSync(join(repoRoot, file)).size > 2_000_000) continue;
        text = readFileSync(join(repoRoot, file), 'utf8');
    } catch { continue; }           // a file listed but not checked out
    if (text.includes('\0')) continue;                              // binary after all
    scanned++;
    const lines = text.split(/\r?\n/);
    for (const rule of rules) {
        if (rule.files && !rule.files.test(file)) continue;
        if (rule.allow?.some(re => re.test(file))) continue;
        checks++;
        // A file of patterns necessarily contains its own patterns, so it is
        // not scanned. Its prose is written to pass them regardless.
        if (file === 'tools/publication-gates.mjs') continue;
        lines.forEach((line, i) => {
            if (rule.re.test(line)) findings.push({ file, line: i + 1, rule, text: line.trim() });
        });
    }
}

const byRule = new Map();
for (const f of findings) byRule.set(f.rule.name, [...(byRule.get(f.rule.name) ?? []), f]);

for (const rule of rules) {
    const hits = byRule.get(rule.name) ?? [];
    if (!hits.length) { console.log(`  ok    ${rule.name}`); continue; }
    failed++;
    console.log(`  FAIL  ${rule.name} — ${hits.length} in ${new Set(hits.map(h => h.file)).size} file(s)`);
    console.log(`        ${rule.why}`);
    for (const h of hits.slice(0, 12)) {
        console.log(`        ${h.file}:${h.line}  ${h.text.slice(0, 96)}`);
    }
    if (hits.length > 12) console.log(`        …and ${hits.length - 12} more`);
}

console.log(`\n${rules.length - failed} passed, ${failed} failed  ` +
    `(${checks} checks over ${scanned} tracked text files)`);
process.exit(failed === 0 ? 0 : 1);

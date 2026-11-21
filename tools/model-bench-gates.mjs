#!/usr/bin/env node
// tools/model-bench-gates.mjs — the model benchmark's scorers still judge
// correctly.
//
// Run:  node tools/model-bench-gates.mjs
//
// Every case in tools/model-bench/cases/ carries a reply a sound model could
// give and replies broken by hand. This serves each one in place of the model,
// through the same app code a live run uses (prompt, parser, validators,
// stored rows), and fails when a sound reply is scored as a fail or a broken
// one as a pass. No model, no network: a stub answers every request.
//
// It runs in `npm test` because the scorers lean on the app's own parsers and
// gates: a change to a prompt's reply format or to a validator can silently
// turn a case into one every model passes, or one none can.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const r = spawnSync(process.execPath, [join(here, 'model-bench', 'mutate.mjs')], { stdio: 'inherit' });
process.exit(r.status ?? 1);

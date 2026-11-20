/**
 * A throwaway app folder for gates that start the real launcher.
 *
 * The launcher refuses to start without `dist/index.html` beside it, and in a
 * full run the suites that build `dist/` run alongside the ones that start a
 * launcher, so a gate that used the repo's own folder passed or failed by the
 * order the runner happened to pick (red on Linux CI, green here). This folder
 * holds a copy of `desktop/` (the launcher finds its app folder from its own
 * path), links to `server/`, `src/` and `node_modules/`, and a placeholder page:
 * nothing a start-and-check reads from the page itself.
 *
 * The links are removed one by one, and checked gone, before the folder is:
 * deleting a folder that still holds a link to the repo must never be able to
 * reach through it.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LINKED = ['server', 'src', 'node_modules'];

export function scratchApp(repoRoot, parent) {
    const root = join(parent, 'app');
    mkdirSync(root, { recursive: true });
    cpSync(join(repoRoot, 'desktop'), join(root, 'desktop'), { recursive: true });
    cpSync(join(repoRoot, 'package.json'), join(root, 'package.json'));
    const links = [];
    for (const name of LINKED) {
        if (!existsSync(join(repoRoot, name))) continue;
        const at = join(root, name);
        symlinkSync(join(repoRoot, name), at, 'junction');
        links.push(at);
    }
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'index.html'), '<!doctype html><title>placeholder for a gate</title>\n');

    const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
    return {
        root,
        launcher: join(root, 'desktop', 'launcher.js'),
        /** Remove the links, then the folder; leaves the folder if a link would not go. */
        dispose() {
            for (const p of links) {
                if (!isLink(p)) continue;
                try { unlinkSync(p); } catch { try { rmdirSync(p); } catch { /* checked below */ } }
            }
            if (links.some((p) => isLink(p) || existsSync(p))) return false;
            rmSync(root, { recursive: true, force: true });
            return true;
        },
    };
}

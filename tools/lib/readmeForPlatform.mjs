// The README.txt at the top of each desktop zip, cut down to that zip's system.
//
// desktop/README.txt is ONE template for all three packages, so the three
// cannot drift apart. A block that belongs to some systems only sits between
// marker lines of its own:
//
//   @only windows linux
//   ...lines for those systems...
//   @end
//
// __VERSION__ becomes the version and __SYSTEM__ the system's name. Blocks do
// not nest. A marker naming anything but the three systems, an @only without
// its @end, an @end without its @only and any other line opening with @
// throw, so a typo fails the build rather than shipping one system's steps
// to another.

export const PLATFORMS = ['windows', 'macos', 'linux'];

/** process.platform → the name the template uses. */
export const PLATFORM_OF = { win32: 'windows', darwin: 'macos', linux: 'linux' };

/** The name the title gives each system (`__SYSTEM__`). */
export const LABEL = {windows: 'Windows', macos: 'macOS', linux: 'Linux' };

export function readmeForPlatform(template, platform, version) {
    if (!PLATFORMS.includes(platform)) throw new Error(`README: unknown system "${platform}"`);
    const eol = template.includes('\r\n') ? '\r\n' : '\n';
    const out = [];
    let only = null; // the systems of the open block, or null outside one
    template.split(/\r?\n/).forEach((line, i) => {
        const at = `desktop/README.txt line ${i + 1}`;
        // A line opening with @ is a marker or a mistake: "@ONLY macos" or an
        // indented "@only" would otherwise ship as text, block and all.
        if (line.trimStart().startsWith('@') && !/^@(only|end)(\s|$)/.test(line)) {
            throw new Error(`${at}: "${line.trim()}" is not a marker (@only <systems> or @end, lowercase, at the line start)`);
        }
        const marker = /^@(only|end)\b(.*)$/.exec(line);
        if (!marker) {
            if (only === null || only.includes(platform)) out.push(line);
            return;
        }
        if (marker[1] === 'end') {
            if (only === null) throw new Error(`${at}: @end without an @only`);
            if (marker[2].trim()) throw new Error(`${at}: @end takes nothing after it`);
            only = null;
            return;
        }
        if (only !== null) throw new Error(`${at}: @only inside another @only block`);
        only = marker[2].trim().split(/\s+/).filter(Boolean);
        if (only.length === 0) throw new Error(`${at}: @only names no system`);
        const unknown = only.filter((p) => !PLATFORMS.includes(p));
        if (unknown.length) throw new Error(`${at}: @only names an unknown system: ${unknown.join(', ')}`);
    });
    if (only !== null) throw new Error('desktop/README.txt: an @only block is never closed with @end');
    return out.join(eol).replaceAll('__VERSION__', version).replaceAll('__SYSTEM__', LABEL[platform]);
}

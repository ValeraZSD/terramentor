#!/usr/bin/env node
/**
 * The Windows installer's script (desktop/installer/Terramentor.iss), read as
 * text and held to what it promises, on any machine:
 *
 *   - for the current user only: never elevated, never a machine-wide folder
 *     or registry hive, and the app in a folder its owner can write, so the
 *     one-click updater keeps replacing it;
 *   - every registry key it writes is under the user's own file types and is
 *     removed on uninstall;
 *   - the double-click command is one the launcher reads as a file to open;
 *   - its own folder and the names it keeps match the updater's
 *     (desktop/updateCore.js NEVER_MOVED), its mutex the tray program's, and
 *     its AppId the launcher's (desktop/lib.js);
 *   - it never names the library's folder.
 * Also the Linux menu entry's file type (desktop/wrappers/install-desktop-entry.sh),
 * run in a scratch home where a POSIX shell is at hand.
 *
 * Installing it for real is tools/installer-check.mjs, on CI's Windows runner.
 *
 *   node tools/installer-gates.mjs
 */
import { readFileSync, readdirSync, mkdtempSync, rmSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { openRequest, SETUP_DIR, SETUP_APP_ID, UNINSTALL_KEY, installedBySetup, uninstallVersionUpdate, APP_NAME } from '../desktop/lib.js';
import { NEVER_MOVED, UPDATE_DIR } from '../desktop/updateCore.js';
import { installerName, numericVersion, findIscc } from './build-installer.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(repoRoot, ...p), 'utf8');

let pass = 0, fail = 0;
const check = (name, got, want) => {
    const good = JSON.stringify(got) === JSON.stringify(want);
    good ? pass++ : fail++;
    console.log(`${good ? '  ok  ' : ' FAIL '} ${name}${good ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};
const ok = (name, cond, detail = '') => check(name + (detail && !cond ? ` — ${detail}` : ''), !!cond, true);

// ---------------------------------------------------------------------------
// Reading the script. Inno Setup's sections are `[Name]` lines; a line
// starting with `;` is a comment; `#define Name "value"` is the preprocessor's,
// and `{#Name}` puts the value in. [Code] is Pascal, read as text.
const raw = readFileSync(join(repoRoot, 'desktop', 'installer', 'Terramentor.iss'));
const iss = raw.toString('utf8').replace(/^\uFEFF/, '');
const defines = Object.fromEntries([...iss.matchAll(/^#define (\w+) "([^"]*)"\s*$/gm)].map((m) => [m[1], m[2]]));
const expand = (s) => s.replace(/\{#(\w+)\}/g, (all, n) => (n in defines ? defines[n] : all));
const sections = {};
{
    let current = null;
    for (const line of iss.split(/\r?\n/)) {
        const head = /^\[(\w+)\]\s*$/.exec(line);
        if (head) { current = head[1]; sections[current] ??= []; continue; }
        if (current && current !== 'Code' && (/^\s*;/.test(line) || !line.trim())) continue;
        if (current) sections[current].push(line);
    }
}
const setup = Object.fromEntries((sections.Setup || []).map((l) => /^(\w+)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], expand(m[2])]));
/** One entry line's parameters: `Name: value; Name: "quoted ""value"""`. */
const params = (line) => {
    const out = {};
    let i = 0;
    const s = expand(line);
    while (i < s.length) {
        const m = /^\s*(\w+):\s*/.exec(s.slice(i));
        if (!m) break;
        i += m[0].length;
        let value = '';
        if (s[i] === '"') {
            i++;
            for (; i < s.length; i++) {
                if (s[i] === '"' && s[i + 1] === '"') { value += '"'; i++; } else if (s[i] === '"') { i++; break; } else value += s[i];
            }
        } else {
            const end = s.indexOf(';', i);
            value = (end < 0 ? s.slice(i) : s.slice(i, end)).trim();
            i = end < 0 ? s.length : end;
        }
        out[m[1]] = value;
        const semi = s.indexOf(';', i);
        i = semi < 0 ? s.length : semi + 1;
    }
    return out;
};
const entries = (name) => (sections[name] || []).filter((l) => !l.startsWith('#')).map(params);
/** The script without its comments (`;` lines, and Pascal's `{ … }` in
 *  [Code], which open with a space where a constant never does). */
const acted = iss.split(/\r?\n/).filter((l) => !/^\s*;/.test(l)).join('\n').replace(/\{ [^}]*\}/g, '');

// ---------------------------------------------------------------------------
console.log('\n--- for the current user only ---');
check('it never asks for elevation', setup.PrivilegesRequired, 'lowest');
ok('…and offers no way to ask for it', !('PrivilegesRequiredOverridesAllowed' in setup));
ok('the app goes in the user\'s own program folder', /^\{userpf\}\\/.test(setup.DefaultDirName || ''), setup.DefaultDirName);
check('…by its name', setup.DefaultDirName, `{userpf}\\${APP_NAME}`);
check('…with no page to move it somewhere the updater cannot write', setup.DisableDirPage, 'yes');
const machineWide = ['{commonpf}', '{pf}', '{autopf}', '{commonprograms}', '{autoprograms}', '{commonstartup}', '{autostartup}', '{commondesktop}', '{autodesktop}', '{commonappdata}', '{sys}', '{win}', 'HKLM', 'HKCR', 'HKA,', 'HKA;', 'HKEY_'];
const named = machineWide.filter((w) => acted.includes(w));
ok('nothing machine-wide is named: no shared folder, no machine registry', named.length === 0, named.join(', '));
check('the Start menu entry is the user\'s', entries('Icons').map((e) => e.Name.split('\\')[0]), ['{userprograms}']);
check('…and starts the program the zip starts', entries('Icons').map((e) => e.Filename), [`{app}\\${APP_NAME}.exe`]);
check('the files are the packaged app folder, whole', entries('Files').map((e) => [e.Source, e.DestDir, e.Flags?.split(/\s+/).sort()]),
    [['{#SourceDir}\\*', '{app}', ['createallsubdirs', 'ignoreversion', 'recursesubdirs']]]);

// ---------------------------------------------------------------------------
console.log('\n--- the registry: the user\'s own file types, removed on uninstall ---');
{
    const reg = entries('Registry');
    ok('it writes the file type', reg.length >= 4);
    const outside = reg.filter((e) => e.Root !== 'HKCU' || !/^Software\\Classes\\/.test(e.Subkey));
    ok('every key is under HKCU\\Software\\Classes', outside.length === 0, JSON.stringify(outside));
    const flags = (e) => (e.Flags || '').split(/\s+/).filter(Boolean);
    const deletesKey = reg.filter((e) => flags(e).includes('uninsdeletekey')).map((e) => e.Subkey);
    const kept = reg.filter((e) => !flags(e).some((f) => /^uninsdelete/.test(f))
        && !deletesKey.some((k) => e.Subkey.toLowerCase().startsWith(`${k.toLowerCase()}\\`)));
    ok('every key or value it writes goes on uninstall, itself or with the key above it', kept.length === 0, JSON.stringify(kept));
    const ext = reg.find((e) => e.Subkey === 'Software\\Classes\\.studyvault' && e.ValueName === '');
    const progId = defines.ProgId;
    ok('the ProgID is the app\'s own', /^Terramentor\.\w+$/.test(progId || ''), progId);
    check('.studyvault names it', ext && [ext.ValueType, ext.ValueData], ['string', progId]);
    ok('…removing only its own value, so another app\'s claim since is kept', ext && flags(ext).includes('uninsdeletevalue') && !flags(ext).includes('uninsdeletekey'));
    const owp = reg.find((e) => e.Subkey === 'Software\\Classes\\.studyvault\\OpenWithProgids');
    check('…and lists it in "Open with"', owp && [owp.ValueName, owp.ValueData], [progId, '']);
    const icon = reg.find((e) => e.Subkey === `Software\\Classes\\${progId}\\DefaultIcon`);
    check('course files show the app\'s icon', icon?.ValueData, `{app}\\${APP_NAME}.ico`);
    ok('…which the build writes into the app folder', /writeFileSync\(join\(stage, `\$\{APP\}\.ico`\)/.test(read('tools', 'build-desktop.mjs')));
    const cmd = reg.find((e) => e.Subkey === `Software\\Classes\\${progId}\\shell\\open\\command`);
    check('a double-click runs the program with the file', cmd?.ValueData, `"{app}\\${APP_NAME}.exe" --open "%1"`);

    // What Windows will run, split as Windows splits a command line.
    const APP = 'C:\\Users\\Ана Smith\\AppData\\Local\\Programs\\Terramentor';
    const FILE = 'C:\\Users\\Ана Smith\\Downloads\\Dutch A2 (1) & more.studyvault';
    const line = (cmd?.ValueData || '').replace('{app}', APP).replace('%1', FILE);
    const argv = [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
    check('…which Windows starts as the program, --open and the file, spaces and all', argv, [`${APP}\\${APP_NAME}.exe`, '--open', FILE]);
    check('…and the launcher reads as the file to open', openRequest(argv.slice(1)), FILE);
    check('the file type has a name in every language the installer speaks',
        /^FileTypeName=\S/m.test(iss) && reg.find((e) => e.Subkey === `Software\\Classes\\${progId}` && e.ValueName === '')?.ValueData, '{cm:FileTypeName}');
    check('Windows is told the file types changed', setup.ChangesAssociations, 'yes');
}

// ---------------------------------------------------------------------------
console.log('\n--- the installer and the app agree ---');
{
    check('its AppId is the one the launcher looks its entry up by', setup.AppId, `{{${SETUP_APP_ID}}`);
    check('…the entry\'s key', UNINSTALL_KEY, `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{${SETUP_APP_ID}}_is1`);
    ok('[Code] reads the same key', iss.includes("'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{{#AppIdGuid}}_is1'") && defines.AppIdGuid === SETUP_APP_ID);
    check('its own files go in the folder the launcher knows it by', setup.UninstallFilesDir, `{app}\\${SETUP_DIR}`);
    ok('…which a one-click update never moves', NEVER_MOVED.has(SETUP_DIR));
    check('…and which says the copy is installed', [installedBySetup('C:\\A', { exists: (p) => p === `C:\\A\\${SETUP_DIR}\\unins000.exe` || p === `C:\\A/${SETUP_DIR}/unins000.exe` }), installedBySetup('C:\\A', { exists: () => false })], [true, false]);

    // KeptInAppFolder: the names a reinstall or an uninstall leaves in the app
    // folder. The updater's list, less its own working folder.
    const keptFn = /function KeptInAppFolder[\s\S]*?\nend;/.exec(iss)?.[0] || '';
    const kept = [...expand(keptFn).matchAll(/CompareText\(Name, '([^']+)'\)/g)].map((m) => m[1]).sort();
    check('it keeps in the app folder what an update never moves, less the update\'s own work folder',
        kept, [...NEVER_MOVED].filter((n) => n !== UPDATE_DIR).sort());
    const clearFn = /procedure ClearAppFolder[\s\S]*?\nend;/.exec(iss)?.[0] || '';
    const guardAt = clearFn.indexOf("FileExists(AddBackslash(Dir) + 'build.json')");
    ok('it clears a folder only once it has seen a packaged app there', guardAt > 0
        && guardAt < clearFn.indexOf('DelTree') && guardAt < clearFn.indexOf('DeleteFile') && /then Exit;/.test(clearFn.slice(guardAt, guardAt + 80)));
    ok('…and the build writes that sign', /build\.json/.test(read('tools', 'build-desktop.mjs')));

    const cs = read('desktop', 'wrappers', 'Launcher.cs');
    ok('it waits for the tray program\'s mutex before it replaces or removes files', setup.AppMutex === `${APP_NAME}.running`
        && /public const string APP = "Terramentor";/.test(cs) && cs.includes('new Mutex(false, "Local\\\\" + APP + ".running")'), setup.AppMutex);
    ok('a launch with a file from a second copy goes to the launcher, never dropped',
        /if \(opening != null\)\s*\{\s*StartHidden\(node, script, root, rest, opening\);/.test(cs));

    const run = entries('Run');
    ok('the finished page offers to start the app, never a silent install', run.length === 1
        && run[0].Filename === `{app}\\${APP_NAME}.exe` && ['postinstall', 'skipifsilent', 'nowait'].every((f) => run[0].Flags.split(/\s+/).includes(f)), JSON.stringify(run));
    ok('the uninstaller removes a sign-in shortcut only when it starts THIS copy',
        /\{userstartup\}\\\{#AppName\}\.lnk/.test(iss) && /LinkNamesFolder\(Startup, Dir\) then DeleteFile\(Startup\)/.test(iss));
    ok('…which is the name "Start when I sign in" writes', /name = APP_NAME/.test(read('desktop', 'lib.js')) && /`\$\{name\}\.lnk`/.test(read('desktop', 'lib.js')));
}

// ---------------------------------------------------------------------------
console.log('\n--- the library is not the app ---');
{
    ok('no {localappdata}: the library\'s folder is never named', !/\{localappdata\}/i.test(iss));
    ok('no [UninstallDelete] or [InstallDelete] reaching past the app folder',
        ['UninstallDelete', 'InstallDelete'].every((s) => entries(s).every((e) => /^\{app\}\\/.test(e.Name || ''))));
    ok('the uninstaller\'s own removal is of the app folder\'s names, never the library', /ClearAppFolder\(Dir\)/.test(iss) && !/DelTree\(ExpandConstant\('\{app\}'\)/.test(iss));
}

// ---------------------------------------------------------------------------
console.log('\n--- its pages and languages ---');
{
    check('a welcome page, then straight to installing: no ready page, no folder page, no Start menu page',
        [setup.DisableWelcomePage, setup.DisableReadyPage, setup.DisableDirPage, setup.DisableProgramGroupPage], ['no', 'yes', 'yes', 'yes']);
    ok('the wizard follows Windows\' light or dark mode', /\bdynamic\b/.test(setup.WizardStyle || ''), setup.WizardStyle);
    // Dark mode reads its own directives; left blank, it shows Inno Setup's pictures.
    for (const name of ['WizardImageFile', 'WizardSmallImageFile']) {
        ok(`…and shows the app's own ${name === 'WizardImageFile' ? 'picture' : 'small picture'} in both`,
            !!setup[name] && /\{#ArtDir\}/.test(setup[name]) && setup[`${name}DynamicDark`] === setup[name], setup[`${name}DynamicDark`] || 'no DynamicDark line');
    }
    check('no language prompt: Windows\' own language is used', setup.ShowLanguageDialog, 'no');
    ok('the script is UTF-8 with its mark, so the compiler reads every language right', raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf);
    const appLocales = new Set(readdirSync(join(repoRoot, 'src', 'locales')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)));
    const langs = [...iss.matchAll(/^#emit Lang\("(\w+)", "(\w+)"\)/gm)].map((m) => ({ code: m[1], file: m[2] }));
    ok('it speaks languages the app speaks', langs.length > 5 && langs.every((l) => appLocales.has(l.code.replace(/^ptbr$/, 'pt'))), langs.map((l) => l.code).join(' '));
    for (const key of ['FileTypeName', 'NewerInstalled', 'ConfirmUninstall']) {
        const msgs = new Map([...iss.matchAll(new RegExp(`^#emit Msg\\("(\\w+)", "(\\w+)", "${key}", "([^"]*)"\\)`, 'gm'))].map((m) => [m[1], { file: m[2], text: m[3] }]));
        const missing = langs.filter((l) => !msgs.has(l.code) || msgs.get(l.code).file !== l.file).map((l) => l.code);
        ok(`${key} is translated for every language, by the same file name`, missing.length === 0, missing.join(' '));
        if (key === 'NewerInstalled') {
            const english = /^NewerInstalled=(.*)$/m.exec(iss)?.[1] || '';
            const bad = [['en', english], ...[...msgs].map(([c, m]) => [c, m.text])].filter(([, t]) => !t.includes('%1') || !t.includes('%2')).map(([c]) => c);
            ok('…naming both versions in every language', bad.length === 0, bad.join(' '));
        }
        if (key === 'ConfirmUninstall') {
            // [Messages] replaces Inno Setup's own text; the same lines under
            // [CustomMessages] would be read by nothing.
            const section = /^\[Messages\]\r?\n([\s\S]*?)^\[/m.exec(iss)?.[1] || '';
            const inSection = [...section.matchAll(/^#emit Msg\("(\w+)", "\w+", "ConfirmUninstall"/gm)].map((m) => m[1]);
            ok('…all of it under [Messages]', inSection.length === msgs.size && /^ConfirmUninstall=/m.test(section), `${inSection.length} of ${msgs.size}`);
            const english = /^ConfirmUninstall=(.*)$/m.exec(section)?.[1] || '';
            ok('the English question says the library stays', /library/.test(english) && /stay/.test(english), english);
            const bad = [['en', english], ...[...msgs].map(([c, m]) => [c, m.text])].filter(([, t]) => !t.includes('%1')).map(([c]) => c);
            ok('…naming the app in every language', bad.length === 0, bad.join(' '));
        }
    }
}

// ---------------------------------------------------------------------------
console.log('\n--- building it ---');
{
    check('the installer\'s name sits beside the zip\'s', installerName('1.7.0-nightly.20261127.2'), 'Terramentor-1.7.0-nightly.20261127.2-win32-x64-setup');
    check('Windows\' four-number file version drops a prerelease', [numericVersion('1.7.0'), numericVersion('1.7.0-nightly.20261127.2')], ['1.7.0.0', '1.7.0.0']);
    ok('a version that is not one is refused', (() => { try { numericVersion('latest'); return false; } catch { return true; } })());
    check('Inno Setup is found by ISCC first, then where it installs', [
        findIscc({ env: { ISCC: 'X:\\iscc.exe' }, exists: (p) => p === 'X:\\iscc.exe' }),
        findIscc({ env: { 'ProgramFiles(x86)': 'C:\\PF86' }, exists: (p) => p === join('C:\\PF86', 'Inno Setup 6', 'ISCC.exe') }),
        findIscc({ env: {}, exists: () => true }),
    ], ['X:\\iscc.exe', join('C:\\PF86', 'Inno Setup 6', 'ISCC.exe'), null]);
    const required = ['AppVersion', 'NumericVersion', 'SourceDir', 'ArtDir'];
    const builder = read('tools', 'build-installer.mjs');
    ok('every define the script requires is one the build passes', required.every((d) => iss.includes(`#ifndef ${d}`) && builder.includes(`${d}:`)));

    // The compiler is a program the release job downloads and runs, and what it
    // builds is published: it comes from its own project's release and is
    // refused unless its digest is the one pinned in the workflow.
    const workflow = read('.github', 'workflows', 'release.yml').replace(/\r/g, '');
    const fetchStep = /- name: Fetch Inno Setup\n([\s\S]*?)\n {6}- name:/.exec(workflow)?.[1] ?? '';
    const url = /\$url\s*=\s*'([^']+)'/.exec(fetchStep)?.[1] ?? '';
    ok('the release job fetches Inno Setup from its own project\'s GitHub release, by version',
        /^https:\/\/github\.com\/jrsoftware\/issrc\/releases\/download\/is-\d+_\d+_\d+\/innosetup-\d+\.\d+\.\d+\.exe$/.test(url), url || 'no Fetch Inno Setup step');
    ok('…holds it to a pinned SHA-256', /\$want\s*=\s*'[0-9a-f]{64}'/.test(fetchStep));
    ok('…and stops before running it when the digest differs',
        /Get-FileHash -Algorithm SHA256 \$exe/.test(fetchStep) && /if \(\$got -ne \$want\) \{ throw/.test(fetchStep)
        && fetchStep.indexOf('throw') < fetchStep.indexOf('Start-Process'));
    ok('…installed for the runner\'s account alone, never elevated', /'\/CURRENTUSER'/.test(fetchStep) && !/RunAs|\/ALLUSERS/i.test(fetchStep));
    ok('the build runs only after it', workflow.indexOf('- name: Fetch Inno Setup') > 0
        && workflow.indexOf('- name: Fetch Inno Setup') < workflow.indexOf('run: node tools/build-installer.mjs'));

    // The install check installs and removes the app for the account it runs
    // as: on a person's own computer it must do nothing. Asked here with no CI
    // marker and a setup that does not exist, so even a broken guard installs nothing.
    const env = { ...process.env };
    delete env.GITHUB_ACTIONS;
    const refused = spawnSync(process.execPath, [join(repoRoot, 'tools', 'installer-check.mjs'), join(tmpdir(), 'Terramentor-9.9.9-win32-x64-setup.exe')],
        { env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    ok('the install check refuses to run off a CI runner or Windows Sandbox', refused.status === 2 && /refuses to run here|Windows only/.test(refused.stderr), `${refused.status} ${refused.stderr}`);
}

// ---------------------------------------------------------------------------
console.log('\n--- Windows\' list of apps after a one-click update ---');
{
    const queried = (v) => `\r\nHKEY_CURRENT_USER\\Software\\...\\{X}_is1\r\n    DisplayVersion    REG_SZ    ${v}\r\n\r\n`;
    check('an entry naming the old version is brought up to date', uninstallVersionUpdate(queried('1.6.0'), '1.7.0')?.args,
        ['add', UNINSTALL_KEY, '/v', 'DisplayVersion', '/t', 'REG_SZ', '/d', '1.7.0', '/f']);
    check('…one that already names it is left alone', uninstallVersionUpdate(queried('1.7.0'), '1.7.0'), null);
    check('…and none is ever made (a zip copy has none)', uninstallVersionUpdate(null, '1.7.0'), null);
    check('a version that is not one is never written', uninstallVersionUpdate(queried('1.6.0'), '1.7.0 /f & calc'), null);
    const launcher = read('desktop', 'launcher.js');
    ok('only an installed, packaged Windows copy touches it', /const installed = packaged && process\.platform === 'win32' && installedBySetup\(appRoot\)/.test(launcher)
        && /function refreshUninstallEntry\(\) \{\s*if \(!installed\) return;/.test(launcher));
    ok('…and an installed copy makes no Start menu shortcut of its own (the installer\'s is there)',
        /if \(process\.platform !== 'win32' \|\| !packaged \|\| !chosen\.dir \|\| installed\) return;/.test(launcher));
}

// ---------------------------------------------------------------------------
console.log('\n--- Linux: the menu entry opens course files ---');
{
    const sh = read('desktop', 'wrappers', 'install-desktop-entry.sh');
    const TYPE = 'application/x-terramentor-studyvault';
    ok('the menu entry says it opens the file type', sh.includes(`MimeType=${TYPE};`));
    ok('…and takes the file as one argument', /printf 'Exec="%s" %%f\\n' "\$EXEC_ARG"/.test(sh));
    ok('the file type is declared by name, as a kind of zip', sh.includes(`<mime-type type="${TYPE}">`) && sh.includes('<glob pattern="*.studyvault"/>') && sh.includes('<sub-class-of type="application/zip"/>'));
    ok('the shell wrapper says where it was started, before it moves', /TERRAMENTOR_CWD="\$\(pwd\)"\nexport TERRAMENTOR_CWD\ncd /.test(read('desktop', 'wrappers', 'terramentor.sh').replace(/\r/g, '')));

    // Run for real where there is a POSIX shell: into a scratch home, from a
    // scratch copy of the folder (it marks its neighbours executable).
    const shell = process.platform === 'win32' ? null : '/bin/sh';
    if (shell && existsSync(shell)) {
        const scratch = mkdtempSync(join(tmpdir(), 'installer-gates-'));
        try {
            const app = join(scratch, 'Terramentor 1.0 "x"');
            mkdirSync(app);
            cpSync(join(repoRoot, 'desktop', 'wrappers', 'install-desktop-entry.sh'), join(app, 'install-desktop-entry.sh'));
            const home = join(scratch, 'home');
            mkdirSync(home);
            const env = { PATH: process.env.PATH, HOME: home, XDG_DATA_HOME: join(home, 'data'), XDG_CONFIG_HOME: join(home, 'config') };
            const r = spawnSync(shell, [join(app, 'install-desktop-entry.sh')], { env, encoding: 'utf8', timeout: 60_000 });
            ok('install-desktop-entry.sh runs', r.status === 0, (r.stderr || r.stdout).trim().slice(0, 300));
            const entry = readFileSync(join(home, 'data', 'applications', 'terramentor.desktop'), 'utf8');
            check('the entry names the file type and passes the file', [/^MimeType=(.*)$/m.exec(entry)?.[1], /^Exec=.* (%f)$/m.exec(entry)?.[1]], [`${TYPE};`, '%f']);
            const xml = readFileSync(join(home, 'data', 'mime', 'packages', 'terramentor-studyvault.xml'), 'utf8');
            ok('the type is written where the desktop reads it', xml.includes('*.studyvault'));
            if (existsSync(join(home, 'data', 'mime', 'globs2'))) {
                ok('…and the MIME database now knows the name', readFileSync(join(home, 'data', 'mime', 'globs2'), 'utf8').includes(`${TYPE}:*.studyvault`));
            } else {
                console.log('  (update-mime-database is not on this machine: the database itself was not rebuilt)');
            }
        } finally {
            rmSync(scratch, { recursive: true, force: true });
        }
    } else {
        console.log('  (skipped running it: no POSIX shell here)');
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;

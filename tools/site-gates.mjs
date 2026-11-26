#!/usr/bin/env node
/**
 * Site mode (server/site/): one front desk at one address serving many
 * people, each from their own library.
 *
 *   1. Passwords: argon2id in PHC form, 15 characters at least, weaker hashes
 *      re-made, the breached-password check sends five hex characters and can
 *      be switched off.
 *   2. The signed note a library takes in place of its password: good only for
 *      its library, its key, and half a minute.
 *   3. Accounts: an invite works once, a new one cancels the old; a session's
 *      token is stored hashed and ends on sign-out; a wrong password and an
 *      unknown address get the same answer; the throttle grows per address and
 *      per network and switches a password off after 100 wrong tries.
 *   4. The front desk end to end with a real library process (each library as
 *      this user here; the separation between users is proven on Linux by
 *      tools/site-proofs.mjs): signed out is sent to sign in, the cookie is
 *      `__Host-`, answers are not stored by the browser, a library sets no
 *      cookie and refuses its own password routes, a cross-site form is
 *      refused, signing out clears the browser's data for the address, and a
 *      library answers nothing without a good note.
 *   4c. The operator's cli.js: backup copies site.db and every library;
 *      remove deletes an account, its rows and folder, and the front desk's
 *      sweep stops it if it runs; a restore of a backup older than an erasure
 *      leaves the erased library out (and, as the control, brings it back
 *      without the ledger); a removed address leaves no trace in the next
 *      backup; one library that cannot be backed up costs no one else
 *      theirs; a restore brings back no session, refuses a forged library
 *      id, and leaves a library its night missed as it is.
 *   5. The solo app is unchanged: no `site` in its status, no site line in its log.
 *
 * Nothing here reaches a model: the model address is a closed port.
 *
 *   node tools/site-gates.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
    cond ? pass++ : fail++;
    console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${cond || !detail ? '' : `  (${detail})`}`);
};

const { hashPassword, verifyPassword, needsRehash, passwordShapeProblem, isBreached, MIN_LENGTH, argonRuns, spendLikeAPasswordCheck } = await import('../server/site/passwords.js');
const { makeNote, readNote, NOTE_HEADER } = await import('../server/siteLibrary.js');
const { openSiteDb } = await import('../server/site/siteDb.js');
const { createAccounts, networkOf, deviceLabel, WRONG, PASSWORD_OFF_AFTER } = await import('../server/site/accounts.js');
const { createFrontDesk, COOKIE, CLEAR_SITE_DATA } = await import('../server/site/frontDesk.js');
const { siteStartProblem, siteSettings } = await import('../server/site/index.js');
const { createLibraryPool } = await import('../server/site/libraries.js');

const scratch = mkdtempSync(join(tmpdir(), 'site-gates-'));
const CLOSED_MODEL = { AI_PROVIDER: 'openai', AI_BASE_URL: 'http://127.0.0.1:9/v1', AI_MODEL: 'none', SITE_BREACH_CHECK: '0' };
// What a section started (front desks, pools, databases, processes), released
// last-first when it ends or when a check throws, before the scratch folder goes.
const held = [];
async function release() {
    while (held.length) { try { await held.pop()(); } catch { /* already gone */ } }
}

try {
    // -------------------------------------------------------------------------
    console.log('--- 1. passwords ---');
    {
        const h = await hashPassword('correct horse battery staple');
        ok('the hash is argon2id in PHC form with OWASP\'s first row', /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/.test(h), h);
        ok('the right password verifies', await verifyPassword('correct horse battery staple', h));
        ok('a wrong one does not', !(await verifyPassword('correct horse battery stapler', h)));
        ok('two hashes of one password differ (salted)', h !== await hashPassword('correct horse battery staple'));
        ok('today\'s hash needs no re-hash', !needsRehash(h));
        ok('a weaker hash is re-made at sign-in', needsRehash(h.replace('m=19456,t=2', 'm=4096,t=1')));
        ok('a scrypt string is not taken as a hash', !(await verifyPassword('x', 'scrypt$16384$aa$bb')));
        ok(`${MIN_LENGTH - 1} characters are refused`, !!passwordShapeProblem('a'.repeat(MIN_LENGTH - 1)));
        ok(`${MIN_LENGTH} are taken, with no composition rule`, passwordShapeProblem('a'.repeat(MIN_LENGTH)) === null);
        ok('length counts characters, not UTF-16 units', !!passwordShapeProblem('\u{1F600}'.repeat(8)));
        ok('129 characters are refused', !!passwordShapeProblem('a'.repeat(129)));

        const asked = [];
        const fakeRange = (suffixes) => async (url, init) => {
            asked.push({ url, padding: init?.headers?.['Add-Padding'] });
            return { ok: true, text: async () => suffixes.map((s) => `${s}:3`).join('\r\n') };
        };
        const pw = 'password1234567890';
        const sha1 = crypto.createHash('sha1').update(pw).digest('hex').toUpperCase();
        ok('a breached password is found', await isBreached(pw, { env: {}, fetchImpl: fakeRange(['0000000000000000000000000000000000A', sha1.slice(5)]) }) === true);
        ok('only the first five characters of the SHA-1 leave, padded', asked[0].url === `https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}` && asked[0].padding === 'true', asked[0]?.url);
        ok('a password not in the range passes', await isBreached(pw, { env: {}, fetchImpl: fakeRange(['0000000000000000000000000000000000A']) }) === false);
        asked.length = 0;
        ok('SITE_BREACH_CHECK=0 sends nothing', await isBreached(pw, { env: { SITE_BREACH_CHECK: '0' }, fetchImpl: fakeRange([]) }) === null && asked.length === 0);
        const quiet = console.warn; console.warn = () => {};
        ok('an unreachable service lets the password through', await isBreached(pw, { env: {}, fetchImpl: async () => { throw new Error('offline'); } }) === null);
        console.warn = quiet;
    }

    // -------------------------------------------------------------------------
    console.log('--- 2. the signed note ---');
    {
        const key = crypto.randomBytes(32);
        const other = crypto.randomBytes(32);
        // One fixed instant: a pause in the run cannot age a note past its 30 s.
        const T = Date.parse('2030-01-10T12:00:00Z');
        const note = makeNote({ key, libraryId: 'liba', accountId: 7, sessionId: 9, now: T });
        ok('a fresh note names its account and session', JSON.stringify(readNote(note, { key, libraryId: 'liba', now: T + 1000 })) === '{"accountId":7,"sessionId":9}');
        ok('another library refuses it', readNote(note, { key, libraryId: 'libb', now: T }) === null);
        ok('another key refuses it', readNote(note, { key: other, libraryId: 'liba', now: T }) === null);
        ok('it expires after 30 s', readNote(note, { key, libraryId: 'liba', now: T + 31_000 }) === null);
        const forged = note.replace('.7.', '.8.');
        ok('changing the account breaks it', readNote(forged, { key, libraryId: 'liba', now: T }) === null);
        const far = makeNote({ key, libraryId: 'liba', accountId: 7, sessionId: 9, now: T, ttlMs: 3600_000 });
        ok('a note claiming a long life is refused', readNote(far, { key, libraryId: 'liba', now: T }) === null);
        ok('garbage is refused', readNote('v1.a.b', { key, libraryId: 'liba', now: T }) === null && readNote(undefined, { key, libraryId: 'liba', now: T }) === null);
    }

    // -------------------------------------------------------------------------
    console.log('--- 3. accounts ---');
    {
        const db = openSiteDb(join(scratch, 'accounts-site'));
        let made = 0;
        const accounts = createAccounts(db, { env: CLOSED_MODEL, createLibrary: () => `lib${++made}`.padEnd(32, '0') });
        db.prepare("INSERT INTO libraries (id, uid, note_key, created_at) VALUES (?, NULL, 'k', 'now'), (?, NULL, 'k', 'now')")
            .run('lib1'.padEnd(32, '0'), 'lib2'.padEnd(32, '0'));
        const first = accounts.createInvite('Ann@Example.org');
        const second = accounts.createInvite('ann@example.org');
        ok('a new invite for the address cancels the older one', accounts.inviteOf(first.token) === null && !!accounts.inviteOf(second.token));
        ok('the invite is stored hashed', !db.prepare('SELECT 1 FROM invites WHERE token_hash = ?').get(second.token));
        const short = await accounts.acceptInvite(second.token, 'too short', 'UA');
        ok('a short password is refused and the link stays good', !!short.error && !!accounts.inviteOf(second.token));
        const good = 'a long enough pass phrase for ann';
        const made1 = await accounts.acceptInvite(second.token, good, 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Safari/537.36 Edg/140.0');
        ok('the invite makes an account with a library and a session', made1.accountId > 0 && made1.libraryId && made1.token);
        ok('it works once', (await accounts.acceptInvite(second.token, good, 'UA')).spent === true);
        const row = db.prepare('SELECT token_hash, device FROM sessions WHERE id = ?').get(made1.sessionId);
        ok('the session token is stored as its SHA-256 only', row.token_hash === crypto.createHash('sha256').update(made1.token).digest('hex'));
        ok('the device is kept as a short name', row.device === 'Edge on Windows', row.device);
        ok('the cookie token finds the session', accounts.sessionOf(made1.token)?.accountId === made1.accountId);
        let threw = '';
        try { accounts.createInvite('ann@example.org'); } catch (e) { threw = e.message; }
        ok('no invite for an address that has an account', /already has an account/.test(threw));

        const ip = '203.0.113.9';
        // Counted, not timed: the stand-in hash an unknown address is checked
        // against is made once, on first use, so that run is spent before counting.
        await spendLikeAPasswordCheck('warm up');
        const r0 = argonRuns(); const wrong = await accounts.signIn('ann@example.org', 'not the password at all', { ip }); const runsWrong = argonRuns() - r0;
        const r1 = argonRuns(); const unknown = await accounts.signIn('nobody@example.org', 'not the password at all', { ip }); const runsUnknown = argonRuns() - r1;
        const r2 = argonRuns(); const odd = await accounts.signIn('not an address', 'not the password at all', { ip }); const runsOdd = argonRuns() - r2;
        ok('a wrong password and an unknown address get the same answer', wrong.wrong === true && unknown.wrong === true && Object.keys(wrong).join() === Object.keys(unknown).join());
        ok('and cost the same work (one argon2 each, a non-address too)', runsWrong === 1 && runsUnknown === 1 && runsOdd === 1 && odd.wrong === true, `${runsWrong} / ${runsUnknown} / ${runsOdd}`);
        ok('something that is not an address gets no count of its own, nor does an overlong one',
            !db.prepare("SELECT 1 FROM throttle WHERE key = 'acct:not an address'").get()
            && (await accounts.signIn(`${'a'.repeat(300)}@example.org`, 'x', { ip })).wrong === true
            && !db.prepare("SELECT 1 FROM throttle WHERE key LIKE 'acct:aaaa%'").get());
        const signed = await accounts.signIn('ANN@example.org ', good, { ip, ua: 'Mozilla/5.0 (Macintosh; Mac OS X) Firefox/140.0' });
        ok('the right password signs in, address case and spaces aside', signed.ok === true && signed.accountId === made1.accountId);

        // Throttle, per address: five free tries, then growing waits. Every try at
        // one fixed instant, so a slow password check cannot outlast the first 1 s wait.
        const TT = Date.parse('2030-01-10T12:00:00Z');
        for (let i = 0; i < 5; i++) await accounts.signIn('carl@example.org', 'wrong wrong wrong', { ip: `198.51.100.${i}`, now: TT });
        const sixth = await accounts.signIn('carl@example.org', 'wrong wrong wrong', { ip: '198.51.100.77', now: TT });
        ok('after five wrong tries for an address the next one waits, from any network', sixth.wait > 0, JSON.stringify(sixth));
        const stamp = db.prepare("SELECT last_fail_at FROM throttle WHERE key = 'acct:carl@example.org'").get().last_fail_at;
        ok('the wait is not a lock: it ends', accounts.throttleState('carl@example.org', '198.51.100.1', stamp + 3000).wait === 0);
        // Per network: an IPv6 /64 is one network.
        ok('an IPv6 address counts by its /64', networkOf('2001:db8:aa:bb:1:2:3:4') === networkOf('2001:db8:aa:bb::ffff') && networkOf('2001:db8:aa:bc::1') !== networkOf('2001:db8:aa:bb::1'));
        for (let i = 0; i < 20; i++) await accounts.signIn(`spray${i}@example.org`, 'wrong wrong wrong', { ip: `2001:db8:aa:bb::${i + 1}`, now: TT });
        const sprayed = await accounts.signIn('fresh@example.org', 'wrong wrong wrong', { ip: '2001:db8:aa:bb::999', now: TT });
        ok('twenty wrong tries from one network slow the next address from it', sprayed.wait > 0, JSON.stringify(sprayed));
        // 100 in a row switches the password off, the same for a made-up address.
        db.prepare('INSERT OR REPLACE INTO throttle (key, fails, last_fail_at) VALUES (?, ?, 0)').run('acct:ann@example.org', PASSWORD_OFF_AFTER);
        db.prepare('INSERT OR REPLACE INTO throttle (key, fails, last_fail_at) VALUES (?, ?, 0)').run('acct:ghost@example.org', PASSWORD_OFF_AFTER);
        const off = await accounts.signIn('ann@example.org', good, { ip: '192.0.2.200' });
        const ghost = await accounts.signIn('ghost@example.org', good, { ip: '192.0.2.201' });
        ok('after 100 wrong tries the password is off, even when right', off.passwordOff === true);
        ok('and a made-up address answers the same', ghost.passwordOff === true);
        ok('the operator can turn it back on', accounts.unlock('ANN@example.org') === true && accounts.unlock('nobody-here@example.org') === false);
        const back = await accounts.signIn('ann@example.org', good, { ip: '192.0.2.202' });
        ok('and the right password works again', back.ok === true, JSON.stringify(back));
        accounts.endSession(back.sessionId, back.accountId);
        ok('throttle counts live in the database', db.prepare('SELECT COUNT(*) AS n FROM throttle').get().n > 2);

        // Sessions: idle limit, list, sign out everywhere.
        db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(new Date(Date.now() - 31 * 864e5).toISOString(), signed.sessionId);
        ok('a session idle for 31 days is over', accounts.sessionOf(signed.token) === null);
        ok('the list shows the remaining device', accounts.listSessions(made1.accountId).length === 1);
        ok('a signed-in session is alive', accounts.sessionAlive(made1.sessionId) === true);
        accounts.endAllSessions(made1.accountId);
        ok('sign out everywhere ends every session', accounts.sessionOf(made1.token) === null && accounts.listSessions(made1.accountId).length === 0);
        ok('and an ended or idle session is not alive', !accounts.sessionAlive(made1.sessionId) && !accounts.sessionAlive(signed.sessionId));

        // The sweep forgets a network a day after its last wrong guess, never an account's count.
        const day = 24 * 3600e3;
        const putThrottle = db.prepare('INSERT OR REPLACE INTO throttle (key, fails, last_fail_at) VALUES (?, 3, ?)');
        // One fixed instant for the rows and the sweep: nothing here reads the clock.
        const NOW = Date.parse('2030-01-15T12:00:00Z');
        putThrottle.run('net:198.18.0.0', NOW - day - 60e3);
        putThrottle.run('net:198.18.1.0', NOW - 60e3);
        putThrottle.run('acct:ann@example.org', NOW - day - 60e3);
        putThrottle.run('acct:stranger@example.org', NOW - day - 60e3);
        putThrottle.run('acct:recent-stranger@example.org', NOW - 60e3);
        accounts.sweepSessions(NOW);
        const keys = new Set(db.prepare('SELECT key FROM throttle').all().map((r) => r.key));
        ok('the sweep drops a network quiet for a day and keeps a recent one',
            !keys.has('net:198.18.0.0') && keys.has('net:198.18.1.0'), [...keys].join(' '));
        ok('it keeps an account\'s count however old, and drops a day-old count for an address with no account',
            keys.has('acct:ann@example.org') && !keys.has('acct:stranger@example.org') && keys.has('acct:recent-stranger@example.org'), [...keys].join(' '));

        // No library, no account: the invite link is not spent.
        const broken = createAccounts(db, { env: CLOSED_MODEL, createLibrary: async () => { throw new Error('no room for a library'); } });
        const eve = broken.createInvite('eve@example.org');
        let noRoom = '';
        try { await broken.acceptInvite(eve.token, good, 'UA'); } catch (e) { noRoom = e.message; }
        ok('when no library can be made, no account is made and the invite stays good',
            /no room/.test(noRoom) && !!broken.inviteOf(eve.token) && !db.prepare('SELECT 1 FROM accounts WHERE email = ?').get('eve@example.org'), noRoom);
        // A right password whose stored hash is due for stronger settings, with every
        // check slot taken: the rehash is skipped, the sign-in goes through.
        {
            const signInSrc = readFileSync(join(repoRoot, 'server', 'site', 'accounts.js'), 'utf8').split('async function signIn')[1] || '';
            ok('a busy check queue skips the rehash instead of failing a right sign-in',
                /try \{ q\.setHash\.run\(await hashPassword\(password\), account\.id\); \} catch \(e\) \{ if \(e\?\.code !== 'AUTH_BUSY'\) throw e; \}/.test(signInSrc));
        }
        ok('device names', deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1') === 'Safari on iOS');
        db.close();
    }

    // -------------------------------------------------------------------------
    console.log('--- 4. the front desk with a real library ---');
    {
        ok('a front desk with no SITE_DIR refuses to start', /SITE_DIR/.test(siteStartProblem({}, { platform: 'linux', uid: 0 }) || ''));
        ok('on Linux, separate users are the default and need root', /root/.test(siteStartProblem({ SITE_DIR: '/s' }, { platform: 'linux', uid: 1000 }) || ''));
        ok('as root on Linux it starts', siteStartProblem({ SITE_DIR: '/s' }, { platform: 'linux', uid: 0 }) === null);
        ok('separate users are refused off Linux', /Linux only/.test(siteStartProblem({ SITE_DIR: 'x', SITE_SEPARATE: '1' }, { platform: 'win32' }) || ''));
        ok('a typo in SITE_SEPARATE is refused', /must be 1 or 0/.test(siteStartProblem({ SITE_DIR: 'x', SITE_SEPARATE: 'yes' }, { platform: 'linux', uid: 0 }) || ''));
        ok('reachable beyond loopback, it will not start without SITE_HOSTS',
            /SITE_HOSTS/.test(siteStartProblem({ SITE_DIR: '/s', HOST: '0.0.0.0' }, { platform: 'linux', uid: 0 }) || '')
            && siteStartProblem({ SITE_DIR: '/s', HOST: '0.0.0.0', SITE_HOSTS: 'learn.example.org' }, { platform: 'linux', uid: 0 }) === null
            && siteStartProblem({ SITE_DIR: '/s', HOST: '127.0.0.1' }, { platform: 'linux', uid: 0 }) === null);
        ok('a SITE_HOSTS of commas and spaces names nothing, so it is refused too',
            /SITE_HOSTS/.test(siteStartProblem({ SITE_DIR: '/s', HOST: '0.0.0.0', SITE_HOSTS: ' , ,' }, { platform: 'linux', uid: 0 }) || ''));
        ok('the start uses the value the check read: " 1 " is separate users (and needs root)',
            siteSettings({ SITE_SEPARATE: ' 1 ' }, { platform: 'linux' }).separate === true
            && /root/.test(siteStartProblem({ SITE_DIR: '/s', SITE_SEPARATE: ' 1 ' }, { platform: 'linux', uid: 1000 }) || '')
            && siteSettings({ SITE_SEPARATE: ' 0 ' }, { platform: 'linux' }).separate === false
            && siteSettings({ HOST: ' 0.0.0.0 ', SITE_HOSTS: ' Learn.example.org ,' }).hosts.join() === 'learn.example.org');
        {
            // The real start reads siteSettings too, not its own parse of the environment.
            const startSrc = readFileSync(join(repoRoot, 'server', 'site', 'index.js'), 'utf8').split('const isMain')[1] || '';
            ok('and the start itself reads siteSettings, not process.env.SITE_SEPARATE / SITE_HOSTS',
                /siteSettings\(env\)/.test(startSrc) && !/env\.SITE_SEPARATE|env\.SITE_HOSTS|env\.HOST\b/.test(startSrc));
            // The front desk speaks plain HTTP on a library's socket; certificates
            // in the app folder must not turn a library to TLS.
            const appSrc = readFileSync(join(repoRoot, 'server', 'index.js'), 'utf8');
            ok('a site library never serves TLS, certificates or not', /const httpsOpts = servingSPA && !isSiteLibrary\(\) &&/.test(appSrc));
            // A first status probe that failed must not leave the app thinking it is not on a site.
            const storeSrc = readFileSync(join(repoRoot, 'src', 'store.ts'), 'utf8');
            const recheck = storeSrc.split('recheckAuth: async () =>')[1]?.split('\n    },')[0] || '';
            ok('the periodic auth recheck keeps "on a site" current too', /\bsite\b[^\n]*= await api\.getAuthStatus\(\)/.test(recheck) && /authSite: !!site/.test(recheck));
        }
        {
            const sw = readFileSync(join(repoRoot, 'src', 'sw-template.js'), 'utf8');
            const m = sw.match(/function isBypassed\(url\) \{[\s\S]*?\r?\n\}\r?\n/);
            let bypassed = null;
            if (m) { try { bypassed = vm.runInNewContext(`${m[0]}; isBypassed`, { URL }); } catch { /* checked below */ } }
            const at = (p) => !!bypassed && bypassed(new URL(`https://learn.example.org${p}`)) === true;
            ok('the service worker never caches a site page (they name the person)', at('/site') && at('/site/sessions') && at('/site/sign-in') && !at('/sitemap.xml'));
        }

        const siteDir = join(scratch, 'site');
        const lines = [];
        const log = { log: (l) => lines.push(l), error: (l) => lines.push(l), warn: (l) => lines.push(l) };
        const db = openSiteDb(siteDir);
        const desk = createFrontDesk({
            db, siteDir, appRoot: repoRoot, separate: false, env: { ...process.env, ...CLOSED_MODEL }, log, sweepEveryMs: 3_600_000,
        });
        held.push(() => db.close(), () => desk.close());
        await new Promise((r) => desk.server.listen(0, '127.0.0.1', r));
        const port = desk.server.address().port;
        const origin = `http://localhost:${port}`;
        const req = (method, path, { headers = {}, body } = {}) => new Promise((resolveReq, reject) => {
            const r = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
                let text = '';
                res.setEncoding('utf8');
                res.on('data', (c) => { text += c; });
                res.on('end', () => resolveReq({ status: res.statusCode, headers: res.headers, text }));
            });
            r.on('error', reject);
            if (body) r.write(body);
            r.end();
        });
        const form = (o) => new URLSearchParams(o).toString();
        const FORM = { 'content-type': 'application/x-www-form-urlencoded', origin };

        const out = await req('GET', '/');
        ok('signed out, a page is sent to sign in', out.status === 303 && out.headers.location === '/site/sign-in');
        const outApi = await req('GET', '/api/projects');
        ok('signed out, the API says sign in again, as the site', outApi.status === 401 && JSON.parse(outApi.text).site === true);
        const signInPage = await req('GET', '/site/sign-in');
        ok('the sign-in page is served with a nonce CSP and no-store', signInPage.status === 200 && /style-src 'nonce-/.test(signInPage.headers['content-security-policy']) && signInPage.headers['cache-control'] === 'no-store');
        ok('the sign-in page carries no script', !/<script/i.test(signInPage.text));
        const outList = await req('GET', '/site/sessions.json', { headers: { accept: 'application/json' } });
        ok('signed out, the devices list says sign in again, as the site', outList.status === 401 && JSON.parse(outList.text).site === true, outList.text);

        const cut = await req('GET', '/site/invite/abc');
        ok('an invite link cut short says it no longer works, not a bare sign-in page', cut.status === 410 && cut.text.includes('This link no longer works'), `${cut.status} ${cut.headers.location || ''}`);
        const { token } = desk.accounts.createInvite('dana@example.org');
        const invitePage = await req('GET', `/site/invite/${token}`);
        ok('the invite page names the address', invitePage.status === 200 && invitePage.text.includes('dana@example.org'));
        const crossSite = await req('POST', `/site/invite/${token}`, { headers: { ...FORM, origin: 'https://evil.example' }, body: form({ password: 'x'.repeat(20), again: 'x'.repeat(20) }) });
        ok('a form from another site is refused', crossSite.status === 403);
        const opaque = await req('POST', `/site/invite/${token}`, { headers: { ...FORM, origin: 'null', 'sec-fetch-site': 'cross-site' }, body: form({ password: 'x'.repeat(20), again: 'x'.repeat(20) }) });
        ok('a form with an opaque origin from another site is refused', opaque.status === 403);
        // The pages send no referrer, so a browser posts their forms with `Origin: null`.
        const BROWSER_FORM = { ...FORM, origin: 'null', 'sec-fetch-site': 'same-origin' };
        const mismatch = await req('POST', `/site/invite/${token}`, { headers: BROWSER_FORM, body:form({ password: 'a long enough pass phrase', again: 'a long enough pass phrasE' }) });
        ok('two different passwords are refused', mismatch.status === 400 && mismatch.text.includes('not the same'));
        const t0 = performance.now();
        const accepted = await req('POST', `/site/invite/${token}`, { headers: FORM, body: form({ password: 'a long enough pass phrase', again: 'a long enough pass phrase' }) });
        const firstStartMs = performance.now() - t0;
        const setCookie = String(accepted.headers['set-cookie'] || '');
        ok('accepting the invite signs in and opens the library', accepted.status === 303 && accepted.headers.location === '/', `${accepted.status} ${accepted.text.slice(0, 200)}`);
        ok('accepting it clears what an earlier person left in this browser', accepted.headers['clear-site-data'] === CLEAR_SITE_DATA);
        ok('the session cookie is __Host-, HttpOnly, Secure, SameSite=Lax, Path=/', setCookie.startsWith(`${COOKIE}=`) && /HttpOnly/.test(setCookie) && /Secure/.test(setCookie) && /SameSite=Lax/.test(setCookie) && /Path=\//.test(setCookie) && !/Domain=/i.test(setCookie), setCookie);
        const cookie = setCookie.split(';')[0];
        const libId = db.prepare('SELECT library_id FROM accounts WHERE email = ?').get('dana@example.org').library_id;
        ok(`the new library started (${(firstStartMs / 1000).toFixed(1)} s, a new library makes its database)`, desk.pool.isAwake(libId));

        const status = await req('GET', '/api/auth/status', { headers: { cookie: `${cookie}; other=1` } });
        ok('the library takes the front desk\'s note as signed in', status.status === 200 && JSON.stringify(JSON.parse(status.text)) === '{"enabled":true,"authenticated":true,"site":true}', status.text);
        const projects = await req('GET', '/api/projects', { headers: { cookie } });
        ok('the API answers through the front desk', projects.status === 200 && Array.isArray(JSON.parse(projects.text)), projects.text.slice(0, 120));
        ok('and the browser is told not to store it', projects.headers['cache-control'] === 'no-store' && !projects.headers.etag);
        const login = await req('POST', '/api/auth/login', { headers: { cookie, 'content-type': 'application/json', origin }, body: '{"password":"x"}' });
        ok('the library\'s own password routes are refused', login.status === 403 && /at the site/.test(login.text), `${login.status} ${login.text}`);
        const disable = await req('POST', '/api/ai/key', { headers: { cookie, 'content-type': 'application/json', origin }, body: '{}' });
        ok('a site library keeps the hosted copy\'s refusals', disable.status === 403);
        const updates = await req('GET', '/api/updates', { headers: { cookie } });
        ok('the app does not offer the person update controls', updates.status === 200 && JSON.parse(updates.text).controls === false, updates.text.slice(0, 120));
        ok('a wake starts no model work', lines.some((l) => l.includes('[site] Woken: start-up model work is not started')));

        // Straight to the library's socket: nothing without a good note.
        const direct = (headers) => new Promise((resolveReq, reject) => {
            const r = http.request({ socketPath: desk.pool.socketPath(libId), path: '/api/projects', headers: { host: 'localhost', ...headers } }, (res) => {
                res.resume(); res.on('end', () => resolveReq(res.statusCode));
            });
            r.on('error', reject); r.end();
        });
        ok('the library answers nothing without a note', await direct({}) === 401);
        const wrongLib = makeNote({ key: desk.pool.noteKey(libId), libraryId: 'f'.repeat(32), accountId: 1, sessionId: 1 });
        ok('nor with a note made for another library', await direct({ [NOTE_HEADER]: wrongLib }) === 401);
        const wrongKey = makeNote({ key: crypto.randomBytes(32), libraryId: libId, accountId: 1, sessionId: 1 });
        ok('nor with a note signed by another key', await direct({ [NOTE_HEADER]: wrongKey }) === 401);
        const forwardedNote = await req('GET', '/api/projects', { headers: { cookie, [NOTE_HEADER]: 'v1.x.1.1.1.y' } });
        ok('a note sent by the browser is replaced, not passed on', forwardedNote.status === 200);

        // Sessions page, sign in from a second device, end it from the first.
        const second = await req('POST', '/site/sign-in', { headers: { ...FORM, 'user-agent': 'Mozilla/5.0 (Linux; Android 15) Chrome/140.0 Mobile Safari/537.36' }, body: form({ email: 'dana@example.org', password: 'a long enough pass phrase' }) });
        const cookie2 = String(second.headers['set-cookie'] || '').split(';')[0];
        ok('signing in again gives a second session', second.status === 303 && cookie2 && cookie2 !== cookie);
        ok('signing in clears what an earlier person left in this browser', second.headers['clear-site-data'] === CLEAR_SITE_DATA, second.headers['clear-site-data']);
        const wrongPw = await req('POST', '/site/sign-in', { headers: FORM, body: form({ email: 'dana@example.org', password: 'not it at all, sorry' }) });
        const unknownPw = await req('POST', '/site/sign-in', { headers: FORM, body: form({ email: 'nobody@example.org', password: 'not it at all, sorry' }) });
        const samePage = (t, email) => t.replace(/nonce="[^"]+"/g, 'nonce').replace(email, 'EMAIL');
        ok('a wrong password and an unknown address get the same page', wrongPw.status === 401 && unknownPw.status === 401
            && wrongPw.text.includes(WRONG) && samePage(wrongPw.text, 'dana@example.org') === samePage(unknownPw.text, 'nobody@example.org'));
        const oldPage = await req('GET', '/site/sessions', { headers: { cookie } });
        ok('the old devices address opens the devices in Settings', oldPage.status === 303 && oldPage.headers.location === '/settings#devices', `${oldPage.status} ${oldPage.headers.location}`);
        const listed = JSON.parse((await req('GET', '/site/sessions.json', { headers: { cookie } })).text);
        ok('the devices list names both devices and marks this one, and nothing secret',
            listed.email === 'dana@example.org' && listed.sessions.length === 2
            && listed.sessions.some((s) => s.current) && listed.sessions.some((s) => /Android/.test(s.device) && !s.current)
            && listed.sessions.every((s) => Object.keys(s).sort().join() === 'created_at,current,device,id,last_seen_at'), JSON.stringify(listed));
        const otherId = listed.sessions.find((s) => !s.current).id;
        // An answer still open for a session: a request whose body never finishes.
        const hang = async (c) => {
            let closed = false;
            const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/projects', headers: { host: `localhost:${port}`, cookie: c, origin, 'content-type': 'application/json', 'content-length': '1000' } });
            r.on('error', () => { closed = true; });
            r.on('close', () => { closed = true; });
            r.write('{"name":');
            const before = desk.openStreams();
            for (let i = 0; i < 100 && desk.openStreams() === before; i++) await new Promise((x) => setTimeout(x, 20));
            return { isClosed: () => closed, end: () => r.destroy() };
        };
        const waitFor = async (cond) => { for (let i = 0; i < 100 && !cond(); i++) await new Promise((x) => setTimeout(x, 20)); return cond(); };
        const open2 = await hang(cookie2);
        ok('an answer in progress is counted for its session', desk.openStreams() === 1, String(desk.openStreams()));
        const ended = await req('POST', `/site/sessions/${otherId}/sign-out`, { headers: { cookie, origin, accept: 'application/json' } });
        ok('signing out another device ends only it', ended.status === 200 && JSON.parse(ended.text).ok === true && (await req('GET', '/api/projects', { headers: { cookie: cookie2 } })).status === 401
            && (await req('GET', '/api/projects', { headers: { cookie } })).status === 200);
        ok('and closes what was still being sent to it', await waitFor(open2.isClosed) && desk.openStreams() === 0, `closed ${open2.isClosed()}, open ${desk.openStreams()}`);
        // Ended by the operator's cli.js, outside this process: the next sweep closes it.
        const third = await req('POST', '/site/sign-in', { headers: FORM, body: form({ email: 'dana@example.org', password: 'a long enough pass phrase' }) });
        const cookie3 = String(third.headers['set-cookie'] || '').split(';')[0];
        const open3 = await hang(cookie3);
        const s3 = desk.accounts.sessionOf(decodeURIComponent(cookie3.slice(cookie3.indexOf('=') + 1)));
        desk.accounts.endSession(s3?.sessionId, s3?.accountId);
        ok('a session ended elsewhere keeps its answer until the sweep', desk.openStreams() === 1 && !open3.isClosed());
        desk.closeEndedStreams();
        ok('and the sweep closes it', await waitFor(open3.isClosed) && desk.openStreams() === 0, `closed ${open3.isClosed()}, open ${desk.openStreams()}`);
        // Sign out of all other devices: this one stays signed in.
        const others = await Promise.all([1, 2].map(() => req('POST', '/site/sign-in', { headers: FORM, body: form({ email: 'dana@example.org', password: 'a long enough pass phrase' }) })));
        const otherCookies = others.map((r) => String(r.headers['set-cookie'] || '').split(';')[0]);
        const open4 = await hang(otherCookies[0]);
        const crossOthers = await req('POST', '/site/sign-out-others', { headers: { cookie, origin: 'https://evil.example', accept: 'application/json' } });
        ok('signing out the others from another site is refused', crossOthers.status === 403);
        const allOthers = await req('POST', '/site/sign-out-others', { headers: { cookie, origin, accept: 'application/json' } });
        const stillIn = (c) => req('GET', '/api/projects', { headers: { cookie: c } }).then((r) => r.status === 200);
        ok('signing out all other devices ends them and keeps this one',
            allOthers.status === 200 && JSON.parse(allOthers.text).ended === 2
            && !(await stillIn(otherCookies[0])) && !(await stillIn(otherCookies[1])) && await stillIn(cookie), allOthers.text);
        ok('and closes what was still being sent to them', await waitFor(open4.isClosed) && desk.openStreams() === 0);

        const signOut = await req('POST', '/site/sign-out', { headers: { cookie, origin } });
        ok('signing out clears the browser\'s data for this address', signOut.status === 303 && signOut.headers['clear-site-data'] === CLEAR_SITE_DATA, signOut.headers['clear-site-data']);
        ok('and the cookie', /Max-Age=0/.test(String(signOut.headers['set-cookie'])));
        ok('the old cookie no longer works', (await req('GET', '/api/projects', { headers: { cookie } })).status === 401);

        // A session ended by another device while its library woke: nothing is forwarded.
        {
            const again = await desk.accounts.signIn('dana@example.org', 'a long enough pass phrase', { ip: '192.0.2.50' });
            const raceCookie = `${COOKIE}=${again.token}`;
            const realWake = desk.pool.wake;
            let reached = 0;
            desk.pool.wake = async (id) => {
                const e = await realWake(id);
                desk.accounts.endSession(again.sessionId, again.accountId);
                return e;
            };
            const realSocket = desk.pool.socketPath;
            desk.pool.socketPath = (id) => { reached += 1; return realSocket(id); };
            const raced = await req('POST', '/api/settings/theme', { headers: { cookie: raceCookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ value: 'dark' }) });
            const racedPage = await req('GET', '/', { headers: { cookie: raceCookie } });
            desk.pool.wake = realWake;
            desk.pool.socketPath = realSocket;
            ok('a session ended while its library woke gets "sign in again", and the request never reaches the library',
                raced.status === 401 && JSON.parse(raced.text).site === true && racedPage.status === 303 && racedPage.headers.location === '/site/sign-in' && reached === 0,
                `${raced.status} ${racedPage.status} reached=${reached}`);
        }

        // A request handed the library while the sweep asks its task list: the
        // sweep reads the stream count again and leaves it running.
        {
            ok('(the library is awake for this)', desk.pool.isAwake(libId));
            const sweeping = desk.pool.sweep(Date.now() + 3600_000); // runs up to its task-list question
            desk.pool.streamOpened(libId);
            await sweeping;
            ok('a stream opened while the sweep asked the task list keeps its library running', desk.pool.isAwake(libId));
            desk.pool.streamClosed(libId);
            // And one that opened and closed meanwhile: the library was just used, so it is not idle.
            const entry = await desk.pool.wake(libId);
            entry.lastActive = Date.now() - 24 * 3600e3; // last used a day ago
            const sweeping2 = desk.pool.sweep(Date.now());
            desk.pool.streamOpened(libId);
            desk.pool.streamClosed(libId);
            await sweeping2;
            ok('a request that came and went while the sweep asked keeps its library running', desk.pool.isAwake(libId));
        }

        // Stopping when idle: not while a request is open.
        desk.pool.streamOpened(libId);
        await desk.pool.sweep(Date.now() + 3600_000);
        ok('a library with an open stream is not stopped', desk.pool.isAwake(libId));
        desk.pool.streamClosed(libId);
        await desk.pool.sweep(Date.now() + 3600_000);
        ok('an idle one with no task is stopped', !desk.pool.isAwake(libId));
        await release();
    }

    // -------------------------------------------------------------------------
    console.log('--- 4b. the library pool under pressure ---');
    {
        const siteDir = join(scratch, 'pool-site');
        const db = openSiteDb(siteDir);
        const quiet = { log() {}, error() {}, warn() {} };
        const base = { db, siteDir, appRoot: repoRoot, env: { ...process.env, ...CLOSED_MODEL }, log: quiet };
        held.push(() => db.close());
        const pool = createLibraryPool({ ...base, separate: false, maxAwake: 1 });
        held.push(() => pool.stopAll());
        const a = pool.create();
        const b = pool.create();
        const both = await Promise.allSettled([pool.wake(a), pool.wake(b)]);
        ok('two cold wakes with one slot: one starts, the other is told the site is full',
            both.filter((r) => r.status === 'fulfilled').length === 1 && both.some((r) => r.status === 'rejected' && r.reason?.code === 'FULL'),
            both.map((r) => r.status + (r.reason ? ` ${r.reason.code || r.reason.message}` : '')).join(', '));
        ok('and never more than one runs', pool.awakeCount() === 1 && pool.awakeOrStarting() === 1);
        const awakeId = pool.isAwake(a) ? a : b;
        ok('a library answering its task list is busy only when a task runs', await pool.isBusy(awakeId) === false);
        // A stop and a wake of the same library at once: the new process keeps its socket.
        const stopping = pool.stop(awakeId, 'gate');
        await pool.wake(awakeId);
        await stopping;
        ok('a wake during a stop waits for the old process, and the new one answers', pool.isAwake(awakeId) && (await pool.ask(awakeId, '/api/auth/status')).status === 200);
        await pool.stopAll();

        // Made with separate users off, started with them on: refused, not run as this user.
        const separatePool = createLibraryPool({ ...base, separate: true });
        let refused = '';
        try { await separatePool.wake(a); } catch (e) { refused = e.message; }
        ok('a library with no user of its own is not started with separate users on', /without a user of its own/.test(refused) && !separatePool.isAwake(a), refused);

        // A process that cannot start at all ends the wake with its reason.
        const brokenPool = createLibraryPool({ ...base, separate: false, appRoot: join(scratch, 'no-such-app') });
        let failed = '';
        const t0 = performance.now();
        await Promise.race([
            brokenPool.wake(a).catch((e) => { failed = e.message; }),
            new Promise((r) => setTimeout(r, 15000)),
        ]);
        ok('a library that cannot be started fails its wake, it does not hang', /stopped while starting/.test(failed) && performance.now() - t0 < 15000, failed || 'still waiting after 15 s');
        await brokenPool.stopAll();

        // Its process may leave a link where its tmp folder goes (to /etc, to another
        // library): the start refuses it, and nothing is made or chowned through it.
        const linked = pool.create();
        const elsewhere = join(scratch, 'not-this-library');
        mkdirSync(elsewhere);
        symlinkSync(elsewhere, join(pool.libDir(linked), 'tmp'), 'junction');
        let linkRefused = '';
        try { await pool.wake(linked); } catch (e) { linkRefused = e.message; }
        ok('a library whose tmp is a link is not started, and nothing happens through the link',
            /not a plain folder/.test(linkRefused) && !pool.isAwake(linked) && readdirSync(elsewhere).length === 0, linkRefused);

        // A socket path past the system's limit is a start-up error, not a failure at every wake.
        if (process.platform !== 'win32') {
            let tooLong = '';
            try { createLibraryPool({ ...base, siteDir: join(scratch, 'd'.repeat(120)), separate: false }); } catch (e) { tooLong = e.message; }
            ok('a SITE_DIR too long for a socket path is refused when the pool is made', /SITE_DIR is too long/.test(tooLong), tooLong);
        }
        await release();
    }

    // -------------------------------------------------------------------------
    console.log('--- 4c. the operator removes, backs up and restores (cli.js) ---');
    {
        const siteDir = join(scratch, 'ops-site');
        const cli = (...a) => {
            const r = spawnSync(process.execPath, [join(repoRoot, 'server', 'site', 'cli.js'), ...a],
                { env: { ...process.env, SITE_DIR: siteDir }, encoding: 'utf8', windowsHide: true });
            return { code: r.status, out: `${r.stdout}${r.stderr}`.trim() };
        };
        const quiet = { log() {}, error() {}, warn() {} };
        let db = openSiteDb(siteDir);
        const pool = createLibraryPool({ db, siteDir, appRoot: repoRoot, env: { ...process.env, ...CLOSED_MODEL }, log: quiet, separate: false });
        held.push(() => pool.stopAll());
        const accounts = createAccounts(db, { createLibrary: () => pool.create(), env: { SITE_BREACH_CHECK: '0' } });
        const join1 = async (email) => (await accounts.acceptInvite(accounts.createInvite(email).token, 'correct horse battery staple', 'UA')).libraryId;
        const ann = await join1('ann@example.org');
        const ben = await join1('ben@example.org');
        await pool.wake(ann); await pool.wake(ben); // each first start makes its database
        await pool.stopAll();
        // A mark in each library's own database, as its content.
        const mark = (id, v) => { const l = new Database(join(pool.libDir(id), 'terramentor.db')); l.exec('CREATE TABLE IF NOT EXISTS gate_mark (v TEXT)'); l.prepare('DELETE FROM gate_mark').run(); l.prepare('INSERT INTO gate_mark VALUES (?)').run(v); l.close(); };
        const markOf = (id) => { try { const l = new Database(join(pool.libDir(id), 'terramentor.db'), { readonly: true }); const v = l.prepare('SELECT v FROM gate_mark').get()?.v; l.close(); return v; } catch { return null; } };
        mark(ann, 'ann-1'); mark(ben, 'ben-1');

        const night = join(scratch, 'ops-night');
        let r = cli('backup', night);
        ok('backup copies site.db and every library', r.code === 0 && existsSync(join(night, 'site.db'))
            && existsSync(join(night, 'libraries', ann, 'terramentor.db')) && existsSync(join(night, 'libraries', ben, 'terramentor.db')), r.out);
        r = cli('backup', join(scratch, 'ops-one'), '--library', ann);
        ok('backup --library copies that library alone, without site.db', r.code === 0 && existsSync(join(scratch, 'ops-one', 'libraries', ann, 'terramentor.db'))
            && !existsSync(join(scratch, 'ops-one', 'site.db')) && !existsSync(join(scratch, 'ops-one', 'libraries', ben)), r.out);
        mark(ben, 'ben-2');

        // Removed while running, with the front desk sweeping as it does every half minute.
        await pool.wake(ann);
        const removing = new Promise((res) => {
            const child = spawn(process.execPath, [join(repoRoot, 'server', 'site', 'cli.js'), 'remove', 'ann@example.org'],
                { env: { ...process.env, SITE_DIR: siteDir }, windowsHide: true });
            let out = '';
            child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
            child.on('exit', (code) => res({ code, out: out.trim() }));
        });
        let stoppedBySweep = false;
        const sweeping = setInterval(() => { pool.sweep().then(() => { if (!pool.isAwake(ann)) stoppedBySweep = true; }, () => {}); }, 500);
        r = await removing;
        clearInterval(sweeping);
        ok('remove deletes the account, its library row and folder', r.code === 0 && r.out.includes(ann)
            && !db.prepare('SELECT 1 FROM accounts WHERE email = ?').get('ann@example.org') && !db.prepare('SELECT 1 FROM libraries WHERE id = ?').get(ann)
            && !existsSync(pool.libDir(ann)), r.out);
        await pool.sweep();
        ok('the front desk\'s sweep stops a removed library that was running', !pool.isAwake(ann), `stopped by a sweep during the remove: ${stoppedBySweep}`);
        await pool.stopAll();
        db.close();
        // A removed account is overwritten in site.db, not left in a free page the next backup copies.
        r = cli('backup', join(scratch, 'ops-after'));
        ok('a backup made after a remove holds no trace of the removed address', r.code === 0
            && !readFileSync(join(scratch, 'ops-after', 'site.db')).includes(Buffer.from('ann@example.org')), r.out);
        // One library that cannot be backed up (here an unfinished restore) does not cost the others theirs.
        const marker = join(pool.libDir(ben), 'terramentor.db.restore-incomplete');
        writeFileSync(marker, 'x');
        r = cli('backup', join(scratch, 'ops-partial'));
        ok('a library that cannot be backed up leaves the rest written, and exits 3', r.code === 3 && /PARTIAL/.test(r.out)
            && existsSync(join(scratch, 'ops-partial', 'site.db')) && !existsSync(join(scratch, 'ops-partial', 'libraries', ben)), r.out);
        rmSync(marker);
        // A library's folder is its own to fill: a link it leaves there is never followed.
        const outside = join(scratch, 'ops-outside');
        mkdirSync(outside);
        writeFileSync(join(outside, 'other-library.txt'), 'not ben\'s');
        const benVault = join(pool.libDir(ben), 'vault');
        if (existsSync(benVault)) renameSync(benVault, `${benVault}.kept`);
        symlinkSync(outside, benVault, 'junction');
        r = cli('backup', join(scratch, 'ops-linked'));
        ok('a library whose vault is a link is not backed up through it', r.code === 3 && /is a link/.test(r.out)
            && !existsSync(join(scratch, 'ops-linked', 'libraries', ben)), r.out);
        if (process.platform === 'win32') rmdirSync(benVault); else unlinkSync(benVault);
        if (existsSync(`${benVault}.kept`)) renameSync(`${benVault}.kept`, benVault);
        const decoy = join(outside, 'decoy');
        writeFileSync(decoy, 'untouched');
        const planted = ['terramentor.db.restoring', 'terramentor.secrets.json.restoring', 'terramentor.db.restore-incomplete'].map((n) => join(pool.libDir(ben), n));
        let linksMade = true;
        for (const p of planted) { try { symlinkSync(decoy, p, 'file'); } catch (e) { if (process.platform === 'win32' && e.code === 'EPERM') linksMade = false; else throw e; } }

        // The erasure ledger, as hosted/copy.sh keeps it: SHA-256 of "site:<id>", then times.
        const ledger = join(scratch, 'ops-erasures');
        writeFileSync(ledger, `${crypto.createHash('sha256').update(`site:${ann}`).digest('hex')} 20261126T000000Z 20261210T000000Z\n`);
        r = cli('restore', night, '--erased', ledger);
        if (linksMade) {
            const still = planted.filter((p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } });
            ok('a restore writes nothing through links left at its fixed names in the library', readFileSync(decoy, 'utf8') === 'untouched',
                `decoy now: ${JSON.stringify(readFileSync(decoy, 'utf8').slice(0, 40))}; links left: ${still.map((p) => p.split(/[\\/]/).pop()).join(' ')}; ${r.out}`);
        } else console.log('  skip a restore through planted links: this Windows account may not make file links');
        db = openSiteDb(siteDir);
        ok('a restore of a backup older than an erasure leaves the erased library out: no account, no row, no folder',
            r.code === 0 && /1 library left out/.test(r.out) && !db.prepare('SELECT 1 FROM accounts WHERE email = ?').get('ann@example.org')
            && !db.prepare('SELECT 1 FROM libraries WHERE id = ?').get(ann) && !existsSync(pool.libDir(ann)), r.out);
        ok('…and puts every other library back as it was that night', markOf(ben) === 'ben-1' && !!db.prepare('SELECT 1 FROM accounts WHERE email = ?').get('ben@example.org'));
        const nightSessions = (() => { const n = new Database(join(night, 'site.db'), { readonly: true }); const c = n.prepare('SELECT COUNT(*) AS c FROM sessions').get().c; n.close(); return c; })();
        ok('…and brings back none of that night\'s sessions', nightSessions > 0 && db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c === 0, `sessions in the backup: ${nightSessions}`);
        db.close();
        // The control: the same backup without the ledger brings that library back, so the ledger is what kept it out.
        r = cli('restore', night);
        db = openSiteDb(siteDir);
        ok('the same restore with no ledger brings it back (the ledger is what left it out)', r.code === 0 && markOf(ann) === 'ann-1'
            && !!db.prepare('SELECT 1 FROM accounts WHERE email = ?').get('ann@example.org'), r.out);
        db.close();
        // Folders, not links, at the same fixed names: still the library's own to clear, never a restore stopped partway.
        for (const p of planted) { rmSync(p, { recursive: true, force: true }); mkdirSync(join(p, 'inside'), { recursive: true }); }
        mark(ben, 'ben-2');
        r = cli('restore', night);
        ok('a restore clears folders left at its fixed names in the library and puts it back', r.code === 0 && markOf(ben) === 'ben-1'
            && !existsSync(planted[0]) && !existsSync(planted[2]), `exit ${r.code}; left: ${planted.filter((p) => existsSync(p)).map((p) => p.split(/[\\/]/).pop()).join(' ')}; ${r.out}`);
        for (const p of planted) rmSync(p, { recursive: true, force: true });
        // A forged site.db (whoever can write where backups are kept) naming a folder outside libraries/.
        const forged = join(scratch, 'ops-forged');
        cpSync(night, forged, { recursive: true });
        { const f = new Database(join(forged, 'site.db')); f.pragma('foreign_keys = OFF'); f.prepare('UPDATE libraries SET id = ? WHERE id = ?').run('..', ben); f.close(); }
        mark(ben, 'ben-3');
        r = cli('restore', forged);
        ok('a backup whose site.db names a library id that is no id is refused and the site is untouched', r.code === 1 && /untouched/.test(r.out) && markOf(ben) === 'ben-3', r.out);
        // A forged site.db handing one user to two libraries (one could read the other's).
        const twoUsers = join(scratch, 'ops-two-users');
        cpSync(night, twoUsers, { recursive: true });
        {
            // Rebuilt without its UNIQUE: a forger writes whatever schema they like.
            const f = new Database(join(twoUsers, 'site.db'));
            f.pragma('foreign_keys = OFF');
            f.exec('CREATE TABLE l2 AS SELECT * FROM libraries; DROP TABLE libraries; ALTER TABLE l2 RENAME TO libraries; UPDATE libraries SET uid = 4242;');
            f.close();
        }
        r = cli('restore', twoUsers);
        ok('a backup whose site.db gives one user to two libraries is refused and the site is untouched', r.code === 1 && /two libraries/.test(r.out) && markOf(ben) === 'ben-3', r.out);
        // A ledger line naming a library the site still has was not written by its removal.
        const wrongLedger = join(scratch, 'ops-erasures-wrong');
        writeFileSync(wrongLedger, `${crypto.createHash('sha256').update(`site:${ben}`).digest('hex')} 20261126T000000Z 20261210T000000Z\n`);
        r = cli('restore', night, '--erased', wrongLedger);
        ok('a ledger that names a library the site still has is refused, and that library is untouched', r.code === 1 && /still has/.test(r.out)
            && markOf(ben) === 'ben-3' && existsSync(pool.libDir(ben)), r.out);
        // A backup whose library is a link (to another library's folder) is not followed.
        const linkedBackup = join(scratch, 'ops-linked-backup');
        cpSync(night, linkedBackup, { recursive: true });
        rmSync(join(linkedBackup, 'libraries', ben), { recursive: true });
        symlinkSync(pool.libDir(ann), join(linkedBackup, 'libraries', ben), 'junction');
        r = cli('restore', linkedBackup);
        ok('a backup whose library folder is a link is refused and the site is untouched', r.code === 1 && /not a folder/.test(r.out)
            && markOf(ben) === 'ben-3' && markOf(ann) === 'ann-1', r.out);
        if (process.platform === 'win32') rmdirSync(join(linkedBackup, 'libraries', ben)); else unlinkSync(join(linkedBackup, 'libraries', ben));
        rmSync(join(night, 'libraries', ben), { recursive: true });
        r = cli('restore', night);
        ok('a library its night could not back up keeps its account and its folder as it is', r.code === 0 && /not backed up that night/.test(r.out)
            && markOf(ben) === 'ben-3' && markOf(ann) === 'ann-1', r.out);
        await release();
    }

    // -------------------------------------------------------------------------
    console.log('--- 5. the solo app is unchanged ---');
    {
        const dir = join(scratch, 'solo');
        const free = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
        const env = { ...process.env, ...CLOSED_MODEL, DATA_DIR: dir, VAULT_ROOT: join(dir, 'vault'), PORT: String(free), HOST: '127.0.0.1' };
        for (const k of Object.keys(env)) if (/^(TERRAMENTOR_|SITE_|DB_PATH)/.test(k)) delete env[k];
        const child = spawn(process.execPath, [join(repoRoot, 'server', 'index.js')], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        // Listened for at once: an exit while starting is not replayed to a later listener.
        let exitedEarly = false;
        const exited = new Promise((r) => child.once('exit', () => { exitedEarly = true; r(); }));
        held.push(() => { child.kill(); return exited; });
        let log = '';
        child.stdout.on('data', (c) => { log += c; });
        child.stderr.on('data', (c) => { log += c; });
        let body = null;
        for (let i = 0; i < 300 && !body && !exitedEarly; i++) {
            await new Promise((r) => setTimeout(r, 100));
            try {
                body = await new Promise((res, rej) => http.get(`http://127.0.0.1:${free}/api/auth/status`, (r) => {
                    let t = ''; r.setEncoding('utf8'); r.on('data', (c) => { t += c; }); r.on('end', () => { try { res(JSON.parse(t)); } catch (e) { rej(e); } });
                }).on('error', rej));
            } catch { /* starting */ }
        }
        ok('the solo app answers its status with no site in it', !!body && !('site' in body), body ? JSON.stringify(body) : `no answer${exitedEarly ? `; it exited: ${log.trim().split('\n').pop()}` : ''}`);
        ok('and starts its own start-up work as before', !log.includes('[site]'));
        await release();
    }
} finally {
    await release();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

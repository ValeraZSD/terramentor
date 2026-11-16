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
 *   5. The solo app is unchanged: no `site` in its status, no site line in its log.
 *
 * Nothing here reaches a model: the model address is a closed port.
 *
 *   node tools/site-gates.mjs
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

const { hashPassword, verifyPassword, needsRehash, passwordShapeProblem, isBreached, MIN_LENGTH } = await import('../server/site/passwords.js');
const { makeNote, readNote, NOTE_HEADER } = await import('../server/siteLibrary.js');
const { openSiteDb } = await import('../server/site/siteDb.js');
const { createAccounts, networkOf, deviceLabel, WRONG, PASSWORD_OFF_AFTER } = await import('../server/site/accounts.js');
const { createFrontDesk, COOKIE, CLEAR_SITE_DATA } = await import('../server/site/frontDesk.js');
const { siteStartProblem } = await import('../server/site/index.js');
const { createLibraryPool } = await import('../server/site/libraries.js');

const scratch = mkdtempSync(join(tmpdir(), 'site-gates-'));
const CLOSED_MODEL = { AI_PROVIDER: 'openai', AI_BASE_URL: 'http://127.0.0.1:9/v1', AI_MODEL: 'none', SITE_BREACH_CHECK: '0' };

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
        const note = makeNote({ key, libraryId: 'liba', accountId: 7, sessionId: 9 });
        ok('a fresh note names its account and session', JSON.stringify(readNote(note, { key, libraryId: 'liba' })) === '{"accountId":7,"sessionId":9}');
        ok('another library refuses it', readNote(note, { key, libraryId: 'libb' }) === null);
        ok('another key refuses it', readNote(note, { key: other, libraryId: 'liba' }) === null);
        ok('it expires after 30 s', readNote(note, { key, libraryId: 'liba', now: Date.now() + 31_000 }) === null);
        const forged = note.replace('.7.', '.8.');
        ok('changing the account breaks it', readNote(forged, { key, libraryId: 'liba' }) === null);
        const far = makeNote({ key, libraryId: 'liba', accountId: 7, sessionId: 9, ttlMs: 3600_000 });
        ok('a note claiming a long life is refused', readNote(far, { key, libraryId: 'liba' }) === null);
        ok('garbage is refused', readNote('v1.a.b', { key, libraryId: 'liba' }) === null && readNote(undefined, { key, libraryId: 'liba' }) === null);
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
        const t0 = performance.now(); const wrong = await accounts.signIn('ann@example.org', 'not the password at all', { ip }); const tWrong = performance.now() - t0;
        const t1 = performance.now(); const unknown = await accounts.signIn('nobody@example.org', 'not the password at all', { ip }); const tUnknown = performance.now() - t1;
        ok('a wrong password and an unknown address get the same answer', wrong.wrong === true && unknown.wrong === true && Object.keys(wrong).join() === Object.keys(unknown).join());
        ok('and cost the same work (one argon2 each)', tUnknown > tWrong / 3 && tUnknown < tWrong * 3, `${tWrong.toFixed(0)} vs ${tUnknown.toFixed(0)} ms`);
        const signed = await accounts.signIn('ANN@example.org ', good, { ip, ua: 'Mozilla/5.0 (Macintosh; Mac OS X) Firefox/140.0' });
        ok('the right password signs in, address case and spaces aside', signed.ok === true && signed.accountId === made1.accountId);

        // Throttle, per address: five free tries, then growing waits.
        for (let i = 0; i < 5; i++) await accounts.signIn('carl@example.org', 'wrong wrong wrong', { ip: `198.51.100.${i}` });
        const sixth = await accounts.signIn('carl@example.org', 'wrong wrong wrong', { ip: '198.51.100.77' });
        ok('after five wrong tries for an address the next one waits, from any network', sixth.wait > 0, JSON.stringify(sixth));
        const stamp = db.prepare("SELECT last_fail_at FROM throttle WHERE key = 'acct:carl@example.org'").get().last_fail_at;
        ok('the wait is not a lock: it ends', accounts.throttleState('carl@example.org', '198.51.100.1', stamp + 3000).wait === 0);
        // Per network: an IPv6 /64 is one network.
        ok('an IPv6 address counts by its /64', networkOf('2001:db8:aa:bb:1:2:3:4') === networkOf('2001:db8:aa:bb::ffff') && networkOf('2001:db8:aa:bc::1') !== networkOf('2001:db8:aa:bb::1'));
        for (let i = 0; i < 20; i++) await accounts.signIn(`spray${i}@example.org`, 'wrong wrong wrong', { ip: `2001:db8:aa:bb::${i + 1}` });
        const sprayed = await accounts.signIn('fresh@example.org', 'wrong wrong wrong', { ip: '2001:db8:aa:bb::999' });
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
        putThrottle.run('net:198.18.0.0', Date.now() - day - 60e3);
        putThrottle.run('net:198.18.1.0', Date.now() - 60e3);
        putThrottle.run('acct:old@example.org', Date.now() - day - 60e3);
        accounts.sweepSessions();
        const keys = new Set(db.prepare('SELECT key FROM throttle').all().map((r) => r.key));
        ok('the sweep drops a network quiet for a day and keeps a recent one and every account',
            !keys.has('net:198.18.0.0') && keys.has('net:198.18.1.0') && keys.has('acct:old@example.org'), [...keys].join(' '));

        // No library, no account: the invite link is not spent.
        const broken = createAccounts(db, { env: CLOSED_MODEL, createLibrary: async () => { throw new Error('no room for a library'); } });
        const eve = broken.createInvite('eve@example.org');
        let noRoom = '';
        try { await broken.acceptInvite(eve.token, good, 'UA'); } catch (e) { noRoom = e.message; }
        ok('when no library can be made, no account is made and the invite stays good',
            /no room/.test(noRoom) && !!broken.inviteOf(eve.token) && !db.prepare('SELECT 1 FROM accounts WHERE email = ?').get('eve@example.org'), noRoom);
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

        // Stopping when idle: not while a request is open.
        desk.pool.streamOpened(libId);
        await desk.pool.sweep(Date.now() + 3600_000);
        ok('a library with an open stream is not stopped', desk.pool.isAwake(libId));
        desk.pool.streamClosed(libId);
        await desk.pool.sweep(Date.now() + 3600_000);
        ok('an idle one with no task is stopped', !desk.pool.isAwake(libId));
        await desk.close();
        db.close();
    }

    // -------------------------------------------------------------------------
    console.log('--- 4b. the library pool under pressure ---');
    {
        const siteDir = join(scratch, 'pool-site');
        const db = openSiteDb(siteDir);
        const quiet = { log() {}, error() {}, warn() {} };
        const base = { db, siteDir, appRoot: repoRoot, env: { ...process.env, ...CLOSED_MODEL }, log: quiet };
        const pool = createLibraryPool({ ...base, separate: false, maxAwake: 1 });
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
        db.close();
    }

    // -------------------------------------------------------------------------
    console.log('--- 5. the solo app is unchanged ---');
    {
        const dir = join(scratch, 'solo');
        const free = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
        const env = { ...process.env, ...CLOSED_MODEL, DATA_DIR: dir, VAULT_ROOT: join(dir, 'vault'), PORT: String(free), HOST: '127.0.0.1' };
        for (const k of Object.keys(env)) if (/^(TERRAMENTOR_|SITE_|DB_PATH)/.test(k)) delete env[k];
        const child = spawn(process.execPath, [join(repoRoot, 'server', 'index.js')], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let log = '';
        child.stdout.on('data', (c) => { log += c; });
        child.stderr.on('data', (c) => { log += c; });
        let body = null;
        for (let i = 0; i < 300 && !body; i++) {
            await new Promise((r) => setTimeout(r, 100));
            try {
                body = await new Promise((res, rej) => http.get(`http://127.0.0.1:${free}/api/auth/status`, (r) => {
                    let t = ''; r.setEncoding('utf8'); r.on('data', (c) => { t += c; }); r.on('end', () => { try { res(JSON.parse(t)); } catch (e) { rej(e); } });
                }).on('error', rej));
            } catch { /* starting */ }
        }
        ok('the solo app answers its status with no site in it', !!body && !('site' in body), JSON.stringify(body));
        ok('and starts its own start-up work as before', !log.includes('[site]'));
        child.kill();
        await new Promise((r) => child.once('exit', r));
    }
} finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

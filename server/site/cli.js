// The operator's tool for a site: `node server/site/cli.js <command>`, with
// SITE_DIR set as for the front desk.
//
//   invite <email> [--url https://name]   print a one-time link that makes an account
//   accounts                               list accounts (email, library, created)
//   sign-out <email>                       end every session of an account
//   unlock <email>                         forget its wrong guesses (after 100 the password is off)
import path from 'node:path';
import { openSiteDb } from './siteDb.js';
import { createAccounts, normalEmail } from './accounts.js';

const [command, ...args] = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const fail = (msg) => { console.error(msg); process.exit(1); };

if (!process.env.SITE_DIR) fail('SITE_DIR is not set.');
const db = openSiteDb(path.resolve(process.env.SITE_DIR));
// Accounts are made by the front desk when an invite is used, so the library
// maker is never called here.
const accounts = createAccounts(db, { createLibrary: () => { throw new Error('not here'); } });

if (command === 'invite') {
    const email = args.find((a) => !a.startsWith('--') && a !== flag('--url'));
    if (!email) fail('usage: invite <email> [--url https://name]');
    const base = String(flag('--url') || 'http://localhost:3001').replace(/\/+$/, '');
    try {
        const { token, email: e } = accounts.createInvite(email);
        console.log(`Invite for ${e}, good for 7 days and once:`);
        console.log(`${base}/site/invite/${token}`);
    } catch (e) { fail(e.message); }
} else if (command === 'accounts') {
    for (const a of accounts.listAccounts()) console.log(`${a.email}\t${a.library_id}\t${a.created_at}`);
} else if (command === 'sign-out') {
    const email = normalEmail(args[0]);
    const row = db.prepare('SELECT id FROM accounts WHERE email = ?').get(email);
    if (!row) fail(`no account ${email}`);
    console.log(`Ended ${accounts.endAllSessions(row.id)} session(s) of ${email}.`);
} else if (command === 'unlock') {
    if (!accounts.unlock(args[0] || '')) fail(`no account ${normalEmail(args[0] || '')}`);
    console.log(`Wrong guesses forgotten for ${normalEmail(args[0])}; the password works again.`);
} else {
    fail('commands: invite <email> [--url https://name] | accounts | sign-out <email> | unlock <email>');
}

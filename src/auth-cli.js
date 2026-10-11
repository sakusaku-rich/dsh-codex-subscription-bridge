#!/usr/bin/env node
import { AuthStore, authDirectory } from './auth.js';
import { failure } from './errors.js';
const controller = new AbortController();
process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
try {
  const command = process.argv[2];
  if (process.argv.length !== 3 || !['login', 'status', 'logout'].includes(command)) {
    console.error('Usage: dsh-codex-subscription-auth <login|status|logout>'); process.exitCode = 2;
  } else {
    const store = new AuthStore(authDirectory(process.env));
    if (command === 'login') {
      await store.login(({ url, code }) => { console.log(`Open ${url}\nEnter the one-time code: ${code}`); }, controller.signal);
      console.log('Subscription login saved.');
    } else if (command === 'logout') { await store.logout(controller.signal); console.log('Local subscription login removed. Server-side revocation is not performed.'); }
    else { await store.transaction(() => store.read(), controller.signal); console.log('A dedicated subscription login is stored. Status does not verify server-side validity.'); }
  }
} catch (error) { const safe = failure(error); console.error(`${safe.code}: ${safe.message}`); process.exitCode = 1; }

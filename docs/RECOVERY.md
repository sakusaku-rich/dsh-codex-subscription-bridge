# Local diagnosis and recovery

Use the same launcher HOME for auth commands and Harness, and the same launcher
DSH_HOME for Desktop. For a generated isolated
profile, always use its `auth.sh`; a bare command in another shell may inspect a
different store. Diagnose with:

```sh
sh artifacts/subscription-web/auth.sh doctor
```

The result contains only fixed local state/action labels, never credentials,
account identifiers, raw responses or a claim of server-side validity. It does
not refresh tokens, create a missing store, or acquire/remove a lock. Diagnosis
is an advisory snapshot: another process can change the state immediately
afterward. Repeat diagnosis after stopping store users before recovery.

| Result | Meaning / action |
| --- | --- |
| `store: missing`, `auth: missing` | Run the explicit login command in this profile |
| `auth: stored` | A structurally valid local grant exists; server validity is unverified |
| `auth: refresh_due` / `expired` | Normal use may attempt refresh; doctor itself does not |
| `auth: relogin_required` | Grant is quarantined, invalid, or refresh outcome is uncertain; log in again |
| `store/auth/lock: invalid` | Check private ownership/type/permissions; do not paste or edit token contents |
| `lock: present_owner_unknown` | A live process or crashed process may own it; never delete based on this label alone |

## Lock recovery

A login can legitimately hold the lock while waiting for browser approval. Close
or cancel that command normally. If an owner crashed, all auth commands may return
AUTH_BUSY after 30 seconds. No PID/lease proof or automatic lock takeover exists.

Only after stopping **all** CLI/Web/auth processes using this store and confirming
none remain, review the exact profile path. For the isolated guide's profile:

```sh
rmdir artifacts/subscription-web/home/.dsh-codex-subscription-bridge/auth.lock
sh artifacts/subscription-web/auth.sh doctor
```

`rmdir` removes an empty lock directory only; it refuses unexpected contents.
Do not use recursive/force removal, remove a lock while a process is alive, or
perform this on a store whose users you cannot identify. Resolve ownership
before continuing. Then run the explicit login command if requested.

## Uncertain refresh or insecure storage

An uncertain refresh is intentionally not retried with the old grant. A fresh
login clears that state under the store lock. Do not clear refresh_pending or
restore an older auth.json manually: that can replay a consumed refresh token.

Expected modes are 0700 for the dedicated directory and 0600 for auth.json, owned
by your OS user and containing regular files rather than symlinks/special files.
Do not apply recursive chmod/chown or change someone else's store. Inspect the
path and use a fresh isolated profile if you cannot establish safe ownership.
File permissions are not encryption or protection against other same-user code.

## Runtime, protocol, or quota failures

NODE_VERSION_UNSUPPORTED requires Node 22 >=22.23.3 or the tested Desktop
Electron 44.0.0 / Node 24.18.1 pair. PLATFORM_UNSUPPORTED means macOS is required.
Other Desktop versions require fresh compatibility verification; do not bypass
the guard or edit a Desktop-bundled runtime. See [Desktop verification](DESKTOP.md).

Protocol diagnostics contain fixed stage labels such as SSE_FRAME or SSE_TERMINAL.
Share only the label, reviewed commit, runtime and sanitized reproduction steps;
never include tokens, one-time codes, bootstrap URLs, auth.json or raw logs/bodies.
RATE_LIMITED can mean rate/usage limits. Repeated re-login does not establish or
increase allowance; no quota interpretation/automatic retry policy is implemented.

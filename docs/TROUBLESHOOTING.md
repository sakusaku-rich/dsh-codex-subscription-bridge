# Local diagnosis and recovery

## Run the doctor

Use the same launcher HOME for auth commands and Harness. Use the same launcher DSH_HOME for Desktop. For a generated isolated Web profile, always use its `auth.sh`; a bare command in another shell may inspect a different store.

Diagnose with:

```sh
sh artifacts/subscription-web/auth.sh doctor
```

## Desktop profiles

A Desktop profile has no such helper, because the plugin imports host peers that only the application resolves.

The settings panel shows one thing only: the local login state (`stored`, `expired`/`refresh_due`, `relogin_required`, `missing`). The `store`, `lock` and `action` fields the doctor reports have no Desktop equivalent. A repeated "Local authentication has not been checked or is busy." reading means the store could not be verified.

The panel offers no store diagnosis. Recover a suspect Desktop store by quitting Harness and preparing a new profile directory instead of editing it. The credentials live under the profile's `harness` directory, as described in [the Desktop guide](DESKTOP_VERIFICATION.md).

## Read the result

The result contains only fixed local state/action labels. It never contains credentials, account identifiers, raw responses, or a claim of server-side validity. It does not refresh tokens, create a missing store, or acquire/remove a lock.

Diagnosis is an advisory snapshot: another process can change the state immediately afterward. Repeat diagnosis after stopping store users before recovery.

| Result | Meaning / action |
| --- | --- |
| `store: missing`, `auth: missing` | Run `sh artifacts/subscription-web/auth.sh login`; on Desktop use **Settings → ChatGPT subscription → Log in** |
| `auth: stored` | A structurally valid local grant exists; server validity is unverified |
| `auth: refresh_due` / `expired` | Normal use may attempt refresh; doctor itself does not |
| `auth: relogin_required` | Grant is quarantined, invalid, or refresh outcome is uncertain; log in again |
| `store/auth/lock: invalid` | Check private ownership/type/permissions; do not paste or edit token contents |
| `lock: present_owner_unknown` | A live process or crashed process may own it; never delete based on this label alone |

## Lock recovery

A login can legitimately hold the lock while waiting for browser approval. Close or cancel that command normally.

In the settings panel, cancel a pending login before discarding its tab. The tab that started it owns the one-time code. Other tabs see only that a login is active.

If an owner crashed, `login`, `status` and `logout` may each return `AUTH_BUSY` after 30 seconds. `doctor` never takes the lock, so it still reports `lock: present_owner_unknown`. No PID/lease proof exists, and there is no automatic lock takeover.

Only after stopping **all** CLI/Web/auth processes using this store and confirming none remain, review the exact profile path. For the isolated guide's profile:

```sh
rmdir artifacts/subscription-web/home/.dsh-codex-subscription-bridge/auth.lock
sh artifacts/subscription-web/auth.sh doctor
```

`rmdir` removes an empty lock directory only. It refuses unexpected contents.

- Do not use recursive or force removal.
- Do not remove a lock while a process is alive.
- Do not perform this on a store whose users you cannot identify.

Resolve ownership before continuing.

If the next `doctor` reports `store: missing`, log in again: `sh artifacts/subscription-web/auth.sh login`, or **Log in** in the settings panel on Desktop.

## Uncertain refresh or insecure storage

An uncertain refresh is intentionally not retried with the old grant. A fresh login clears that state under the store lock.

Do not clear `refresh_pending` or restore an older `auth.json` manually. That can replay a consumed refresh token.

Expected storage:

- Mode `0700` for the dedicated directory.
- Mode `0600` for `auth.json`.
- Both owned by your OS user.
- Regular files, not symlinks or special files.

Do not apply recursive chmod/chown. Do not change someone else's store. Inspect the path and use a fresh isolated profile if you cannot establish safe ownership. File permissions are not encryption, and they do not protect against other same-user code.

## Runtime, protocol, or quota failures

`NODE_VERSION_UNSUPPORTED` requires Node 22 >=22.23.3, or the tested Desktop Electron 44.7.0 / Node 24.21.0 pair. `PLATFORM_UNSUPPORTED` means macOS is required. [Desktop verification](DESKTOP_VERIFICATION.md) records which other versions are admitted.

Protocol diagnostics contain fixed stage labels such as `SSE_FRAME` or `SSE_TERMINAL`. When reporting, share only the label, the reviewed commit, the runtime, and sanitized reproduction steps, as [the security requirements](../SECURITY.md#reporting-a-problem) require.

A terminal `QUOTA` means the ChatGPT plan usage limit was reached. It may carry a "Try again in about N minutes." hint. Transient `RATE_LIMIT` covers all other rate-limit responses. Repeated re-login does not establish or increase allowance. No quota interpretation or automatic retry policy is implemented beyond surfacing that fixed message.

`PROTOCOL_INVALID` with `SSE_EVENT_UNSUPPORTED` appeared in releases up to v0.0.3. It meant the stream carried an event the bridge did not recognize. The turn was failed for a content-free notification rather than for corrupt content, so an answer that had already streamed was discarded.

That label no longer exists. Events the bridge does not consume are now ignored. Every event it does consume is still validated strictly. Seeing this label means the installed build predates the fix, so update the profile rather than re-logging in — it is not a credential or quota problem. Do not paste raw stream bodies.

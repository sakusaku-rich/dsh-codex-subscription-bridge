# Authentication inside Harness

In Desktop or standalone Web, open **Settings → ChatGPT subscription**.
Click **Log in** to start a dedicated device login. The page displays a temporary
**one-time sign-in code** and a fixed `https://auth.openai.com/codex/device` link.
Enter the code on that page and approve it in your browser. Harness polls for
completion and updates the panel, then refreshes model observers.

The displayed code is not an access token. Access and refresh tokens stay in
the private backend store and never enter client state, responses or browser
storage. The code itself is still sensitive: do not share it or put it in logs.
It disappears after cancellation, completion or failure.

**Cancel login** stops the pending operation and joins cleanup. Cancelling does
not remove a previously stored login. **Refresh status** reads only local state;
it does not refresh tokens or verify server-side access. **Log out** removes
only this plugin's local grant after confirmation; it does not revoke provider
sessions. These controls reuse the dedicated store and its serialization rules.

The initiating tab alone receives its code. A random tab identifier may be kept
in sessionStorage to recover ownership after reload; no device code or tokens
are stored there. Other tabs see only that a login is active. Close or cancel a
pending login before discarding its tab; otherwise its bounded 15-minute wait
can continue until timeout. Filesystem locks are never automatically stolen.

The Host contributes four exact POST endpoints to Connection's existing
trusted/authenticated API carrier. Web retains the Host/Origin/browser-session
fence; Desktop uses its trusted IPC carrier. The sole Typert Gateway interceptor
is preserved. Envelopes and arguments are validated, body parsing is limited to
4 KiB, each request has a five-second signal deadline, and responses use
Cache-Control: no-store. Request admission is bounded to four and account
mutations are serialized. Shutdown aborts the login and waits for owned work.
Unknown errors become fixed diagnostics rather than raw bodies or credentials.

The settings component uses the host React and settings slot contract, fixed
link destinations, escaped text, and an allowlist of diagnostic codes. The panel
is styled after the OpenAI interface language (near-monochrome palette, pill
actions, monospace code display) with automatic light and dark palettes scoped
to the section. It does not automatically start login on load and offers account
actions only on the local/owned-host surface with secure browser randomness.

Synthetic tests cover ownership, redaction, cancellation, logout, disposal,
malformed/oversized requests, unauthorized Web requests and cross-Origin refusal,
existing Gateway coexistence, and the installed Desktop Fetch/IPC seam. Browser
checks used synthetic device codes and grants only. Real OAuth and model requests
remain separately authorized, owner-operated verification.

The CLI remains available as an optional developer/recovery tool. Preparing an
experimental dedicated Desktop profile still needs the source-checkout launcher;
authentication itself is performed inside Harness after it starts.

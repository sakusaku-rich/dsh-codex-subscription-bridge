# Authentication inside Harness

In Desktop or standalone Web, open **Settings → ChatGPT subscription**. Click **Log in** to start a dedicated device login. The page displays a temporary **one-time sign-in code** that you can click to copy, and a fixed `https://auth.openai.com/codex/device` link. Paste or enter the code on that page and approve it in your browser. Harness polls for completion and updates the panel, then refreshes model observers.

The displayed code is not an access token. Access and refresh tokens stay in the private backend store and never enter client state, responses or browser storage. The code itself is still sensitive: do not share it or put it in logs. It disappears after cancellation, completion or failure.

**Cancel login** stops the pending operation and joins cleanup. Cancelling does not remove a previously stored login. **Refresh status** reads only local state; it does not refresh tokens or verify server-side access. **Log out** removes only this plugin's local grant after confirmation; it does not revoke provider sessions. These controls reuse the dedicated store and its serialization rules.

The initiating tab alone receives its code. A random tab identifier may be kept in sessionStorage to recover ownership after reload; no device code or tokens are stored there. Other tabs see only that a login is active. Close or cancel a pending login before discarding its tab; otherwise its bounded 15-minute wait can continue until timeout. Filesystem locks are never automatically stolen.

Panel requests run only through the Host's authenticated API carrier, with the existing browser-session fence on Web and the trusted IPC carrier on Desktop; requests are bounded and serialized, and unknown errors become fixed diagnostics rather than raw bodies or credentials. The transport bounds themselves are recorded in [the design and limits](DIRECT.md).

The panel is styled after the OpenAI interface language (near-monochrome palette, pill actions, monospace code display) with automatic light and dark palettes scoped to the section. It does not automatically start login on load and offers account actions only on the local/owned-host surface.

Synthetic coverage of the panel, including ownership, redaction, cancellation and malformed requests, is recorded in [verification](VERIFICATION.md#in-app-device-login-ui-2026-10-12). Real OAuth and model requests remain separately authorized, owner-operated verification.

The CLI remains available as an optional developer/recovery tool. Preparing an experimental dedicated Desktop profile still needs the source-checkout launcher; authentication itself is performed inside Harness after it starts.

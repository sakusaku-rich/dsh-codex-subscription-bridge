# Authentication panel design

The panel is the settings card the bundled client registers as `settings.section`; it is the supported way to sign in, read status and log out on every surface. Its audience is a contributor changing that card.

## Surface and gating

The card performs account actions only on a loopback Connection that supplies a client id. Anywhere else it renders one line, "Open this settings page locally in a browser with secure randomness support.", and no controls. It never starts a login on load: opening the section reads status and nothing else.

## Layout

- Title "ChatGPT subscription" and the subtitle "Connect using a dedicated ChatGPT device login. Existing logins are not imported."
- A status block (`role="status"`, `aria-live="polite"`) with a row per fact: the local store state, the login phase, a "A login is running in another window. Wait for it to finish." row while another tab owns the login, and the note "Local status does not verify server-side access or subscription allowance."
- An alert row (`role="alert"`) while a call fails or the phase is `failed`.
- While this tab owns a waiting login, a code block: the label "One-time sign-in code", the code itself as a large monospace button that copies on click, the hint "Click the code to copy it, then enter it on the OpenAI sign-in page. It is not an access token. Keep it private; this page updates after approval.", the copy result ("Copied to the clipboard." or "Copy failed. Select the code and copy it manually.", cleared after 2.5 seconds), and a link to the sign-in page that opens in a new tab with `noopener noreferrer`.
- Actions: **Log in** (or **Log in again** once a login is stored), **Refresh status**, **Cancel login** while this tab owns an active login, and **Log out**.
- The footer note "Credentials stay on this computer in the backend. The settings page never receives access or refresh tokens."

## States

| Login phase | Label | Dot |
| --- | --- | --- |
| `idle` | No device login is running. | idle |
| `starting` | Starting device login… | busy |
| `waiting` | Approve the device code in your browser. | busy |
| `cancelling` | Cancelling login… | busy |
| `signed_in` | Device login completed. | ok |
| `cancelled` | Login cancelled. | idle |
| `failed` | Login failed. Refresh status or try again. | bad |

| Local store | Text | Dot |
| --- | --- | --- |
| `stored` | A local subscription login is stored. | ok |
| `expired`, `refresh_due` | The stored login may refresh during normal use. | busy |
| `relogin_required` | Log in again to recover the local authentication state. | bad |
| `missing` | No local subscription login is stored. | idle |
| anything else | Local authentication has not been checked or is busy. | idle |

Until the first status reply arrives the phase row reads "Checking authentication…" with a busy dot.

## Behaviour

- Every action is one Connection RPC with a ten-second deadline, and a new call supersedes the previous one.
- While a login is active the panel polls status once a second and stops when it unmounts.
- Cancel switches the local phase to `cancelling` and drops the code immediately, then reports what the backend returns.
- **Log in** is disabled while any login is active, **Log out** while a login is active or no login is stored, and **Log out** asks `window.confirm('Remove this plugin's local login? Server-side authorization is not revoked.')` first.
- A failure renders a fixed message. A recognized code is appended as `The operation could not complete (CODE). Refresh status or try again.`; an unrecognized one gets the generic sentence. Upstream text, tokens and device codes never reach the alert.

## Presentation

Near-monochrome surfaces, pill actions and a restrained green accent follow the OpenAI interface language, with automatic light and dark palettes from `prefers-color-scheme`, a 16-pixel card radius, a 560-pixel maximum width, and monospace code display. Every class is prefixed `dshcsb` so the card cannot collide with host styles.

Non-goals: showing tokens, starting a login automatically, claiming server-side validity or allowance, and quota display.

Synthetic coverage of the panel — ownership, redaction, cancellation and malformed requests — is recorded in [the verification record](VERIFICATION.md#covered-controls).

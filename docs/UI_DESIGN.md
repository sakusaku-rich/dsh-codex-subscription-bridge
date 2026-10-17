# Authentication panel design

The panel is styled after the OpenAI interface language (near-monochrome palette, pill actions, monospace code display) with automatic light and dark palettes scoped to the section. It does not automatically start login on load and offers account actions only on the local/owned-host surface.

The sign-in steps are recorded in [the README](../README.md) and [the installation guide](INSTALL.md); panel behavior and transport guarantees are recorded in [the direct connection architecture](ARCHITECTURE.md). Synthetic coverage of the panel, including ownership, redaction, cancellation and malformed requests, is recorded in [verification](VERIFICATION.md#covered-controls). Real sign-in and model requests were verified by the owner on a dedicated account; the record is in [verification](VERIFICATION.md#real-account-evidence-and-limits).

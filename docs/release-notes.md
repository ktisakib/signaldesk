SignalDesk 0.1.7 adds account license keys with expiry, broadcaster installation limits and multiple channel ownership per client account.

Administrators can issue, renew, revoke and rotate licenses, release device slots, and manage named TV channels. Broadcasters activate their desktop installation in the client portal and import its private profile. Multiple channels on one installation share a device slot. The relay rejects missing/expired/revoked activations and disconnects unauthorized running licensed publishers.

Existing unlicensed channels retain their current profiles. Upgrade to this release before enabling a license on an account. Stop broadcasting before installing an update. Signed updates are offered in the desktop application; the single Windows installer includes the offline media runtime and WebView2.

Installation identity is a software credential, not hardware attestation. Keep private profiles and the installation data directory private. The Windows executable is unsigned by Authenticode.

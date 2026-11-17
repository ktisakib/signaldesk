# Account licenses and broadcaster devices

A client account can own multiple TV channels. One account license defines its expiry, maximum registered broadcaster installations, and maximum assigned channels. For example, two devices and five channels means up to two installations can activate profiles for any of that account's five assigned channels. Multiple profiles on one installation share one device slot.

## Administrator workflow

1. Sign in at https://tv.pressmos.com/account/ and create the client account in People & permissions.
2. Open Licenses & devices, select that client, set the expiry in your browser's local time, and set device/channel allowances. Generate the license key and download the private key file. Full keys are returned once; only a hash and identifying prefix are stored in PostgreSQL.
3. Use Relay & channel configuration to create the TV channels. Assign each channel to the client using Channel owner controls. The API checks the allowance under a database lock, so simultaneous assignments cannot exceed it.
4. Give the client their account login and license file privately. Support and CRM accounts cannot issue, rotate or change licenses.
5. Save license renews expiry or changes allowances without changing the key. Revoked status stops authorization. Lowering allowances below current assignments/active device registrations is rejected; reassign channels or release installations first.
6. Release device revokes that activation and frees a slot. Replace key rotates the license key and removes all device activations. Old keys/profiles no longer authorize publishing; clients must activate again.

Existing subscriptions remain available for accounts without licenses. Once an account has a license, its license is authoritative for client editing, channel ownership allowance and activation. A subscription cannot override an expired or revoked license. Legacy unlicensed channels retain their old publishing behavior until an administrator issues a license or assigns them to a licensed account.

## Broadcaster activation

Use SignalDesk 0.1.7 or newer. In the desktop relay panel, copy This broadcaster installation ID. Sign in to your client account portal, then enter the license key, installation ID, device name and assigned channel. Activate & download profile produces a private connection file. Import it into that same desktop installation, then enable relay output.

The profile retains the stable channel ID for routing, even when its public TV name changes. Activate/download again for other channels on the same installation without consuming another slot. Each engine still runs one local playout program; separate programs need separate engine instances or computers. The account can own their channels together.

The desktop rejects licensed profiles bound to a different installation. Keep its installation-id file with the broadcaster data directory across reinstalls. Losing that data creates a new identity and requires releasing the previous slot. Installation identity and private profiles are software credentials, not TPM/hardware attestation; deliberately copying both the complete installation identity and private credentials can clone an installation. Use OS-bound keys if physical anti-cloning becomes necessary.

## Relay enforcement

Licensed channel policies set licenseRequired=true. Their encrypted SRT publishing proof must include the opaque device token from the activated profile. The private account-service check verifies the current channel owner, non-banned account, active/unexpired license and non-revoked device. It uses one PostgreSQL query and stores no raw license keys or raw device tokens.

The relay monitors active licensed publishers on its existing nominal five-second cycle. Expiry, revocation, reassignment and key rotation cause the publisher to be disconnected and reconnects to be rejected. Actual detection includes network/database latency and monitor workload; it is not a hard real-time deadline. Audience HLS sessions are not broadcaster device slots. The viewer/session and bitrate controls remain separate.

compose.accounts.yaml sets RELAY_LICENSE_URL to the internal account service. The private /private/publish route is never forwarded by Caddy; it additionally requires the relay admin bearer credential. Missing/unavailable licensing services fail closed for licensed channels. Unlicensed channels do not depend on this callback. Keep the database/account service online for licensed broadcasting.

Deploy the committed Drizzle migration before starting the new account image. Back up the PostgreSQL database, relay SQLite database, private environment and broadcaster installation data first. Upgrade broadcasters before enabling licensing on a running account: enabling enforcement disconnects publishers with old profiles. A server rollback can restore the previous images; do not drop license tables during rollback.

## Verification

The PostgreSQL integration suite tests expiry/renewal, rotation, device release, account separation, secret redaction, concurrent device activation caps and multiple channels per installation. The native MediaMTX smoke test verifies encrypted SRT/HLS, rejection without activation, and disconnection/reconnect rejection after revocation. Run it with MediaMTX and FFmpeg installed after cargo build -p broadcast-service --bin relay-server: python scripts/smoke-licensed-relay.py. It uses only disposable local media/state and reserves host ports 9790/9791 for its duration.

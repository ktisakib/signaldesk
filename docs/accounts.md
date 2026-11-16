# Accounts, roles and subscriptions

SignalDesk uses Better Auth 1.7 with its admin plugin, Drizzle ORM and PostgreSQL. Neon is supported through its standard PostgreSQL connection URL. Media, schedules, playout and existing stream IDs remain on their existing devices. A TV channel's display name can change without changing its stream URL or laptop connection key.

The account layer is optional until a database is connected. It never substitutes an in-memory database or exposes a registration route while unconfigured. Existing token-based relay administration remains available for bootstrap and recovery. Keep its token private; it retains full relay privileges.

## Connect Neon later

1. Obtain a PostgreSQL DATABASE_URL from your Neon project. Use a development branch first. Preserve the existing relay database and `.env.relay` credentials.
2. Set DATABASE_URL, BETTER_AUTH_SECRET (at least 32 random characters), and BETTER_AUTH_URL=https://tv.pressmos.com in the private environment. Keep the same secret across restarts. Never use a PUBLIC_ prefix for secrets.
3. Install dependencies with `npm ci`, then run `npm run db:migrate`. This applies the committed Drizzle migration. Do not use schema push against production.
4. Create the first administrator interactively: `npx auth create-admin --config server/auth.ts --email YOUR_EMAIL --name "Platform administrator" --role admin`. The CLI prompts for the password. Public signup is disabled; administrators create subsequent accounts.
5. Build the optional service: `docker compose --env-file .env.relay -f compose.relay.yaml -f compose.public.yaml -f compose.accounts.yaml build accounts`.
6. Set RELAY_ACCOUNTS_ENABLED=true in `.env.relay`. Run `scripts/deploy-relay.sh` after setting ACCOUNTS_IMAGE to your published image, or start the above Compose files with `up -d --no-build`. Open https://tv.pressmos.com/account/.

Run migration commands from an environment containing DATABASE_URL; the tools do not automatically load `.env.relay`. Avoid pasting secrets into shell history. For development, run `npm run accounts` alongside `npm run dev`; the frontend proxies the account API to localhost:9792. A missing configuration returns 503 rather than admitting users.

## Regenerate schemas

`npm run auth:generate` uses the official Better Auth CLI to generate `server/db/auth-schema.ts`, including admin and database rate-limit tables. Re-run after changing plugins. Then `npm run db:generate` uses Drizzle Kit to generate SQL and metadata in `drizzle/`. Review and commit these files. Apply using `npm run db:migrate` after a backup. Generation works before Neon is connected; migration requires PostgreSQL.

## Access model

| Role | Access |
| --- | --- |
| admin | Create accounts, assign roles, configure relay/channels and limits, assign channel ownership, manage subscriptions, grant/revoke support access. |
| user | See own channels and subscription; rename own channels with an active, unexpired subscription. |
| crm | View client names/emails and manage subscription records. No publishing keys, relay configuration or role administration. |
| support | See and rename only explicitly granted channels. No subscription editing, role administration or publishing keys. |

Use the account panel to create users, activate their subscriptions, and assign existing channels to them. New channels can be created in the embedded relay controls. Assign an owner afterward; unassigned legacy laptop-a/laptop-b channels remain visible only to administrators in the account panel. Give them real TV display names instead of replacing IDs. The public directory uses display names.

Subscriptions record plan, active/inactive/suspended status, channel allowance and expiry. They gate client name editing and new ownership assignments. They do not stop an already running broadcaster, revoke SRT credentials, collect payments or create invoices. Disable a channel in relay controls when you intend to stop its stream. Payment processing was not configured.

Support grants must name both a support account and an owned channel. Reassigning ownership clears old support grants. Account role changes are checked server-side on the next request. Admin plugin endpoints enforce their own permissions. Control mutations require the configured origin and a valid session. All account APIs must remain behind HTTPS and Caddy; never publish the accounts container port directly. Authentication rate limiting uses PostgreSQL. Without a trusted client IP, Better Auth uses a stricter shared bucket; do not trust arbitrary forwarding headers to bypass it.

## Validation

`npm test` covers role separation. `tests/accounts.integration.ts` applies real sessions against an isolated local PostgreSQL database and mocks only the internal relay: it tests client isolation, subscription allowances/suspension, scoped support, invalid origins and blocked role escalation. Set ACCOUNTS_TEST_DATABASE=1 and a loopback test DATABASE_URL to run it with `node --import tsx tests/accounts.integration.ts`. Never run this fixture against a real customer database.

Database outages prevent account management and new logins; existing playout continues independently. Password-reset email delivery and automated billing require separate configuration. Back up both the PostgreSQL account database and the relay SQLite database; ownership records reference relay channel IDs.

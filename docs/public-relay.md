# Public IPTV relay

The public publishing IP is **103.140.205.192**. The relay machine remains **192.168.0.248** on the LAN. The administration website and channel directory use **tv.pressmos.com**.

The frontend and API run in the same Docker deployment as MediaMTX and Caddy. Each broadcaster sends one encrypted SRT program from its laptop. Programs, playlists and schedules stay on that laptop. The relay stores credentials, settings and TLS certificates, with short HLS segments kept in memory.

## Network and DNS

| Public port | Forward to | Purpose |
| --- | --- | --- |
| TCP 80 | 192.168.0.248 port 80 | HTTPS redirect and certificate validation |
| TCP 443 | 192.168.0.248 port 443 | Website and HLS |
| UDP 8890 | 192.168.0.248 port 8890 | Encrypted broadcaster publishing |
| TCP 18088, optional | 192.168.0.248 port 18088 | Direct-IP viewing and LAN bootstrap |

Create a DNS-only **A** record named **tv**, with value **103.140.205.192**, in the pressmos.com zone. Remove incorrect AAAA records unless IPv6 is configured. Additional channel domains each need their own DNS records pointing to the same IP.

The administration URL is https://tv.pressmos.com/relay/. Laptop A uses https://tv.pressmos.com/streams/laptop-a/index.m3u8. A channel assigned a separate domain, for example news.example.com, also serves https://news.example.com/live/index.m3u8.

Saving a domain in SignalDesk registers it with the relay. Create its DNS record at your DNS provider to make it resolve.

## Enable the public gateway

Run commands in /opt/signaldesk on the relay. Back up the private environment file and relay database before upgrading. Add these non-secret values to the existing .env.relay, preserving its tokens.

    RELAY_PUBLIC_ENABLED=true
    RELAY_BIND_IP=192.168.0.248
    RELAY_HTTP_PORT=18088
    RELAY_SRT_PORT=8890
    RELAY_TLS_HTTP_PORT=80
    RELAY_TLS_HTTPS_PORT=443

If another service uses host TCP 80/443, choose different LAN host ports and forward public 80/443 to those ports.

    docker compose --env-file .env.relay -f compose.relay.yaml -f compose.public.yaml config --quiet
    docker compose --env-file .env.relay -f compose.relay.yaml -f compose.public.yaml pull
    docker compose --env-file .env.relay -f compose.relay.yaml -f compose.public.yaml up --no-build -d --wait

The deployment script and existing timer include the public overlay when RELAY_PUBLIC_ENABLED=true. Caddy persists certificates in Docker volumes. The certificate allowlist accepts only the saved administration domain and enabled channel domains. MediaMTX administration and its authentication callback remain inside Docker.

## Super administration

1. Open http://192.168.0.248:18088/relay/ on the private LAN.
2. Enter the existing RELAY_ADMIN_TOKEN and choose **Unlock administration**.
3. Save publishing host **103.140.205.192**, SRT port **8890**, administration domain **tv.pressmos.com** and website origin **https://tv.pressmos.com**.
4. Once DNS and router forwarding are ready, use https://tv.pressmos.com/relay/.
5. Create channels with unique lowercase IDs, display names, optional domains and limits.
6. Download each private connection profile and give it to its broadcaster.
7. Use **Edit channel** to change its settings. Channels can also be disabled, re-enabled, deleted, or have their publishing key rotated.

The admin token can change every channel. Broadcasters receive only their own publishing credential. The UI keeps the admin token in memory until locked or closed. Public administration requires HTTPS. Use the LAN address to configure domains initially.

Public endpoint settings determine downloaded profiles. Changing them does not alter Docker bindings, router rules or DNS. Existing laptops must update or reimport their profiles when moving from the LAN address to the public host.

## Channel policies

| Control | Enforcement |
| --- | --- |
| Enabled | Disabled channels reject HLS playback and SRT authentication. The active publisher is disconnected. |
| Maximum HLS sessions | MediaMTX limits simultaneous player sessions per path. A session can differ from a person, device or HTTP connection. Changing this limit reconnects the path and its publisher. Enabled SignalDesk outputs retry automatically. |
| Aggregate HLS output Mbps | The relay paces response-body bytes across all simultaneous requests for that channel. Both LAN and public playback pass through this proxy. |
| Maximum publisher bitrate Mbps | Incoming media bytes are sampled every five seconds. Over-limit publishers are disconnected and checked again if they reconnect. |
| Publishing key | A private per-channel encrypted SRT credential. Rotation disconnects the previous publisher. |

Allow headroom for video, audio and transport. Ten viewers of a 3 Mbps program need roughly 30 Mbps of media output. A 10 Mbps aggregate limit shared by those viewers causes buffering. The output limiter counts response-body bytes. TLS, HTTP and network overhead add traffic. These controls provide rate limits. Monthly transfer quotas and ISP billing remain separate.

Every viewer's video travels through the relay's internet connection. Channels share its upload capacity. The relay cannot bypass the transfer allowance of the connection serving viewers.

## Verify externally

Use a phone on mobile data to open the public domain. Tests from the same Wi-Fi depend on router NAT loopback.

Start the laptop's queue and enable relay output. Confirm LIVE in the directory and play its .m3u8 URL in VLC or **Watch channel**. Check actual video and audio. Keep the laptop and relay awake.

For an outside-LAN playback check, run the **Verify public HLS playback** GitHub Actions workflow with the ID of a live channel. It validates HTTPS and decodes eight seconds of video and audio from tv.pressmos.com. It needs no administrator token, publishing key or GitHub secret. Publishing still happens from the broadcaster on the LAN; this workflow does not test public SRT ingress. This check passed on November 15, 2026, using a disposable test channel that was removed afterward.

If publishing fails, check UDP forwarding, enabled state, credentials and publisher bitrate. If HTTPS fails, check DNS A/AAAA, TCP forwarding and gateway logs. A saved domain remains pending until DNS and routing permit certificate issuance.

If the public address shows your router login or a certificate for `tplinkwifi.net`, move or disable WAN remote administration on TCP 80/443 and correct the forwarding rules above. Never enter the relay administrator token into that router page. Let's Encrypt must reach Caddy on the relay, rather than the router's web interface.

If Docker reports `Unable to enable DNAT rule` with a missing `DOCKER` chain, its firewall rules may have been cleared after Docker started. During a maintenance window, restart Docker, then recreate the gateway. This briefly interrupts all containers on that host; it preserves named volumes and channel credentials.

    sudo systemctl restart docker
    docker compose --env-file .env.relay -f compose.relay.yaml -f compose.public.yaml up --no-build -d --force-recreate --no-deps gateway
    docker compose --env-file .env.relay -f compose.relay.yaml -f compose.public.yaml ps

Back up the private environment, channel database and certificate volumes. Backups contain publishing secrets.

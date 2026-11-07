# Stream from one computer to the internet

SignalDesk uses your broadcasting computer for encoding and serving. No rented server is required for a reachable connection and a small audience. The limits are the computer, power, ISP policy, and total upload bandwidth. Installing the app does not create a public address or unlimited viewer capacity.

For a domain using an outbound Dockerized connector, follow [Cloudflare Tunnel setup](cloudflare-tunnel.md), including its video-service limitation. [YouTube output](live-production.md) is a separate outbound delivery option. The direct port-forwarding instructions below do not apply to either of those outbound paths.

## Verify each hop

1. Start the test signal. On the broadcasting computer, open `http://127.0.0.1:8888/live/`. An IPTV player such as VLC can open `http://127.0.0.1:8888/live/index.m3u8`.
2. Find the computer's LAN IPv4 address with `ipconfig`. Reserve it in the router's DHCP settings, for example `192.168.1.50`.
3. If this is a trusted home/studio network, set Windows' network profile to **Private**. In an Administrator PowerShell window, run the optional firewall script from the repository's `scripts` folder or the installed `runtime` folder:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\configure-firewall.ps1
   ```

   This allows only MediaMTX's TCP viewer port 8888 on Private networks. It does not open publishing or management ports. If you changed the HLS port in Settings, pass the same value with `-Port`.
4. On a second device connected to that LAN, open `http://192.168.1.50:8888/live/`. Replace the example address with the real one.
5. In the router, forward **TCP 8888** to `192.168.1.50:8888`. Do not enable DMZ or forward every port. With double NAT, both routers need the appropriate forwarding rule.
6. Test from a phone using mobile data, with Wi-Fi switched off: `http://YOUR_PUBLIC_IP:8888/live/`. Some routers cannot test their own public address from inside the LAN.
7. Set **Public viewer address** in the app to your public IPv4 address or DNS hostname, without a scheme, port, or path for direct HTTP viewing. It labels the public HLS link; you still need the network configuration above.

MediaMTX serves HLS as a web player and an `index.m3u8` playlist on port 8888. HLS is the supported viewer transport in this implementation. The local pipeline publishes through RTSP on loopback. [MediaMTX HLS documentation](https://github.com/bluenviron/mediamtx/blob/main/docs/4-read/06-hls.md)

To revoke the Windows rule, run `configure-firewall.ps1 -Remove` as Administrator and remove the router forwarding rule.

## Keep the control ports private

| Endpoint | Bind address | Internet access |
| --- | --- | --- |
| Rust control API, TCP 9780 | `127.0.0.1` | Never forward |
| RTSP publisher, TCP 8554 | `127.0.0.1` | Never forward |
| HLS viewers, TCP 8888 | All interfaces | Forward this port only for plain HTTP viewing |
| Astro development UI, TCP 4321 | `127.0.0.1` | Never forward |

Other MediaMTX listeners are disabled. Publishing is restricted to the local computer; public viewers receive read access to the `live` channel. This version is a public channel and has no subscriber access control. Anyone who can reach its HLS URL can watch. The control API validates local host/origin requests, but same-user local programs remain trusted.

## CGNAT and changing addresses

Look at the router's **WAN/internet IPv4 address**. If it is a private address (`10.x`, `172.16`–`172.31.x`, or `192.168.x`), or in `100.64.0.0`–`100.127.255.255`, an upstream NAT exists. The `100.64.0.0/10` range is reserved for shared provider addressing. [IETF RFC 6598](https://datatracker.ietf.org/doc/html/rfc6598)

Under ISP CGNAT, forwarding your own router generally cannot accept unsolicited public IPv4 connections. Ask the ISP for a publicly reachable IPv4 address and permission to host a stream. A dynamic public IPv4 address can work with dynamic DNS, provided the hostname stays updated. A relay or tunnel changes the one-computer-only design and may add costs or video traffic limits; none is silently configured here.

This initial app generates IPv4/DNS viewer links. Public IPv6 deployment, TLS certificates, and IPv6 firewall policy need separate configuration and testing.

## HTTPS for a website

Plain HTTP is useful for local testing and compatible IPTV players. A public HTTPS website needs an HTTPS HLS source to avoid mixed-content blocking. Setting **Public viewer address** does not itself enable HTTPS.

A reverse proxy can run on the **same computer**. For example, install Caddy from its official distribution, point a DNS hostname to your public IP, and use this `Caddyfile`:

```caddyfile
tv.example.com {
    reverse_proxy 127.0.0.1:8888
}
```

Run Caddy with that config and forward TCP 80 and 443 to that computer, with corresponding Windows firewall rules restricted to Caddy. Caddy can obtain and renew public TLS certificates when DNS and external reachability are correct. Serve viewers at `https://tv.example.com/live/` or `https://tv.example.com/live/index.m3u8`. Do not proxy port 9780. Remove the public 8888 forwarding rule after the HTTPS path works. Caddy installation, startup supervision, and DNS are operator configuration; this repository does not install them automatically. [Caddy automatic HTTPS requirements](https://caddyserver.com/docs/automatic-https), [reverse proxy configuration](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

With an HTTPS proxy or tunnel configured, enter `https://tv.example.com` in **Public viewer address**. The app generates `https://tv.example.com/live/index.m3u8` without the internal HLS port. Bare hostnames/IPs retain the direct HTTP link and configured HLS port.

## Estimate viewer capacity

Every viewer consumes another copy of the encoded stream from this computer. Use the measured sustained **upload** rate, not the ISP's download rate. Leave spare capacity for audio, transport overhead, and normal traffic.

```text
safe viewers ≈ floor((upload Mbps × 0.70) / ((video Mbps + audio Mbps) × 1.10))
```

At 2.5 Mbps video plus 0.128 Mbps audio, a measured 20 Mbps uplink gives about **4 viewers** using this conservative estimate. A 100 Mbps uplink gives about **24**. These are arithmetic estimates, not measured guarantees. Simultaneous viewers, bitrate spikes, ISP shaping, CPU load, Wi-Fi, and buffer pressure can reduce the real number. There is one encoded rendition, so slow clients cannot automatically switch to a lower bitrate.

Lower the output bitrate for a small uplink, use wired ethernet, and test multiple remote devices before advertising a viewer limit. A CDN or relay becomes necessary when the audience outgrows your uplink; that adds an external service and is outside this one-computer setup.

The queue loops when enabled. Starting a queue first prepares normalized clips in the local cache, so allow preparation time before the planned broadcast. There is no automatic playout recovery after Windows restarts. Keep power and sleep settings appropriate for the broadcast, and check the stream after rebooting.

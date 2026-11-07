# Domain access with Dockerized Cloudflare Tunnel

The optional `compose.cloudflare.yaml` runs the official pinned `cloudflare/cloudflared:2026.10.7` image beside SignalDesk. It uses a remotely managed named tunnel and a Docker secret. The normal local app works without Cloudflare, a token, or this extra Compose file.

Cloudflare's [Tunnel FAQ](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/#large-file-and-streaming-traffic-through-tunnel) states that public video and large-file delivery on Free, Pro and Business plans requires a specific paid service. Confirm an appropriate service with Cloudflare before carrying public HLS video over this route. This setup is not free unlimited IPTV hosting. For the budget option, [send the program to YouTube](live-production.md) and let YouTube deliver the video; a tunnel does not remove your computer's upload limits.

## Create the tunnel and hostname

1. Add the domain to your Cloudflare account and complete its DNS setup. In Cloudflare One, open **Networks / Tunnels** (the navigation may also appear under **Networking**), create a **Cloudflared** tunnel, and choose Docker for the connector. Use a named, remotely managed tunnel rather than an anonymous quick tunnel.
2. Copy only the connector token from Cloudflare's install command. From the SignalDesk project folder, copy `.env.example` to `.env` and set `CLOUDFLARE_TUNNEL_TOKEN` there. Do not run Cloudflare's separate example Docker command as well. Never paste the token into chat or source files. `.env` is ignored by Git and excluded from the application build context. On macOS/Linux, restrict it with `chmod 600 .env`; on Windows, keep the project and file in your private user folder with appropriate access permissions.
3. Add a published application/public hostname to this tunnel, for example `tv.example.com`. Leave its path empty, choose **HTTP**, and set the service URL to **`studio:8888`** (the resulting origin is `http://studio:8888`). Docker's service name resolves inside the shared Compose network. `localhost:8888` would point to the cloudflared container itself and is incorrect.
4. Keep the app's HLS port set to **8888**. Never route the hostname to `studio:9780`, host port 8080, RTSP 8554 or the development server. The viewer origin has no operator controls; the local dashboard has no login and must stay local. Remote administration would need a separate authenticated design.
5. Cloudflare normally creates the tunnel's DNS record when the hostname is saved. Resolve any conflicting existing DNS record through the dashboard before continuing. Keep TLS verification enabled; the internal origin uses HTTP, while the public edge and tunnel connection are encrypted.

See Cloudflare's [remote-tunnel setup](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/) and [token-file parameter](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/#token-file).

## Start and check the connector

Run from the project folder, with `.env` containing the real token:

```sh
docker compose -f compose.yaml -f compose.cloudflare.yaml up --build -d --wait
docker compose -f compose.yaml -f compose.cloudflare.yaml ps
docker compose -f compose.yaml -f compose.cloudflare.yaml logs --tail=50 cloudflared
```

The token is injected as `/run/secrets/cloudflared_token`, rather than included in the command line or container environment. Compose needs to inject this environment-backed secret into the connector's filesystem, so that container uses a writable root filesystem; it still runs as the image's nonroot user, with all Linux capabilities dropped and no published ports. Keep Docker access and volume backups private.

The connector health check uses `cloudflared tunnel ready` and becomes healthy after an edge connection is established. It verifies the tunnel connection, not that a broadcast is on air or the hostname points to the right origin. A healthy connector can still return 502 if the service URL is wrong.

Start the channel in [the local studio](http://localhost:8080), then open:

```text
https://tv.example.com/live/
https://tv.example.com/live/index.m3u8
```

The first is the browser player; the second is for HLS/IPTV players. Replace the example hostname with yours. Test from a second network as well as the broadcasting computer. There is no viewer login, so a public viewer route is publicly watchable.

In **Settings → Public viewer address**, enter `https://tv.example.com` without a port or path. Stop the broadcast to edit settings, save, and restart the queue. The app then generates the correct HTTPS playlist URL without adding `:8888`. This field labels the viewer link; it does not create DNS or register a tunnel.

For a live origin, configure a Cloudflare Cache Rule to bypass caching for this hostname's `/live/*` requests. Do not apply a Cache Everything rule to the live playlist. Bypassing cache prevents stale live manifests; it does not change Cloudflare's video-service restrictions. See [cache rules](https://developers.cloudflare.com/cache/how-to/cache-rules/).

No inbound router forwarding is needed for a tunnel, including behind CGNAT. Permit the connector's required outbound DNS and TCP/UDP 7844 traffic according to [Cloudflare's firewall requirements](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/). QUIC uses UDP; automatic protocol selection can fall back to HTTP/2 over TCP. Docker and this computer must remain running and awake.

The existing Compose viewer mapping on 8888 still supports LAN viewing. The tunnel does not require a public 8888 firewall/router rule, so remove any unnecessary router forwarding through its normal configuration after the tunnel is verified. Management remains bound to `127.0.0.1:8080`.

## Stop, rotate and update

```sh
docker compose -f compose.yaml -f compose.cloudflare.yaml stop cloudflared
docker compose -f compose.yaml -f compose.cloudflare.yaml pull cloudflared
docker compose -f compose.yaml -f compose.cloudflare.yaml up -d --wait cloudflared
```

Stopping the connector leaves local playout running. To rotate a token, rotate it in Cloudflare, update the private `.env` file, then recreate the connector with `up -d --force-recreate --wait cloudflared` using the same two Compose files. The image is pinned; change its version deliberately when updating. Do not share `docker compose config --environment` output because that can include environment secrets.

The repo supplies and validates this connector setup. An actual healthy domain connection requires your Cloudflare account, tunnel token, DNS route and permitted service plan; no sample token can establish it.

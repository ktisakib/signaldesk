# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY astro.config.mjs tsconfig.json components.json ./
COPY src ./src
RUN npm run build

FROM rust:1.97.1-bookworm AS engine
WORKDIR /app
ARG TARGETARCH
COPY Cargo.toml Cargo.lock ./
COPY crates/broadcast-service ./crates/broadcast-service
# Cargo reads every workspace manifest even when only the service is built.
COPY src-tauri/Cargo.toml src-tauri/build.rs ./src-tauri/
COPY src-tauri/src ./src-tauri/src
# A cached artifact can be newer than changed source copied from the host.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,id=signaldesk-cargo-target-${TARGETARCH},target=/app/target \
    find crates/broadcast-service/src -type f -exec touch {} + && \
    cargo build --locked --release -p broadcast-service && \
    cp target/release/broadcast-service /broadcast-service

FROM bluenviron/mediamtx:1.21.3 AS mediamtx

FROM debian:bookworm-slim AS runtime
LABEL org.opencontainers.image.source="https://github.com/ktisakib/signaldesk"
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl ffmpeg && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd --gid 10001 signaldesk && \
    useradd --uid 10001 --gid signaldesk --no-create-home --home-dir /data signaldesk && \
    mkdir -p /app/web /app/licenses /data /media && \
    chown signaldesk:signaldesk /data
COPY --from=engine /broadcast-service /usr/local/bin/broadcast-service
COPY --from=mediamtx /mediamtx /usr/local/bin/mediamtx
COPY --from=web /app/dist /app/web
COPY docker/mediamtx.LICENSE /app/licenses/mediamtx.LICENSE
COPY crates/broadcast-service/assets/fonts/*OFL.txt /app/licenses/
ENV BROADCAST_WEB_ROOT=/app/web \
    BROADCAST_HOME=/data \
    BROADCAST_BIND=0.0.0.0:9780
WORKDIR /data
USER 10001:10001
EXPOSE 9780 8888
STOPSIGNAL SIGINT
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD curl --fail --silent --show-error http://127.0.0.1:9780/api/health || exit 1
ENTRYPOINT ["/usr/local/bin/broadcast-service"]

# The relay has no encoder and no broadcaster media mounts.
FROM engine AS relay-engine
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,id=signaldesk-cargo-target-${TARGETARCH},target=/app/target \
    cargo build --locked --release -p broadcast-service --bin relay-server && \
    cp target/release/relay-server /relay-server
FROM debian:bookworm-slim AS relay-runtime
LABEL org.opencontainers.image.source="https://github.com/ktisakib/signaldesk"
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd --gid 10001 signaldesk && \
    useradd --uid 10001 --gid signaldesk --no-create-home signaldesk && \
    mkdir -p /data /app/web && chown signaldesk:signaldesk /data
COPY --from=relay-engine /relay-server /usr/local/bin/relay-server
COPY --from=web /app/dist /app/web
USER 10001:10001
STOPSIGNAL SIGINT
HEALTHCHECK --interval=5s --timeout=3s --start-period=30s --retries=6 \
    CMD curl --fail --silent http://127.0.0.1:9790/api/health || exit 1
ENTRYPOINT ["/usr/local/bin/relay-server"]

FROM runtime AS studio-runtime

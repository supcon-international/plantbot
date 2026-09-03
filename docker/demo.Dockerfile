FROM node:24-bookworm-slim AS plantbot-base

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get -o Acquire::Retries=5 update \
  && apt-get -o Acquire::Retries=5 install -y --no-install-recommends ca-certificates \
  && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
  && apt-get -o Acquire::Retries=5 update \
  && apt-get -o Acquire::Retries=5 install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global pnpm@11.0.9

WORKDIR /app/robots

# Dependency manifests first, so source changes do not invalidate the install.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
COPY integrations/package.json integrations/package.json
COPY sdk/adapter-sdk-ts/package.json sdk/adapter-sdk-ts/package.json
RUN pnpm install --frozen-lockfile

# Download Linux-native demo footage, robot meshes, Redoc and go2rtc in a
# cacheable layer. Local macOS binaries/media are excluded by .dockerignore.
COPY scripts/setup.mjs scripts/setup.mjs
ARG PB_SETUP_FETCH_TIMEOUT_MS=60000
RUN mkdir -p server/media web/public/assets/robots/spot web/public/vendor bin \
  && PB_SETUP_FETCH_TIMEOUT_MS=${PB_SETUP_FETCH_TIMEOUT_MS} node scripts/setup.mjs \
  && test -x bin/go2rtc

COPY . .


FROM plantbot-base AS web-build
ARG WEB_BASE=/robots/
ENV WEB_BASE=${WEB_BASE}
RUN pnpm --filter web build


FROM nginx:1.30.4-alpine AS gateway
COPY docker/nginx.demo.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/robots/web/dist /usr/share/nginx/html/robots
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=12 \
  CMD wget -q -O - http://127.0.0.1:8080/robots/ | grep -Fq '<div id="root"></div>'


FROM plantbot-base AS api
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps
RUN mkdir -p /app/robots/server/data \
  && chown -R node:node /app/robots/server/data
USER node
WORKDIR /app/robots/server
EXPOSE 8787
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/index.ts"]


# The simulator protocols currently bind loopback by design. Keep the five
# simulator processes and five matching adapters in one bench container so the
# faithful protocol code does not need Docker-specific network changes.
FROM plantbot-base AS bench
USER root
WORKDIR /opt/plantbotsimulator
COPY --from=simulator package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY --from=simulator spot ./spot
COPY --from=simulator deeprobotics ./deeprobotics
COPY --from=simulator gosuncn ./gosuncn
COPY --from=simulator shared ./shared

# Re-encode the setup clips into a decoder-friendly RTSP tier while preserving
# the public-demo egress budget: 640px, 12 fps and at most 450 kbps per feed.
# Keep the encoder ceiling below that budget to leave room for mux overhead.
# Main profile without B-frames keeps go2rtc's fMP4 remux stable in Chrome.
# campus_quad consistently trips macOS VideoToolbox after go2rtc remuxing, so
# its public RTSP alias uses the verified campus walkway loop in this demo tier.
RUN set -eu; \
  mkdir -p /opt/rtsp-media; \
  for file in switchgear.mp4 thermal.mp4 night_walkway.mp4 substation.mp4 theft_cctv.mp4 campus_walk.mp4 campus_gate.mp4; do \
    ffmpeg -y -loglevel error -i "/app/robots/server/media/$file" \
      -vf "scale=640:-2" -r 12 -c:v libx264 -profile:v main -level:v 3.1 \
      -bf 0 -refs 1 -crf 30 -maxrate 400k -bufsize 800k -preset slow \
      -g 12 -keyint_min 12 -sc_threshold 0 -pix_fmt yuv420p -an -movflags +faststart \
      "/opt/rtsp-media/$file"; \
  done; \
  cp /opt/rtsp-media/campus_walk.mp4 /opt/rtsp-media/campus_quad.mp4
COPY docker/bench-rtsp.mjs ./rtsp/serve.mjs
RUN chown -R node:node /opt/plantbotsimulator
USER node
WORKDIR /app/robots/integrations
# Only the RTSP media port is consumed from outside this container (the go2rtc
# relay pulls rtsp://…:8554). The vendor sim protocol ports — 9101 (gosuncn),
# 9103/9113 (spot), 30000/30010 (deeprobotics) — are spoken only by the adapters
# running in this same container over loopback, so they are not published.
EXPOSE 8554
CMD ["node", "scripts/dev-all.mjs"]


# The platform playback relay only needs the pinned Linux go2rtc binary fetched
# above. Alpine supplies wget for the healthcheck.
FROM alpine:3.24 AS relay
COPY --from=plantbot-base /app/robots/bin/go2rtc /usr/local/bin/go2rtc
RUN addgroup -S go2rtc \
  && adduser -S -G go2rtc go2rtc \
  && mkdir -p /config \
  && chown go2rtc:go2rtc /config
COPY --chown=go2rtc:go2rtc docker/go2rtc.demo.yaml /config/go2rtc.yaml
USER go2rtc
EXPOSE 1984
HEALTHCHECK --interval=5s --timeout=3s --retries=20 \
  CMD wget -q -O /dev/null http://127.0.0.1:1984/api || exit 1
ENTRYPOINT ["/usr/local/bin/go2rtc", "-config", "/config/go2rtc.yaml"]

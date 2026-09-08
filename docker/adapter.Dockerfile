FROM node:24-bookworm-slim AS adapter
RUN npm install --global pnpm@11.0.9
WORKDIR /app/robots
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
COPY integrations/package.json integrations/package.json
COPY sdk/adapter-sdk-ts/ sdk/adapter-sdk-ts/
ARG PB_NPM_REGISTRY=https://registry.npmjs.org
RUN --mount=type=cache,id=plantbot-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter integrations... --ignore-scripts --registry=${PB_NPM_REGISTRY} \
    && pnpm --filter @plantbot/adapter-sdk build
COPY integrations/ integrations/
COPY shared/ shared/
COPY --chmod=755 docker/adapter-entrypoint.sh /usr/local/bin/plantbot-adapter-entrypoint
ENV PB_ADAPTER_CONFIG=/config/adapter.json
ENTRYPOINT ["/usr/local/bin/plantbot-adapter-entrypoint"]
WORKDIR /app/robots/integrations
CMD ["node", "node_modules/tsx/dist/cli.mjs", "runtime.ts"]

FROM python:3.12-slim-bookworm AS vision
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 OPENCV_LOG_LEVEL=OFF \
    PB_VISION_DATA=/data PB_ADAPTER_CONFIG=/config/adapter.json
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 plantbot
WORKDIR /app/robots
COPY integrations/vision/requirements.lock.txt /tmp/requirements.lock.txt
RUN pip install --no-cache-dir -r /tmp/requirements.lock.txt
COPY integrations/vision/models.lock.json integrations/vision/setup_models.py integrations/vision/
RUN python integrations/vision/setup_models.py
COPY shared/ shared/
COPY integrations/vision/ integrations/vision/
RUN mkdir -p /data && chown plantbot:plantbot /data
COPY --chmod=755 docker/adapter-entrypoint.sh /usr/local/bin/plantbot-adapter-entrypoint
ENTRYPOINT ["/usr/local/bin/plantbot-adapter-entrypoint"]
HEALTHCHECK --interval=15s --timeout=3s --start-period=90s --retries=3 \
  CMD python -c "import time,pathlib; assert time.time()-float(pathlib.Path('/data/health').read_text()) < 30"
CMD ["python", "integrations/vision/worker.py"]

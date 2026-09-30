# Reproducible render environment: pinned Node, FFmpeg and Chromium headless shell.
# Deterministic mode renders the same pixels here on any machine.
#
#   docker build -f docker/Dockerfile -t devicewrapper .
#   docker run --rm -i -v "$PWD:/work" -w /work devicewrapper mcp
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable
WORKDIR /opt/devicewrapper
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile && pnpm build
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN cd packages/renderer && pnpm exec playwright-core install --with-deps chromium-headless-shell

ENV DEVICEWRAPPER_WORKSPACE=/work
ENTRYPOINT ["node", "/opt/devicewrapper/packages/cli/dist/index.js"]
CMD ["mcp"]

# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS build

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV QMD_FORCE_CPU_ONLY=true

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      cmake \
      g++ \
      git \
      make \
      pkg-config \
      python3 && \
    rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.8.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm prune --prod

FROM node:20-bookworm-slim AS runner

ENV NODE_ENV=production
ENV PORT=3000
ENV SLACK_MODE=oauth
ENV SOCKET_MODE=false
ENV QMD_FORCE_CPU_ONLY=true
ENV PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      libgomp1 && \
    rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --chown=node:node public ./public

RUN mkdir -p /app/data && chown -R node:node /app/data

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "dist/app.js"]

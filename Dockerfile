FROM node:22-bookworm-slim AS node

FROM oven/bun:1.3.3-slim AS build

COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN bun run build

FROM oven/bun:1.3.3-slim

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src
COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
EXPOSE 8080

CMD ["bun", "src/index.ts"]

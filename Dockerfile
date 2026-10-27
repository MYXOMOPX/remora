# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/core-plugin/package.json packages/core-plugin/
COPY packages/server/package.json packages/server/
RUN npm ci
COPY packages/ packages/
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PLUGINS_DIR=/plugins PORT=8080 HOST=0.0.0.0
COPY --from=build /app/package.json /app/
COPY --from=build /app/node_modules /app/node_modules
# only what runs: package.json + dist per package, and the SQL migrations (no sources, tests or tsconfigs)
COPY --from=build /app/packages/sdk/package.json /app/packages/sdk/
COPY --from=build /app/packages/sdk/dist /app/packages/sdk/dist
COPY --from=build /app/packages/core-plugin/package.json /app/packages/core-plugin/
COPY --from=build /app/packages/core-plugin/dist /app/packages/core-plugin/dist
COPY --from=build /app/packages/server/package.json /app/packages/server/
COPY --from=build /app/packages/server/dist /app/packages/server/dist
COPY --from=build /app/packages/server/migrations /app/packages/server/migrations
RUN mkdir -p /plugins && chown node:node /plugins
VOLUME /plugins
USER node
EXPOSE 8080
# node is PID 1: main.ts handles SIGTERM/SIGINT itself (graceful drain, exit 0).
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node","packages/server/dist/main.js"]

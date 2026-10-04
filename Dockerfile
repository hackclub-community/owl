# syntax=docker/dockerfile:1
FROM dhi.io/bun:1-alpine AS build
USER 0
WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache ["bun", "install", "--frozen-lockfile"]

WORKDIR /production
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache ["bun", "install", "--frozen-lockfile", "--production"]

WORKDIR /app
COPY tsconfig*.json ./
COPY src ./src
RUN ["bun", "node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"]

FROM dhi.io/node:26-alpine AS runtime
ARG SOURCE_COMMIT=unknown
ARG COMMIT_SHA=$SOURCE_COMMIT
ENV COMMIT_SHA=$COMMIT_SHA
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=1000:1000 /production/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/dist ./dist
COPY --chown=1000:1000 package.json ./
COPY --chown=1000:1000 drizzle ./drizzle
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# Gate startup on migrations without a shell; Node remains PID 1.
CMD ["node", "--input-type=module", "-e", "await import('./dist/db/migrate.js'); await import('./dist/index.js');"]

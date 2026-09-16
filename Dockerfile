# Huletts Promotions — API + embedded worker + static console.
# Build: docker build -t hullets . · Run: docker run --env-file .env -p 8080:8080 hullets
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json .npmrc ./
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/console/package.json apps/console/
RUN npm ci
COPY . .
RUN npm run console:build && npm run typecheck

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# postgresql-client provides pg_dump/pg_restore for the restore rehearsal; curl for health checks
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client curl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
RUN mkdir -p /app/data/media && chown -R node:node /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD curl -fsS http://127.0.0.1:8080/health/live || exit 1
# migrations run on every start (idempotent), then the API with the embedded worker
CMD ["sh", "-c", "npm run -s db:migrate && npm run -s start"]

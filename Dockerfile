# syntax=docker/dockerfile:1
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Ferramentas (migrate/seed/test): dev deps + código-fonte completo
FROM deps AS tools
COPY . .
CMD ["pnpm", "typecheck"]

FROM tools AS builder
RUN pnpm build

FROM node:22-slim AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3150
WORKDIR /app
RUN useradd -r -u 1001 app
COPY --from=builder --chown=app /app/.next/standalone ./
COPY --from=builder --chown=app /app/.next/static ./.next/static
USER app
EXPOSE 3150
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3150/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]

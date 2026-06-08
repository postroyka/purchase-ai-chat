# ---- backend deps ----
FROM node:22.16.0-alpine3.22 AS backend-deps

RUN corepack enable && corepack prepare pnpm@11.5.0 --activate

WORKDIR /app/backend
COPY backend/package.json backend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ---- ui build ----
FROM node:22.16.0-alpine3.22 AS ui-builder

RUN corepack enable && corepack prepare pnpm@11.5.0 --activate

WORKDIR /app/ui
COPY ui/package.json ui/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY ui/ ./
RUN pnpm build

# ---- runtime ----
FROM node:22.16.0-alpine3.22

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code@2.1.168

WORKDIR /app

# Backend
COPY --from=backend-deps /app/backend/node_modules ./backend/node_modules
COPY backend/ ./backend/

# UI static output
COPY --from=ui-builder /app/ui/.output/public ./ui/public

# Prompts (used by claude code agent)
COPY prompts/ ./prompts/

# Run as non-root. uploads/ is written at runtime, so chown the app dir.
RUN addgroup -S appuser && adduser -S appuser -G appuser \
  && mkdir -p /app/uploads && chown -R appuser:appuser /app
USER appuser

EXPOSE 3000

CMD ["node", "backend/index.js"]

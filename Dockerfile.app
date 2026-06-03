# ---- backend deps ----
FROM node:22-alpine AS backend-deps

WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

# ---- ui build ----
FROM node:22-alpine AS ui-builder

RUN corepack enable && corepack prepare pnpm@11.5.0 --activate

WORKDIR /app/ui
COPY ui/package.json ui/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY ui/ ./
RUN pnpm build

# ---- runtime ----
FROM node:22-alpine

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Backend
COPY --from=backend-deps /app/backend/node_modules ./backend/node_modules
COPY backend/ ./backend/

# UI static output
COPY --from=ui-builder /app/ui/.output/public ./ui/public

# Prompts (used by claude code agent)
COPY prompts/ ./prompts/

EXPOSE 3000

CMD ["node", "backend/index.js"]

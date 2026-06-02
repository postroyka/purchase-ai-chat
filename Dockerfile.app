# Stage 1: build dependencies
FROM node:20-alpine AS deps

WORKDIR /app

COPY backend/package.json backend/package.json
RUN cd backend && npm install --omit=dev

# Stage 2: final image
FROM node:20-alpine

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Copy backend with installed deps
COPY --from=deps /app/backend/node_modules ./backend/node_modules
COPY backend/ ./backend/
COPY ui/ ./ui/
COPY prompts/ ./prompts/

EXPOSE 3000

CMD ["node", "backend/index.js"]

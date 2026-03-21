# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY scripts/ ./scripts/

RUN npx tsc

# Stage 2: Runtime
FROM node:22-alpine

RUN addgroup -S worker && adduser -S worker -G worker

WORKDIR /app

COPY --from=builder /app/package.json /app/package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist/ ./scripts/

RUN chown -R worker:worker /app

USER worker

# Default: no-op — command is set by Validance catalog's command_template
CMD ["echo", "ready"]

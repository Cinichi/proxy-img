FROM node:20-alpine

# Install build deps for Sharp (native bindings)
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    vips-dev \
    libc6-compat

WORKDIR /app

# Copy package files first for layer caching
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy source
COPY server.js ./

# Stats + logs persist via volume on /root/.pm2
VOLUME ["/root/.pm2"]

EXPOSE 4000

ENV NODE_ENV=production \
    PORT=4000

# Healthcheck — polls /health every 30s
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:4000/health || exit 1

CMD ["node", "server.js"]

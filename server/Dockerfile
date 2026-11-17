# PocketPad server image. Build from the server/ folder:  docker build -t pocketpad ./server
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=8080 \
    THEMES_DIR=/themes
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY themes ./themes
COPY tools ./tools
RUN mkdir -p /themes && chown node:node /themes
USER node
EXPOSE 8080
VOLUME ["/themes"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
CMD ["node", "src/index.js"]

FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/scores.db

WORKDIR /app
COPY server.mjs ./
COPY public ./public

RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

# node:sqlite is built in (Node 22.13+); silence its experimental notice
CMD ["node", "--disable-warning=ExperimentalWarning", "server.mjs"]

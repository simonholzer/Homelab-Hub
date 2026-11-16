# syntax=docker/dockerfile:1
FROM node:26-slim
ENV NODE_ENV=production \
    PORT=8080 \
    CONFIG_PATH=/config/services.yaml \
    DEFAULT_CONFIG_PATH=/app/config/starter.yaml
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
# starter.yaml is copied to /config/services.yaml on the first start; services.yaml is the full example
COPY config ./config
COPY docker-entrypoint.sh ./
VOLUME /config
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# starts as root only to fix the owner of /config, then runs as PUID:PGID (default 1000:1000)
ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]

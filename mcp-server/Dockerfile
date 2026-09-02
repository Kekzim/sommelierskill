# The MCP server. Reads the published mirror; never writes it.
FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:26-alpine AS runtime
RUN addgroup -g 10001 -S bolaget && adduser -u 10001 -S bolaget -G bolaget
WORKDIR /app
COPY --from=deps --chown=bolaget:bolaget /app/node_modules ./node_modules
COPY --from=build --chown=bolaget:bolaget /app/dist ./dist
COPY --chown=bolaget:bolaget package.json ./
USER 10001
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8848 \
    BOLAGETDB_PATH=/data/bolaget.db
EXPOSE 8848
# No curl in the image; node's own fetch does the job.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8848)+'/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]

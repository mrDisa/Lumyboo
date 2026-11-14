FROM node:24-alpine AS web
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY apps/web/src apps/web/src
COPY apps/web/public apps/web/public
COPY apps/web/index.html apps/web/tsconfig.json apps/web/vite.config.ts apps/web/
COPY scripts/check-pwa.mjs scripts/check-pwa.mjs
RUN npm run build

FROM caddy:2.11.2-alpine
COPY --from=web /src/apps/web/dist /srv
COPY ops/staging/Caddyfile /etc/caddy/Caddyfile

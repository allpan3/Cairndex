# Cairndex frontend — development image (Vite dev server with HMR).
#
# Production builds a static bundle served by the backend or a static host;
# that is Phase 8 work (docs/deployment.md). Build context is apps/web
# (see docker-compose.yml). Node 22 satisfies Vite 8's engine requirement
# (^20.19 || >=22.12).

FROM node:26-bookworm-slim

WORKDIR /app

# Install dependencies first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 5173

# --host binds to 0.0.0.0 so the dev server is reachable from outside the
# container. In compose, VITE_API_PROXY_TARGET points the /api proxy at the
# backend service.
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

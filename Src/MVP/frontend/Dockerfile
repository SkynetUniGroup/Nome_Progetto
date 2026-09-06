# ---- Stage 1: Build ----
FROM node:26 AS builder

WORKDIR /app

# corepack doesn't work, install pnpm via npm
RUN npm install -g pnpm

# Copy dependency manifests first to leverage layer cache
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json ./frontend/

# Install frontend dependencies (dev deps needed for the build step)
RUN pnpm install --frozen-lockfile --filter frontend --ignore-scripts

# Copy the rest of the source
COPY frontend/ ./frontend/

# VITE_API_BASE_URL defaults to /api/v1 (same-origin relative path).
# Override at build time with: docker build --build-arg VITE_API_BASE_URL=/custom/path
ARG VITE_API_BASE_URL=/api/v1
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

RUN pnpm --filter frontend run build

# ---- Stage 2: Serve ----
FROM nginx:1.31-alpine AS runtime

# SPA routing configuration
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Copy compiled static assets from the builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]

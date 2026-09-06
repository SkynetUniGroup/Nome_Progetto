FROM node:26

WORKDIR /app

# corepack doesn't work, install pnpm via npm
RUN npm install -g pnpm

# Copy root lockfile + workspace config + backend package
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json ./backend/

# Install backend deps only
RUN pnpm install --frozen-lockfile --filter backend --ignore-scripts

COPY backend/ ./backend/

EXPOSE 3000

CMD ["pnpm", "run", "start:dev"]

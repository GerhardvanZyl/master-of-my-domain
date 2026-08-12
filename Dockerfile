# Raspberry Pi 4 (arm64). Build on the Pi, or:
#   docker buildx build --platform linux/arm64 -t property-compare .
FROM node:22-bookworm-slim

# better-sqlite3 falls back to compiling from source when prebuild-install has
# no binary for this node ABI + arm64. Cheaper to carry a toolchain than to
# debug the failure on a Pi.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Run as the image's `node` user (uid 1000) — same uid as the default Pi user, so
# files the app writes into the bind-mounted data/ stay editable on the host
# instead of landing root-owned.
RUN mkdir -p /app && chown node:node /app
WORKDIR /app
USER node

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci

COPY --chown=node:node . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3225
# ponytail: no dev-dep prune — tsx stays so the scripts/ CLIs (db:migrate,
# tag:*, scrape) still run inside the container. Costs ~150 MB of image.
CMD ["npm", "start"]

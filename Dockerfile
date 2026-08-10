# Raspberry Pi 4 (arm64). Build on the Pi, or:
#   docker buildx build --platform linux/arm64 -t property-compare .
FROM node:22-bookworm-slim

# better-sqlite3 falls back to compiling from source when prebuild-install has
# no binary for this node ABI + arm64. Cheaper to carry a toolchain than to
# debug the failure on a Pi.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3225
# ponytail: no dev-dep prune — tsx stays so the scripts/ CLIs (db:migrate,
# tag:*, scrape) still run inside the container. Costs ~150 MB of image.
CMD ["npm", "start"]

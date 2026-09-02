# Optional container image for the MTProto listener (alternative to pm2).
# node:20-slim is multi-arch, so it runs on both ARM (Oracle Ampere) and AMD hosts.
FROM node:20-slim

WORKDIR /app

# Install deps first for better layer caching. GramJS's only native deps
# (bufferutil / utf-8-validate) are OPTIONAL — npm skips them on slim and `ws`
# works without them, so no C toolchain is needed and the image stays small.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js ./

# Config comes from the mounted .env at runtime (see docker-compose.yml);
# nothing secret is baked into the image.
ENV NODE_ENV=production
CMD ["node", "index.js"]

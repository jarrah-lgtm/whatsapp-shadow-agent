FROM ghcr.io/puppeteer/puppeteer:22

# Switch to root to install deps
USER root

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy app
COPY index.js ./

# Create persistent data directory (app runs as root so volume mounts are writable)
RUN mkdir -p /data/wwebjs_auth

EXPOSE 3000

CMD ["node", "index.js"]

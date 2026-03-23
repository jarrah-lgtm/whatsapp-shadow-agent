FROM ghcr.io/puppeteer/puppeteer:22

# Switch to root to install deps
USER root

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy app
COPY index.js ./

# Create persistent data directory
RUN mkdir -p /data/wwebjs_auth && chown -R pptruser:pptruser /data

# Switch back to non-root
USER pptruser

EXPOSE 3000

CMD ["node", "index.js"]

FROM node:20-slim

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY index.js ./

RUN mkdir -p /data/baileys_auth

EXPOSE 3000

CMD ["node", "index.js"]

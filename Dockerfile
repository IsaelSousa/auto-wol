FROM node:22-alpine

# ping (iputils) e arp (net-tools) sao usados via child_process para o
# ping sweep e leitura da tabela ARP durante a descoberta de dispositivos.
RUN apk add --no-cache iputils net-tools

WORKDIR /app

COPY package*.json ./
# npm ci = instalacao reprodutivel a partir do package-lock.json (mais
# rapida e consistente que npm install para builds de CI/imagem)
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8099
ENV DATA_DIR=/app/data
EXPOSE 8099

VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/network" > /dev/null || exit 1

CMD ["node", "server.js"]

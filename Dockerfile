FROM node:22-alpine

# ping (iputils) e arp (net-tools) sao usados via child_process para o
# ping sweep e leitura da tabela ARP durante a descoberta de dispositivos.
RUN apk add --no-cache iputils net-tools

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=8099
ENV DATA_DIR=/app/data
EXPOSE 8099

VOLUME ["/app/data"]

CMD ["node", "server.js"]

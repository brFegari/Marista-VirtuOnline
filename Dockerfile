# Dockerfile recomendado para Puppeteer + Node
FROM node:20-bullseye-slim

# instalar dependências do sistema necessárias para Chromium
RUN apt-get update && apt-get install -y \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    wget \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# diretório de trabalho
WORKDIR /usr/src/app

# Copia package.json e package-lock.json primeiro para cache de layers
COPY package*.json ./

# instala dependências (vai baixar Chromium se usar puppeteer)
RUN npm ci --omit=dev

# copia o restante do app
COPY . .

# expor porta (Render vai fornecer $PORT no runtime)
EXPOSE 3000

# variáveis de ambiente seguras por padrão
ENV NODE_ENV=production

# comando de start
CMD ["node", "server.js"]

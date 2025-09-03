# Dockerfile (colocar na raiz do repositório)
FROM node:20-bullseye-slim

# dependências do sistema necessárias para Chromium
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

WORKDIR /usr/src/app

# Copia apenas package.json / package-lock.json primeiro para aproveitar cache de camada
COPY package*.json ./

# Instala dependências: usa npm ci se houver lockfile, senão npm install
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi

# Copia o resto da aplicação
COPY . .

# Expor porta (o runtime usará process.env.PORT)
EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "server.js"]

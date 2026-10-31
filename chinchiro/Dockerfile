FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# 依存関係（本番用のみ）
COPY package*.json ./
RUN npm ci --omit=dev

# アプリ本体
COPY server ./server
COPY public ./public

# Render / Cloud Run などは環境変数 PORT を渡してくるので、それに従う
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server/index.js"]

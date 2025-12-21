FROM node:18-slim

# Chromeと日本語フォントのインストール
# Puppeteerを動かすために必要なライブラリと、PDFで日本語を表示するためのフォントをインストールします
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
    && sh -c 'echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# 作業ディレクトリの設定
WORKDIR /usr/src/app

# パッケージ定義をコピー
COPY package*.json ./

# 環境変数の設定
# PuppeteerにChromiumをダウンロードさせず、インストールしたChromeを使うように設定
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# 依存関係のインストール
RUN npm install

# ソースコードをコピー
COPY . .

# フロントエンドのビルド
RUN npm run build

# ポートの公開（Cloud Run等は環境変数PORTでポートを指定してくるため、それに従う必要があるが、明示的に3000もあけておく）
EXPOSE 3000

# サーバー起動
CMD [ "npm", "start" ]

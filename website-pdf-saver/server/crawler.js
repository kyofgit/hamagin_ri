import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

/**
 * ウェブサイトをクロールし、同一ドメイン内のページを収集
 * @param {string} baseUrl - 開始URL
 * @param {function} onProgress - 進捗コールバック
 * @returns {Promise<Array>} ページ情報の配列
 */
export async function crawlWebsite(baseUrl, tempDir, onProgress, checkCancel) {
    let browser;
    let page;

    const setupBrowser = async () => {
        if (browser) {
            try {
                await browser.close();
            } catch (e) {
                // Ignore close errors
            }
        }
        console.log('Puppeteerブラウザを起動中...');
        browser = await puppeteer.launch({
            headless: 'new',
            protocolTimeout: 120000, // 2分のタイムアウト
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-software-rasterizer',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-sync',
                '--metrics-recording-only',
                '--mute-audio',
                '--no-first-run',
                '--safebrowsing-disable-auto-update',
            ],
        });
        console.log('ブラウザ起動完了');
    };

    const setupPage = async () => {
        try {
            if (!browser || !browser.isConnected()) {
                await setupBrowser();
            }
            if (page) {
                try {
                    await page.close();
                } catch (e) {
                    // Ignore
                }
            }
            page = await browser.newPage();
            page.setDefaultNavigationTimeout(30000); // 30秒に短縮
            page.setDefaultTimeout(30000);
            await page.setUserAgent(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            );
            // リソースをブロックして高速化
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                const resourceType = req.resourceType();
                // 画像、フォント、メディアをブロック
                if (['image', 'font', 'media', 'stylesheet'].includes(resourceType)) {
                    req.abort();
                } else {
                    req.continue();
                }
            });
        } catch (err) {
            console.error('ページ/ブラウザの作成に失敗:', err.message);
            await setupBrowser();
            page = await browser.newPage();
            page.setDefaultNavigationTimeout(30000);
            page.setDefaultTimeout(30000);
            await page.setUserAgent(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            );
        }
    };

    try {
        await setupBrowser();
        await setupPage();

        const baseUrlObj = new URL(baseUrl);
        const baseDomain = baseUrlObj.hostname;

        const visited = new Set();
        const queue = [normalizeUrl(baseUrl)];
        const pages = [];

        let pageIndex = 0;
        let processedCount = 0; // ★ ループ外で宣言

        while (queue.length > 0) {
            // キャンセルチェック
            if (checkCancel && checkCancel()) {
                console.log('クローリング中断（キャンセル）');
                break;
            }

            const url = queue.shift();

            if (visited.has(url)) continue;
            visited.add(url);

            // 定期的にブラウザを再起動してメモリを解放（3ページごと）
            if (processedCount > 0 && processedCount % 3 === 0) {
                console.log(`${processedCount}ページ処理済み。メモリ解放のためブラウザを再起動...`);
                await setupBrowser();
                await setupPage();
            }

            // このURLの処理（リトライあり）
            let retries = 2; // リトライ回数を減らす
            let success = false;

            while (retries > 0 && !success) {
                try {
                    console.log(`クローリング中: ${url}`);

                    // ★ ウォッチドッグタイマー付きでページ処理
                    const pageResult = await Promise.race([
                        processPage(page, url, baseDomain, tempDir, pageIndex),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('ページ処理タイムアウト（45秒）')), 45000)
                        )
                    ]);

                    if (pageResult) {
                        pages.push(pageResult.pageData);
                        pageIndex++;
                        processedCount++; // ★ 成功時のみインクリメント

                        // 新しいリンクをキューに追加
                        for (const link of pageResult.links) {
                            const normalizedLink = normalizeUrl(link);
                            if (!visited.has(normalizedLink) && !queue.includes(normalizedLink)) {
                                if (!shouldExclude(normalizedLink)) {
                                    queue.push(normalizedLink);
                                }
                            }
                        }
                    }

                    success = true;

                    // 進捗報告
                    onProgress({
                        totalFound: queue.length + pages.length,
                        processed: pages.length,
                        currentUrl: url,
                    });

                } catch (error) {
                    console.error(`[ERROR] ${url}: ${error.message}`);
                    retries--;

                    if (retries > 0) {
                        console.log('ページ再作成後リトライ...');
                        await setupPage().catch(() => { });
                        await new Promise(r => setTimeout(r, 1000));
                    } else {
                        console.log(`${url} をスキップします`);
                        processedCount++; // スキップしてもカウント（メモリ解放トリガー用）
                    }
                }
            }
        }

        console.log(`クローリング完了。${pages.length} ページを取得`);
        return pages;

    } finally {
        if (page) {
            try { await page.close(); } catch (e) { }
        }
        if (browser) {
            try { await browser.close(); } catch (e) { }
        }
    }
}

/**
 * 1ページを処理する関数（分離してタイムアウト制御しやすく）
 */
async function processPage(page, url, baseDomain, tempDir, pageIndex) {
    const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 25000
    });

    if (!response) {
        console.log(`${url}: レスポンスなし、スキップ`);
        return null;
    }

    const status = response.status();
    if (status >= 400) {
        console.log(`${url}: HTTPエラー ${status}、スキップ`);
        return null;
    }

    // Content-Typeをチェック
    const contentType = response.headers()['content-type'] || '';
    if (!contentType.includes('text/html')) {
        console.log(`${url}: HTMLではない (${contentType})、スキップ`);
        return null;
    }

    // ページ情報を取得
    const pageInfo = await page.evaluate((currentUrl) => {
        // baseタグを注入
        const base = document.createElement('base');
        base.href = currentUrl;
        if (document.head) {
            document.head.insertBefore(base, document.head.firstChild);
        }

        return {
            title: document.title || 'No Title',
            html: document.documentElement.outerHTML,
        };
    }, url);

    // HTMLを一時ファイルに保存
    const htmlFilename = `page_${pageIndex}.html`;
    const htmlPath = path.join(tempDir, htmlFilename);
    fs.writeFileSync(htmlPath, pageInfo.html);

    // 同一ドメインのリンクを収集
    const links = await page.evaluate((baseDomain) => {
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        return anchors
            .map(a => a.href)
            .filter(href => {
                try {
                    const linkUrl = new URL(href);
                    return linkUrl.hostname === baseDomain ||
                        linkUrl.hostname.endsWith('.' + baseDomain);
                } catch {
                    return false;
                }
            });
    }, baseDomain);

    return {
        pageData: {
            url,
            title: pageInfo.title,
            htmlPath: htmlPath,
        },
        links: links,
    };
}

/**
 * URLを正規化
 */
function normalizeUrl(url) {
    try {
        const urlObj = new URL(url);
        urlObj.hash = '';
        let pathname = urlObj.pathname;
        if (pathname !== '/' && pathname.endsWith('/')) {
            pathname = pathname.slice(0, -1);
        }
        urlObj.pathname = pathname;
        return urlObj.toString();
    } catch {
        return url;
    }
}

/**
 * 除外すべきURLかチェック
 */
function shouldExclude(url) {
    const excludePatterns = [
        /\.(pdf|jpg|jpeg|png|gif|svg|webp|ico|css|js|woff|woff2|ttf|eot)$/i,
        /\?(utm_|ref=|source=)/i,
        /#/,
        /mailto:/i,
        /tel:/i,
        /javascript:/i,
    ];

    return excludePatterns.some(pattern => pattern.test(url));
}

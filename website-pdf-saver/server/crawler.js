import puppeteer from 'puppeteer';

/**
 * ウェブサイトをクロールし、同一ドメイン内のページを収集
 * @param {string} baseUrl - 開始URL
 * @param {function} onProgress - 進捗コールバック
 * @returns {Promise<Array>} ページ情報の配列
 */
export async function crawlWebsite(baseUrl, onProgress, checkCancel) {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-extensions',
        ],
    });

    try {
        const baseUrlObj = new URL(baseUrl);
        const baseDomain = baseUrlObj.hostname;

        const visited = new Set();
        const queue = [normalizeUrl(baseUrl)];
        const pages = [];

        let page;
        const setupPage = async () => {
            if (page) await page.close().catch(() => { });
            page = await browser.newPage();
            page.setDefaultNavigationTimeout(60000);
            await page.setUserAgent(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            );
        };

        await setupPage();

        while (queue.length > 0) {
            // キャンセルチェック
            if (checkCancel && checkCancel()) {
                console.log('クローリング中断（キャンセル）');
                break;
            }

            const url = queue.shift();

            if (visited.has(url)) continue;
            visited.add(url);

            // このURLの処理全体をリトライループで囲む
            let retries = 3;
            let success = false;

            while (retries > 0 && !success) {
                try {
                    console.log(`クローリング中: ${url} (残り試行回数: ${retries})`);

                    // 進捗報告
                    onProgress({
                        totalFound: queue.length + pages.length + 1,
                        processed: pages.length,
                        currentUrl: url,
                    });

                    // ページに移動
                    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

                    if (!response || !response.ok()) {
                        console.log(`${url} をスキップします: レスポンスが正常ではありません`);
                        success = true; // 正常にスキップできたことにする（リトライしない）
                        continue;
                    }

                    // Content-Typeをチェック
                    const contentType = response.headers()['content-type'] || '';
                    if (!contentType.includes('text/html')) {
                        console.log(`${url} をスキップします: HTMLではありません (${contentType})`);
                        success = true; // 正常にスキップ
                        continue;
                    }

                    // ページ情報を取得
                    const pageInfo = await page.evaluate(() => {
                        return {
                            title: document.title,
                            html: document.documentElement.outerHTML,
                        };
                    });

                    pages.push({
                        url,
                        title: pageInfo.title,
                        html: pageInfo.html,
                    });

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

                    // キューに追加
                    for (const link of links) {
                        const normalizedLink = normalizeUrl(link);
                        if (!visited.has(normalizedLink) && !queue.includes(normalizedLink)) {
                            if (shouldExclude(normalizedLink)) continue;
                            queue.push(normalizedLink);
                        }
                    }

                    success = true; // 成功

                } catch (error) {
                    console.error(`${url} の処理中にエラーが発生しました:`, error.message);

                    // エラー時はページを作り直す（クラッシュ対策）
                    try {
                        await setupPage();
                    } catch (setupError) {
                        console.error('ページの再作成に失敗:', setupError);
                    }

                    retries--;
                    if (retries > 0) {
                        console.log('リトライします...');
                        await new Promise(r => setTimeout(r, 2000));
                    } else {
                        console.error(`${url} の取得を諦めました。`);
                    }
                }
            }
        }

        if (page) await page.close();

        console.log(`クローリング完了。${pages.length} ページが見つかりました。`);
        return pages;

    } finally {
        await browser.close();
    }
}

/**
 * URLを正規化
 */
function normalizeUrl(url) {
    try {
        const urlObj = new URL(url);
        // フラグメントを削除
        urlObj.hash = '';
        // 末尾のスラッシュを統一
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

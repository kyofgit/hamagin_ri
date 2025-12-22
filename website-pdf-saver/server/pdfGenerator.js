import puppeteer from 'puppeteer';
import { PDFDocument } from 'pdf-lib';
import fs from 'fs';
import path from 'path';

/**
 * 複数ページのHTMLを一つのPDFとして生成（超軽量版）
 */
export async function generatePDF(pages, outputPath, tempDir, onProgress, checkCancel) {
    let browser;
    let page;

    const setupBrowser = async () => {
        if (browser) {
            try { await browser.close(); } catch (e) { }
        }
        console.log('PDF生成用ブラウザを起動...');
        browser = await puppeteer.launch({
            headless: 'new',
            protocolTimeout: 60000,
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
                '--disable-translate',
                '--disable-hang-monitor',
                '--disable-prompt-on-repost',
                '--disable-client-side-phishing-detection',
                '--disable-popup-blocking',
                '--disable-component-update',
                '--metrics-recording-only',
                '--mute-audio',
                '--no-first-run',
                '--safebrowsing-disable-auto-update',
                '--single-process', // 省メモリ
                '--no-zygote', // 省メモリ
            ],
        });
    };

    const setupPage = async () => {
        try {
            if (!browser || !browser.isConnected()) {
                await setupBrowser();
            }
            if (page) {
                try { await page.close(); } catch (e) { }
            }
            page = await browser.newPage();

            // ★ 全ての外部リクエストをブロック → 超高速化
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                // dataスキームとaboutスキーム以外は全てブロック
                const url = req.url();
                if (url.startsWith('data:') || url.startsWith('about:')) {
                    req.continue();
                } else {
                    req.abort();
                }
            });

            await page.setViewport({ width: 1200, height: 900 });

        } catch (err) {
            console.error('ページ作成失敗:', err.message);
            await setupBrowser();
            page = await browser.newPage();
            await page.setViewport({ width: 1200, height: 900 });
        }
    };

    try {
        await setupBrowser();
        await setupPage();

        const pdfPaths = [];
        let successCount = 0;

        for (let i = 0; i < pages.length; i++) {
            if (checkCancel && checkCancel()) {
                console.log('PDF生成中断（キャンセル）');
                break;
            }

            const pageData = pages[i];

            // 進捗報告
            onProgress({
                processed: i + 1,
                total: pages.length,
            });

            // 5ページごとにブラウザ再起動
            if (i > 0 && i % 5 === 0) {
                console.log(`${i}ページ処理済み。ブラウザ再起動...`);
                if (browser) try { await browser.close(); } catch (e) { }
                await setupBrowser();
                await setupPage();
            }

            try {
                console.log(`PDF [${i + 1}/${pages.length}]: ${pageData.url}`);

                // HTMLを読み込む
                let htmlContent = '';
                try {
                    htmlContent = fs.readFileSync(pageData.htmlPath, 'utf-8');
                } catch (e) {
                    console.log(`  → HTML読み込み失敗、スキップ`);
                    continue;
                }

                // 外部リソース参照を削除してシンプル化
                htmlContent = simplifyHtml(htmlContent, pageData.url);

                // ★ setContent - 外部リソースをブロックしているので即座に完了する
                await page.setContent(htmlContent, {
                    waitUntil: 'domcontentloaded',
                    timeout: 5000  // 5秒で十分
                });

                // PDF生成
                const pdfBuffer = await page.pdf({
                    format: 'A4',
                    printBackground: true,
                    margin: { top: '15mm', right: '10mm', bottom: '15mm', left: '10mm' },
                });

                // 保存
                const tempPdfPath = path.join(tempDir, `pdf_${i}.pdf`);
                fs.writeFileSync(tempPdfPath, pdfBuffer);
                pdfPaths.push(tempPdfPath);
                successCount++;

            } catch (error) {
                console.log(`  → エラー: ${error.message}, スキップ`);
                // ページ再作成を試みる
                try { await setupPage(); } catch (e) { }
            }
        }

        console.log(`PDF生成完了: ${successCount}/${pages.length} ページ成功`);

        // ブラウザを閉じる
        if (browser) try { await browser.close(); } catch (e) { }

        if (pdfPaths.length === 0) {
            throw new Error('PDFを生成できませんでした');
        }

        // 全てのPDFを結合
        console.log('PDFを結合中...');
        const mergedPdf = await PDFDocument.create();

        for (const tempPdfPath of pdfPaths) {
            try {
                const pdfBytes = fs.readFileSync(tempPdfPath);
                const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
                const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
                copiedPages.forEach(p => mergedPdf.addPage(p));
            } catch (error) {
                console.error('結合エラー:', error.message);
            }
        }

        mergedPdf.setTitle('ウェブサイト一括PDF保存');
        mergedPdf.setCreator('Website PDF Saver');
        mergedPdf.setCreationDate(new Date());

        const mergedPdfBytes = await mergedPdf.save();
        fs.writeFileSync(outputPath, mergedPdfBytes);

        console.log(`PDFが保存されました: ${outputPath}`);
        return outputPath;

    } catch (error) {
        console.error('PDF生成で致命的エラー:', error.message);
        if (browser) try { await browser.close(); } catch (e) { }
        throw error;
    }
}

/**
 * HTMLをシンプル化（外部リソース参照を削除し、ヘッダーを追加）
 */
function simplifyHtml(html, url) {
    // <script>タグを削除（JavaScriptは不要）
    html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

    // 外部CSS linkを削除
    html = html.replace(/<link[^>]*rel=["']stylesheet["'][^>]*>/gi, '');

    // 外部画像を削除（または空に）
    html = html.replace(/<img[^>]*src=["']https?:\/\/[^"']*["'][^>]*>/gi, '[画像]');

    // iframeを削除
    html = html.replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '');

    // ヘッダーを追加
    const headerHtml = `
        <div style="background:#005BAC; color:white; padding:12px 16px; margin-bottom:20px; font-family:sans-serif; font-size:14px; border-radius:4px;">
            📄 ${url}
        </div>
    `;

    // 基本スタイルを追加
    const basicStyle = `
        <style>
            body { font-family: "Noto Sans JP", "Hiragino Sans", sans-serif; line-height: 1.6; color: #333; padding: 20px; }
            a { color: #005BAC; }
            img { max-width: 100%; height: auto; }
            table { border-collapse: collapse; width: 100%; }
            th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        </style>
    `;

    // <head>内または先頭にスタイルを追加
    if (html.includes('</head>')) {
        html = html.replace('</head>', basicStyle + '</head>');
    } else {
        html = basicStyle + html;
    }

    // <body>直後にヘッダーを追加
    if (html.includes('<body')) {
        html = html.replace(/(<body[^>]*>)/i, '$1' + headerHtml);
    } else {
        html = '<body>' + headerHtml + html + '</body>';
    }

    return html;
}

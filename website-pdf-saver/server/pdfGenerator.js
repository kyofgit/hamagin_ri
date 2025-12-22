import puppeteer from 'puppeteer';
import { PDFDocument } from 'pdf-lib';
import fs from 'fs';

/**
 * 複数ページのHTMLを一つのPDFとして生成
 * @param {Array} pages - ページ情報の配列
 * @param {string} outputPath - 出力ファイルパス
 * @param {function} onProgress - 進捗コールバック
 */
export async function generatePDF(pages, outputPath, tempDir, onProgress, checkCancel) {
    let browser;
    let page;

    // ... (setupBrowser unchanged) ...
    const setupBrowser = async () => {
        if (browser) await browser.close().catch(() => { });
        browser = await puppeteer.launch({
            headless: 'new',
            protocolTimeout: 240000,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions',
            ],
        });
    };

    // ... (setupPage unchanged) ...
    const setupPage = async () => {
        try {
            if (!browser || !browser.isConnected()) {
                await setupBrowser();
            }
            if (page) await page.close().catch(() => { });
            page = await browser.newPage();
        } catch (err) {
            console.error('PDF生成用ページ/ブラウザの作成に失敗:', err);
            try {
                await setupBrowser();
                page = await browser.newPage();
            } catch (fatalError) {
                console.error('致命的エラー: ブラウザの再起動にも失敗しました', fatalError);
                throw fatalError;
            }
        }
    };

    try {
        await setupBrowser();
        await setupPage();

        const pdfPaths = [];

        for (let i = 0; i < pages.length; i++) {
            // キャンセルチェック
            if (checkCancel && checkCancel()) {
                console.log('PDF生成中断（キャンセル）');
                break;
            }

            const pageData = pages[i];

            console.log(`PDF生成中: ${pageData.url}`);

            // 進捗報告
            onProgress({
                processed: i + 1,
                total: pages.length,
            });

            try {
                // 定期的にブラウザを再起動（5ページごと）
                if (i > 0 && i % 5 === 0) {
                    console.log('メモリ解放のためブラウザを再起動します...');
                    await setupBrowser();
                    page = null;
                }

                if (!page) await setupPage();

                // 画面表示モードをエミュレート（background graphicsなどを強制表示し、print用CSSによる非表示を回避）
                await page.emulateMediaType('screen');

                // JSを無効化（SPAの再ハイドレーションによるDOM破壊を防ぐため、収集した静的HTMLをそのままレンダリング）
                await page.setJavaScriptEnabled(false);

                // ディスクからHTMLを読み込む
                let htmlContent = '';
                try {
                    htmlContent = fs.readFileSync(pageData.htmlPath, 'utf-8');
                } catch (readError) {
                    console.error(`${pageData.url} のHTML読み込みに失敗:`, readError);
                    continue; // 読み込めなければスキップ
                }

                // HTMLを設定 (JS無効なので load イベントで十分)
                await page.setContent(htmlContent, { waitUntil: 'load', timeout: 60000 });

                // (中略 - unchanged styles and header injection) ...
                // スタイルを調整してPDF向けに最適化
                await page.evaluate(() => {
                    const style = document.createElement('style');
                    style.textContent = `
            @media print {
              * {
                -webkit-print-color-adjust: exact !important;
                print-color-adjust: exact !important;
              }
              body {
                margin: 0;
                padding: 20px;
              }
              a {
                text-decoration: underline;
              }
            }
          `;
                    document.head.appendChild(style);
                });

                // ページヘッダーを追加
                await page.evaluate((url) => {
                    const header = document.createElement('div');
                    header.style.cssText = `
            background: #f0f0f0;
            padding: 10px;
            margin-bottom: 20px;
            border-bottom: 2px solid #333;
            font-family: sans-serif;
            font-size: 12px;
          `;
                    header.innerHTML = `<strong>📄 ${url}</strong>`;
                    document.body.insertBefore(header, document.body.firstChild);
                }, pageData.url);


                // PDFを生成
                const pdfBuffer = await page.pdf({
                    format: 'A4',
                    printBackground: true,
                    margin: {
                        top: '20mm',
                        right: '15mm',
                        bottom: '20mm',
                        left: '15mm',
                    },
                });

                // 一時ファイルとして保存
                const tempPdfPath = path.join(tempDir, `pdf_${i}.pdf`);
                fs.writeFileSync(tempPdfPath, pdfBuffer);
                pdfPaths.push(tempPdfPath);

            } catch (error) {
                console.error(`${pageData.url} のPDF生成中にエラーが発生しました:`, error.message);
                await setupPage();
            }
        }

        if (page) await page.close().catch(() => { });
        if (browser) await browser.close().catch(() => { });

        // 全てのPDFを結合
        console.log('PDFを結合中...');
        const mergedPdf = await PDFDocument.create();

        for (const tempPdfPath of pdfPaths) {
            try {
                // ファイルから読み込む
                const pdfBytes = fs.readFileSync(tempPdfPath);
                const pdf = await PDFDocument.load(pdfBytes);
                const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
                copiedPages.forEach(p => mergedPdf.addPage(p));
                // ループスコープを抜ければ pdfBytes と pdf は解放される
            } catch (error) {
                console.error('PDF結合中にエラーが発生しました:', error.message);
            }
        }

        // メタデータを設定
        mergedPdf.setTitle('ウェブサイト一括PDF保存');
        mergedPdf.setCreator('Website PDF Saver');
        mergedPdf.setCreationDate(new Date());

        // ファイルに保存
        const mergedPdfBytes = await mergedPdf.save();
        fs.writeFileSync(outputPath, mergedPdfBytes);

        console.log(`PDFが保存されました: ${outputPath}`);
        return outputPath;

    } catch (error) {
        if (browser) await browser.close().catch(() => { });
        throw error;
    }
}

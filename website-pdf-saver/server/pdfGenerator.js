import puppeteer from 'puppeteer';
import { PDFDocument } from 'pdf-lib';
import fs from 'fs';
import path from 'path';

/**
 * 複数ページのHTMLを一つのPDFとして生成
 * @param {Array} pages - ページ情報の配列
 * @param {string} outputPath - 出力ファイルパス
 * @param {function} onProgress - 進捗コールバック
 */
export async function generatePDF(pages, outputPath, tempDir, onProgress, checkCancel) {
    let browser;
    let page;

    const setupBrowser = async () => {
        if (browser) {
            try {
                await browser.close();
            } catch (e) {
                // Ignore
            }
        }
        console.log('PDF生成用ブラウザを起動...');
        browser = await puppeteer.launch({
            headless: 'new',
            protocolTimeout: 120000,
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
                try { await page.close(); } catch (e) { }
            }
            page = await browser.newPage();
            page.setDefaultNavigationTimeout(20000);
            page.setDefaultTimeout(20000);
            await page.setViewport({ width: 1280, height: 1024 });
            await page.emulateMediaType('screen');
        } catch (err) {
            console.error('ページ作成失敗、ブラウザ再起動:', err.message);
            await setupBrowser();
            page = await browser.newPage();
            page.setDefaultNavigationTimeout(20000);
            page.setDefaultTimeout(20000);
            await page.setViewport({ width: 1280, height: 1024 });
            await page.emulateMediaType('screen');
        }
    };

    try {
        await setupBrowser();
        await setupPage();

        const pdfPaths = [];
        let successCount = 0;

        for (let i = 0; i < pages.length; i++) {
            // キャンセルチェック
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

            // 定期的にブラウザを再起動（3ページごと - より積極的に）
            if (i > 0 && i % 3 === 0) {
                console.log(`${i}ページ処理済み。ブラウザ再起動...`);
                await setupBrowser();
                await setupPage();
            }

            try {
                console.log(`PDF生成中 [${i + 1}/${pages.length}]: ${pageData.url}`);

                // ★ ウォッチドッグタイマー付きでPDF生成
                const pdfPath = await Promise.race([
                    generateSinglePDF(page, pageData, tempDir, i),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('PDF生成タイムアウト（30秒）')), 30000)
                    )
                ]);

                if (pdfPath) {
                    pdfPaths.push(pdfPath);
                    successCount++;
                }

            } catch (error) {
                console.error(`[ERROR] ${pageData.url}: ${error.message}`);
                // エラー時はページを再作成
                try {
                    await setupPage();
                } catch (e) {
                    console.error('リカバリー失敗、ブラウザ再起動...');
                    await setupBrowser();
                    await setupPage();
                }
                // スキップして次へ
            }
        }

        console.log(`PDF生成完了。${successCount}/${pages.length} ページ成功`);

        // ブラウザを閉じる
        if (page) try { await page.close(); } catch (e) { }
        if (browser) try { await browser.close(); } catch (e) { }

        // 何もPDFがなければエラー
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
                console.error('PDF結合エラー:', error.message);
            }
        }

        // メタデータを設定
        mergedPdf.setTitle('ウェブサイト一括PDF保存');
        mergedPdf.setCreator('Website PDF Saver');
        mergedPdf.setCreationDate(new Date());

        // ファイルに保存
        const mergedPdfBytes = await mergedPdf.save();
        fs.writeFileSync(outputPath, mergedPdfBytes);

        console.log(`PDFが保存されました: ${outputPath} (${pdfPaths.length}ページ)`);
        return outputPath;

    } catch (error) {
        console.error('PDF生成で致命的エラー:', error.message);
        if (browser) try { await browser.close(); } catch (e) { }
        throw error;
    }
}

/**
 * 単一ページのPDFを生成（分離してタイムアウト制御しやすく）
 */
async function generateSinglePDF(page, pageData, tempDir, index) {
    // ディスクからHTMLを読み込む
    let htmlContent = '';
    try {
        htmlContent = fs.readFileSync(pageData.htmlPath, 'utf-8');
    } catch (readError) {
        console.log(`HTML読み込み失敗: ${pageData.url}`);
        return null;
    }

    // スタイル注入（シンプル化）
    const printStyle = `
    <style>
        @media print {
            * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
            body { margin: 0; padding: 20px; }
        }
        /* ページヘッダー */
        .pdf-page-header { 
            background: #f0f0f0; padding: 10px; margin-bottom: 20px; 
            border-bottom: 2px solid #333; font-family: sans-serif; font-size: 12px;
        }
    </style>`;

    const headerHtml = `<div class="pdf-page-header">📄 ${pageData.url}</div>`;

    // </head>の直前にスタイルを挿入
    if (htmlContent.includes('</head>')) {
        htmlContent = htmlContent.replace('</head>', `${printStyle}</head>`);
    } else {
        htmlContent = printStyle + htmlContent;
    }

    // <body>の直後にヘッダーを挿入
    if (htmlContent.includes('<body')) {
        htmlContent = htmlContent.replace(/(<body[^>]*>)/i, `$1${headerHtml}`);
    } else {
        htmlContent = `<body>${headerHtml}${htmlContent}</body>`;
    }

    // HTMLを設定 - 短いタイムアウト
    await page.setContent(htmlContent, {
        waitUntil: 'domcontentloaded',
        timeout: 15000
    });

    // PDFを生成
    const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: {
            top: '15mm',
            right: '10mm',
            bottom: '15mm',
            left: '10mm',
        },
        timeout: 15000,
    });

    // 一時ファイルとして保存
    const tempPdfPath = path.join(tempDir, `pdf_${index}.pdf`);
    fs.writeFileSync(tempPdfPath, pdfBuffer);

    return tempPdfPath;
}

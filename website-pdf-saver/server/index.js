import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { crawlWebsite } from './crawler.js';
import { generatePDF } from './pdfGenerator.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// ジョブの状態を保持
const jobs = new Map();

// PDFファイルの保存先
const outputDir = path.join(__dirname, '../output');
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

// プロダクション環境での静的ファイル配信
if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.join(__dirname, '../dist')));
}

// クローリング開始
app.post('/api/crawl', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URLが必要です' });
    }

    // URL形式の検証
    try {
        new URL(url);
    } catch (e) {
        return res.status(400).json({ error: '無効なURL形式です' });
    }

    const jobId = uuidv4();

    // ジョブを初期化
    jobs.set(jobId, {
        status: 'crawling',
        totalPages: 0,
        processedPages: 0,
        currentUrl: url,
        pages: [],
        error: null,
        pdfPath: null,
    });

    res.json({ jobId });

    // バックグラウンドでクローリングを開始
    (async () => {
        try {
            const job = jobs.get(jobId);

            // クローリング実行
            const pages = await crawlWebsite(url, (progress) => {
                job.totalPages = progress.totalFound;
                job.processedPages = progress.processed;
                job.currentUrl = progress.currentUrl;
            });

            job.pages = pages;
            job.status = 'generating_pdf';
            job.processedPages = 0;
            job.totalPages = pages.length;

            // PDF生成
            const pdfPath = path.join(outputDir, `${jobId}.pdf`);
            await generatePDF(pages, pdfPath, (progress) => {
                job.processedPages = progress.processed;
            });

            job.status = 'completed';
            job.pdfPath = pdfPath;
        } catch (error) {
            console.error('エラー:', error);
            const job = jobs.get(jobId);
            if (job) {
                job.status = 'error';
                job.error = error.message;
            }
        }
    })();
});

// ステータス取得
app.get('/api/status/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = jobs.get(jobId);

    if (!job) {
        return res.status(404).json({ error: 'ジョブが見つかりません' });
    }

    res.json({
        status: job.status,
        totalPages: job.totalPages,
        processedPages: job.processedPages,
        currentUrl: job.currentUrl,
        error: job.error,
    });
});

// PDFダウンロード
app.get('/api/download/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = jobs.get(jobId);

    if (!job) {
        return res.status(404).json({ error: 'ジョブが見つかりません' });
    }

    if (job.status !== 'completed') {
        return res.status(400).json({ error: 'PDFが準備できていません' });
    }

    if (!job.pdfPath || !fs.existsSync(job.pdfPath)) {
        return res.status(404).json({ error: 'PDFファイルが見つかりません' });
    }

    res.download(job.pdfPath, 'website.pdf');
});

// 発見されたページ一覧を取得
app.get('/api/pages/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = jobs.get(jobId);

    if (!job) {
        return res.status(404).json({ error: 'ジョブが見つかりません' });
    }

    res.json({
        pages: job.pages.map(p => ({ url: p.url, title: p.title })),
    });
});

// その他のリクエストはReactアプリを返す（SPA対応）
if (process.env.NODE_ENV === 'production') {
    app.get('*', (req, res) => {
        res.sendFile(path.join(__dirname, '../dist/index.html'));
    });
}

app.listen(PORT, () => {
    console.log(`サーバーが起動しました: http://localhost:${PORT}`);
});

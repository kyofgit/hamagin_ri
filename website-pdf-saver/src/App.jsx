import { useState, useEffect, useRef } from 'react';

function App() {
    const [url, setUrl] = useState('');
    const [jobId, setJobId] = useState(null);
    const [status, setStatus] = useState(null);
    const [error, setError] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const pollingRef = useRef(null);

    // ステータスのポーリング
    useEffect(() => {
        if (!jobId) return;

        const pollStatus = async () => {
            try {
                const response = await fetch(`/api/status/${jobId}`);
                const data = await response.json();

                setStatus(data);

                if (data.status === 'completed') {
                    clearInterval(pollingRef.current);
                    setIsLoading(false);
                } else if (data.status === 'error') {
                    clearInterval(pollingRef.current);
                    setError(data.error);
                    setIsLoading(false);
                }
            } catch (err) {
                console.error('Status polling error:', err);
            }
        };

        pollingRef.current = setInterval(pollStatus, 1000);
        pollStatus(); // 即座に最初のポーリング

        return () => {
            if (pollingRef.current) {
                clearInterval(pollingRef.current);
            }
        };
    }, [jobId]);

    // クローリング開始
    const handleSubmit = async (e) => {
        e.preventDefault();

        if (!url) {
            setError('URLを入力してください');
            return;
        }

        setError(null);
        setStatus(null);
        setJobId(null);
        setIsLoading(true);

        try {
            const response = await fetch('/api/crawl', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url }),
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'エラーが発生しました');
            }

            setJobId(data.jobId);
        } catch (err) {
            setError(err.message);
            setIsLoading(false);
        }
    };

    // PDFダウンロード
    const handleDownload = () => {
        if (jobId) {
            window.location.href = `/api/download/${jobId}`;
        }
    };

    // ステータステキスト
    const getStatusText = () => {
        if (!status) return '';

        switch (status.status) {
            case 'crawling':
                return `🔍 クローリング中... (${status.processedPages}ページ処理済み)`;
            case 'generating_pdf':
                return `📄 PDF生成中... (${status.processedPages}/${status.totalPages}ページ)`;
            case 'completed':
                return '✅ 完了！PDFをダウンロードできます';
            case 'error':
                return '❌ エラーが発生しました';
            default:
                return '処理中...';
        }
    };

    // 進捗率の計算
    const getProgress = () => {
        if (!status || status.totalPages === 0) return 0;
        return Math.round((status.processedPages / status.totalPages) * 100);
    };

    return (
        <div className="app">
            <div className="container">
                <header className="header">
                    <div className="logo">
                        <span className="logo-icon">📑</span>
                        <h1>Website PDF Saver</h1>
                    </div>
                    <p className="subtitle">ウェブサイトを一括でPDF保存</p>
                </header>

                <main className="main">
                    <form onSubmit={handleSubmit} className="form">
                        <div className="input-group">
                            <label htmlFor="url">企業のトップページURL</label>
                            <input
                                type="url"
                                id="url"
                                value={url}
                                onChange={(e) => setUrl(e.target.value)}
                                placeholder="https://www.example.com/"
                                disabled={isLoading}
                                autoComplete="url"
                            />
                        </div>

                        <button
                            type="submit"
                            className={`submit-btn ${isLoading ? 'loading' : ''}`}
                            disabled={isLoading}
                        >
                            {isLoading ? (
                                <>
                                    <span className="spinner"></span>
                                    処理中...
                                </>
                            ) : (
                                <>
                                    <span>🚀</span>
                                    PDF保存を開始
                                </>
                            )}
                        </button>
                    </form>

                    {error && (
                        <div className="error-message">
                            <span>⚠️</span>
                            {error}
                        </div>
                    )}

                    {status && (
                        <div className="status-panel">
                            <div className="status-header">
                                <h3>{getStatusText()}</h3>
                            </div>

                            {status.currentUrl && status.status === 'crawling' && (
                                <div className="current-url">
                                    <span className="label">現在のページ:</span>
                                    <span className="url">{status.currentUrl}</span>
                                </div>
                            )}

                            {(status.status === 'crawling' || status.status === 'generating_pdf') && (
                                <div className="progress-container">
                                    <div className="progress-bar">
                                        <div
                                            className="progress-fill"
                                            style={{ width: `${getProgress()}%` }}
                                        ></div>
                                    </div>
                                    <span className="progress-text">{getProgress()}%</span>
                                </div>
                            )}

                            {status.status === 'completed' && (
                                <button
                                    onClick={handleDownload}
                                    className="download-btn"
                                >
                                    <span>📥</span>
                                    PDFをダウンロード
                                </button>
                            )}
                        </div>
                    )}

                    <div className="info-section">
                        <h3>💡 使い方</h3>
                        <ol>
                            <li>保存したい企業のトップページURLを入力します</li>
                            <li>「PDF保存を開始」ボタンをクリックします</li>
                            <li>アプリが自動的に同一ドメイン内のページをクロールします</li>
                            <li>完了後、「PDFをダウンロード」ボタンが表示されます</li>
                        </ol>

                        <div className="notes">
                            <h4>📌 注意事項</h4>
                            <ul>
                                <li>同一ドメイン内のページのみが対象です（外部リンクは除外）</li>
                                <li><strong>ページ数の上限はありません</strong>（サイトの全ページを取得します）</li>
                                <li>大規模サイトの場合、処理に時間がかかることがあります</li>
                                <li>テキスト情報は読み取り可能な状態でPDFに保存されます</li>
                            </ul>
                        </div>
                    </div>
                </main>

                <footer className="footer">
                    <p>Website PDF Saver © 2024</p>
                </footer>
            </div>
        </div>
    );
}

export default App;

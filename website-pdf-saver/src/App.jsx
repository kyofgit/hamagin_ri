import { useState, useEffect, useRef } from 'react';
import robotImage from './assets/robot.png';
import './App.css';

function App() {
    const [url, setUrl] = useState('');
    const [jobId, setJobId] = useState(null);
    const [status, setStatus] = useState(null);
    const [error, setError] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isCanceling, setIsCanceling] = useState(false);
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
                    setIsCanceling(false);
                } else if (data.status === 'error') {
                    clearInterval(pollingRef.current);
                    setError(data.error);
                    setIsLoading(false);
                    setIsCanceling(false);
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
        setIsCanceling(false);

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

    // キャンセル処理
    const handleCancel = async () => {
        if (!jobId) return;
        setIsCanceling(true);
        try {
            await fetch(`/api/cancel/${jobId}`, { method: 'POST' });
        } catch (err) {
            console.error('Cancellation error:', err);
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
        if (isCanceling) return '🛑 キャンセル処理中... (今の分まででPDFを作ります)';
        if (!status) return '';

        switch (status.status) {
            case 'crawling':
                return `🔍 ロボットが調査中... (${status.processedPages}ページ見つけました)`;
            case 'generating_pdf':
                return `📄 PDFを作成しています... (${status.processedPages}/${status.totalPages})`;
            case 'completed':
                if (status.error === 'cancelled') { // 念のため
                    return '✅ キャンセル完了！ここまでの分をダウンロードできます';
                }
                return '✅ 完了しました！';
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
                    <img src={robotImage} alt="Friendly Robot" className="mascot-image" />
                    <h1>Website PDF Saver</h1>
                    <p className="subtitle">URLを入れるだけで、ロボットが全部PDFにしてきてくれます！</p>
                </header>

                <main className="main">
                    <form onSubmit={handleSubmit} className="form">
                        <div className="input-group">
                            <input
                                type="text"
                                id="url"
                                value={url}
                                onChange={(e) => setUrl(e.target.value)}
                                placeholder="例：https://www.example.com/"
                                disabled={isLoading}
                                autoComplete="url"
                            />
                        </div>

                        {!isLoading ? (
                            <button
                                type="submit"
                                className="btn-primary"
                                disabled={isLoading}
                            >
                                🚀 PDF保存をスタート
                            </button>
                        ) : (
                            <div className="loading-controls">
                                <div className="spinner"></div>
                                <button
                                    type="button"
                                    onClick={handleCancel}
                                    className="btn-cancel"
                                    disabled={isCanceling}
                                >
                                    {isCanceling ? '停止中...' : '✋ 途中でやめる（そこまでの分を保存）'}
                                </button>
                            </div>
                        )}
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
                                <h3 className="status-text">{getStatusText()}</h3>
                            </div>

                            {status.currentUrl && status.status === 'crawling' && !isCanceling && (
                                <div className="status-detail">
                                    見ています: {status.currentUrl}
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
                                <div className="download-section">
                                    <div className="success-message">お待たせしました！準備できました。</div>
                                    <button
                                        onClick={handleDownload}
                                        className="btn-download"
                                    >
                                        📥 PDFをダウンロード
                                    </button>
                                    <div className="notes">
                                        ※「途中でやめる」を押した場合でも、集めた分だけダウンロードできます
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    <div className="info-section notes">
                        <p>・同一ドメイン（同じサイト）のページを全部自動で集めます。</p>
                        <p>・ページ数が多くても大丈夫ですが、時間がかかることがあります。</p>
                    </div>
                </main>
            </div>
        </div>
    );
}

export default App;

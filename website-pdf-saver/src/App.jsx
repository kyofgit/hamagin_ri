import { useState, useEffect } from 'react';
import './App.css';
import techBg from './assets/modern_tech_background.png';

function App() {
  const [url, setUrl] = useState('');
  const [jobId, setJobId] = useState(null);
  const [status, setStatus] = useState(null); // 'crawling', 'generating_pdf', 'completed', 'error', 'canceled'
  const [progress, setProgress] = useState({ total: 0, processed: 0, currentUrl: '' });
  const [downloadUrl, setDownloadUrl] = useState(null);
  const [pages, setPages] = useState([]); // List of found pages
  const [errorMessage, setErrorMessage] = useState('');
  const [isCanceling, setIsCanceling] = useState(false);

  // Poll status
  useEffect(() => {
    let interval;
    if (jobId && status !== 'completed' && status !== 'error' && !isCanceling) {
      interval = setInterval(async () => {
        try {
          const res = await fetch(`/api/status/${jobId}`);
          if (res.ok) {
            const data = await res.json();

            // Map backend status to frontend state
            if (data.status === 'crawling') setStatus('crawling');
            else if (data.status === 'generating_pdf') setStatus('generating_pdf');
            else if (data.status === 'completed') {
              setStatus('completed');
              console.log('Job completed, setting download URL');
              setDownloadUrl(`/api/download/${jobId}`);
            } else if (data.status === 'error') {
              setStatus('error');
              setErrorMessage(data.error);
            }

            setProgress({
              total: data.totalPages,
              processed: data.processedPages,
              currentUrl: data.currentUrl,
            });

            // Fetch pages list if crawling
            if (data.status === 'crawling' || data.status === 'generating_pdf' || data.status === 'completed') {
              try {
                const pagesRes = await fetch(`/api/pages/${jobId}`);
                if (pagesRes.ok) {
                  const pagesData = await pagesRes.json();
                  setPages(pagesData.pages);
                }
              } catch (e) { /* ignore */ }
            }

          }
        } catch (error) {
          console.error('Status check failed', error);
        }
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [jobId, status, isCanceling]);

  const startJob = async () => {
    if (!url) return;
    setStatus('starting');
    setErrorMessage('');
    setPages([]);
    setProgress({ total: 0, processed: 0, currentUrl: '' });
    setIsCanceling(false);
    setDownloadUrl(null);

    try {
      const res = await fetch('/api/crawl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      if (res.ok) {
        const data = await res.json();
        setJobId(data.jobId);
        setStatus('crawling');
      } else {
        const err = await res.json();
        setErrorMessage(err.error || '開始できませんでした');
        setStatus('error');
      }
    } catch (error) {
      setErrorMessage('サーバーに接続できません');
      setStatus('error');
    }
  };

  const cancelJob = async () => {
    if (!jobId) return;
    setIsCanceling(true);
    try {
      await fetch(`/api/cancel/${jobId}`, { method: 'POST' });
      // Force status update logic to wait for backend to finish up
      setStatus('canceling');
    } catch (e) {
      console.error("Cancel failed", e);
      setIsCanceling(false);
    }
  };


  // Helper to determine status display
  const getStatusDisplay = () => {
    if (status === 'starting') return { icon: '🚀', text: '起動中...', sub: '準備しています' };
    if (status === 'crawling') return { icon: '🔍', text: 'スキャン中', sub: `ページを探索しています... ${progress.processed}件` };
    if (status === 'generating_pdf') return { icon: '⚙️', text: 'PDF化中...', sub: 'ドキュメントを生成しています' };
    if (status === 'completed') return { icon: '✅', text: '完了', sub: 'ダウンロード準備OK' };
    if (status === 'error') return { icon: '❌', text: 'エラー', sub: errorMessage };
    if (status === 'canceling') return { icon: '🛑', text: '停止中...', sub: '現在の処理を完了させています' };
    return { icon: '💻', text: '待機中', sub: 'URLを入力してスタート' };
  };

  const statusInfo = getStatusDisplay();

  return (
    <div className="app-container" style={{ backgroundImage: `url(${techBg})` }}>
      <header className="app-header">
        <div className="brand-logo" style={{ fontSize: '2rem' }}>📑</div>
        <h1 className="brand-title">PDF SAVER PRO</h1>
      </header>

      <main className="main-content">

        {/* Left Column: Controls */}
        <div className="control-panel">

          {/* Status Card */}
          <div className="card status-card">
            <div className="status-indicator">{statusInfo.icon}</div>
            <div className="status-text">{statusInfo.text}</div>
            <div className="status-subtext">{statusInfo.sub}</div>

            {/* Progress Bar */}
            {(status === 'crawling' || status === 'generating_pdf' || status === 'canceling') && (
              <div className="progress-container">
                <div className="progress-bar" style={{ width: '100%' }}></div>
              </div>
            )}
            {status === 'generating_pdf' && progress.total > 0 && (
              <div style={{ fontSize: '0.8rem', color: '#aaa', marginTop: '5px' }}>
                生成進捗: {progress.processed} / {progress.total}
              </div>
            )}
          </div>

          {/* Input Card */}
          <div className="card input-card">
            <div className="input-group">
              <label className="input-label">TARGET URL</label>
              <input
                type="text"
                className="url-input"
                placeholder="https://example.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={status === 'crawling' || status === 'generating_pdf' || status === 'canceling'}
              />
            </div>
          </div>

          {/* Action Buttons */}
          <div className="action-buttons">
            {!jobId || status === 'completed' || status === 'error' ? (
              <button
                className="btn btn-primary"
                onClick={startJob}
                disabled={!url || status === 'starting'}
              >
                <span>▶ START SCAN</span>
              </button>
            ) : (
              <button
                className="btn btn-danger"
                onClick={cancelJob}
                disabled={isCanceling || status === 'canceling'}
              >
                <span>{isCanceling ? 'STOPPING...' : '⏹ STOP & SAVE'}</span>
              </button>
            )}
          </div>

          {/* Download Card (Appears when done) */}
          {downloadUrl && (
            <div className="card" style={{ marginTop: '20px', borderColor: '#4facfe' }}>
              <a href={downloadUrl} className="btn btn-primary" style={{ textDecoration: 'none' }}>
                📥 DOWNLOAD PDF
              </a>
            </div>
          )}

        </div>

        {/* Right Column: Information & Logs */}
        <div className="info-panel">
          <div className="results-area">
            <div className="results-header">
              <div className="results-title">
                <span>DETECTED PAGES</span>
                {pages.length > 0 && <span className="page-count">{pages.length}</span>}
              </div>
            </div>
            <ul className="pages-list">
              {pages.map((p, i) => (
                <li key={i} className="page-item">
                  <span className="page-icon">📄</span>
                  <div className="page-info">
                    <div className="page-title">{p.title || 'No Title'}</div>
                    <div className="page-url">{p.url}</div>
                  </div>
                </li>
              ))}
              {pages.length === 0 && (
                <li className="page-item" style={{ justifyContent: 'center', color: '#64748b' }}>
                  Waiting for results...
                </li>
              )}
            </ul>
          </div>
        </div>

      </main>
    </div>
  );
}

export default App;

import { useState, useEffect } from 'react';
import './App.css';

function App() {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState('idle'); // idle, crawling, generating, complete, error, canceled
  const [progress, setProgress] = useState({ current: 0, total: 0, message: '' });
  const [downloadUrl, setDownloadUrl] = useState('');
  const [jobId, setJobId] = useState(null);
  const [isCanceling, setIsCanceling] = useState(false);

  // Polling for job status
  useEffect(() => {
    if (!jobId || status === 'complete' || status === 'error') {
      return;
    }

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/status/${jobId}`);
        if (!res.ok) {
          console.error('Status fetch failed');
          return;
        }
        const data = await res.json();

        if (data.status === 'crawling') {
          setStatus('crawling');
          setProgress({
            current: data.processedPages || 0,
            total: data.totalPages || 0,
            message: `ページ収集中: ${data.processedPages || 0} / ${data.totalPages || 0}`,
          });
        } else if (data.status === 'generating_pdf') {
          setStatus('generating');
          setProgress({
            current: data.processedPages || 0,
            total: data.totalPages || 0,
            message: `PDF作成中: ${data.processedPages || 0} / ${data.totalPages || 0}`,
          });
        } else if (data.status === 'completed') {
          setStatus('complete');
          setDownloadUrl(`/api/download/${jobId}`);
          setProgress(prev => ({ ...prev, message: '完了しました！' }));
          clearInterval(interval);
        } else if (data.status === 'error') {
          setStatus('error');
          setProgress(prev => ({ ...prev, message: `エラー: ${data.error}` }));
          clearInterval(interval);
        }
      } catch (error) {
        console.error('Polling error:', error);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [jobId, status]);

  const startProcess = async () => {
    if (!url) {
      alert('URLを入力してください');
      return;
    }

    setStatus('crawling');
    setProgress({ current: 0, total: 0, message: 'サーバーに接続中...' });
    setDownloadUrl('');
    setIsCanceling(false);
    setJobId(null);

    try {
      // Call the correct endpoint: /api/crawl
      const response = await fetch('/api/crawl', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url }),
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || '開始リクエストに失敗しました');
      }

      const data = await response.json();
      setJobId(data.jobId); // This triggers the useEffect polling
      setProgress({ current: 0, total: 0, message: 'クローリングを開始しました...' });

    } catch (error) {
      console.error('Error:', error);
      setStatus('error');
      setProgress({ current: 0, total: 0, message: error.message || '通信エラーが発生しました' });
    }
  };

  const cancelProcess = async () => {
    if (!jobId) return;
    setIsCanceling(true);
    try {
      await fetch(`/api/cancel/${jobId}`, { method: 'POST' });
      // Status will be updated via polling
    } catch (error) {
      console.error('Cancel failed:', error);
      setIsCanceling(false);
    }
  };

  // Calculate progress percentage
  const progressPercent = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  // ステータスに応じた表示ヘルパー
  const getStatusDisplay = () => {
    if (status === 'idle') return { step: 1, icon: '📋', title: 'Ready', desc: 'URLを入力して開始してください' };
    if (status === 'crawling') return { step: 2, icon: '🔍', title: 'Crawling...', desc: progress.message };
    if (status === 'generating') return { step: 3, icon: '⚙️', title: 'Generating PDF...', desc: progress.message };
    if (status === 'complete') return { step: 4, icon: '✅', title: 'Complete!', desc: 'PDFの作成が完了しました' };
    if (status === 'canceled') return { step: 4, icon: '⚠️', title: 'Canceled', desc: '処理を中断しました' };
    if (status === 'error') return { step: 4, icon: '❌', title: 'Error', desc: progress.message };
    return { step: 1, icon: '❓', title: 'Unknown', desc: '' };
  };

  const statusInfo = getStatusDisplay();

  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div className="brand-container">
          <img src="/logo-icon.png" alt="Logo" className="brand-logo" />
          <div>
            <h1 className="brand-title">Web Archive Utility</h1>
            <div className="brand-subtitle">Hamagin Research Institute</div>
          </div>
        </div>
      </header>

      <div className="main-content">
        {/* Left Column: Control Panel */}
        <aside className="control-panel">
          <div className="card">
            <h2 className="card-title">📝 新規アーカイブ作成</h2>

            <div className="input-group">
              <label className="input-label">保存対象URL</label>
              <input
                type="text"
                className="url-input"
                placeholder="https://example.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={status === 'crawling' || status === 'generating'}
              />
            </div>

            <div className="actions">
              <button
                className="btn btn-primary"
                onClick={startProcess}
                disabled={status === 'crawling' || status === 'generating' || !url}
              >
                {status === 'idle' || status === 'complete' || status === 'error' || status === 'canceled' ? 'アーカイブ開始' : '処理中...'}
              </button>
            </div>

            {(status === 'crawling' || status === 'generating') && (
              <button
                className="btn btn-danger"
                onClick={cancelProcess}
                disabled={isCanceling}
                style={{ marginTop: '1rem', width: '100%' }}
              >
                {isCanceling ? '中断処理中...' : '処理を中断する'}
              </button>
            )}
          </div>

          {/* Guide Card */}
          <div className="card guide-card">
            <h2 className="card-title">💡 使い方 & 注意点</h2>
            <ul className="info-list">
              <li><strong>URL入力:</strong> 保存したいウェブサイトのトップページURLを入力します。</li>
              <li><strong>同一ドメインのみ:</strong> 入力したURLと同じドメインのページのみを自動で巡回します。</li>
              <li><strong>時間:</strong> ページ数が多い場合、数分～数十分かかることがあります。</li>
              <li><strong>中断:</strong> 途中で中断しても、そこまで収集したページでPDFを作成します。</li>
            </ul>
          </div>
        </aside>

        {/* Right Column: Status & Results */}
        <main className="status-area">
          {/* Hero Banner */}
          <div className="hero-banner">
            <img src="/hero-header.png" alt="Research & Data" className="hero-img" />
            <div className="hero-overlay">
              <h2 className="hero-title">INTELLIGENT ARCHIVING</h2>
              <div className="hero-subtitle">Advanced Web Crawler & PDF Generation Engine</div>
            </div>
          </div>

          {/* Progress Steps */}
          <div className="step-container">
            <div className={`step-item ${statusInfo.step >= 1 ? 'active' : ''}`}>
              <div className="step-circle">1</div>
              <div className="step-label">準備</div>
            </div>
            <div className={`step-item ${statusInfo.step >= 2 ? 'active' : ''}`}>
              <div className="step-circle">2</div>
              <div className="step-label">調査</div>
            </div>
            <div className={`step-item ${statusInfo.step >= 3 ? 'active' : ''}`}>
              <div className="step-circle">3</div>
              <div className="step-label">生成</div>
            </div>
            <div className={`step-item ${statusInfo.step >= 4 ? 'active' : ''}`}>
              <div className="step-circle">4</div>
              <div className="step-label">完了</div>
            </div>
          </div>

          {/* Status Display */}
          <div className="status-card">
            <div className="status-icon">{statusInfo.icon}</div>
            <h2 className="status-text">{statusInfo.title}</h2>
            <p className="status-subtext">{statusInfo.desc}</p>

            {/* Real-time Progress Bar */}
            {(status === 'crawling' || status === 'generating') && (
              <div className="progress-section">
                <div className="progress-bar-container">
                  <div
                    className="progress-bar-fill"
                    style={{ width: `${progressPercent}%` }}
                  ></div>
                </div>
                <div className="progress-text">
                  {progress.current} / {progress.total} ページ ({progressPercent}%)
                </div>
              </div>
            )}

            {downloadUrl && (
              <div style={{ marginTop: '2rem' }}>
                <a href={downloadUrl} className="btn-download" download>
                  📥 PDFをダウンロード
                </a>
                {status === 'canceled' && <p style={{ marginTop: '1rem', fontSize: '0.9rem', color: '#666' }}>※中断時点までのデータが含まれています</p>}
              </div>
            )}
          </div>

        </main>
      </div>
    </div>
  );
}

export default App;

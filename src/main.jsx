import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('Pawfit Desk Runtime Error:', error, errorInfo);
  }

  handleReset = () => {
    localStorage.clear();
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh',
          backgroundColor: '#0a0a0a',
          color: '#f4f4f5',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          fontFamily: 'sans-serif',
          textAlign: 'center'
        }}>
          <div style={{
            maxWidth: '480px',
            backgroundColor: '#18181b',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '16px',
            padding: '24px',
            boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5)'
          }}>
            <h2 style={{ fontSize: '18px', fontWeight: 'bold', color: '#f87171', marginBottom: '12px' }}>
              Oops! May error na naganap
            </h2>
            <p style={{ fontSize: '13px', color: '#a1a1aa', marginBottom: '16px', wordBreak: 'break-word' }}>
              {this.state.error?.message || 'Unknown error'}
            </p>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
              <button
                onClick={() => window.location.reload()}
                style={{
                  backgroundColor: '#9333ea',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '8px',
                  padding: '10px 16px',
                  fontSize: '13px',
                  fontWeight: 'bold',
                  cursor: 'pointer'
                }}
              >
                Reload Page
              </button>
              <button
                onClick={this.handleReset}
                style={{
                  backgroundColor: '#27272a',
                  color: '#f87171',
                  border: '1px solid rgba(248,113,113,0.3)',
                  borderRadius: '8px',
                  padding: '10px 16px',
                  fontSize: '13px',
                  fontWeight: 'bold',
                  cursor: 'pointer'
                }}
              >
                Clear Cache & Reset
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
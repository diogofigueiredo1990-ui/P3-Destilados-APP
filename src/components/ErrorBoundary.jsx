import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f3f4f6',
          padding: '24px',
          fontFamily: 'Inter, sans-serif',
        }}>
          <div style={{
            background: '#fff',
            borderRadius: '16px',
            padding: '32px',
            maxWidth: '400px',
            width: '100%',
            boxShadow: '0 4px 20px rgba(0,0,0,0.1)',
            textAlign: 'center',
          }}>
            <p style={{ fontSize: '32px', margin: '0 0 12px' }}>⚠️</p>
            <h2 style={{ margin: '0 0 8px', fontSize: '18px', color: '#111827' }}>
              Algo deu errado
            </h2>
            <p style={{ margin: '0 0 20px', fontSize: '13px', color: '#6b7280' }}>
              Ocorreu um erro inesperado. Tente recarregar a página.
            </p>
            <button
              onClick={() => window.location.reload()}
              style={{
                background: '#0f3460',
                color: '#fff',
                border: 'none',
                borderRadius: '8px',
                padding: '10px 24px',
                fontSize: '14px',
                fontWeight: '600',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              🔄 Recarregar
            </button>
            {this.state.error && (
              <p style={{ marginTop: '16px', fontSize: '11px', color: '#9ca3af', wordBreak: 'break-all' }}>
                {String(this.state.error.message || this.state.error).slice(0, 120)}
              </p>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

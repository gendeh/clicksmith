// Placeholder for renderer entry point
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '../styles/global.css';

type BoundaryState = {
  hasError: boolean;
  message: string;
};

class AppErrorBoundary extends React.Component<React.PropsWithChildren, BoundaryState> {
  public state: BoundaryState = {
    hasError: false,
    message: '',
  };

  public static getDerivedStateFromError(error: unknown): BoundaryState {
    const message = error instanceof Error ? error.message : String(error);
    return { hasError: true, message };
  }

  public componentDidCatch(error: unknown) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    // Surface stack in terminal logs for debugging startup failures.
    // eslint-disable-next-line no-console
    console.error('[renderer] fatal error', message);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="app-shell">
          <section className="card" style={{ maxWidth: 820 }}>
            <div className="card-header">
              <h2>Renderer Crash</h2>
              <span className="hint">Unhandled runtime error</span>
            </div>
            <div className="inline-alert">{this.state.message || 'Unknown renderer error'}</div>
          </section>
        </div>
      );
    }

    return this.props.children;
  }
}

const root = document.getElementById('root');
if (!root) {
  throw new Error('Renderer root element #root not found');
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);

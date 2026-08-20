import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import './ErrorBoundary.css';

interface Props {
  children: React.ReactNode;
  /** What failed, in the operator's terms — "Battery Management", "CH 4". */
  label?: string;
  /** `card` for a single channel strip; `page` for a whole route. */
  variant?: 'page' | 'card';
}

interface State {
  error: Error | null;
}

// Without this, a render error anywhere unmounts the entire app — mid-show that
// means a black window. Wrapping each route and each channel strip keeps a
// failure local: one card degrades while the rest of the dashboard stays live.
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[RFDeck] ${this.props.label ?? 'Component'} failed to render:`, error, info);
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const label = this.props.label ?? 'This panel';

    if (this.props.variant === 'card') {
      return (
        <div className="eb-card" role="alert">
          <AlertTriangle size={16} />
          <div className="eb-card-body">
            <div className="eb-card-title">{label} failed to display</div>
            <div className="eb-card-msg">{error.message}</div>
          </div>
          <button className="eb-retry-sm" onClick={this.reset} title="Try again">
            <RotateCcw size={13} />
          </button>
        </div>
      );
    }

    return (
      <div className="eb-page" role="alert">
        <AlertTriangle size={34} />
        <h2 className="eb-page-title">{label} stopped working</h2>
        <p className="eb-page-msg">{error.message}</p>
        <p className="eb-page-hint">
          Device monitoring is still running in the background — other pages are unaffected.
        </p>
        <button className="eb-retry" onClick={this.reset}>
          <RotateCcw size={14} /> Try again
        </button>
      </div>
    );
  }
}

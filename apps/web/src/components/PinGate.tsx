import React, { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { fetchAuthStatus, submitPin, setPinRequiredHandler } from '../lib/api';
import './PinGate.css';

// Blocks the app until a remote client has entered the PIN.
//
// On the default open configuration, and always on the machine running RFDeck,
// this renders nothing and children mount immediately. It also re-arms mid-
// session: if a token expires because the admin set a re-auth interval, the API
// client calls back here and the prompt returns.
export function PinGate({ children }: { children: React.ReactNode }) {
  const [checking, setChecking] = useState(true);
  const [needsPin, setNeedsPin] = useState(false);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [offline, setOffline] = useState(false);

  // The Micboard is read-only and PIN-exempt by design: a wall display has
  // nobody to type a PIN, and the PIN exists to prevent changes rather than to
  // hide telemetry. Gating it here would defeat the exemption the server
  // already grants.
  const isMicboard = window.location.hash.startsWith('#/micboard');

  useEffect(() => {
    if (isMicboard) {
      setChecking(false);
      return;
    }
    setPinRequiredHandler(() => setNeedsPin(true));

    // This check must never hold the app hostage. A phone waking from
    // background often has a half-open connection, and a fetch with no
    // deadline hangs for the browser's own TCP give-up — about thirty
    // seconds of nothing on screen. Cap the wait: past the deadline the app
    // mounts and shows its own connection state, and if a PIN really is
    // required, the first 401 re-raises this gate through the handler above,
    // so nothing is bypassed — only un-blanked.
    let done = false;
    const settle = (fn: () => void) => { if (!done) { done = true; fn(); } };
    const deadline = setTimeout(() => settle(() => {
      setOffline(true);
      setChecking(false);
    }), 3_500);

    fetchAuthStatus()
      .then(status => settle(() => {
        setNeedsPin(!status.authenticated);
        setChecking(false);
      }))
      .catch(() => settle(() => {
        // Can't reach the server. Let the app mount and show its own connection
        // state rather than trapping the user behind a PIN box it can't verify.
        setOffline(true);
        setChecking(false);
      }));

    return () => {
      clearTimeout(deadline);
      setPinRequiredHandler(null);
    };
  }, [isMicboard]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pin || submitting) return;
    setSubmitting(true);
    setError(null);
    const ok = await submitPin(pin);
    setSubmitting(false);
    if (ok) {
      setNeedsPin(false);
      setPin('');
      // The socket authenticates during its handshake, so it has to be rebuilt
      // with the new token. Simplest correct route is a reload.
      window.location.reload();
    } else {
      setError('That PIN was not accepted.');
      setPin('');
    }
  };

  if (checking) {
    return <div className="pg-checking">Connecting to RFDeck…</div>;
  }

  if (!needsPin || offline) return <>{children}</>;

  return (
    <div className="pg-root">
      <form className="pg-card" onSubmit={handleSubmit}>
        <div className="pg-icon"><ShieldCheck size={26} /></div>
        <h1 className="pg-title">Enter PIN</h1>
        <p className="pg-sub">
          This RFDeck server requires a PIN from devices on the network.
        </p>

        <input
          className="pg-input"
          type="password"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={pin}
          onChange={e => { setPin(e.target.value.replace(/\D/g, '')); setError(null); }}
          placeholder="••••"
          maxLength={12}
          autoFocus
          aria-label="PIN"
        />

        {error && <p className="pg-error">{error}</p>}

        <button className="pg-submit" type="submit" disabled={!pin || submitting}>
          {submitting ? 'Checking…' : 'Connect'}
        </button>

        <p className="pg-hint">
          The PIN is set in Settings → Remote Access on the machine running RFDeck.
        </p>
      </form>
    </div>
  );
}

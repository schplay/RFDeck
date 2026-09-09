import React, { useEffect } from 'react';
import { useShortcutRegistry, isTypingTarget } from '../lib/shortcuts';
import './ShortcutsOverlay.css';

// What the keys do, on demand, anywhere.
//
// Mounted once above the router so it covers the full-screen views as well —
// Backstage and the Micboard render outside the sidebar shell, and they are
// exactly the screens somebody is put in front of without a tour.
//
// It lists whatever is registered right now rather than a fixed table, so a
// view that binds no keys says so instead of promising keys that do nothing.

export function ShortcutsOverlay() {
  const scopes = useShortcutRegistry(s => s.scopes);
  const helpOpen = useShortcutRegistry(s => s.helpOpen);
  const setHelpOpen = useShortcutRegistry(s => s.setHelpOpen);

  // "?" and Escape are handled here rather than through useShortcuts, because
  // they have to work even on a view that registers nothing at all.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setHelpOpen(false); return; }
      if (isTypingTarget(e.target)) return;
      if (e.key === '?') setHelpOpen(!helpOpen);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [helpOpen, setHelpOpen]);

  if (!helpOpen) return null;

  return (
    <div className="ks-backdrop" onClick={() => setHelpOpen(false)} role="presentation">
      <div
        className="ks-card"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
      >
        <div className="ks-head">
          <h2>Keyboard shortcuts</h2>
          <button className="ks-close" onClick={() => setHelpOpen(false)} aria-label="Close">✕</button>
        </div>

        {scopes.length === 0 ? (
          <p className="ks-empty">This view has no shortcuts of its own.</p>
        ) : (
          scopes.map(({ scope, shortcuts }) => (
            <section key={scope} className="ks-scope">
              <h3>{scope}</h3>
              <dl>
                {shortcuts.map(s => (
                  <React.Fragment key={s.keys + s.label}>
                    <dt><kbd>{s.keys}</kbd></dt>
                    <dd>{s.label}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </section>
          ))
        )}

        <section className="ks-scope">
          <h3>Everywhere</h3>
          <dl>
            <dt><kbd>?</kbd></dt><dd>Show this</dd>
            <dt><kbd>Esc</kbd></dt><dd>Close</dd>
          </dl>
        </section>

        <p className="ks-note">
          Shortcuts do nothing while you are typing in a field.
        </p>
      </div>
    </div>
  );
}

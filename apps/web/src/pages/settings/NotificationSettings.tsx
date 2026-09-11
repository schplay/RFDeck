import React, { useCallback, useEffect, useState } from 'react';
import { BellRing, Plus, Send, Trash2, CheckCircle2, XCircle } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { pushStatus, enablePush, disablePush, PushStatus } from '../../lib/push';

// Alerts that leave the browser.
//
// RFDeck's alerts otherwise exist only in an open tab: a dropout during a show
// nobody is watching, or overnight on a resident install, tells nobody. Two
// ways out, both self-contained and both free:
//
//   • a webhook — an HTTP POST to a URL you give it, which reaches Slack,
//     Teams, a home automation box or a pager gateway without RFDeck owning an
//     account or a bill;
//   • browser push — a notification on this phone or laptop, through the
//     browser's own push service.
//
// Email and SMS are a hosted service RFDeck would operate for you, and belong
// to the cloud tier. They are not here.

interface Webhook {
  id: string;
  name: string;
  url: string;
  hasSecret: boolean;
  enabled: boolean;
  minSeverity: 'INFO' | 'WARNING' | 'CRITICAL';
  lastAt: string | null;
  lastStatus: number | null;
  lastError: string | null;
  failures: number;
}

const SEVERITIES: Array<{ value: Webhook['minSeverity']; label: string; hint: string }> = [
  { value: 'CRITICAL', label: 'Critical only', hint: 'Dropouts, critical battery, a device lost. What is worth waking someone for.' },
  { value: 'WARNING',  label: 'Warning and above', hint: 'Also low battery, mutes, an unstable connection. Noisy during a show.' },
  { value: 'INFO',     label: 'Everything', hint: 'Recoveries too. For a log, not a person.' },
];

function since(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function NotificationSettings() {
  // ── Webhooks ──────────────────────────────────────────────────────────
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', url: '', secret: '', minSeverity: 'CRITICAL' as Webhook['minSeverity'] });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: string; ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setHooks(await apiFetch<Webhook[]>('/notifications/webhooks')); }
    catch { setError('Could not load webhooks.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/notifications/webhooks', { method: 'POST', body: JSON.stringify(draft) });
      setDraft({ name: '', url: '', secret: '', minSeverity: 'CRITICAL' });
      setAdding(false);
      await load();
    } catch (err: any) { setError(err?.message ?? 'Could not add the webhook'); }
  };

  const update = async (id: string, partial: Partial<Webhook>) => {
    setHooks(hs => hs.map(h => h.id === id ? { ...h, ...partial } : h));
    try { await apiFetch(`/notifications/webhooks/${id}`, { method: 'PUT', body: JSON.stringify(partial) }); }
    catch (err: any) { setError(err?.message ?? 'Could not save'); await load(); }
  };

  const remove = async (h: Webhook) => {
    if (!window.confirm(`Remove the webhook "${h.name}"?`)) return;
    await apiFetch(`/notifications/webhooks/${h.id}`, { method: 'DELETE' }).catch(() => {});
    await load();
  };

  const test = async (h: Webhook) => {
    setBusy(h.id);
    setNotice(null);
    try {
      const r = await apiFetch<{ ok: boolean; status: number | null; error: string | null }>(
        `/notifications/webhooks/${h.id}/test`, { method: 'POST' });
      setNotice({ id: h.id, ok: r.ok, text: r.ok ? `Delivered (HTTP ${r.status})` : `Failed: ${r.error}` });
    } catch (err: any) {
      setNotice({ id: h.id, ok: false, text: err?.message ?? 'Test failed' });
    } finally {
      setBusy(null);
      await load();
    }
  };

  // ── Push ──────────────────────────────────────────────────────────────
  const [push, setPush] = useState<PushStatus>({ state: 'off' });
  const [pushSeverity, setPushSeverity] = useState<Webhook['minSeverity']>('CRITICAL');
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);

  useEffect(() => { void pushStatus().then(setPush); }, []);

  const togglePush = async () => {
    setPushBusy(true);
    setPushError(null);
    try {
      setPush(push.state === 'on' ? await disablePush() : await enablePush(pushSeverity));
    } catch (err: any) {
      setPushError(err?.message ?? 'Could not change push notifications');
    } finally { setPushBusy(false); }
  };

  return (
    <div className="settings-card mt-4">
      <div className="settings-card-header">
        <h3><BellRing size={16} /> Notifications</h3>
      </div>
      <p className="settings-desc">
        Alerts otherwise exist only in an open tab. These get them out: to
        another system, or to this device's notifications. Both default to
        critical alerts only — a webhook that fires on every mute is one you
        will switch off within a night.
      </p>

      {/* ── Push ── */}
      <div className="ns-section">
        <div className="form-group-row">
          <div>
            <label>Notifications on this device</label>
            <p className="settings-desc settings-desc-tight">
              {push.state === 'on' && 'On. Critical alerts arrive even with the tab closed.'}
              {push.state === 'off' && 'Off. Uses this browser\'s own notifications.'}
              {push.state === 'denied' && 'Blocked: this browser has denied notifications for RFDeck. Allow them in the site settings, then try again.'}
              {push.state === 'unsupported' && push.reason}
            </p>
          </div>
          <button
            className={`active-switch ${push.state === 'on' ? 'on' : ''}`}
            role="switch"
            aria-checked={push.state === 'on'}
            aria-label="Notifications on this device"
            disabled={pushBusy || push.state === 'unsupported' || push.state === 'denied'}
            onClick={togglePush}
          >
            <span className="active-switch-knob" />
          </button>
        </div>
        {push.state !== 'on' && push.state !== 'unsupported' && (
          <div className="form-group">
            <label htmlFor="ns-push-sev">Send</label>
            <select id="ns-push-sev" value={pushSeverity} onChange={e => setPushSeverity(e.target.value as Webhook['minSeverity'])}>
              {SEVERITIES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
        )}
        {pushError && <p className="settings-desc settings-warn">{pushError}</p>}
      </div>

      {/* ── Webhooks ── */}
      <div className="ns-section">
        <div className="settings-card-header">
          <label>Webhooks</label>
          {!adding && (
            <button className="btn-ghost" onClick={() => setAdding(true)}><Plus size={14} /> Add</button>
          )}
        </div>

        {hooks.length === 0 && !adding && (
          <p className="settings-desc settings-desc-tight">
            None yet. A webhook is an HTTP POST of each alert, as JSON, to a URL
            you choose. Signed with a secret if you set one.
          </p>
        )}

        {hooks.map(h => (
          <div key={h.id} className="ns-hook">
            <div className="ns-hook-main">
              <div className="ns-hook-title">
                <strong>{h.name}</strong>
                <span className="ns-hook-url" title={h.url}>{h.url}</span>
              </div>
              {/* The last result, always. A webhook that is failing has to be
                  visible to be fixed, and "never" is its own warning. */}
              <div className={`ns-hook-status ${h.failures > 0 ? 'is-failing' : ''}`}>
                {h.lastAt
                  ? h.lastError
                    ? <><XCircle size={12} /> {h.lastError} · {since(h.lastAt)}{h.failures > 1 ? ` · ${h.failures} in a row` : ''}</>
                    : <><CheckCircle2 size={12} /> Delivered · {since(h.lastAt)}</>
                  : 'Never sent — use Test'}
                {notice?.id === h.id && (
                  <span className={`ns-notice ${notice.ok ? 'ok' : 'bad'}`}> · {notice.text}</span>
                )}
              </div>
            </div>
            <div className="ns-hook-controls">
              <select
                className="sm-select"
                value={h.minSeverity}
                onChange={e => update(h.id, { minSeverity: e.target.value as Webhook['minSeverity'] })}
                aria-label={`${h.name} severity`}
              >
                {SEVERITIES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
              <button
                className={`active-switch ${h.enabled ? 'on' : ''}`}
                role="switch"
                aria-checked={h.enabled}
                aria-label={`${h.name} enabled`}
                onClick={() => update(h.id, { enabled: !h.enabled })}
              >
                <span className="active-switch-knob" />
              </button>
              <button className="btn-ghost" disabled={busy === h.id} onClick={() => test(h)} title="Send a test alert now">
                <Send size={14} /> {busy === h.id ? 'Sending…' : 'Test'}
              </button>
              <button className="btn-ghost" onClick={() => remove(h)} title="Remove" aria-label={`Remove ${h.name}`}>
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}

        {adding && (
          <form className="settings-form ns-add" onSubmit={add}>
            <div className="form-group">
              <label htmlFor="ns-url">URL</label>
              <input id="ns-url" type="url" required placeholder="https://hooks.example.com/…"
                value={draft.url} onChange={e => setDraft({ ...draft, url: e.target.value })} autoFocus />
            </div>
            <div className="form-group">
              <label htmlFor="ns-name">Name</label>
              <input id="ns-name" type="text" placeholder="Optional — defaults to the host"
                value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div className="form-group">
              <label htmlFor="ns-secret">Secret</label>
              <input id="ns-secret" type="password" placeholder="Optional — signs each POST"
                value={draft.secret} onChange={e => setDraft({ ...draft, secret: e.target.value })} />
              <p className="settings-desc settings-desc-tight">
                If set, every POST carries <code>X-RFDeck-Signature: sha256=…</code>,
                an HMAC-SHA256 of the body, so the receiver can check it came from here.
              </p>
            </div>
            <div className="form-group">
              <label htmlFor="ns-sev">Send</label>
              <select id="ns-sev" value={draft.minSeverity} onChange={e => setDraft({ ...draft, minSeverity: e.target.value as Webhook['minSeverity'] })}>
                {SEVERITIES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
              <p className="settings-desc settings-desc-tight">
                {SEVERITIES.find(s => s.value === draft.minSeverity)?.hint}
              </p>
            </div>
            <div className="settings-actions-row">
              <button type="submit" className="btn-primary">Add webhook</button>
              <button type="button" className="btn-ghost" onClick={() => setAdding(false)}>Cancel</button>
            </div>
          </form>
        )}

        {error && <p className="settings-desc settings-warn">{error}</p>}
      </div>
    </div>
  );
}

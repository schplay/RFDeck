import React, { useEffect, useState } from 'react';
import { BellRing } from 'lucide-react';
import { pushStatus, enablePush, disablePush, PushStatus } from '../../lib/push';

// Alerts that leave the browser.
//
// RFDeck's alerts otherwise exist only in an open tab: a dropout during a show
// nobody is watching, or overnight on a resident install, tells nobody. Browser push
// is the way out that the application owns — a notification on this phone or laptop,
// through the browser's own push service, with no account and no bill.
//
// Everything else is Meros's. Alerts are rules configured in the cloud over RFDeck's
// event stream, so webhooks, email and SMS are delivered there and chosen there.
// RFDeck had its own webhook implementation until 2026-09-27; two implementations of
// the same feature only invited them to disagree about what had been sent.

type Severity = 'INFO' | 'WARNING' | 'CRITICAL';

const SEVERITIES: Array<{ value: Severity; label: string; hint: string }> = [
  { value: 'CRITICAL', label: 'Critical only', hint: 'Dropouts, critical battery, a device lost. What is worth waking someone for.' },
  { value: 'WARNING',  label: 'Warning and above', hint: 'Also low battery, mutes, an unstable connection. Noisy during a show.' },
  { value: 'INFO',     label: 'Everything', hint: 'Recoveries too. For a log, not a person.' },
];

export function NotificationSettings() {
  const [push, setPush] = useState<PushStatus>({ state: 'off' });
  const [pushSeverity, setPushSeverity] = useState<Severity>('CRITICAL');
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
        Alerts otherwise exist only in an open tab. This gets them to this device's
        notifications instead. It defaults to critical alerts only — anything that
        fired on every mute is something you would switch off within a night.
      </p>

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
            <select
              id="ns-push-sev"
              value={pushSeverity}
              onChange={e => setPushSeverity(e.target.value as Severity)}
            >
              {SEVERITIES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <p className="settings-desc settings-desc-tight">
              {SEVERITIES.find(s => s.value === pushSeverity)?.hint}
            </p>
          </div>
        )}
        {pushError && <p className="settings-desc settings-warn">{pushError}</p>}
      </div>

      {/* Said rather than left as an absence: an operator who expects webhooks
          should find out where they went, not conclude RFDeck cannot do it. */}
      <p className="settings-desc">
        Webhooks, email and SMS are configured in your Meros account, as rules over
        the events this rig reports — so they work whether or not a browser is open
        here. Turn the event stream on in Settings → Cloud.
      </p>
    </div>
  );
}

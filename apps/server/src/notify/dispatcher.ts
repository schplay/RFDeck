import type { EventEmitter } from 'events';
import { log } from '../logger';
import type { OutboundAlert } from './alert';
import { dispatchToPush } from './push';

// Fan an alert out to everything that has asked to be told.
//
// Listens to the device manager rather than being called by it, so alerting
// stays independent of whether anything is listening — the manager raises an
// alert the same way whether zero or twenty targets exist, and a delivery
// failure can never reach back into the telemetry path.
//
// Browser push is the only local channel. It reaches a phone through the browser's
// own push service with no account and no bill, which is why it belongs in the
// application. Webhooks used to sit beside it and do not any more: alerts are rules
// configured in the cloud over RFDeck's event stream, so webhook delivery is Meros's
// job and having a second implementation here only invited the two to disagree.

export function attachAlertDispatcher(source: EventEmitter): void {
  source.on('alert', (alert: OutboundAlert) => {
    // Failures are swallowed and logged: an unreachable push service must not
    // reach back into the telemetry path that raised the alert.
    void dispatchToPush(alert).catch(err => {
      log.warn(`[notify] Dispatch failed: ${err?.message ?? err}`);
    });
  });
}

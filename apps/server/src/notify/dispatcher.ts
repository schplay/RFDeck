import type { EventEmitter } from 'events';
import { log } from '../logger';
import { dispatchToWebhooks, OutboundAlert } from './webhooks';
import { dispatchToPush } from './push';

// Fan an alert out to everything that has asked to be told.
//
// Listens to the device manager rather than being called by it, so alerting
// stays independent of whether anything is listening — the manager raises an
// alert the same way whether zero or twenty targets exist, and a delivery
// failure can never reach back into the telemetry path.

export function attachAlertDispatcher(source: EventEmitter): void {
  source.on('alert', (alert: OutboundAlert) => {
    // Both in parallel, each swallowing its own failures. An unreachable
    // webhook must not delay a phone, and vice versa.
    void Promise.allSettled([
      dispatchToWebhooks(alert),
      dispatchToPush(alert),
    ]).then(results => {
      for (const r of results) {
        if (r.status === 'rejected') log.warn(`[notify] Dispatch failed: ${r.reason?.message ?? r.reason}`);
      }
    });
  });
}

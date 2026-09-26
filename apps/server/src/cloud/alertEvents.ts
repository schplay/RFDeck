import type { EventEmitter } from 'events';
import type { OutboundAlert } from '../notify/webhooks';
import type { CloudService } from './service';
import type { Severity } from './events';

/**
 * RFDeck's alerts, as events.
 *
 * Attached to the device manager alongside the webhook and push dispatchers, and
 * for the same reason: alerting stays independent of whether anything is
 * listening. The manager raises an alert the same way whether zero or twenty
 * targets exist, and nothing a target does can reach back into the telemetry path.
 *
 * Note what this is *not*: it does not ask the cloud to send anything. Alerts are
 * rules the user configures in the cloud over the event stream, so RFDeck's whole
 * responsibility is emitting the event well — a good `type`, an honest `severity`,
 * and enough in `subject` and `attrs` for a rule to match on and a person to read.
 */

/**
 * RFDeck's three internal levels, mapped onto the envelope's six.
 *
 * Deliberately not spread across the range. An operator configuring "notify me on
 * warning and above" should get RFDeck's warnings, and inventing a `notice` tier
 * for some of them would quietly exclude them from that rule.
 */
const SEVERITY: Record<string, Severity> = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical',
};

/**
 * Alert types to `rfdeck.subject.verb`, past tense.
 *
 * Explicit rather than derived from the internal name, because these are a public
 * vocabulary that a user's alert rules match on. A rule that stopped firing
 * because an internal enum was renamed would be a bad surprise, so the mapping is
 * a place someone has to come and change on purpose.
 */
const TYPES: Record<string, string> = {
  DROPOUT: 'rfdeck.channel.dropped_out',
  RECOVERY: 'rfdeck.channel.recovered',
  LOW_BATTERY: 'rfdeck.battery.low',
  CRITICAL_BATTERY: 'rfdeck.battery.critical',
  MUTED: 'rfdeck.channel.muted',
  DEVICE_OFFLINE: 'rfdeck.device.went_offline',
  DEVICE_ONLINE: 'rfdeck.device.came_online',
  AUTH_FAILED: 'rfdeck.device.auth_failed',
  AUDIO_FAULT: 'rfdeck.audio.fault_detected',
  FIRMWARE_CHANGED: 'rfdeck.device.firmware_changed',
  UNSTABLE: 'rfdeck.device.connection_unstable',
};

export function eventTypeFor(alertType: string): string {
  // An unmapped type still travels — collectors never reject on a `type` value,
  // and a vocabulary that can only grow by a code change in two places is one
  // that silently loses events.
  return TYPES[alertType] ?? `rfdeck.alert.${alertType.toLowerCase()}`;
}

export function severityFor(alertSeverity: string): Severity {
  return SEVERITY[alertSeverity?.toUpperCase()] ?? 'info';
}

/** Attach the event stream to a source of alerts. */
export function attachEventEmitter(source: EventEmitter, cloud: CloudService): void {
  source.on('alert', (alert: OutboundAlert) => {
    cloud.emit({
      type: eventTypeFor(alert.type),
      severity: severityFor(alert.severity),
      occurredAt: alert.timestamp ? new Date(alert.timestamp) : undefined,
      // The channel is what a rule is most likely to be scoped to, so it is the
      // subject; the device rides in attrs alongside it.
      subject: alert.channelId
        ? { kind: 'channel', id: alert.channelId, name: alert.channelName ?? undefined }
        : alert.deviceId
          ? { kind: 'device', id: alert.deviceId, name: alert.deviceName ?? undefined }
          : undefined,
      attrs: {
        // The human sentence. This is what reaches an email or a text, so it has
        // to read on its own rather than assume a dashboard is open.
        message: alert.message,
        ...(alert.detail ? { detail: alert.detail } : {}),
        ...(alert.deviceId ? { deviceId: alert.deviceId } : {}),
        ...(alert.deviceName ? { deviceName: alert.deviceName } : {}),
        ...(alert.channelName ? { channelName: alert.channelName } : {}),
        alertId: alert.id,
      },
    });
  });
}

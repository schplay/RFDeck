import type { EventEmitter } from 'events';
import type { OutboundAlert } from '../notify/alert';
import type { CloudService } from './service';
import type { Severity } from './events';

/**
 * RFDeck's alerts, as events.
 *
 * Attached to the device manager alongside the push dispatcher, and for the same
 * reason: alerting stays independent of whether anything is
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
 *
 * ── Why `rfdeck.rf.*` is its own namespace ──────────────────────────────────
 *
 * Meros builds RF environment history and post-show RF reports by selecting events
 * on a **type prefix**, configured as `identity.rollup.rf_event_prefix` and
 * defaulting to `rfdeck.rf`. So the prefix is a contract, not a naming preference:
 * anything RF has to sit under it or those features see nothing at all.
 *
 * That is exactly what had happened. RFDeck's RF events were spread across
 * `rfdeck.channel.*`, `rfdeck.frequency.*`, `rfdeck.intermod.*` and
 * `rfdeck.audio.*`, no single prefix covered them, and the two features matched
 * nothing while appearing to be wired up. Renamed on 2026-09-27.
 *
 * What is deliberately *not* under it matters just as much, since the prefix is a
 * filter: battery, mutes, device connectivity, show lifecycle and inventory are not
 * the RF environment, and sweeping them in would make an RF report a log of
 * everything.
 */
const TYPES: Record<string, string> = {
  // DROPOUT and RECOVERY are deliberately absent: they come from the RF event
  // signal instead, which is complete rather than rate-limited. Mapping them here
  // as well would emit every dropout twice — and since each emit generates its own
  // ULID, the collector's dedupe would not catch it.
  LOW_BATTERY: 'rfdeck.battery.low',
  CRITICAL_BATTERY: 'rfdeck.battery.critical',
  MUTED: 'rfdeck.channel.muted',
  DEVICE_OFFLINE: 'rfdeck.device.went_offline',
  DEVICE_ONLINE: 'rfdeck.device.came_online',
  AUTH_FAILED: 'rfdeck.device.auth_failed',
  AUDIO_FAULT: 'rfdeck.rf.audio_fault',
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

/**
 * Attach the event stream to everything worth recording.
 *
 * More than alerts, deliberately. Alerts are a throttled, human-facing subset —
 * one dropout a minute per channel — and an event history built only from them
 * would be missing the things a post-show RF report needs most: recoveries,
 * carrier moves, and the audio faults that are RFDeck's whole differentiator.
 */
export function attachEventEmitter(source: EventEmitter, cloud: CloudService): void {
  // ── RF transitions, complete ────────────────────────────────────────────────
  source.on('rf:event', (event: any) => {
    cloud.emit({
      type: event.type === 'RECOVERY' ? 'rfdeck.rf.recovery' : 'rfdeck.rf.dropout',
      severity: event.type === 'RECOVERY' ? 'info' : 'warning',
      occurredAt: event.timestamp ? new Date(event.timestamp) : undefined,
      subject: { kind: 'channel', id: event.channelId, name: event.channelName ?? undefined },
      attrs: {
        message: event.type === 'RECOVERY'
          ? `${event.channelName ?? 'A channel'} recovered`
          : `RF dropout on ${event.channelName ?? 'a channel'}`,
        rfLevelA: event.rfLevelA,
        rfLevelB: event.rfLevelB,
        deviceId: event.deviceId,
      },
    });
  });

  // ── A carrier moved ────────────────────────────────────────────────────────
  source.on('channel:frequency', (change: any) => {
    cloud.emit({
      type: 'rfdeck.rf.frequency_changed',
      severity: 'notice',
      subject: { kind: 'channel', id: change.channelId, name: change.channelName ?? undefined },
      attrs: {
        message: `${change.channelName ?? 'A channel'} moved from ` +
                 `${(change.fromKHz / 1000).toFixed(3)} to ${(change.toKHz / 1000).toFixed(3)} MHz`,
        fromKHz: change.fromKHz,
        toKHz: change.toKHz,
        deviceId: change.deviceId,
      },
    });
  });

  // ── Audio faults: fuzz, noise, a click ─────────────────────────────────────
  //
  // The thing RFDeck can say that an RF meter cannot, so it belongs in an RF
  // history more than most of what is here.
  source.on('rf:detection', (detection: any) => {
    // RF dropouts already arrive via rf:event; this signal carries both, so the
    // RF-triggered ones are skipped rather than counted twice.
    if (detection.trigger === 'RF_DROPOUT') return;
    cloud.emit({
      type: 'rfdeck.rf.audio_fault',
      severity: severityFor(detection.severity),
      subject: { kind: 'channel', id: detection.channelKey, name: detection.channelName ?? undefined },
      attrs: {
        message: detection.message,
        trigger: detection.trigger,
        rfLevelA: detection.rfLevelA,
        rfLevelB: detection.rfLevelB,
        deviceId: detection.deviceId,
      },
    });
  });

  // ── Intermodulation, when the picture changes ───────────────────────────────
  source.on('intermod:changed', (report: any) => {
    cloud.emit({
      type: report.hits > 0 ? 'rfdeck.rf.intermod_detected' : 'rfdeck.rf.intermod_cleared',
      severity: report.hits > 0 ? 'warning' : 'info',
      attrs: {
        message: report.hits > 0
          ? `${report.hits} intermodulation product(s) land on a live channel` +
            (report.worst ? `; closest is ${report.worst.formula} on ${report.worst.victimName}` : '')
          : 'No intermodulation products land on a live channel',
        hits: report.hits,
        sourceCount: report.sourceCount,
        ...(report.worst ? { worst: report.worst } : {}),
      },
    });
  });

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

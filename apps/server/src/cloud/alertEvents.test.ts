import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { attachEventEmitter, eventTypeFor, severityFor } from './alertEvents';
import type { CloudService } from './service';
import type { EmitInput } from './events';

/**
 * The event vocabulary, as a contract rather than a naming preference.
 *
 * Meros selects RF events by **type prefix** — `identity.rollup.rf_event_prefix`,
 * defaulting to `rfdeck.rf` — to build RF environment history and post-show reports.
 * Anything RF that sits outside that prefix is invisible to both features, and
 * anything non-RF that sits inside it pollutes them. That is a silent failure in
 * both directions, which is why it is pinned here.
 *
 * This whole file exists because the prefix had in fact drifted: RF events were
 * spread across four namespaces and the two cloud features matched nothing at all.
 */

/** The prefix Meros selects on. Changing this is a cloud-contract change. */
const RF_PREFIX = 'rfdeck.rf.';

function harness() {
  const source = new EventEmitter();
  const emitted: EmitInput[] = [];
  const cloud = { emit: (input: EmitInput) => { emitted.push(input); } } as unknown as CloudService;
  attachEventEmitter(source, cloud);
  return { source, emitted };
}

describe('the RF prefix contract', () => {
  it('emits dropouts and recoveries under the prefix Meros selects on', () => {
    const { source, emitted } = harness();
    source.emit('rf:event', {
      type: 'DROPOUT', channelId: 'dev-1:1', channelName: 'Handheld 4',
      rfLevelA: 12, rfLevelB: 9, deviceId: 'dev-1', timestamp: Date.now(),
    });
    source.emit('rf:event', {
      type: 'RECOVERY', channelId: 'dev-1:1', channelName: 'Handheld 4',
      rfLevelA: 60, rfLevelB: 58, deviceId: 'dev-1', timestamp: Date.now(),
    });
    expect(emitted.map(e => e.type)).toEqual(['rfdeck.rf.dropout', 'rfdeck.rf.recovery']);
  });

  it('emits carrier moves under the prefix', () => {
    const { source, emitted } = harness();
    source.emit('channel:frequency', {
      channelId: 'dev-1:1', channelName: 'Handheld 4',
      fromKHz: 606_000, toKHz: 608_500, deviceId: 'dev-1',
    });
    expect(emitted[0].type).toBe('rfdeck.rf.frequency_changed');
    // The numbers a report needs, not just the sentence.
    expect(emitted[0].attrs).toMatchObject({ fromKHz: 606_000, toKHz: 608_500 });
  });

  it('emits intermod under the prefix, both directions', () => {
    const { source, emitted } = harness();
    source.emit('intermod:changed', { hits: 2, sourceCount: 14, worst: { formula: '2A-B', victimName: 'Lav 3' } });
    source.emit('intermod:changed', { hits: 0, sourceCount: 14 });
    expect(emitted.map(e => e.type))
      .toEqual(['rfdeck.rf.intermod_detected', 'rfdeck.rf.intermod_cleared']);
  });

  it('emits audio faults under the prefix', () => {
    const { source, emitted } = harness();
    source.emit('rf:detection', {
      channelKey: 'dev-1:1', channelName: 'Handheld 4', deviceId: 'dev-1',
      trigger: 'AUDIO_SIGNATURE', severity: 'WARNING', message: 'Fuzz on Handheld 4',
      rfLevelA: 40, rfLevelB: 38,
    });
    expect(emitted[0].type).toBe('rfdeck.rf.audio_fault');
    expect(emitted[0].attrs).toMatchObject({ trigger: 'AUDIO_SIGNATURE' });
  });

  it('every RF-signal event lands under the prefix, with none left behind', () => {
    // The guard against a new RF signal being added under a different namespace and
    // quietly not appearing in RF history.
    const { source, emitted } = harness();
    source.emit('rf:event', { type: 'DROPOUT', channelId: 'c', timestamp: Date.now() });
    source.emit('rf:event', { type: 'RECOVERY', channelId: 'c', timestamp: Date.now() });
    source.emit('channel:frequency', { channelId: 'c', fromKHz: 1000, toKHz: 2000 });
    source.emit('intermod:changed', { hits: 1, sourceCount: 2 });
    source.emit('rf:detection', { channelKey: 'c', trigger: 'AUDIO_SIGNATURE', severity: 'WARNING' });

    expect(emitted).toHaveLength(5);
    for (const event of emitted) {
      expect(event.type.startsWith(RF_PREFIX)).toBe(true);
    }
  });
});

describe('what must stay outside the RF prefix', () => {
  it('keeps battery, mutes and connectivity out, since the prefix is a filter', () => {
    // Sweeping these in would turn an RF report into a log of everything.
    for (const alertType of [
      'LOW_BATTERY', 'CRITICAL_BATTERY', 'MUTED',
      'DEVICE_OFFLINE', 'DEVICE_ONLINE', 'AUTH_FAILED',
      'FIRMWARE_CHANGED', 'UNSTABLE',
    ]) {
      expect(eventTypeFor(alertType).startsWith(RF_PREFIX)).toBe(false);
    }
  });

  it('routes audio faults from the alert path to the same RF type as the signal path', () => {
    // One concept, one type string, whichever path raised it.
    expect(eventTypeFor('AUDIO_FAULT')).toBe('rfdeck.rf.audio_fault');
  });

  it('gives an unmapped alert type a name rather than dropping it', () => {
    expect(eventTypeFor('SOMETHING_NEW')).toBe('rfdeck.alert.something_new');
  });
});

describe('not counting a dropout twice', () => {
  it('ignores the RF-triggered detection, which rf:event already reported', () => {
    // Both signals fire for a dropout. Each emit mints its own ULID, so a
    // collector's dedupe cannot catch the duplicate — it has to not be sent.
    const { source, emitted } = harness();
    source.emit('rf:detection', {
      channelKey: 'dev-1:1', trigger: 'RF_DROPOUT', severity: 'CRITICAL',
      message: 'RF dropout on Handheld 4',
    });
    expect(emitted).toHaveLength(0);
  });

  it('does not map DROPOUT or RECOVERY through the alert path', () => {
    // Alerts are throttled to one a minute per channel; rf:event is complete. If
    // both emitted, a dropout would appear twice with different ids.
    expect(eventTypeFor('DROPOUT')).toBe('rfdeck.alert.dropout');
    expect(eventTypeFor('RECOVERY')).toBe('rfdeck.alert.recovery');
    // Neither is in the RF namespace, so neither reaches an RF report by accident.
    expect(eventTypeFor('DROPOUT').startsWith(RF_PREFIX)).toBe(false);
  });
});

describe('severity', () => {
  it('maps RFDeck\'s three levels onto the envelope without inventing a tier', () => {
    expect(severityFor('INFO')).toBe('info');
    expect(severityFor('WARNING')).toBe('warning');
    expect(severityFor('CRITICAL')).toBe('critical');
  });

  it('falls back to info rather than guessing high', () => {
    expect(severityFor('WHATEVER')).toBe('info');
    expect(severityFor('')).toBe('info');
  });
});

describe('attrs a report can actually use', () => {
  it('carries RF levels and the device alongside the sentence', () => {
    const { source, emitted } = harness();
    source.emit('rf:event', {
      type: 'DROPOUT', channelId: 'dev-1:1', channelName: 'Handheld 4',
      rfLevelA: 12, rfLevelB: 9, deviceId: 'dev-1', timestamp: Date.now(),
    });
    expect(emitted[0].attrs).toMatchObject({
      rfLevelA: 12, rfLevelB: 9, deviceId: 'dev-1',
    });
    // The sentence has to read on its own: it is what reaches an email.
    expect(String(emitted[0].attrs!.message)).toContain('Handheld 4');
  });

  it('names the channel as the subject, since that is what a rule scopes to', () => {
    const { source, emitted } = harness();
    source.emit('rf:event', {
      type: 'DROPOUT', channelId: 'dev-1:1', channelName: 'Handheld 4', timestamp: Date.now(),
    });
    expect(emitted[0].subject).toEqual({ kind: 'channel', id: 'dev-1:1', name: 'Handheld 4' });
  });
});

import { describe, it, expect } from 'vitest';
import { normalizeBatteryThresholds, batteryAlertStep, DEFAULT_BATTERY_THRESHOLDS } from './batteryThresholds';

// The battery levels from Settings. Until these were wired in, the levels an
// operator saved were stored and then ignored: alerts fired at a fixed 20% and
// 5% whatever Settings said.

describe('normalizeBatteryThresholds', () => {
  it('takes the saved levels as they are when they make sense', () => {
    expect(normalizeBatteryThresholds(30, 10)).toEqual({ warningPct: 30, criticalPct: 10 });
  });

  it('keeps the current level for a value that is missing or not a number', () => {
    const current = { warningPct: 25, criticalPct: 8 };
    expect(normalizeBatteryThresholds(undefined, 'abc', current)).toEqual(current);
    expect(normalizeBatteryThresholds(null, 4, current)).toEqual({ warningPct: 25, criticalPct: 4 });
  });

  it('accepts numbers sent as text and rounds to whole percent', () => {
    expect(normalizeBatteryThresholds('35', '12.6')).toEqual({ warningPct: 35, criticalPct: 13 });
  });

  it('keeps critical below warning, so the low warning can still be reached', () => {
    expect(normalizeBatteryThresholds(10, 10)).toEqual({ warningPct: 11, criticalPct: 10 });
    expect(normalizeBatteryThresholds(5, 40)).toEqual({ warningPct: 41, criticalPct: 40 });
  });

  it('keeps both inside 0-100', () => {
    expect(normalizeBatteryThresholds(150, -5)).toEqual({ warningPct: 100, criticalPct: 0 });
    expect(normalizeBatteryThresholds(100, 100)).toEqual({ warningPct: 100, criticalPct: 98 });
  });
});

describe('batteryAlertStep', () => {
  const t = { warningPct: 40, criticalPct: 15 };

  it('warns at the saved level, not at a fixed 20%', () => {
    const first = batteryAlertStep(45, 38, undefined, t);
    expect(first).toEqual({ pending: 38, alert: null });
    expect(batteryAlertStep(38, 37, first.pending, t)).toEqual({ pending: undefined, alert: 'low' });
  });

  it('raises critical at the saved critical level', () => {
    const first = batteryAlertStep(20, 14, undefined, t);
    expect(first).toEqual({ pending: 14, alert: null });
    expect(batteryAlertStep(14, 14, first.pending, t)).toEqual({ pending: undefined, alert: 'critical' });
  });

  it('says nothing above the warning level, and forgets a pending low reading', () => {
    expect(batteryAlertStep(50, 41, 38, t)).toEqual({ pending: undefined, alert: null });
  });

  it('needs a second low reading: one bad sample is not an alert', () => {
    const glitch = batteryAlertStep(90, 3, undefined, t);
    expect(glitch.alert).toBeNull();
    expect(batteryAlertStep(3, 90, glitch.pending, t)).toEqual({ pending: undefined, alert: null });
  });

  it('matches the old fixed behavior at the default levels', () => {
    const d = DEFAULT_BATTERY_THRESHOLDS;
    expect(batteryAlertStep(25, 20, undefined, d)).toEqual({ pending: 20, alert: null });
    expect(batteryAlertStep(25, 21, undefined, d)).toEqual({ pending: undefined, alert: null });
    expect(batteryAlertStep(6, 5, undefined, d)).toEqual({ pending: 5, alert: null });
    expect(batteryAlertStep(5, 5, 5, d)).toEqual({ pending: undefined, alert: 'critical' });
  });
});

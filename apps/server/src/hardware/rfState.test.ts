import { describe, it, expect } from 'vitest';
import {
  evaluateSample, confirmDropout, signalLevel,
  DEFAULT_RF_THRESHOLDS, RfState, RfSample,
} from './rfState';

const sample = (a: number, b = a, isMuted = false): RfSample => ({
  rfLevelA: a, rfLevelB: b, isMuted,
});

describe('signalLevel', () => {
  it('uses the stronger antenna', () => {
    // Diversity receivers switch between antennas constantly; a channel is only
    // in trouble when BOTH are weak.
    expect(signalLevel(sample(0, 90))).toBe(90);
    expect(signalLevel(sample(90, 0))).toBe(90);
  });
});

describe('evaluateSample — IEM transmitters', () => {
  // An IEM transmitter receives nothing, so it reports no RF and reads as 0 on
  // both antennas. Run through the normal path it arms a dropout, waits out
  // the confirmation window, confirms, and alerts — on a transmitter that is
  // working perfectly, every time, forever. That is what a monitor rig looked
  // like before the channel carried its role.
  const iem = (a = 0, b = 0): RfSample => ({
    rfLevelA: a, rfLevelB: b, isMuted: false, role: 'iem',
  });

  it('never arms a dropout, however low the RF reads', () => {
    expect(evaluateSample('OK', iem())).toEqual({ kind: 'none' });
    expect(evaluateSample('OK', iem(0, 0))).toEqual({ kind: 'none' });
  });

  it('cancels a confirmation that was already pending', () => {
    // A channel reclassified as an IEM mid-flight must not have its timer
    // fire afterwards.
    expect(evaluateSample('OK', iem(), DEFAULT_RF_THRESHOLDS, true))
      .toEqual({ kind: 'disarm' });
  });

  it('does not announce a recovery it never dropped from', () => {
    expect(evaluateSample('DROPPED', iem(0, 0))).toEqual({ kind: 'none' });
  });

  it('still alerts normally for a microphone at the same levels', () => {
    // The guard must be about the role, not about the numbers — a real mic
    // reading zero is exactly the alert that matters most.
    const mic: RfSample = { rfLevelA: 0, rfLevelB: 0, isMuted: false, role: 'mic' };
    expect(evaluateSample('OK', mic)).toEqual({ kind: 'arm' });
  });

  it('treats a channel with no role as a microphone', () => {
    // Every existing caller predates the field; none of them may lose alerting
    // by omitting it.
    expect(evaluateSample('OK', sample(0))).toEqual({ kind: 'arm' });
  });
});

describe('evaluateSample — from OK', () => {
  const state: RfState = 'OK';

  it('arms a confirmation timer when the signal drops', () => {
    expect(evaluateSample(state, sample(10))).toEqual({ kind: 'arm' });
  });

  it('does not re-arm while a confirmation is already pending', () => {
    // Re-arming on every sample would push the confirmation deadline forward
    // forever and a sustained dropout would never be reported.
    expect(evaluateSample(state, sample(10), DEFAULT_RF_THRESHOLDS, true))
      .toEqual({ kind: 'none' });
  });

  it('ignores a low reading on a muted channel', () => {
    // Muting is an operator action, not a fault.
    expect(evaluateSample(state, sample(0, 0, true))).toEqual({ kind: 'none' });
  });

  it('disarms when the signal returns before confirmation', () => {
    // This is the diversity-switching case: 0% then 100% within a second.
    expect(evaluateSample(state, sample(100), DEFAULT_RF_THRESHOLDS, true))
      .toEqual({ kind: 'disarm' });
  });

  it('does nothing for a healthy signal with nothing pending', () => {
    expect(evaluateSample(state, sample(80))).toEqual({ kind: 'none' });
  });

  it('stays quiet between the dropout and recovery thresholds', () => {
    // 35 is above dropout (25) but below recovery (45) — no action either way.
    expect(evaluateSample(state, sample(35))).toEqual({ kind: 'none' });
  });
});

describe('evaluateSample — from DROPOUT', () => {
  const state: RfState = 'DROPOUT';

  it('recovers once the signal clears the recovery threshold', () => {
    expect(evaluateSample(state, sample(50))).toEqual({ kind: 'recovered' });
  });

  it('does not recover inside the hysteresis band', () => {
    // The gap between thresholds is the whole point: a signal sitting at 30
    // would otherwise flap between states on every sample.
    expect(evaluateSample(state, sample(30))).toEqual({ kind: 'none' });
    expect(evaluateSample(state, sample(44))).toEqual({ kind: 'none' });
  });

  it('recovers exactly at the recovery threshold', () => {
    expect(evaluateSample(state, sample(45))).toEqual({ kind: 'recovered' });
  });

  it('stays in dropout while the signal is still low', () => {
    expect(evaluateSample(state, sample(0))).toEqual({ kind: 'none' });
  });
});

describe('confirmDropout', () => {
  it('confirms when the signal is still low', () => {
    expect(confirmDropout(sample(5))).toBe(true);
  });

  it('rejects when the signal recovered during the window', () => {
    expect(confirmDropout(sample(90))).toBe(false);
  });

  it('rejects a channel muted during the window', () => {
    // An operator muting mid-window must not produce a dropout alert.
    expect(confirmDropout(sample(0, 0, true))).toBe(false);
  });

  it('rejects a channel that vanished during the window', () => {
    // Device removed or deactivated while the timer was running.
    expect(confirmDropout(undefined)).toBe(false);
  });

  it('rejects when only one antenna is weak', () => {
    expect(confirmDropout(sample(0, 80))).toBe(false);
  });
});

describe('threshold boundaries', () => {
  it('treats the dropout threshold itself as healthy', () => {
    // Strictly below, so 25 is not a dropout.
    expect(evaluateSample('OK', sample(25))).toEqual({ kind: 'none' });
    expect(evaluateSample('OK', sample(24))).toEqual({ kind: 'arm' });
  });

  it('honours custom thresholds', () => {
    const strict = { dropout: 50, recovery: 70, confirmMs: 1000 };
    expect(evaluateSample('OK', sample(40), strict)).toEqual({ kind: 'arm' });
    expect(evaluateSample('OK', sample(40))).toEqual({ kind: 'none' });
  });
});

describe('a full diversity-switching flap', () => {
  it('produces no dropout when the signal returns in time', () => {
    // The exact sequence the user reported: RF reads 0% then 100% within the
    // same second while the mics sound fine.
    let pending = false;

    const first = evaluateSample('OK', sample(0), DEFAULT_RF_THRESHOLDS, pending);
    expect(first).toEqual({ kind: 'arm' });
    pending = true;

    const second = evaluateSample('OK', sample(100), DEFAULT_RF_THRESHOLDS, pending);
    expect(second).toEqual({ kind: 'disarm' });

    // The timer never fires, so no event and no alert are ever emitted.
  });

  it('still reports a genuine sustained dropout', () => {
    let pending = false;
    expect(evaluateSample('OK', sample(0), DEFAULT_RF_THRESHOLDS, pending)).toEqual({ kind: 'arm' });
    pending = true;

    // Signal stays down across the window...
    expect(evaluateSample('OK', sample(2), DEFAULT_RF_THRESHOLDS, pending)).toEqual({ kind: 'none' });
    // ...and the timer's confirmation check agrees.
    expect(confirmDropout(sample(2))).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { isRfdeckRetune, frequencyChangeMessage, RETUNE_WINDOW_MS } from './frequencyHistory';

// Who moved a carrier. RFDeck remembers the retunes it sends; a change that
// matches one of them is RFDeck's, anything else happened at the receiver.

describe('isRfdeckRetune', () => {
  const sent = { toKHz: 520_100, at: 1_000_000 };

  it('claims the change RFDeck asked for', () => {
    expect(isRfdeckRetune(sent, 520_100, sent.at + 1_500)).toBe(true);
  });

  it('absorbs a kHz of rounding from the Hz the command carried', () => {
    expect(isRfdeckRetune(sent, 520_101, sent.at + 100)).toBe(true);
    expect(isRfdeckRetune(sent, 520_103, sent.at + 100)).toBe(false);
  });

  it('does not claim a change to somewhere else', () => {
    expect(isRfdeckRetune(sent, 518_200, sent.at + 100)).toBe(false);
  });

  it('does not claim a change long after the command', () => {
    expect(isRfdeckRetune(sent, 520_100, sent.at + RETUNE_WINDOW_MS + 1)).toBe(false);
  });

  it('treats a change with no command behind it as the receiver\'s', () => {
    expect(isRfdeckRetune(undefined, 520_100, sent.at)).toBe(false);
  });
});

describe('frequencyChangeMessage', () => {
  it('says who moved it and where, in MHz', () => {
    expect(frequencyChangeMessage(true, 518_200, 520_100))
      .toBe('Retuned by RFDeck: 518.200 → 520.100 MHz');
    expect(frequencyChangeMessage(false, 520_100, 518_200))
      .toBe('Frequency changed at the receiver: 520.100 → 518.200 MHz');
  });
});

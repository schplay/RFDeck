import { describe, it, expect, vi, beforeEach } from 'vitest';

// The device manager records every carrier move and says who made it. The
// database is replaced so nothing here writes to a real one.
const created: any[] = [];
vi.mock('../db', () => ({
  prisma: { event: { create: vi.fn(async ({ data }: any) => { created.push(data); return data; }) } },
}));

import { DeviceManagerService } from './sennheiser/DeviceManagerService';

function setup() {
  const emitted: Array<{ name: string; payload: any }> = [];
  const io = { emit: (name: string, payload: any) => emitted.push({ name, payload }) };
  const m = new DeviceManagerService(io as any);
  const frequencyEvents = () => emitted.filter(e => e.name === 'rf:frequency').map(e => e.payload);
  return { m, frequencyEvents };
}

const channel = (frequency: number) => ({
  id: 'row-1:1', deviceId: '10.0.0.5:443', channelIndex: 1, name: 'Vocal 1', frequency,
});

describe('recording a frequency change', () => {
  beforeEach(() => { created.length = 0; });

  it('records a change made at the receiver, on every screen and in the history', () => {
    const { m, frequencyEvents } = setup();
    (m as any).recordFrequencyChange('row-1:1', channel(520_100), 518_200);

    const [event] = frequencyEvents();
    expect(event).toMatchObject({
      type: 'FREQUENCY_CHANGE', source: 'RF', channelKey: 'row-1:1', channelName: 'Vocal 1',
      deviceId: '10.0.0.5:443', fromKHz: 518_200, toKHz: 520_100,
      message: 'Frequency changed at the receiver: 518.200 → 520.100 MHz',
    });
    expect(created).toHaveLength(1);
    expect(created[0].id).toBe(event.id);
  });

  it('records a retune RFDeck sent as RFDeck\'s', async () => {
    const { m, frequencyEvents } = setup();
    (m as any).clients.set('10.0.0.5:443', { setFrequency: async () => true });

    await m.setChannelFrequency('10.0.0.5:443', 1, 520_100_000);
    (m as any).recordFrequencyChange('row-1:1', channel(520_100), 518_200);

    expect(frequencyEvents()[0]).toMatchObject({
      type: 'FREQUENCY_SET', message: 'Retuned by RFDeck: 518.200 → 520.100 MHz',
    });
  });

  it('credits RFDeck once: a later move to the same place is the receiver\'s', async () => {
    const { m, frequencyEvents } = setup();
    (m as any).clients.set('10.0.0.5:443', { setFrequency: async () => true });

    await m.setChannelFrequency('10.0.0.5:443', 1, 520_100_000);
    (m as any).recordFrequencyChange('row-1:1', channel(520_100), 518_200);
    (m as any).recordFrequencyChange('row-1:1', channel(518_200), 520_100);
    (m as any).recordFrequencyChange('row-1:1', channel(520_100), 518_200);

    expect(frequencyEvents().map(e => e.type))
      .toEqual(['FREQUENCY_SET', 'FREQUENCY_CHANGE', 'FREQUENCY_CHANGE']);
  });

  it('does not credit RFDeck with a retune on a different receiver slot', async () => {
    const { m, frequencyEvents } = setup();
    (m as any).clients.set('10.0.0.5:443', { setFrequency: async () => true });

    await m.setChannelFrequency('10.0.0.5:443', 2, 520_100_000);
    (m as any).recordFrequencyChange('row-1:1', channel(520_100), 518_200);

    expect(frequencyEvents()[0].type).toBe('FREQUENCY_CHANGE');
  });
});

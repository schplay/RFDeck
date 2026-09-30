import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SSCClient } from './SSCClient';

// A password the device has refused must not be presented again on every tick.
//
// `DeviceManagerService` starts these clients at 250 ms, and a client with no
// connection yet probes on every pass, walking five candidate URLs — each one
// carrying the stored password. A receiver that refuses it therefore took up to
// twenty failed authentications a second, for as long as it stayed powered on.
//
// That is what put an EW-DX into a state needing re-adoption in Control Cockpit
// and a fresh password, which cannot be done remotely. Retrying could never have
// helped: a wrong password becomes right when a person changes one, and saving a
// password re-tracks the device and builds a new client, so nothing here has to
// poll for it.

function makeClient() {
  const client = new SSCClient('192.0.2.50', 443, 'wrong-password');
  const authFailed = vi.fn();
  client.on('auth-failed', authFailed);
  client.on('disconnected', () => {});
  // Count what reaches the network instead of reaching it.
  const probe = vi.fn().mockRejectedValue(Object.assign(new Error('401'), { code: 'EAUTH' }));
  (client as any).probe = probe;
  return { client, authFailed, probe };
}

const poll = (client: SSCClient) => (client as any).poll();
const reject = (client: SSCClient) => (client as any).noteAuthRejected();

describe('a device that refused the stored password', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-29T12:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('is not probed again on the next tick', async () => {
    const { client, probe } = makeClient();
    await poll(client);
    expect(probe).toHaveBeenCalledTimes(1);

    reject(client);

    // Four ticks a second for ten seconds: forty passes, none of which may reach
    // the device. This is the flood, and it is the whole point of the change.
    for (let i = 0; i < 40; i++) {
      vi.advanceTimersByTime(250);
      await poll(client);
    }
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('is retried once the backoff has elapsed', async () => {
    const { client, probe } = makeClient();
    reject(client);
    await poll(client);
    expect(probe).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    await poll(client);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('tells the operator, once, rather than failing silently', async () => {
    const { client, authFailed } = makeClient();
    reject(client);
    reject(client);
    reject(client);
    expect(authFailed).toHaveBeenCalledTimes(1);
    expect(authFailed.mock.calls[0][0].reason).toMatch(/refused/i);
  });

  it('polls normally again as soon as the device accepts a credential', async () => {
    const { client, probe } = makeClient();
    reject(client);

    // What a corrected password looks like from in here: the probe succeeds.
    probe.mockResolvedValue(undefined);
    (client as any).isSSCv2 = false;
    (client as any).pollOsc = vi.fn().mockResolvedValue({});

    vi.advanceTimersByTime(60_000);
    await poll(client);
    expect((client as any).authRejectedAt).toBe(0);

    // And the throttle is gone, not merely reset for one pass.
    await poll(client);
    await poll(client);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('forgets the rejection when the client is restarted, so a saved password is tried at once', () => {
    const { client } = makeClient();
    reject(client);
    client.stopPolling();
    expect((client as any).authRejectedAt).toBe(0);
  });
});

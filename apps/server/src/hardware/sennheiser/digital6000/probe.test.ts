import { describe, it, expect, afterEach } from 'vitest';
import dgram from 'dgram';
import { FakeDigital6000Device } from './fakeDigital6000Device';
import { probeSscUdp } from './probe';

// The one question discovery asks a device that announced `_ssc._udp`.

const devices: FakeDigital6000Device[] = [];
afterEach(async () => { await Promise.all(devices.splice(0).map(d => d.close())); });

async function fake(product = 'EM 6000') {
  const device = new FakeDigital6000Device({ product });
  devices.push(device);
  return { device, port: await device.listen() };
}

describe('probeSscUdp', () => {
  it('reads the product and name from the device', async () => {
    const { port } = await fake();
    expect(await probeSscUdp('127.0.0.1', port)).toEqual({
      product: 'EM 6000', vendor: 'Sennheiser', version: '1.1.4.74', name: 'Rack 1',
    });
  });

  it('reports whatever product answers, so discovery can decide', async () => {
    const { port } = await fake('EM 6000 DANTE');
    expect((await probeSscUdp('127.0.0.1', port))?.product).toBe('EM 6000 DANTE');
  });

  it('gives up quietly when nothing answers', async () => {
    // A bound socket that never replies.
    const silent = dgram.createSocket('udp4');
    await new Promise<void>(r => silent.bind(0, '127.0.0.1', () => r()));
    const port = (silent.address() as { port: number }).port;
    try {
      expect(await probeSscUdp('127.0.0.1', port, 300)).toBeNull();
    } finally {
      silent.close();
    }
  });
});

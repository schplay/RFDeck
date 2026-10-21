import { describe, it, expect, afterEach } from 'vitest';
import { DiscoveryService } from './DiscoveryService';
import { FakeDigital6000Device } from './digital6000/fakeDigital6000Device';

// Finding a Digital 6000 on its own. It has no TCP, so it never shows up on
// `_ssc._tcp`; it announces `_ssc._udp`, and discovery asks it once what it
// is before offering it.

const devices: FakeDigital6000Device[] = [];
afterEach(async () => { await Promise.all(devices.splice(0).map(d => d.close())); });

async function announce(product: string) {
  const device = new FakeDigital6000Device({ product });
  devices.push(device);
  const port = await device.listen();
  const discovery = new DiscoveryService();
  const found: any[] = [];
  discovery.on('discovered', d => found.push(d));
  (discovery as any).onSscUdpAnnouncement('127.0.0.1', port, 'announced-name');
  // One datagram each way on loopback.
  await new Promise(r => setTimeout(r, 300));
  return { found, device, discovery, port };
}

describe('a device announcing _ssc._udp', () => {
  it('is offered when it says it is a Digital 6000, as Sennheiser on port 45', async () => {
    const { found } = await announce('EM 6000');
    expect(found).toEqual([expect.objectContaining({
      ip: '127.0.0.1', port: 45, name: 'Rack 1', protocol: 'd6000',
      manufacturer: 'Sennheiser', model: 'EM 6000',
    })]);
  });

  it('is not offered when it is something else', async () => {
    const { found } = await announce('EW-DX EM 2');
    expect(found).toEqual([]);
  });

  it('is asked only once, however often it announces', async () => {
    const { device, discovery, port } = await announce('EM 6000');
    (discovery as any).onSscUdpAnnouncement('127.0.0.1', port, 'again');
    (discovery as any).onSscUdpAnnouncement('127.0.0.1', port, 'again');
    await new Promise(r => setTimeout(r, 300));
    const questions = device.received.filter(m => m.includes('"identity"'));
    expect(questions).toHaveLength(1);
  });
});

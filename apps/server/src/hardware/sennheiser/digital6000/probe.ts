import dgram from 'dgram';
import { SSC_PORT } from './protocol';

// Ask an SSC-over-UDP device what it is: one datagram out, one back.
//
// Used by discovery after a device has announced itself over mDNS as
// `_ssc._udp`, never as a sweep. The announcement says an SSC server is there
// but not which product; the model decides which client RFDeck starts, so the
// device is asked rather than guessed at.

export interface SscUdpIdentity {
  product: string;
  vendor: string | null;
  version: string | null;
  /** The name the operator gave the device, if it reports one. */
  name: string | null;
}

export function probeSscUdp(ip: string, port = SSC_PORT, timeoutMs = 1500): Promise<SscUdpIdentity | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    const finish = (result: SscUdpIdentity | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    socket.on('error', () => finish(null));
    socket.on('message', (buf, rinfo) => {
      if (rinfo.address !== ip) return;
      try {
        const json = JSON.parse(buf.toString('utf8'));
        const identity = json?.device?.identity;
        if (!identity || typeof identity.product !== 'string') return;
        finish({
          product: identity.product,
          vendor: typeof identity.vendor === 'string' ? identity.vendor : null,
          version: typeof identity.version === 'string' ? identity.version : null,
          name: typeof json.device.name === 'string' ? json.device.name : null,
        });
      } catch { /* not a reply to us; keep waiting */ }
    });

    // The device answers to the port the question came from.
    socket.bind(0, () => {
      const question = JSON.stringify({
        device: { identity: { product: null, vendor: null, version: null }, name: null },
      });
      socket.send(question, port, ip, (err) => { if (err) finish(null); });
    });
  });
}

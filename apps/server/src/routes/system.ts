import { FastifyPluginAsync } from 'fastify';
import * as os from 'os';

interface NetworkInterface {
  name: string;
  address: string;
  label: string;
}

export const systemRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/system/network-interfaces', async () => {
    const raw = os.networkInterfaces();
    const result: NetworkInterface[] = [
      { name: 'any', address: '0.0.0.0', label: '0.0.0.0 — All Interfaces' },
    ];

    for (const [name, addrs] of Object.entries(raw)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if (addr.family !== 'IPv4' || addr.internal) continue;
        result.push({
          name,
          address: addr.address,
          label: `${addr.address} — ${name}`,
        });
      }
    }

    return result;
  });

  // Clear the RF event log for everyone. The log is server-owned, so clearing
  // it on one client has to clear it on all of them — otherwise operators end
  // up comparing different histories of the same show.
  fastify.delete('/system/rf-events', async () => {
    (fastify as any).deviceManager.clearRfEvents();
    return { success: true };
  });
};

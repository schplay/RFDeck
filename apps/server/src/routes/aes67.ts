import { FastifyPluginAsync } from 'fastify';
import { SinkManager } from '../audio/SinkManager';
import { AES67DaemonClient } from '../audio/AES67DaemonClient';
import { listAudioInputDevices } from '../audio/deviceList';
import { log } from '../logger';

// AES67 stream routing, driven from RFDeck rather than the daemon's own web UI.
//
// The daemon exposes its configuration on a separate port that a rack server
// often is not publishing, and asking an operator to manage subscriptions in a
// second interface — in different vocabulary, with no knowledge of which RF
// channel is which — is not a workable answer during a show call.

const daemon = new AES67DaemonClient();
const sinks = new SinkManager(daemon);

// Which ALSA device do sinks land on? The RAVENNA device the daemon creates.
// Identified by name rather than by card number, which changes with boot order
// and with whatever else is plugged in.
function ravennaDevice() {
  const devices = listAudioInputDevices();
  return devices.find(d => /ravenna|aes67|merging/i.test(d.label)) ?? null;
}

export const aes67Routes: FastifyPluginAsync = async (fastify) => {
  // Everything the routing page needs, in one call.
  fastify.get('/aes67/status', async () => {
    const available = await daemon.available();
    if (!available) {
      return {
        available: false,
        reason:
          'The AES67 daemon is not responding on ' + daemon.url + '. It is ' +
          'installed by scripts/install-ubuntu.sh; a desktop install or one run ' +
          'with --no-aes67 will not have it.',
        sources: [], sinks: [], device: null, ptp: null,
      };
    }

    const device = ravennaDevice();
    const [sources, currentSinks, ptp] = await Promise.all([
      daemon.browseSources('all'),
      daemon.listSinks(),
      daemon.ptpStatus(),
    ]);

    // Pair each discovered sender with its subscription, so the UI can show one
    // list rather than making the operator cross-reference two.
    const enriched = sources.map(source => {
      const sink = currentSinks.find(s => SinkManager.isSubscribedTo(s, source));
      return {
        id: source.id,
        name: SinkManager.sourceName(source),
        via: source.source,
        address: source.address ?? null,
        channels: SinkManager.channelCountFromSdp(source.sdp),
        subscribed: !!sink,
        sinkId: sink?.id ?? null,
        // 1-based, matching how the audio patch refers to inputs.
        inputChannels: sink ? (sink.map ?? []).map(c => c + 1) : [],
      };
    });

    return {
      available: true,
      reason: null,
      device: device ? { id: device.id, label: device.label, channels: device.channels } : null,
      sources: enriched,
      sinks: currentSinks,
      ptp,
    };
  });

  // Receive one discovered sender.
  fastify.post('/aes67/subscribe', async (request, reply) => {
    const { sourceId } = request.body as { sourceId?: string };
    if (!sourceId) return reply.code(400).send({ error: 'sourceId is required' });

    const device = ravennaDevice();
    if (!device) {
      return reply.code(409).send({
        error: 'No RAVENNA capture device found on this machine, so there is ' +
               'nowhere to receive the stream. Check the kernel module is loaded: ' +
               'lsmod | grep MergingRavenna',
      });
    }

    const source = (await daemon.browseSources('all')).find(s => s.id === sourceId);
    if (!source) {
      return reply.code(404).send({
        error: 'That sender is no longer being announced. Rescan and try again.',
      });
    }

    try {
      const result = await sinks.provision(source, device.channels);
      return result;
    } catch (err: any) {
      log.warn(`[aes67] Subscribe failed: ${err?.message}`);
      return reply.code(409).send({ error: err?.message ?? 'Could not subscribe' });
    }
  });

  // Subscribe to everything not already received.
  fastify.post('/aes67/subscribe-all', async (_request, reply) => {
    const device = ravennaDevice();
    if (!device) {
      return reply.code(409).send({ error: 'No RAVENNA capture device found on this machine.' });
    }
    try {
      return await sinks.provisionAll(device.channels);
    } catch (err: any) {
      return reply.code(502).send({ error: err?.message ?? 'Could not reach the AES67 daemon' });
    }
  });

  fastify.delete('/aes67/subscribe/:sinkId', async (request, reply) => {
    const { sinkId } = request.params as { sinkId: string };
    const id = Number(sinkId);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Invalid sink id' });

    try {
      await sinks.unprovision(id);
      return { success: true };
    } catch (err: any) {
      return reply.code(502).send({ error: err?.message ?? 'Could not remove the subscription' });
    }
  });
};

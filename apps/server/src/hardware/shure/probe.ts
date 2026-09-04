import net from 'net';
import { log } from '../../logger';
import {
  ShureFamily, identifyModel, unsupportedModel, splitMessages, parseMessage,
} from './protocol';

// Ask a host on TCP 2202 what it is.
//
// Two jobs, and the first one matters more: decide whether this is a Shure
// receiver at all. An open port is not identification — the Sennheiser
// discovery already learned that lesson the expensive way, by claiming every
// device on a venue network that answered HTTPS on 443. So a host is only
// claimed when it replies with a well-formed `< REP ... >`, which nothing else
// on a network does by accident.
//
// The second job is working out which receiver it is, because the model
// decides both the command vocabulary and how many channels to poll — and
// getting it wrong is the least diagnosable failure this protocol has.

const SHURE_PORT = 2202;

/** Long enough for embedded firmware on a busy network, short enough to scan. */
const PROBE_TIMEOUT_MS = 2500;

/** After the last reply, wait this long for stragglers before deciding. */
const QUIET_MS = 350;

/** Highest channel index any supported receiver has. */
const MAX_CHANNELS = 4;

export interface ShureIdentity {
  family: ShureFamily;
  /** How many channels actually answered. */
  channels: number;
  deviceId: string | null;
  firmware: string | null;
  /** Axient reports one; ULX-D and QLX-D have no MODEL parameter at all. */
  model: string | null;
}

/**
 * What a probe found, from the replies it collected.
 *
 * Pure, so the decision logic is testable without a socket — which matters
 * because it is all inference: the absence of a MODEL reply is itself the
 * evidence that this is not an Axient receiver.
 */
export function identifyFromReplies(messages: string[]): ShureIdentity | null {
  let deviceId: string | null = null;
  let firmware: string | null = null;
  let model: string | null = null;
  const channelsSeen = new Set<number>();
  let sawAnyReport = false;

  for (const raw of messages) {
    const m = parseMessage(raw);
    if (!m || (m.type !== 'REP' && m.type !== 'REPORT')) continue;
    sawAnyReport = true;

    if (m.channel === null) {
      if (m.param === 'DEVICE_ID') deviceId = m.value || null;
      else if (m.param === 'FW_VER') firmware = m.value || null;
      else if (m.param === 'MODEL') model = m.value || null;
      continue;
    }

    // A channel that answers exists. This is how the channel count is
    // established for ULX-D, which has no MODEL to read it from.
    if (m.param === 'CHAN_NAME') channelsSeen.add(m.channel);
  }

  // Nothing well-formed came back: not a Shure receiver, whatever is on 2202.
  if (!sawAnyReport) return null;

  const fromModel = model ? identifyModel(model) : null;

  // A model this build recognises but cannot drive is refused by name.
  //
  // The earlier version of this treated *any* MODEL reply as "Axient", on the
  // reasoning that only Axient answers MODEL. SLX-D answers it too, and its
  // metering sample is a different shape — so an SLX-D would have been
  // identified as Axient and then had its audio peak read as channel quality
  // and its RF level as an antenna string. Every number on the dashboard
  // wrong, and every one of them plausible.
  if (!fromModel && model) {
    const unsupported = unsupportedModel(model);
    log.warn(
      unsupported
        ? `[Shure] ${model} is a ${unsupported}, which RFDeck cannot drive yet — ` +
          `see docs/MANUFACTURER_ROADMAP.md`
        : `[Shure] Unrecognised model "${model}". Not claiming it rather than ` +
          `guessing at its protocol dialect.`,
    );
    return null;
  }

  // No MODEL reply at all means ULX-D or QLX-D, which have no such parameter.
  const family: ShureFamily = fromModel?.family ?? 'ulxd';

  // Prefer what actually answered over what the model implies. A receiver with
  // a channel card removed, or a model string this build does not recognise,
  // is described by its behaviour rather than by a table.
  const answered = channelsSeen.size > 0 ? Math.max(...channelsSeen) : 0;
  const channels = answered || fromModel?.channels || 1;

  return { family, channels, deviceId, firmware, model };
}

/** The queries a probe sends. Exported so a test can assert on them. */
export function probeCommands(): string[] {
  const cmds = ['< GET MODEL >', '< GET DEVICE_ID >', '< GET FW_VER >'];
  // Which channels answer is how the count is established. Asking a
  // two-channel receiver about channels 3 and 4 is harmless — it simply does
  // not reply, and that silence is the answer.
  for (let ch = 1; ch <= MAX_CHANNELS; ch++) cmds.push(`< GET ${ch} CHAN_NAME >`);
  return cmds;
}

/**
 * Probe one host. Resolves null for anything that is not a Shure receiver.
 *
 * Never rejects: this is called across a whole subnet, where refused
 * connections and timeouts are the normal case rather than errors.
 */
export function probeShure(
  ip: string,
  port: number = SHURE_PORT,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ShureIdentity | null> {
  return new Promise(resolve => {
    const socket = new net.Socket();
    const collected: string[] = [];
    let buffer = '';
    let settled = false;
    let quietTimer: NodeJS.Timeout | null = null;

    const finish = (result: ShureIdentity | null) => {
      if (settled) return;
      settled = true;
      if (quietTimer) clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      socket.removeAllListeners();
      socket.on('error', () => { /* nothing left to report to */ });
      socket.destroy();
      resolve(result);
    };

    const hardTimer = setTimeout(() => finish(identifyFromReplies(collected)), timeoutMs);

    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => finish(identifyFromReplies(collected)));
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(identifyFromReplies(collected)));

    socket.on('connect', () => {
      for (const cmd of probeCommands()) socket.write(cmd);
    });

    socket.on('data', chunk => {
      const { messages, remainder } = splitMessages(buffer + chunk.toString('utf8'));
      buffer = remainder;
      collected.push(...messages);

      // Decide once the device has stopped talking, rather than after the full
      // timeout — a subnet scan doing this serially would otherwise take
      // minutes of waiting on devices that already answered.
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(identifyFromReplies(collected)), QUIET_MS);
    });

    socket.connect(port, ip);
  });
}

/** A human-readable name for a probed receiver. */
export function describeIdentity(id: ShureIdentity, ip: string): string {
  const name = id.deviceId?.trim();
  if (name) return name;
  if (id.model) return `Shure ${id.model}`;
  return `Shure receiver (${ip})`;
}

export function logIdentity(ip: string, id: ShureIdentity): void {
  log.debug(
    `[Discovery] Shure at ${ip}: family=${id.family} channels=${id.channels} ` +
    `model=${id.model ?? 'n/a'} id=${id.deviceId ?? 'n/a'}`,
  );
}

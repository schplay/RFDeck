#!/usr/bin/env node
import { prisma } from './db';
import { makePinHash } from './auth/pinAuth';

// Administration from a shell on the server.
//
// RFDeck normally runs headless, where nobody can open a browser on the host —
// so shell access has to be a first-class way to administer it, and the only
// recovery path when a PIN is forgotten. Everything here is reachable over SSH.
//
//   rfdeck status
//   rfdeck set-pin 4821 [--reauth-hours 24]
//   rfdeck disable-pin
//   rfdeck audio-devices
//
// Run on the server as the rfdeck user (or root) so it can read the database.

function usage(): void {
  console.log(`
RFDeck server administration

  rfdeck status                       Show access and audio configuration
  rfdeck set-pin <pin> [--reauth-hours N]
                                      Set the remote-access PIN and enable it
  rfdeck disable-pin                  Turn off the PIN (network becomes open)
  rfdeck audio-devices                List capture devices on this machine
  rfdeck audio-level <device> [input ...]
                                      Capture one second and report the level
                                      on each input, to tell whether signal is
                                      reaching this machine at all

The PIN gates remote clients only; a browser on this machine is always trusted.
Changing or disabling the PIN signs out every remote device.
`.trim());
}

async function settingsRow() {
  const existing = await prisma.settings.findFirst();
  return existing ?? prisma.settings.create({ data: {} });
}

async function cmdStatus(): Promise<void> {
  const s = await settingsRow();
  const pinSet = !!s.authPinHash;

  console.log('Remote access');
  console.log(`  PIN required   : ${s.authPinEnabled ? 'yes' : 'no'}`);
  console.log(`  PIN configured : ${pinSet ? 'yes' : 'no'}`);
  console.log(
    `  Re-ask after   : ${s.authReauthHours > 0 ? `${s.authReauthHours}h` : 'never'}`,
  );

  if (s.authPinEnabled && !pinSet) {
    console.log('\n  WARNING: PIN is enabled but none is set. Run: rfdeck set-pin <pin>');
  }

  const patches = await prisma.channelAudioMap.count();
  console.log('\nAudio');
  console.log(`  Channels patched : ${patches}`);
}

async function cmdSetPin(argv: string[]): Promise<void> {
  const pin = argv[0];
  if (!pin || !/^\d{4,12}$/.test(pin)) {
    console.error('A PIN of 4 to 12 digits is required.\n  rfdeck set-pin 4821');
    process.exit(1);
  }

  let reauthHours: number | undefined;
  const flag = argv.indexOf('--reauth-hours');
  if (flag >= 0) {
    const value = Number(argv[flag + 1]);
    if (!Number.isFinite(value) || value < 0) {
      console.error('--reauth-hours takes a number of hours, or 0 for never.');
      process.exit(1);
    }
    reauthHours = value;
  }

  const s = await settingsRow();
  await prisma.settings.update({
    where: { id: s.id },
    data: {
      authPinHash: makePinHash(pin),
      authPinEnabled: true,
      ...(reauthHours !== undefined ? { authReauthHours: reauthHours } : {}),
    },
  });

  console.log('PIN set. Remote devices must enter it to connect.');
  // Tokens live in the server process, so a running service must be restarted
  // for existing sessions to be invalidated by this change.
  console.log('Restart to sign out devices already connected:');
  console.log('  sudo systemctl restart rfdeck');
}

async function cmdDisablePin(): Promise<void> {
  const s = await settingsRow();
  await prisma.settings.update({
    where: { id: s.id },
    data: { authPinEnabled: false },
  });
  console.log('PIN disabled — any device on the network can now connect.');
  console.log('The stored PIN is kept, so re-enabling does not need it re-typed.');
  console.log('  sudo systemctl restart rfdeck');
}

// Is signal actually reaching this machine?
//
// "I hear nothing" has two halves — audio not arriving at the server, and
// audio not reaching the browser — and they need different fixes. This answers
// the first half on its own by opening the device exactly the way RFDeck does
// (same format, rate and width) and measuring what comes out, with WebRTC and
// the browser out of the picture entirely.
async function cmdAudioLevel(args: string[]): Promise<void> {
  const { probeChannelCount, FALLBACK_CHANNELS } = await import('./audio/deviceList');
  const { spawnSync } = await import('child_process');

  const deviceId = args[0];
  if (!deviceId) {
    console.error('Usage: rfdeck audio-level <device> [input ...]   e.g. rfdeck audio-level hw:2,0 1 2');
    process.exit(1);
  }
  const wanted = args.slice(1).map(Number).filter(n => Number.isInteger(n) && n >= 1);

  const probed = probeChannelCount(deviceId);
  const channels = probed ?? FALLBACK_CHANNELS;
  if (probed === null) {
    console.log(`Could not read the channel count for ${deviceId}; assuming ${channels}.\n`);
  }

  const SECONDS = 1;
  const RATE = 48000;
  console.log(
    `Capturing ${SECONDS}s from ${deviceId} as ${channels}-channel S16_LE ${RATE / 1000} kHz ` +
    `— the same way RFDeck opens it.\n`,
  );

  // Identical arguments to CaptureManager, so a format the device refuses
  // fails here with arecord's own words rather than silently in the service.
  const r = spawnSync('arecord', [
    '-D', deviceId, '-f', 'S16_LE', '-r', String(RATE), '-c', String(channels),
    '-t', 'raw', '-d', String(SECONDS), '-q',
  ], { maxBuffer: 256 * 1024 * 1024 });

  if (r.error) {
    console.log(`arecord could not be started: ${r.error.message}`);
    process.exit(1);
  }
  const stderr = r.stderr?.toString().trim();
  if (stderr) console.log(`arecord said:\n  ${stderr.split('\n').join('\n  ')}\n`);

  const buf = r.stdout ?? Buffer.alloc(0);
  const frameBytes = channels * 2;
  const frames = Math.floor(buf.length / frameBytes);
  if (frames === 0) {
    console.log(
      'No audio data came back. If arecord reported an error above, that is the ' +
      'reason — and it is why the service gets nothing either.',
    );
    process.exit(1);
  }
  console.log(`Received ${frames} frames (${(frames / RATE).toFixed(2)}s).\n`);

  const dbfs = (v: number) => (v > 0 ? (20 * Math.log10(v / 32768)).toFixed(1) : '-inf');
  const list = wanted.length > 0 ? wanted : Array.from({ length: channels }, (_, i) => i + 1);

  console.log('  input     peak dBFS    rms dBFS');
  let silent = 0;
  for (const ch of list) {
    if (ch > channels) {
      console.log(`  ${String(ch).padEnd(9)} (device has only ${channels} inputs)`);
      continue;
    }
    let peak = 0;
    let sumSq = 0;
    const offset = (ch - 1) * 2;
    for (let f = 0; f < frames; f++) {
      const s = buf.readInt16LE(f * frameBytes + offset);
      const a = Math.abs(s);
      if (a > peak) peak = a;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / frames);
    if (peak === 0) silent++;
    console.log(
      `  ${String(ch).padEnd(9)} ${dbfs(peak).padStart(9)}   ${dbfs(rms).padStart(9)}` +
      (peak === 0 ? '   silent' : ''),
    );
  }

  if (silent === list.length) {
    console.log(
      '\nEvery input measured is silent: nothing is arriving at this server on ' +
      'those channels. Look at the AES67 subscription and PTP lock before the browser.',
    );
  } else {
    console.log(
      '\nSignal is reaching this server. If the browser still plays nothing, the ' +
      'fault is between the service and the browser, not in the audio network.',
    );
  }
}

async function cmdAudioDevices(): Promise<void> {
  // Imported lazily so `status` works on a machine with no sound subsystem.
  const { listAudioInputDevices, describeNoDevices, describeAccessProblem } =
    await import('./audio/deviceList');
  const devices = listAudioInputDevices();

  // This CLI is normally run under sudo, so it sees more than the service does.
  // Say so plainly: a root-only success here reads as "audio works" while the
  // service is still shut out, which is exactly how a permissions fault gets
  // mistaken for a hardware limit.
  if (process.getuid?.() === 0) {
    console.log('Note: running as root. To check what the service itself sees:');
    console.log('  sudo -u rfdeck arecord -l\n');
  }

  if (devices.length === 0) {
    console.log(describeNoDevices());
    return;
  }

  console.log('Capture devices on this machine:\n');
  for (const d of devices) {
    const width = d.channelsProbed
      ? `${d.channels} input${d.channels === 1 ? '' : 's'}`
      : `width unknown, assuming ${d.channels}`;
    console.log(`  ${d.id.padEnd(10)} ${d.label}  (${width})`);
  }

  const accessProblem = describeAccessProblem();
  if (accessProblem) console.log(`\n! ${accessProblem}`);

  const patches = await prisma.channelAudioMap.findMany();
  if (patches.length > 0) {
    console.log('\nPatched channels:\n');
    for (const p of patches) {
      console.log(`  ${p.channelKey.padEnd(24)} -> ${p.deviceId} input ${p.inputChannel}`);
    }
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case 'status':         await cmdStatus(); break;
    case 'set-pin':        await cmdSetPin(rest); break;
    case 'disable-pin':    await cmdDisablePin(); break;
    case 'audio-devices':  await cmdAudioDevices(); break;
    case 'audio-level':    await cmdAudioLevel(rest); break;
    case undefined:
    case '-h':
    case '--help':         usage(); break;
    default:
      console.error(`Unknown command: ${command}\n`);
      usage();
      process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

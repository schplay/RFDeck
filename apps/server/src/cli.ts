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

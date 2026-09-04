// Did this device's firmware actually change?
//
// Firmware is the one maintenance event visible over the network, and it is
// the one most likely to explain "it worked last month" — so RFDeck logs it
// without being asked. That makes getting the condition right worth more than
// the three lines suggest: a false positive writes a maintenance entry
// claiming work nobody did, on every reconnect.
//
// Three ways to get it wrong, all of which look the same in passing:
//
//   First contact records a version for the first time. That is not an update.
//   A device that reports nothing must not read as "downgraded to unknown".
//   Firmware strings arrive with incidental whitespace and casing from
//   different endpoints on the same device.

export interface FirmwareChange {
  from: string;
  to: string;
}

export function detectFirmwareChange(
  previous: string | null | undefined,
  reported: string | null | undefined,
): FirmwareChange | null {
  const from = (previous ?? '').trim();
  const to = (reported ?? '').trim();

  // Nothing reported: the device did not say, which is not a downgrade.
  if (!to) return null;
  // Nothing on record: this is the first version we have seen, not a change.
  if (!from) return null;
  // Same version, however it was punctuated on the wire.
  if (from.toLowerCase() === to.toLowerCase()) return null;

  return { from, to };
}

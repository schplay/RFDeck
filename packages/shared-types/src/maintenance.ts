// The maintenance log for one piece of hardware.
//
// Answers "has this one been trouble before", which is what an operator wants
// to know when a channel misbehaves and they are deciding whether to swap the
// pack or chase the RF. Across a season, a rental fleet, or a change of A2,
// memory does not answer it.

export type MaintenanceKind =
  | 'BATTERY'
  | 'ELEMENT'
  | 'REPAIR'
  | 'FIRMWARE'
  | 'SERVICE'
  | 'NOTE';

export interface MaintenanceEntry {
  id: string;
  deviceId: string;
  /** When the work happened — not when it was written down. ISO 8601. */
  at: string;
  kind: MaintenanceKind;
  summary: string;
  detail: string;
  /** True for entries RFDeck wrote itself, such as an observed firmware change. */
  automatic: boolean;
  createdAt: string;
}

/**
 * The kinds an operator can pick, in the order they are offered.
 *
 * Ordered by how often they are actually logged rather than alphabetically:
 * elements and batteries are consumables that fail weekly, a repair is an
 * event, and NOTE is the escape hatch that should not be the first thing the
 * eye lands on.
 */
export const MAINTENANCE_KINDS: ReadonlyArray<{
  kind: MaintenanceKind;
  label: string;
  /** Shown as the placeholder, to suggest the level of detail that is useful. */
  hint: string;
}> = [
  { kind: 'ELEMENT',  label: 'Element / capsule', hint: 'e.g. MKE-1 replaced, old one intermittent' },
  { kind: 'BATTERY',  label: 'Battery / pack',    hint: 'e.g. cells replaced, pack held 40% for a week' },
  { kind: 'SERVICE',  label: 'Service / clean',   hint: 'e.g. connectors reseated, contacts cleaned' },
  { kind: 'REPAIR',   label: 'Repair',            hint: 'e.g. sent to service, RMA 41822' },
  { kind: 'FIRMWARE', label: 'Firmware',          hint: 'e.g. updated 4.1.0 to 4.2.1' },
  { kind: 'NOTE',     label: 'Note',              hint: 'anything else worth remembering about this unit' },
];

export function maintenanceKindLabel(kind: string): string {
  return MAINTENANCE_KINDS.find(k => k.kind === kind)?.label ?? 'Note';
}

// A person, independent of any show. Cast into shows via Player rows, which
// carry the per-show role, channel and notes.
export interface Performer {
  id: string;
  name: string;
  notes: string;
  /** How many shows this performer is cast in. Informational. */
  castingCount: number;
  createdAt: string;
  updatedAt: string;
}

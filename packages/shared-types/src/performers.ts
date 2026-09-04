// A person, independent of any show. Cast into shows via Player rows, which
// carry the per-show role, channel and notes.
export interface Performer {
  id: string;
  name: string;
  notes: string;
  /**
   * How this person is rigged: element placement, pack position, spare
   * element, comfort and allergy notes. Belongs to the person rather than the
   * production — it is the same next season.
   */
  fitNotes: string;
  /** URL for the headshot, or null when there is none. */
  photoUrl: string | null;
  /** How many shows this performer is cast in. Informational. */
  castingCount: number;
  createdAt: string;
  updatedAt: string;
}

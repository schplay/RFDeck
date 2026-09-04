import { Show } from './shows';

// What a show type calls things, and which parts of the performer notebook
// apply to it.
//
// A theatre run needs a quick-change log — packs come off and go back on
// between scenes, and an A2 has to know when. A worship service does not, and
// showing that section there is clutter in front of the one thing they came to
// do. Vocabulary works the same way: "Act" and "Character" are wrong for a
// Sunday morning.
//
// Shared rather than living in the show page, so the roster, the show page and
// the printed report describe a production the same way.

export interface EnvironmentProfile {
  periodLabel: string;   // Act / Service / Set / Session / Segment
  rosterLabel: string;   // Players / Roster / Performers / Presenters / Talent
  personLabel: string;   // Player / Musician / Performer / Presenter
  roleLabel: string;     // Character / Part-Instrument / Role / Title
  addPersonLabel: string;
  emptyRoster: string;
  realNameLabel: string;

  /**
   * Costume changes that take the pack off and back on. Theatre business:
   * everywhere else it is a section nobody fills in.
   */
  quickChanges: boolean;
  /**
   * Where the element is taped, where the pack sits, spare element, comfort
   * and allergy notes. Belongs to the person, not the production — it is the
   * same next season — so it lives on the roster entry.
   */
  fitNotes: boolean;
  /** A headshot, for finding someone backstage who you have not met. */
  photos: boolean;
}

export const ENVIRONMENTS: Record<Show['environmentMode'], EnvironmentProfile> = {
  THEATER: {
    periodLabel:    'Act',
    rosterLabel:    'Players',
    personLabel:    'Player',
    roleLabel:      'Character',
    addPersonLabel: 'Add Player',
    emptyRoster:    'No players yet — add your cast below',
    realNameLabel:  'Real Name',
    quickChanges:   true,
    fitNotes:       true,
    photos:         true,
  },
  CONCERT: {
    periodLabel:    'Set',
    rosterLabel:    'Performers',
    personLabel:    'Performer',
    roleLabel:      'Instrument / Role',
    addPersonLabel: 'Add Performer',
    emptyRoster:    'No performers yet — add your band below',
    realNameLabel:  'Name',
    quickChanges:   false,
    fitNotes:       true,
    photos:         true,
  },
  CORPORATE: {
    periodLabel:    'Session',
    rosterLabel:    'Presenters',
    personLabel:    'Presenter',
    roleLabel:      'Title',
    addPersonLabel: 'Add Presenter',
    emptyRoster:    'No presenters yet — add your speakers below',
    realNameLabel:  'Name',
    quickChanges:   false,
    fitNotes:       true,
    photos:         true,
  },
  BROADCAST: {
    periodLabel:    'Segment',
    rosterLabel:    'Talent',
    personLabel:    'Talent',
    roleLabel:      'Role',
    addPersonLabel: 'Add Talent',
    emptyRoster:    'No talent yet — add your on-air team below',
    realNameLabel:  'Name',
    quickChanges:   false,
    fitNotes:       true,
    photos:         true,
  },
  HOUSE_OF_WORSHIP: {
    periodLabel:    'Service',
    rosterLabel:    'Roster',
    personLabel:    'Musician',
    roleLabel:      'Part / Instrument',
    addPersonLabel: 'Add to Roster',
    emptyRoster:    'No one on the roster yet — add musicians below',
    realNameLabel:  'Name',
    quickChanges:   false,
    fitNotes:       true,
    photos:         true,
  },
};

/** One performer coming off mic and back on, within a show. */
export interface QuickChange {
  id: string;
  playerId: string;
  /** Which act/set/service it falls in. Null when it spans or is unassigned. */
  act: number | null;
  /** When the pack comes off — a cue, a line, a scene number. */
  outCue: string;
  /** When it goes back on. */
  inCue: string;
  notes: string;
  sortIndex: number;
}

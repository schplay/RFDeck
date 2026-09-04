import { describe, it, expect } from 'vitest';
import { detectFirmwareChange } from './firmwareChange';

// This decides whether RFDeck writes a maintenance entry nobody asked for.
// A false positive is a log entry claiming work that was never done — worse
// than a missing one, because an operator reading the history will believe it.

describe('detectFirmwareChange', () => {
  it('reports a real change', () => {
    expect(detectFirmwareChange('4.1.0', '4.2.1')).toEqual({ from: '4.1.0', to: '4.2.1' });
  });

  it('reports a downgrade too — a rollback is maintenance', () => {
    expect(detectFirmwareChange('4.2.1', '4.1.0')).toEqual({ from: '4.2.1', to: '4.1.0' });
  });

  it('does not treat first contact as an update', () => {
    // The common case: a freshly added device reports its version, and there
    // is nothing on record to have changed from.
    expect(detectFirmwareChange(null, '4.2.1')).toBeNull();
    expect(detectFirmwareChange('', '4.2.1')).toBeNull();
    expect(detectFirmwareChange(undefined, '4.2.1')).toBeNull();
  });

  it('does not treat silence as a downgrade', () => {
    // A device that answers without a firmware field has not been downgraded
    // to nothing; it just did not say.
    expect(detectFirmwareChange('4.2.1', null)).toBeNull();
    expect(detectFirmwareChange('4.2.1', '')).toBeNull();
    expect(detectFirmwareChange('4.2.1', '   ')).toBeNull();
  });

  it('is not fooled by whitespace or casing from different endpoints', () => {
    // The same device reports its version from more than one place, and they
    // do not agree on punctuation. Logging an "update" on every reconnect
    // because of a trailing space would fill the log with fiction.
    expect(detectFirmwareChange('4.2.1', ' 4.2.1 ')).toBeNull();
    expect(detectFirmwareChange('4.2.1-RC', '4.2.1-rc')).toBeNull();
  });

  it('trims what it reports, so the entry text is clean', () => {
    expect(detectFirmwareChange(' 4.1.0 ', ' 4.2.1 ')).toEqual({ from: '4.1.0', to: '4.2.1' });
  });

  it('says nothing when both sides are empty', () => {
    expect(detectFirmwareChange(null, null)).toBeNull();
  });
});

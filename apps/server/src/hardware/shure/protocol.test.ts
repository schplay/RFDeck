import { describe, it, expect } from 'vitest';
import {
  splitMessages, parseMessage, parseSample, identifyModel,
  parseBatteryBars, batteryBarsToPercent, parseBatteryPercent, parseBatteryMinutes,
  rssiToDbm, rssiToPercent, dbmToPercent, audioToDbfs, parseFrequencyKhz,
  setMeterRate, setMute, setFrequency, getAll, getChannelParam, getEveryChannelParam,
  iemMeterToPercent,
  FAMILIES,
} from './protocol';

// There is no Shure receiver on this machine, so these fixtures are the
// closest thing to hardware: strings copied character-for-character out of
// Shure's own "Axient Digital — Command Strings" document, and out of a
// working implementation for the ULX-D names that document does not cover.
//
// See docs/SHURE_PROTOCOL.md. If any of this turns out to be wrong against a
// real receiver, the fix belongs here first and the code second.

describe('splitMessages', () => {
  it('splits several messages arriving in one read', () => {
    const { messages, remainder } = splitMessages(
      '< REP 1 CHAN_NAME {Lead Vox} >< REP 1 TX_BATT_BARS 004 >',
    );
    expect(messages).toEqual([
      '< REP 1 CHAN_NAME {Lead Vox} >',
      '< REP 1 TX_BATT_BARS 004 >',
    ]);
    expect(remainder).toBe('');
  });

  it('carries a message split across two reads', () => {
    // Shure sends no line breaks, so a TCP segment routinely ends mid-message.
    // Dropping the tail loses whichever message straddled the boundary —
    // usually a meter sample, so the symptom is a stuttering meter rather than
    // anything that looks like a fault.
    const first = splitMessages('< REP 1 TX_BATT_BARS 004 >< REP 1 RSSI 1 08');
    expect(first.messages).toHaveLength(1);
    expect(first.remainder).toBe('< REP 1 RSSI 1 08');

    const second = splitMessages(first.remainder + '6 >');
    expect(second.messages).toEqual(['< REP 1 RSSI 1 086 >']);
    expect(second.remainder).toBe('');
  });

  it('returns nothing but keeps the tail when no message is complete', () => {
    const { messages, remainder } = splitMessages('< REP 1 CHAN_N');
    expect(messages).toEqual([]);
    expect(remainder).toBe('< REP 1 CHAN_N');
  });

  it('does not grow without bound on a device that opens a message and stops', () => {
    const { remainder } = splitMessages('<' + 'x'.repeat(10_000));
    expect(remainder.length).toBeLessThanOrEqual(1024);
  });

  it('drops a stray closing bracket rather than carrying it forever', () => {
    const { messages, remainder } = splitMessages('junk >< REP 1 TX_BATT_BARS 004 >');
    expect(messages).toEqual(['< REP 1 TX_BATT_BARS 004 >']);
    expect(remainder).toBe('');
  });
});

describe('parseMessage', () => {
  it('reads a channel-level report', () => {
    const m = parseMessage('< REP 1 TX_BATT_BARS 004 >')!;
    expect(m.type).toBe('REP');
    expect(m.channel).toBe(1);
    expect(m.param).toBe('TX_BATT_BARS');
    expect(m.value).toBe('004');
  });

  it('reads a device-level report, which carries no channel index', () => {
    const m = parseMessage('< REP DEVICE_ID {AD4Q-A } >')!;
    expect(m.channel).toBeNull();
    expect(m.param).toBe('DEVICE_ID');
    expect(m.value).toBe('AD4Q-A');
  });

  it('keeps a braced name containing spaces whole', () => {
    // Splitting on whitespace turns "Lead Vox" into "Lead" — the failure is
    // silent and looks like a device that reports truncated names.
    const m = parseMessage('< REP 1 CHAN_NAME {Lead Vox                       } >')!;
    expect(m.value).toBe('Lead Vox');
  });

  it('strips the fixed-width padding Shure sends inside braces', () => {
    const m = parseMessage('< REP 1 CHAN_NAME {Channel1  } >')!;
    expect(m.value).toBe('Channel1');
  });

  it('handles an empty braced value — an unpaired transmitter slot', () => {
    const m = parseMessage('< REP 1 TX_DEVICE_ID {  } >')!;
    expect(m.value).toBe('');
  });

  it('reads a parameter with its own index after the name', () => {
    // RSSI is indexed by antenna as well as channel: 1:A 2:B 3:C 4:D.
    const m = parseMessage('< REP 1 RSSI 1 083 >')!;
    expect(m.channel).toBe(1);
    expect(m.param).toBe('RSSI');
    expect(m.args).toEqual(['1', '083']);
  });

  it('returns null for empty or bracket-only input', () => {
    expect(parseMessage('<  >')).toBeNull();
    expect(parseMessage('')).toBeNull();
  });
});

describe('parseSample — Axient Digital', () => {
  // Verbatim from the specification, standard channel:
  //   < SAMPLE chNum ALL qual audBitmap audPeak audRms rfAntStats
  //            rfBitmapA rfRssiA rfBitmapB rfRssiB >
  const STANDARD = '< SAMPLE 1 ALL 005 031 102 102 BB 31 086 31 065 >';

  it('reads quality, audio and both antennas', () => {
    const s = parseSample(parseMessage(STANDARD)!, 'axtd')!;
    expect(s.channel).toBe(1);
    expect(s.quality).toBe(5);
    // audRms 102 → 102 - 120 = -18 dBFS.
    expect(s.audioDbfs).toBe(-18);
    expect(s.antennas).toEqual(['B', 'B']);
    expect(s.rfPercent).toHaveLength(2);
  });

  it('reads four antennas on a Quadversity channel', () => {
    // The layout grows. A parser with hardcoded indices reads the wrong
    // fields here and reports plausible nonsense rather than failing.
    const quad = '< SAMPLE 1 ALL 005 031 102 102 BBBB 31 083 31 068 31 069 31 072 >';
    const s = parseSample(parseMessage(quad)!, 'axtd')!;
    expect(s.antennas).toEqual(['B', 'B', 'B', 'B']);
    expect(s.rfPercent).toHaveLength(4);
  });

  it('does not read a frequency-diversity second section as more antennas', () => {
    // FD-C appends a whole second RF section. Its fields are not antennas C
    // and D of the first one, and showing them as such would put a second
    // receiver's signal on this channel's meter.
    const fdc = '< SAMPLE 1 ALL 005 031 102 102 BB 31 082 31 060 BB 31 082 31 060 >';
    const s = parseSample(parseMessage(fdc)!, 'axtd')!;
    expect(s.antennas).toEqual(['B', 'B']);
    expect(s.rfPercent).toHaveLength(2);
  });

  it('reads the antenna letters, including an antenna that is off', () => {
    const m = parseMessage('< REP 1 ANTENNA_STATUS BRXB >')!;
    expect(m.value).toBe('BRXB');
  });

  it('treats quality 255 as unknown rather than as a reading', () => {
    const unknown = '< SAMPLE 1 ALL 255 031 102 102 BB 31 086 31 065 >';
    const s = parseSample(parseMessage(unknown)!, 'axtd')!;
    expect(s.quality).toBeNull();
  });

  it('refuses anything that is not a sample', () => {
    expect(parseSample(parseMessage('< REP 1 TX_BATT_BARS 004 >')!, 'axtd')).toBeNull();
  });
});

describe('parseSample — ULX-D', () => {
  // < SAMPLE 1 ALL antenna rf audio >, per micboard's field indices.
  it('reads antenna, RF and audio', () => {
    const s = parseSample(parseMessage('< SAMPLE 1 ALL AX 075 040 >')!, 'ulxd')!;
    expect(s.channel).toBe(1);
    // "AX - Antenna A on, Antenna B off" — positional, not Axient's X/R/B.
    expect(s.antennas).toEqual(['A', 'X']);
    // One RF figure, not one per antenna: the ULX-D sample carries a single
    // "aaa" field and "nn" is only which LEDs are lit.
    expect(s.rfPercent).toHaveLength(1);
    // Audio 000-050, converted with the -50 offset: 40 → -10 dBFS.
    expect(s.audioDbfs).toBe(-10);
  });

  it('reports no link quality, because the family does not send one', () => {
    const s = parseSample(parseMessage('< SAMPLE 1 ALL AX 075 040 >')!, 'ulxd')!;
    expect(s.quality).toBeNull();
  });
});

describe('parseSample — SLX-D', () => {
  // Verbatim from Shure's SLX-D document:
  //   < SAMPLE chNum ALL audPeak audRms rfRssi >
  //   < SAMPLE 1 ALL 102 102 086 >
  const SAMPLE = '< SAMPLE 1 ALL 102 102 086 >';

  it('reads the three fields SLX-D actually sends', () => {
    const s = parseSample(parseMessage(SAMPLE)!, 'slxd')!;
    expect(s.channel).toBe(1);
    // Same -120 offset as Axient, stated outright in SLX-D's own document.
    expect(s.audioDbfs).toBe(-18);
    expect(s.rfPercent).toHaveLength(1);
  });

  it('reports no antenna state and no quality, because SLX-D sends neither', () => {
    // Claiming either would be inventing it. An antenna indicator that is
    // always "off" reads as a fault on a working receiver.
    const s = parseSample(parseMessage(SAMPLE)!, 'slxd')!;
    expect(s.antennas).toEqual([]);
    expect(s.quality).toBeNull();
  });

  it('is not parsed as Axient, which would scramble every field', () => {
    // Read as Axient, this same line gives quality=102, audio from the antenna
    // slot and RF from nowhere. The numbers all look plausible.
    const asAxient = parseSample(parseMessage(SAMPLE)!, 'axtd');
    const asSlxd = parseSample(parseMessage(SAMPLE)!, 'slxd')!;
    expect(asAxient?.audioDbfs).not.toBe(asSlxd.audioDbfs);
  });
});

describe('PSM1000 — the IEM dialect', () => {
  // Verified against Shure's own PSM1000 command-strings page (archived
  // 2023-09-22, before the site became JavaScript-only). It differs from the
  // receivers in nearly every mechanical detail, and each difference fails
  // silently rather than loudly.

  it('mutes with 1/0, not ON/OFF', () => {
    // "SET x RF_MUTE vvvv  1 = mute, 0 = unmute". Sending ON to a PSM1000
    // looks accepted and does nothing.
    expect(setMute(1, true, 'p10t')).toBe('< SET 1 RF_MUTE 1 >\r\n');
    expect(setMute(1, false, 'p10t')).toBe('< SET 1 RF_MUTE 0 >\r\n');
    // And the receivers are unchanged.
    expect(setMute(1, true, 'axtd')).toBe('< SET 1 AUDIO_MUTE ON >');
  });

  it('terminates messages with CRLF, which the receivers do not', () => {
    // "Each message is terminated by a carriage return and line feed (CRLF)."
    expect(setMeterRate(1, 100, 'p10t').endsWith('\r\n')).toBe(true);
    expect(setMeterRate(1, 100, 'axtd').endsWith('\r\n')).toBe(false);
  });

  it('does not zero-pad the meter rate to five characters', () => {
    // The receivers document "5 character fixed output"; the PSM1000
    // documents an 11-character millisecond value.
    expect(setMeterRate(1, 100, 'p10t')).toBe('< SET 1 METER_RATE 100 >\r\n');
    expect(setMeterRate(1, 100, 'axtd')).toBe('< SET 1 METER_RATE 00100 >');
  });

  it('has no ALL command, so parameters are asked for one at a time', () => {
    // The PSM1000's command table has no ALL. Sending one would go
    // unanswered, and the device would look dead.
    expect(getAll(1, 'p10t')).toBeNull();
    expect(getAll(1, 'axtd')).toBe('< GET 1 ALL >');

    const each = getEveryChannelParam(1, 'p10t');
    expect(each).toContain('< GET 1 CHAN_NAME >\r\n');
    expect(each).toContain('< GET 1 FREQUENCY >\r\n');
    expect(each).toContain('< GET 1 RF_MUTE >\r\n');
  });

  it('asks for no battery, because a transmitter has none to report', () => {
    expect(FAMILIES.p10t.param.battBars).toBeUndefined();
    expect(FAMILIES.p10t.param.battMins).toBeUndefined();
    expect(getEveryChannelParam(1, 'p10t').join(' ')).not.toMatch(/BATT/);
  });

  it('is marked a transmitter, which is what suppresses RF alerting', () => {
    expect(FAMILIES.p10t.isTransmitter).toBe(true);
    expect(FAMILIES.axtd.isTransmitter).toBeFalsy();
  });

  it('names the stereo meter, which only an IEM has', () => {
    expect(FAMILIES.p10t.param.audioLevelL).toBe('AUDIO_IN_LVL_L');
    expect(FAMILIES.p10t.param.audioLevelR).toBe('AUDIO_IN_LVL_R');
    expect(FAMILIES.axtd.param.audioLevelL).toBeUndefined();
  });
});

describe('iemMeterToPercent', () => {
  // Shure documents these values only as "Audio Meter Level" with an
  // 11-character value — no units. The thresholds come from micboard and its
  // actively maintained wirelessboard fork, and reproduce the transmitter's
  // own front-panel LED ladder rather than measuring anything.
  it('rises monotonically across the ladder', () => {
    const points = [0, 10272, 23728, 85488, 246260, 641928, 1588744, 2157767, 2502970];
    const levels = points.map(p => iemMeterToPercent(p)!);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]).toBeGreaterThan(levels[i - 1]);
    }
  });

  it('reads silence as zero and a hot feed as full', () => {
    expect(iemMeterToPercent(0)).toBe(0);
    expect(iemMeterToPercent(5000)).toBe(0);
    expect(iemMeterToPercent(9_000_000)).toBe(100);
  });

  it('rejects an unreadable value rather than reporting silence', () => {
    // Reporting 0 for a level that could not be read is indistinguishable
    // from a dead monitor feed.
    expect(iemMeterToPercent('')).toBeNull();
    expect(iemMeterToPercent('---')).toBeNull();
  });
});

describe('value conversions', () => {
  it('converts RSSI to dBm by the offset each family documents', () => {
    // These are NOT the same, and using one for both is the mistake this
    // suite exists to prevent.
    //   Axient: "actualValue = reportedValue - 120"
    //   ULX-D:  "the RF level received and is 000-115. To convert this value
    //            to dBm, subtract 128."
    expect(rssiToDbm('086', 'axtd')).toBe(-34);
    expect(rssiToDbm('086', 'ulxd')).toBe(-42);
    expect(rssiToDbm('115', 'ulxd')).toBe(-13);
    expect(rssiToDbm('000', 'axtd')).toBe(-120);
  });

  it('maps dBm onto 0-100 so the existing thresholds land sensibly', () => {
    // RFDeck calls a channel CRITICAL below 20 and marginal below 35. Those
    // must fall at RF levels that are actually bad, not at a healthy link.
    // A receiver squelches around -95 dBm; a good link sits at -60 to -40.
    expect(dbmToPercent(-95)).toBe(0);
    expect(dbmToPercent(-35)).toBe(100);

    // Both of RFDeck's thresholds land on round dBm figures with this window:
    // CRITICAL (below 20) is exactly -83 dBm and marginal (below 35) exactly
    // -74, so those are the boundaries and anything worse trips them. -83 is
    // near squelch and -74 is worth watching, which is the point.
    expect(dbmToPercent(-83)).toBe(20);
    expect(dbmToPercent(-84)).toBeLessThan(20);
    expect(dbmToPercent(-74)).toBe(35);
    expect(dbmToPercent(-75)).toBeLessThan(35);

    expect(dbmToPercent(-50)).toBeGreaterThan(60); // healthy, and looks it
    expect(dbmToPercent(-40)).toBeGreaterThan(85);
  });

  it('never returns an out-of-range RF percentage', () => {
    expect(rssiToPercent('255', 'axtd')).toBe(100);
    expect(rssiToPercent('-10', 'axtd')).toBe(0);
    expect(dbmToPercent(0)).toBe(100);
    expect(dbmToPercent(-200)).toBe(0);
  });

  it('converts Axient audio to dBFS, which is what the manager expects', () => {
    // DeviceManagerService computes afLevel as 100 + dBFS, exactly as it does
    // for Sennheiser — so this must be dBFS and not a percentage.
    expect(audioToDbfs('102', 'axtd')).toBe(-18);
    expect(audioToDbfs('120', 'axtd')).toBe(0);
    expect(audioToDbfs('020', 'axtd')).toBe(-100);
  });

  it('converts ULX-D audio through its own offset rather than the Axient one', () => {
    // ULX-D audio is documented as "000-050". The -50 offset is inferred from
    // that range and matches Bitfocus Companion; it is the one value here that
    // Shure does not state outright.
    expect(audioToDbfs('050', 'ulxd')).toBe(0);
    expect(audioToDbfs('000', 'ulxd')).toBe(-50);
    expect(audioToDbfs('040', 'qlxd')).toBe(-10);
    // The same raw value means something quite different per family, which is
    // the whole reason the offsets are separate.
    expect(audioToDbfs('040', 'axtd')).toBe(-80);
  });

  it('rejects unparseable levels rather than reporting silence', () => {
    // Reporting 0 for a level that could not be read is indistinguishable
    // from a dead mic, which is exactly the alarm that must not be false.
    expect(rssiToPercent('---', 'axtd')).toBeNull();
    expect(audioToDbfs('', 'axtd')).toBeNull();
  });

  it('reads the real battery charge percentage both families report', () => {
    // An earlier version of this file insisted Axient had no battery
    // percentage and inferred one from the five-bar gauge. It does:
    // TX_BATT_CHARGE_PERCENT, "000 - 100 : Percent, 255 : Unknown", and ULX-D
    // has BATT_CHARGE. That claim came from grepping the specification for the
    // wrong name and trusting the absence of a match.
    expect(parseBatteryPercent('088')).toBe(88);
    expect(parseBatteryPercent('000')).toBe(0);
    expect(parseBatteryPercent('100')).toBe(100);
    expect(parseBatteryPercent('255')).toBeNull();
    expect(parseBatteryPercent('')).toBeNull();
  });

  it('names the charge parameter correctly per family', () => {
    expect(FAMILIES.axtd.param.battPercent).toBe('TX_BATT_CHARGE_PERCENT');
    expect(FAMILIES.ulxd.param.battPercent).toBe('BATT_CHARGE');
  });

  it('reads battery bars, and 255 as unknown', () => {
    expect(parseBatteryBars('004')).toBe(4);
    expect(parseBatteryBars('000')).toBe(0);
    expect(parseBatteryBars('255')).toBeNull();
  });

  it('turns bars into the coarse percentage the protocol actually supports', () => {
    expect(batteryBarsToPercent(5)).toBe(100);
    expect(batteryBarsToPercent(3)).toBe(60);
    expect(batteryBarsToPercent(0)).toBe(0);
    expect(batteryBarsToPercent(null)).toBeUndefined();
  });

  it('reads battery runtime and rejects every sentinel', () => {
    // 65533 comms warning, 65534 calculating, 65535 unknown. Taken at face
    // value that is forty-five years of runtime, and it passes any check that
    // only rejects negatives.
    expect(parseBatteryMinutes('00125')).toBe(125);
    expect(parseBatteryMinutes('00000')).toBe(0);
    expect(parseBatteryMinutes('65532')).toBe(65532);
    expect(parseBatteryMinutes('65533')).toBeNull();
    expect(parseBatteryMinutes('65534')).toBeNull();
    expect(parseBatteryMinutes('65535')).toBeNull();
  });

  it('reads frequency as kHz, which is what RFDeck stores', () => {
    // "< REP 1 FREQUENCY 0578350 >" is 578.350 MHz.
    expect(parseFrequencyKhz('0578350')).toBe(578350);
    expect(parseFrequencyKhz('0606125')).toBe(606125);
  });

  it('reports an unreadable frequency as 0 rather than NaN', () => {
    expect(parseFrequencyKhz('------')).toBe(0);
  });
});

describe('building commands', () => {
  it('pads the meter rate to the fixed five characters', () => {
    // "Format: Numeric, 5 character fixed output"
    expect(setMeterRate(1, 100)).toBe('< SET 1 METER_RATE 00100 >');
    expect(setMeterRate(2, 1000)).toBe('< SET 2 METER_RATE 01000 >');
  });

  it('turns metering off with zero', () => {
    // Sent before dropping the socket: a receiver left metering into a closed
    // connection keeps doing work for nobody.
    expect(setMeterRate(1, 0)).toBe('< SET 1 METER_RATE 00000 >');
  });

  it('clamps a meter rate that would not fit the field', () => {
    expect(setMeterRate(1, 999_999)).toBe('< SET 1 METER_RATE 65535 >');
    expect(setMeterRate(1, -5)).toBe('< SET 1 METER_RATE 00000 >');
  });

  it('builds mute per family', () => {
    expect(setMute(1, true, 'axtd')).toBe('< SET 1 AUDIO_MUTE ON >');
    expect(setMute(2, false, 'ulxd')).toBe('< SET 2 AUDIO_MUTE OFF >');
  });

  it('builds the whole-device query used on connect', () => {
    expect(getAll(1)).toBe('< GET 1 ALL >');
  });

  it('builds a per-family parameter query', () => {
    expect(getChannelParam(1, FAMILIES.axtd.param.battBars)).toBe('< GET 1 TX_BATT_BARS >');
    expect(getChannelParam(1, FAMILIES.ulxd.param.battBars)).toBe('< GET 1 BATT_BARS >');
  });

  it('sets frequency in kHz', () => {
    expect(setFrequency(1, 602125)).toBe('< SET 1 FREQUENCY 602125 >');
  });
});

describe('family command names', () => {
  it('keeps the Axient and ULX-D vocabularies apart', () => {
    // These genuinely differ, and a GET for a parameter a device does not
    // have never produces a REP — so merging them would look like a dead
    // receiver rather than a bug.
    expect(FAMILIES.axtd.param.battBars).toBe('TX_BATT_BARS');
    expect(FAMILIES.ulxd.param.battBars).toBe('BATT_BARS');
    expect(FAMILIES.axtd.param.battPercent).toBe('TX_BATT_CHARGE_PERCENT');
    expect(FAMILIES.ulxd.param.battPercent).toBe('BATT_CHARGE');
  });

  it('claims no ULX-D parameter name for values that only arrive in a sample', () => {
    // Shure's ULX-D document defines RF, audio and antenna state only as
    // fields of "< SAMPLE x ALL nn aaa eee >" — there is no GET-able name for
    // them. Names do appear in one third-party implementation; they are in no
    // Shure document and no implementation actually sends them.
    //
    // Undefined here means "this family has no such parameter", which is a
    // claim worth being able to fail. Inventing a name produces a GET answered
    // by silence, which looks exactly like a dead receiver.
    expect(FAMILIES.ulxd.param.rfLevel).toBeUndefined();
    expect(FAMILIES.ulxd.param.audioLevel).toBeUndefined();
    expect(FAMILIES.ulxd.param.antenna).toBeUndefined();
    expect(FAMILIES.qlxd.param.rfLevel).toBeUndefined();

    // Axient does document all three.
    expect(FAMILIES.axtd.param.rfLevel).toBe('RSSI');
    expect(FAMILIES.axtd.param.audioLevel).toBe('AUDIO_LEVEL_RMS');
    expect(FAMILIES.axtd.param.antenna).toBe('ANTENNA_STATUS');
  });

  it('gives SLX-D Axient names for battery, and no mute at all', () => {
    // SLX-D borrows Axient's transmitter-side vocabulary but has no mute
    // command of any kind — "mute" does not appear in its specification.
    expect(FAMILIES.slxd.param.battBars).toBe('TX_BATT_BARS');
    expect(FAMILIES.slxd.param.battMins).toBe('TX_BATT_MINS');
    expect(FAMILIES.slxd.param.mute).toBeUndefined();
    // And no charge percentage: bars are all it reports.
    expect(FAMILIES.slxd.param.battPercent).toBeUndefined();
    // No antenna status and no channel quality either.
    expect(FAMILIES.slxd.param.antenna).toBeUndefined();
    expect(FAMILIES.slxd.param.quality).toBeUndefined();
  });

  it('refuses to build a mute command for a family that has none', () => {
    // Returning a command string here would have the client send
    // "< SET 1 undefined ON >" and report success, leaving an operator
    // pressing Mute during a show while the channel stays open.
    expect(setMute(1, true, 'slxd')).toBeNull();
    expect(setMute(1, true, 'axtd')).toBe('< SET 1 AUDIO_MUTE ON >');
  });

  it('only Axient claims to report link quality', () => {
    expect(FAMILIES.axtd.param.quality).toBe('CHAN_QUALITY');
    expect(FAMILIES.ulxd.param.quality).toBeUndefined();
  });
});

describe('identifyModel', () => {
  it('reads channel count from the model, since it decides what to poll', () => {
    expect(identifyModel('AD4D')).toEqual({ family: 'axtd', channels: 2 });
    expect(identifyModel('AD4Q')).toEqual({ family: 'axtd', channels: 4 });
    expect(identifyModel('QLX-D')).toEqual({ family: 'qlxd', channels: 1 });
  });

  it('reads the ULX-D variants', () => {
    expect(identifyModel('ULX-D Quad')).toEqual({ family: 'ulxd', channels: 4 });
    expect(identifyModel('ULXD4D')).toEqual({ family: 'ulxd', channels: 2 });
    expect(identifyModel('ULXD4')).toEqual({ family: 'ulxd', channels: 1 });
  });

  it('reads the SLX-D variants, longest match first', () => {
    // SLXD4D must not be matched by the SLXD4 pattern — that would make a
    // two-channel receiver report one channel and lose half the rack.
    expect(identifyModel('SLXD4D')).toEqual({ family: 'slxd', channels: 2 });
    expect(identifyModel('SLXD4')).toEqual({ family: 'slxd', channels: 1 });
    expect(identifyModel('SLXD4D+')).toEqual({ family: 'slxd', channels: 2 });
  });

  it('returns null for an unknown model rather than guessing a channel count', () => {
    // Guessing means either missing half a receiver, or asking a two-channel
    // box about channels 3 and 4 for the life of the process.
    expect(identifyModel('AXT600')).toBeNull();
    expect(identifyModel('')).toBeNull();
  });
});

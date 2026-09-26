import { prisma } from '../db';
import { log } from '../logger';
import { encryptSecret, decryptSecret } from '../auth/secretBox';
import {
  buildConfigFile, parseConfigFile, describeRestore,
  ConfigFile, CONFIG_COLLECTION, CONFIG_KEY,
} from './configFile';
import { Documents, DocumentConflict, DocumentNotFound, contentHash } from './documents';

/**
 * The install snapshot, between the database and document sync.
 *
 * Same three-layer split as show files: format in `configFile.ts`, protocol in
 * `documents.ts`, and this part knows about RFDeck's tables.
 *
 * One document per install, at `config/instance`, because a restore should have one
 * obvious thing to take rather than a list to choose from.
 */
export class ConfigBackup {
  constructor(private readonly documents: Documents) {}

  private async bookmark() {
    return prisma.cloudDocument.findUnique({
      where: { path: `${CONFIG_COLLECTION}/${CONFIG_KEY}` },
    });
  }

  private async remember(version: number, hash: string | null, pulled = false) {
    const path = `${CONFIG_COLLECTION}/${CONFIG_KEY}`;
    const data = {
      path, collection: CONFIG_COLLECTION, key: CONFIG_KEY, version,
      contentHash: hash,
      ...(pulled ? { pulledAt: new Date() } : { pushedAt: new Date() }),
    };
    await prisma.cloudDocument.upsert({ where: { path }, create: data, update: data });
  }

  /**
   * Snapshot this install.
   *
   * Device passwords are unsealed here. At rest they are
   * AES-256-GCM sealed with a key in `.rfdeck-key`, which deliberately does not
   * travel with the database — so the sealed form would restore onto replacement
   * hardware as something the new machine cannot open, and the device would look
   * configured while failing to connect. Carrying the real value is what makes the
   * restore a restore.
   */
  async build(): Promise<ConfigFile> {
    const [settings, devices, performers, audioPatch] = await Promise.all([
      prisma.settings.findFirst(),
      prisma.inventoryDevice.findMany(),
      prisma.performer.findMany(),
      prisma.channelAudioMap.findMany(),
    ]);
    return buildConfigFile({
      settings: settings ?? {},
      performers, audioPatch,
      devices: devices.map(d => ({ ...d, password: decryptSecret(d.password) })),
      version: process.env.RFDECK_VERSION ?? null,
      edition: process.env.RFDECK_EDITION ?? 'server',
    });
  }

  async push(): Promise<
    | { status: 'pushed'; version: number }
    | { status: 'already-current'; version: number }
    | { status: 'conflict'; conflict: DocumentConflict }
  > {
    const file = await this.build();
    const known = await this.bookmark();
    try {
      const result = await this.documents.put(
        CONFIG_COLLECTION, CONFIG_KEY, file, known?.version ?? undefined,
      );
      await this.remember(result.version, result.content_hash ?? contentHash(file));
      log.info(`[Cloud] Backed up this install's configuration as version ${result.version}`);
      return { status: 'pushed', version: result.version };
    } catch (err) {
      if (err instanceof DocumentConflict) {
        if (err.sameContent) {
          await this.remember(err.headVersion, err.headContentHash);
          return { status: 'already-current', version: err.headVersion };
        }
        return { status: 'conflict', conflict: err };
      }
      throw err;
    }
  }

  /**
   * What is in the cloud, and what taking it would do — without taking it.
   *
   * A restore rewrites the inventory, which on the wrong machine is destructive in a
   * way a confirmation dialog does not convey. So the UI can show the actual
   * consequences first: how many devices come back, whether their passwords come
   * with them, what will still be missing afterwards.
   */
  async preview(): Promise<{
    available: boolean;
    version: number | null;
    exportedAt: string | null;
    instance: ConfigFile['instance'] | null;
    brings: string[];
    needsAttention: string[];
    reason: string | null;
  }> {
    try {
      const fetched = await this.documents.get(CONFIG_COLLECTION, CONFIG_KEY);
      const file = parseConfigFile(fetched.body);
      const described = describeRestore(file);
      return {
        available: true,
        version: fetched.version,
        exportedAt: file.exportedAt,
        instance: file.instance,
        ...described,
        reason: null,
      };
    } catch (err) {
      const reason = err instanceof DocumentNotFound
        ? 'No configuration backup has been saved to the cloud from this account yet.'
        : (err as Error).message;
      return {
        available: false, version: null, exportedAt: null, instance: null,
        brings: [], needsAttention: [], reason,
      };
    }
  }

  /**
   * Apply the cloud's snapshot to this install.
   *
   * One transaction, because a half-restored rig is worse than an unrestored one:
   * the operator would not know which half they were looking at.
   *
   * Devices are **upserted by id rather than replaced wholesale**, and nothing local
   * is deleted. A restore should be able to bring a rig back without also destroying
   * anything added since the backup — and an operator who wanted a device gone can
   * remove it themselves, whereas one whose device vanished has no way to know what
   * it was.
   *
   * Credentials are re-sealed with *this* machine's key on the way in, which is the
   * other half of unsealing them on the way out.
   */
  async restore(): Promise<{ devices: number; performers: number; patches: number }> {
    const fetched = await this.documents.get(CONFIG_COLLECTION, CONFIG_KEY);
    const file = parseConfigFile(fetched.body);

    await prisma.$transaction(async (tx) => {
      const settings = await tx.settings.findFirst() ?? await tx.settings.create({ data: {} });
      await tx.settings.update({
        where: { id: settings.id },
        // Only the fields the snapshot owns. Nothing here touches the cloud link,
        // the VAPID keys or the event identity: those are not withheld for secrecy
        // but because copying them onto a second install breaks the first — a
        // replayed refresh token unlinks both, and a shared event instance id makes
        // two rigs look like one.
        data: {
          aes67MulticastIp: file.settings.aes67MulticastIp,
          aes67Port: file.settings.aes67Port,
          batteryWarningPct: file.settings.batteryWarningPct,
          batteryCriticalPct: file.settings.batteryCriticalPct,
          dropoutSensitivity: file.settings.dropoutSensitivity,
          bindInterface: file.settings.bindInterface,
          discoveryIgnore: file.settings.discoveryIgnore,
          audioInputDevice: file.settings.audioInputDevice,
          recordingEnabled: file.settings.recordingEnabled,
          recordingMaxMb: file.settings.recordingMaxMb,
          recordingPreSec: file.settings.recordingPreSec,
          recordingPostSec: file.settings.recordingPostSec,
          authReauthHours: file.settings.authReauthHours,
          venueLocation: file.settings.venueLocation,
          // The same PIN keeps working on the restored machine. Restoring the
          // enabled flag without the hash would lock the operator out of their own
          // rig with no PIN that opens it.
          authPinEnabled: file.settings.authPinEnabled,
          authPinHash: file.settings.authPinHash,
        },
      });

      for (const device of file.devices) {
        const { password, ...rest } = device;
        // Re-sealed with this machine's key. A null password is left as null rather
        // than skipped: the snapshot is what the rig should look like, and a device
        // that had no password should not inherit one from whatever was here before.
        const row = { ...rest, password: encryptSecret(password) };
        await tx.inventoryDevice.upsert({
          where: { id: device.id },
          create: row,
          update: row,
        });
      }

      for (const performer of file.performers) {
        const { hadPhoto, ...row } = performer;
        await tx.performer.upsert({
          where: { id: performer.id },
          create: row,
          update: row,
        });
      }

      for (const patch of file.audioPatch) {
        await tx.channelAudioMap.upsert({
          where: { channelKey: patch.channelKey },
          create: patch,
          update: { deviceId: patch.deviceId, inputChannel: patch.inputChannel },
        });
      }

    });

    await this.remember(fetched.version, fetched.contentHash, true);
    log.warn(
      `[Cloud] Restored configuration from version ${fetched.version}: ` +
      `${file.devices.length} device(s), ${file.performers.length} performer(s)`,
    );
    return {
      devices: file.devices.length,
      performers: file.performers.length,
      patches: file.audioPatch.length,
    };
  }
}

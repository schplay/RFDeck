import { describe, it, expect, vi } from 'vitest';

const calls = vi.hoisted(() => [] as any[]);
vi.mock('../db', () => ({
  prisma: { cloudUser: { updateMany: async (args: any) => { calls.push(args); return { count: 1 }; } } },
}));

import { PrismaCloudUserStore, SIGNED_IN_VIA } from './cloudUserStore';

// A sign-in method stored by an older version is renamed to a current one on
// start, keeping the person signed in.

describe('migrating the stored sign-in method', () => {
  it('renames anything that is not a current value to console', async () => {
    expect(SIGNED_IN_VIA).toEqual(['console']);
    await new PrismaCloudUserStore().migrate();
    expect(calls).toEqual([{
      where: { signedInVia: { notIn: ['console'] } },
      data: { signedInVia: 'console' },
    }]);
  });
});

import { defineConfig } from 'vitest/config';

// Tests are the ones in `src`, never a compiled copy in `dist`.
//
// Without this, a stale `dist/*.test.js` left by an earlier build gets collected
// alongside its source and runs an old version of the same test — passing or failing
// on code that is no longer there. `tsconfig.json` now excludes tests from the build
// so nothing should land there, but this makes the run independent of whatever is on
// disk from before.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
});

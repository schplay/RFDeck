// The shared domain model, imported by the server, the web app and the desktop shell.
//
// **The `.js` on each specifier is required, not stylistic.** This package emits ES
// modules, TypeScript does not rewrite specifiers, and Node's ESM resolver will not
// guess an extension — so an extensionless re-export typechecks, bundles, and then
// fails at runtime with ERR_MODULE_NOT_FOUND. See `shared-utils/src/index.ts` for the
// longer version; it is where that actually bit.
//
// It has never bitten here only because every server import from this package is
// type-only and gets erased. `ENVIRONMENTS`, `MAINTENANCE_KINDS` and
// `maintenanceKindLabel` are real values, so that is luck rather than safety.

export * from './devices.js';
export * from './channels.js';
export * from './alerts.js';
export * from './shows.js';
export * from './performers.js';
export * from './environments.js';
export * from './maintenance.js';

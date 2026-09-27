// Shared pure functions, imported by both the server and the web app.
//
// **Relative specifiers here carry an explicit `.js`, and that is load-bearing.**
// These packages emit ES modules (`module: ESNext` in the base config), TypeScript
// never rewrites a specifier, and Node's ESM resolver does not guess extensions — so
// an extensionless `export * from './frequency'` compiles fine, passes every
// typecheck, bundles fine under Vite, and then kills the built server at startup with
// ERR_MODULE_NOT_FOUND.
//
// That is precisely what happened the first time anything imported a *value* rather
// than a type from this package. Only a clean-tree end-to-end run caught it, because
// the failure needs the compiled output plus a real Node process: the unit suite runs
// from source, and the bundler does not care.
//
// CommonJS output was the other candidate and is worse: Rollup cannot see named
// exports through `__exportStar`, so it breaks the web build instead.
export * from './frequency.js';
export * from './battery.js';
export * from './stagePlot.js';

# Repository separation — plan

How the paid application is built from, and kept in step with, the open-source
one. Companion to `docs/EDITIONS.md` (the line between free and paid) and
`docs/CLOUD_INTEGRATION_PLAN.md` (the cloud, most of which is *not* paid
application code).

## First: the open-source repository is not yet open source

There is no `LICENSE` file and no `license` field in any `package.json`.
Without one the code is all-rights-reserved by default, and nothing in this
plan can start until that is decided. It is a business decision with two
sensible answers:

| | AGPL-3.0 + contributor licence agreement | Apache-2.0 |
|---|---|---|
| What it protects | Nobody can offer RFDeck as a hosted service, or ship a modified build, without releasing their changes. A competitor cannot fork the core into their own closed paid edition. | Nothing beyond attribution. |
| What it costs | Outside contributors must sign a CLA so the copyright holder can also license the core to the paid edition under different terms (the standard "open core" dual-licence: GitLab, Grafana, Sentry's earlier model). The paid packages are *not* derivative works of the core only because the copyright holder says so — which is fine, and only works while the holder owns every line. | Anyone, including a competitor, may build a closed paid edition on the core. Simpler; no CLA. |
| Fit with the editions doc | Good. The paid line is organisational features; AGPL keeps others from selling those on top of the free core. | Weak. Nothing stops "RFDeck Pro by somebody else". |

**Recommendation: AGPL-3.0 for the application repository, with a CLA for
outside contributions.** The cloud contract package and shared types should be
Apache-2.0 or MIT so that third parties (Companion modules, integrators) can
depend on them freely. **Decision needed.** Also: the RFDeck name and mark
should be reserved to the company explicitly in the README regardless of
licence.

## The shape: one core, extension packages, a distribution repository

Three ways to keep a paid edition in step with an open core were considered:

- **A fork.** Merges from upstream become the job; every paid change to a
  core file is a future conflict. This is how open-core projects end up with
  two products that share a name.
- **A vendored copy / subtree.** History mixes; the pin is implicit; nobody
  can say which core commit a paid build contains.
- **The core as a pinned dependency, with the paid edition as extensions.**
  The paid repository contains *only* paid code plus a pointer to an exact
  core release. Upgrading the core is a deliberate, reviewable bump.

The third, with one rule that makes it work:

> **The paid repository never edits a core file.** Anything the paid edition
> needs from the core is an extension point, and extension points are
> contributed upstream, in the open, first.

That rule is what keeps the core honest — its hooks are visible to everyone —
and what keeps the paid edition cheap to maintain: no merges, only a version
bump and a test run.

### The pin: a git submodule on release tags

The paid repository (`rfdeck-pro`, private) carries the core as a **git
submodule at `core/`, pinned to a release tag** (`vX.Y.Z`) of the open
repository, never to a branch. Submodules are awkward for day-to-day editing,
and that is the point: nobody edits the core from inside the paid repo. The
pnpm workspace of the paid repository includes the submodule's packages:

```yaml
# rfdeck-pro/pnpm-workspace.yaml
packages:
  - 'core/apps/*'
  - 'core/packages/*'
  - 'packages/*'
  - 'apps/*'
```

so `@rfdeck/server`, `@rfdeck/web` and the shared packages resolve exactly as
they do in the core, and the paid packages depend on them by workspace
reference.

Publishing the core packages to npm was considered and rejected for now:
`@rfdeck/web` is an application, not a library, and a submodule pin is a
stronger statement of "this exact core" than a semver range.

### Extension points in the core (the upstream work)

These are the changes to the open repository that make an edition possible.
They ship in the free build with **no extensions loaded** and are exercised by
the core's own tests through a tiny in-tree example extension, so they cannot
rot.

**Server — `buildApp({ extensions })`.** An extension is a module exporting:

```ts
export interface RfdeckExtension {
  name: string;
  version: string;
  /** Runs after core plugins, before routes. May decorate, add hooks, register routes. */
  register?(app: FastifyInstance, ctx: ExtensionContext): Promise<void>;
  /** Replace the request authoriser. Core: the PIN gate. Paid: named users and roles. */
  authorize?(request: FastifyRequest): Promise<AuthDecision | null>;
  /** Extra alert targets for the dispatcher. */
  alertTargets?: AlertTarget[];
  /** Socket handlers, namespaced by the extension. */
  socket?(io: Server, ctx: ExtensionContext): void;
}
```

`ExtensionContext` exposes the device manager, Prisma client, settings,
secret box and logger — the things a feature needs, by interface rather than
by importing server internals. Extensions are listed in an `extensions.json`
beside the database (headless) or resolved from the package manifest
(desktop); the core build has an empty list.

**Data.** Extensions do not add models to the core Prisma schema — a
schema is one file and one migration history, and two editions writing it is
the fork this plan exists to avoid. An extension owns **its own SQLite
database and Prisma schema**, in the same directory, and refers to core rows
by id. The core gains a small read API for the ids and names an extension
needs (`ctx.core.devices()`, `ctx.core.channels()`, `ctx.core.shows()`).
Where an extension must attach data to a core row — an owner, an
audit reference — it keeps that in its own table keyed by the core id.

**Auth.** The PIN gate in `app.ts` becomes the default `authorize`; an
extension may replace it. This is the seam the first paid feature (named
users, roles, permissions) goes through, and the reason the hook is a
*decision* (`allow | deny | pass`) rather than a boolean: an edition can
layer roles on top of the PIN, or replace it.

**Web — an extension registry resolved at build time.** The core imports a
module `@rfdeck/web-extensions` that, in the core build, is an empty
registry. The paid build aliases it (Vite `resolve.alias`) to its own
package. The registry contributes: routes and pages, settings panels, header
items (the account menu), channel context-menu items, dashboard panels, and
the entitlement/permission hooks the UI gates on. Contribution points are
enumerated and typed in the core; a paid page is a normal React component.

**Branding.** `productName`, `appId`, icons and the About text come from one
`edition.json` read by the desktop shell, the web header and the server's
`/health`. Core: "RFDeck". Paid: "RFDeck Pro".

### Licensing (the paid application)

A licence is a **signed document, verified offline**, because a venue's rig
may never see the internet:

```
{ licensee, edition: "pro", issuedAt, updatesUntil, seats?: n, keyId }
```

as a JWS signed with an Ed25519 key whose public half is compiled into the
paid build only. Activation is pasting the key into Settings → Licence (or a
file beside the database for headless installs). The rule that implements
"lifetime licence, one year of updates":

- The application **runs forever** on a valid licence.
- The updater refuses to install a build whose *release date* is after
  `updatesUntil`, and says so with the date and where to renew. Renewal
  issues a new document with a later date; nothing else changes.

No phone-home is required. A cloud-linked rig *may* refresh its licence
automatically, as a convenience, never as a requirement. This lives in
`packages/licensing` of the paid repo, with the verification code and its
tests small enough to be audited by a customer's IT department.

### Layout of `rfdeck-pro`

```
rfdeck-pro/
  core/                      git submodule → github.com/…/rfdeck @ vX.Y.Z
  packages/
    pro-server/              the server extension (users, roles, audit, …)
    pro-web/                 the web extension registry implementation
    licensing/               licence document verification, activation UI pieces
  apps/
    desktop-pro/             electron-builder.yml, branding, edition.json; no code of its own
  scripts/
    install-ubuntu-pro.sh    the core installer + extensions.json + the pro packages
    update-server-pro.sh     the core updater + the updatesUntil check
  .github/workflows/         build against the pinned core; nightly build against core main
```

### Process

- **Upstream first.** A paid feature that needs a hook starts as a PR to
  the open repository adding the hook, with the in-tree example exercising
  it. Only then does the paid package use it.
- **Releases follow core tags.** Core releases `vX.Y.Z`; `rfdeck-pro` bumps
  the submodule, runs its suite, releases `vX.Y.Z-pro.n`. The pro version
  always names the core it contains.
- **A nightly build of pro against core `main`** catches a core change that
  breaks an extension point weeks before a release would.
- **The core's tests are the pro's tests too:** the paid CI runs
  `core`'s unit and E2E suites against the pinned commit, then its own.
- **Nothing in the core mentions the pro edition by feature.** The core
  knows there can be extensions; it does not know what they do. (The
  editions doc already forbids scattered conditionals; this is the
  structural form of that rule.)

### What is *not* paid-repository work

The cloud. The rig link, show files, profiles, and the *gates* for the paid
cloud tier are all core work: they are free-tier features plus a signature
check on data the cloud issues. A rig running the free application can be
linked to a paying organisation and receive regional data and relayed
notifications. The paid *application* is about what an organisation needs on
the machine — named users, permissions, audit — and only that goes through
the extension mechanism. Keeping these two apart means the cloud can launch
before the pro edition exists.

## Phases

| Phase | What | Size | Needs |
|---|---|---|---|
| R.0 | Choose the licence; add `LICENSE`, `license` fields, CLA text, trademark note | S | **decision** |
| R.1 | Extension points in the core: `buildApp({ extensions })`, `ExtensionContext`, `authorize` hook, dispatcher targets, `edition.json`, web registry with the empty default; the in-tree example extension and its tests | M | R.0 |
| R.2 | Create `rfdeck-pro`: submodule at the first tagged core release, workspace, CI, desktop-pro branding build, headless scripts | M | R.1, a tagged core release |
| R.3 | `packages/licensing`: document format, verification, activation UI, updater check | M | R.2 |
| R.4 | First paid feature: named users, roles and permissions replacing the PIN gate via `authorize`, with an audit log in the extension's own database | L | R.3 |
| R.5 | Appliance image: the pro headless install on a chosen SBC/mini-PC, pre-activated | M | R.4 |

R.1 is the only phase that touches the open repository's code, and it is
worth doing soon after R.0 regardless of when R.2 starts: the hooks are small,
they clarify the core's own structure (auth, dispatch, edition identity), and
building them early is how the "no scattered conditionals" rule in the
editions doc stays true.

## Decisions needed

- The licence (above), and whether to require a CLA.
- Whether `rfdeck-pro` builds are distributed as signed installers only, or
  also as a private package feed for appliances.
- Seat model, if any, for the licence document (per rig is the simple
  answer; per named user is the organisational one).

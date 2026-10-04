# Repository separation — plan

How the paid edition, **RFDeck Server**, is built from, and kept in step with,
the open-source one. Companion to `docs/EDITIONS.md` (the line between free and paid) and
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
| Fit with the editions doc | Good. The paid line is organisational features; AGPL keeps others from selling those on top of the free core. | Weak. Nothing stops "RFDeck Server by somebody else". |

**Recommendation: AGPL-3.0 for the application repository, with a CLA for
outside contributions.** The cloud contract package and shared types should be
Apache-2.0 or MIT so that third parties (Companion modules, integrators) can
depend on them freely. **Decision needed.** Also: the RFDeck name and mark
should be reserved to the company explicitly in the README regardless of
licence.

## Headless is RFDeck Server only

**Decided 2026-10-04 (David).** The paid edition is named **RFDeck Server**; it
was called "RFDeck Pro" in earlier drafts. Every headless server product in the
portfolio except Imperio is named "Server".

**A headless install is RFDeck Server and nothing else.** Free RFDeck is the
desktop application. This repository does contain a working headless install —
`scripts/install-ubuntu.sh`, the systemd unit it writes, `scripts/update-server.sh`
and the `rfdeck` admin CLI (`scripts/rfdeck`, `apps/server/src/cli.ts`) — but that
is **David's personal testing setup**. It does not ship, it is not a free
feature, and it will be removed from this repository once testing is done. It is
kept for now only because it is in use. Nothing should be built on the
assumption that a free edition runs headless, and nothing should describe one.

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

The paid repository (`rfdeck-server`, private) carries the core as a **git
submodule at `core/`, pinned to a release tag** (`vX.Y.Z`) of the open
repository, never to a branch. Submodules are awkward for day-to-day editing,
and that is the point: nobody edits the core from inside the paid repo. The
pnpm workspace of the paid repository includes the submodule's packages:

```yaml
# rfdeck-server/pnpm-workspace.yaml
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
`edition.json` read by the web header and the server's `/health` (and by the
desktop shell, which only the free edition has). Core: "RFDeck". Paid:
"RFDeck Server".

### Licensing (RFDeck Server)

Follows the portfolio decision "Cloud Accounts, Licensing and User Identifiers"
(vault, 2026-10-03). Where this section and that decision disagree, the decision
wins.

- **Editions.** Free RFDeck needs no licence. RFDeck Server requires one.
  Appliances ship with RFDeck Server pre-installed and **pre-licensed**.
- **A licence is tied to the Meros Cloud account that bought it**, because that is
  where it is purchased. It is **never tied to users**: not to a local account,
  not to a named user, not to a seat. A licensed install does not thereby need a
  paid cloud subscription.
- **Activation works three ways**, and all three must be possible:
  1. with a cloud login;
  2. online, without a login;
  3. offline — a venue's rig may never see the internet.
- **Deferred until RFDeck Server prepares to launch:** activation with a cloud
  login, the mapping from licence to features, and key provisioning. None of it is
  built.

**Commercial terms (priced 2026-09-26): $499 perpetual, including twelve months
of updates and support** — a licence, not a subscription. The cloud subscription
is separate and à la carte (`docs/EDITIONS.md`). The rule that implements
"lifetime licence, one year of updates": RFDeck Server **runs forever** on a valid
licence, and the updater refuses to install a build released after the licence's
updates window, saying so with the date and where to renew.

An earlier draft specified one activation mechanism — a signed document pasted
into Settings — and floated per-seat or per-named-user licensing. Both are
superseded by the decision above and are not part of the design.

RFDeck Server also gates three *cloud* features, which makes it a prerequisite
rather than merely an upgrade: one-click remote restore and provisioning, remote
UI and control, and attributed change history. None of them can exist on a
desktop install, because there is no always-on server for the cloud to reach — so
they are not being withheld from desktop so much as undefined there. All three
are deferred until RFDeck Server exists.

A Team cloud subscription can additionally move RFDeck Server's local per-user
permissions and auditing into the cloud, as a migration with a keep-local option.
Also deferred, and it only makes sense once R.4's named users exist. (Named users
are an RFDeck Server *feature*; the licence is still never tied to them.)

A licence is a different thing from a Meros **entitlement**: the licence says
this install may run RFDeck Server; an entitlement says what an account has paid
for in the *cloud*. They must not be merged. The licence code lives in
`packages/licensing` of the RFDeck Server repository, small enough to be audited
by a customer's IT department.

### Layout of `rfdeck-server`

```
rfdeck-server/
  core/                      git submodule → github.com/…/rfdeck @ vX.Y.Z
  packages/
    server-extension/        the server extension (users, roles, audit, …)
    web-extension/           the web extension registry implementation
    licensing/               licence verification and activation
  scripts/
    install-ubuntu.sh        the headless install, moved here from the core's testing setup
    update-server.sh         the updater + the updates-window check
  image/                     the appliance system image build (R.5)
  .github/workflows/         build against the pinned core; nightly build against core main
```

There is no desktop build of RFDeck Server: it is headless only. (An earlier draft
had an `apps/desktop-pro` branding build; it is dropped, not renamed.) The headless
install scripts belong here, not in the core — the copies in the core today are a
testing setup that will be removed (see "Headless is RFDeck Server only").

### Process

- **Upstream first.** A paid feature that needs a hook starts as a PR to
  the open repository adding the hook, with the in-tree example exercising
  it. Only then does the paid package use it.
- **Releases follow core tags.** Core releases `vX.Y.Z`; `rfdeck-server` bumps
  the submodule, runs its suite, releases `vX.Y.Z-server.n`. The RFDeck Server
  version always names the core it contains.
- **A nightly build of RFDeck Server against core `main`** catches a core change that
  breaks an extension point weeks before a release would.
- **The core's tests are RFDeck Server's tests too:** the paid CI runs
  `core`'s unit and E2E suites against the pinned commit, then its own.
- **Nothing in the core mentions the Server edition by feature.** The core
  knows there can be extensions; it does not know what they do. (The
  editions doc already forbids scattered conditionals; this is the
  structural form of that rule.)

### What is *not* paid-repository work

The cloud. The instance link, show files, profiles, and the *gates* for the
paid cloud tier are all core work: they are free-tier features plus a signature
check on data Meros issues. A rig running the free application can be linked to
a paying Meros **account** — a person or an organisation — and receive regional
data and relayed notifications. The paid *application* is about what an organisation needs on
the machine — named users, permissions, audit — and only that goes through
the extension mechanism. Keeping these two apart means the cloud can launch
before the pro edition exists.

## Phases

| Phase | What | Size | Needs |
|---|---|---|---|
| R.0 | Choose the licence; add `LICENSE`, `license` fields, CLA text, trademark note | S | **decision** |
| R.1 | Extension points in the core: `buildApp({ extensions })`, `ExtensionContext`, `authorize` hook, dispatcher targets, `edition.json`, web registry with the empty default; the in-tree example extension and its tests | M | R.0 |
| R.2 | Create `rfdeck-server`: submodule at the first tagged core release, workspace, CI, the headless install scripts moved out of the core | M | R.1, a tagged core release |
| R.3 | `packages/licensing`: document format, verification, activation UI, updater check | M | R.2 |
| R.4 | First paid feature: named users, roles and permissions replacing the PIN gate via `authorize`, with an audit log in the extension's own database | L | R.3 |
| R.5 | Appliance image: RFDeck Server as a system image on a chosen SBC/mini-PC, pre-licensed | M | R.4 |

R.1 is the only phase that touches the open repository's code, and it is
worth doing soon after R.0 regardless of when R.2 starts: the hooks are small,
they clarify the core's own structure (auth, dispatch, edition identity), and
building them early is how the "no scattered conditionals" rule in the
editions doc stays true.

## Decisions needed

- The licence (above), and whether to require a CLA.
- Whether RFDeck Server updates reach installed systems as signed system images
  only, or also through a private package feed. (Distribution itself is settled:
  a system image, not Docker — `docs/IMPLEMENTATION_PLAN.md` §7.4.)

The seat model is no longer open: a licence is tied to the account that bought it,
never to users (see Licensing).

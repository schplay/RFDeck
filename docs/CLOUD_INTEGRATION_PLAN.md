# Cloud integration — plan

How RFDeck cloud accounts and cloud features reach the application: what is
linked to what, where the tokens live, how a paid feature is gated, and in what
order it gets built. Companion to `docs/EDITIONS.md` (what is free and what is
paid, and why) and `docs/REPO_SEPARATION_PLAN.md` (how the paid *application*
is built). This document is about the *cloud*; most of it lands in the
open-source repository, because the free cloud tier is free.

## Principles

1. **The application never needs the cloud.** A rig on a show LAN with no
   internet is the normal case, not a failure mode. Every cloud feature is an
   addition to a working application; nothing that works today acquires a
   network dependency. If the cloud is unreachable the UI says so once and
   carries on.
2. **Two links, not one.** A *rig* (an RFDeck server, whether headless or
   inside the desktop app) is linked to an *organisation*. A *person* (a
   browser) is signed in to an *account*. Show files, regional data and
   notifications belong to the rig link; preferences and profiles belong to
   the person link. Conflating them puts a person's token on a shared venue
   machine, or a venue's entitlements in a freelancer's browser.
3. **The server is the cloud client for rig things; the browser for personal
   things.** Rig tokens are stored server-side, encrypted at rest with the
   existing `secretBox` key that already protects device passwords. Personal
   tokens never touch the server.
4. **Entitlements are data, verified offline.** The cloud issues a signed
   statement of what the organisation has paid for; the application checks
   the signature with a public key it ships with and honours it through an
   offline grace period. There is exactly one place in the code that answers
   "is this rig entitled to X".
5. **Free features are never gated.** The gate exists only for the paid cloud
   tier in `docs/EDITIONS.md`: regional data and email/SMS notifications.
   Diagnosis is never behind it.
6. **The contract is the boundary.** Application and cloud service live in
   different repositories and talk through a versioned API contract kept as
   its own package. Either side can be rewritten behind it.
7. **What leaves the venue is listed, and short.** Show files and their
   metadata; alert events when relaying notifications; the rig's identity;
   nothing else. Never audio, never telemetry, never device passwords.

## The pieces

### Identity

Do not write an identity provider. Use an OIDC-compliant one — hosted
(Auth0, Clerk, WorkOS) or self-hosted (Keycloak, Ory) — behind the cloud
service. The application only ever sees standard OAuth 2.0 flows, so the
provider is replaceable. **Decision needed:** which, and where the data
lives (EU/US residency matters to venues).

### Rig link — OAuth 2.0 Device Authorization Grant (RFC 8628)

The right flow for a machine that may have no browser of its own and may be
reached only over a show LAN:

1. Settings → Cloud → *Link this rig*. The server asks the cloud for a device
   code; the UI shows a short user code, the URL, and a QR of the same.
2. The operator opens the URL on any device — their phone is fine — signs in,
   and approves the rig into an organisation.
3. The server polls, receives tokens, stores the refresh token with
   `secretBox`, and records `rigId`, `orgId`, `linkedAt`.
4. From then on the server holds a short-lived access token it refreshes
   itself. Unlinking revokes the refresh token at the cloud and deletes it
   locally; the cloud side can also revoke, which the server notices on its
   next refresh and reports as "unlinked by the organisation".

Identical on the desktop app and a headless box, which is the point.

### Person link — Authorization Code + PKCE (RFC 7636)

Header → account menu → *Sign in*. The browser goes to the cloud, comes back
with tokens held in that browser only. Used for profile sync (below). A
person can be signed in on a rig that is not linked, and vice versa.

### Entitlements

On link and on every refresh the cloud returns an **entitlement document**: a
JWS signed with the cloud's Ed25519 key:

```
{ orgId, rigId, plan: "free" | "paid", features: ["regional-data", "notify-relay"],
  issuedAt, expiresAt, graceDays: 30 }
```

The server verifies it with the public key compiled into the build, caches it
in Settings, and answers `entitled(feature)` from the cache. After
`expiresAt + graceDays` with no successful refresh, paid features switch off
with a message that says exactly why. Clock skew and a rig that has been in a
flight case for two months are the cases this is designed for.

One module: `apps/server/src/cloud/entitlements.ts`. The UI reads
`/api/cloud/status` → `{ linked, org, plan, features[], expiresAt, offline }`
and gates through a single `useEntitled(feature)` hook. A gated control is
shown disabled with the reason ("Email and SMS alerts are part of the paid
cloud tier — configure in the cloud console"), never hidden: the operator
should know the feature exists and why it is off.

### Contract package

`packages/cloud-contract`: TypeScript types plus an OpenAPI document for
`/v1/…`, the entitlement schema, and the show-file schema. Versioned
independently; the application pins a contract version and sends it in a
header; the cloud serves the versions it supports. The cloud repository
depends on the same package, so a breaking change is a visible bump on both
sides rather than a surprise.

## The free tier

### Show files

A show file is the portable form of a show: the show row, its periods, cast,
castings, channel assignments, quick changes, mic-check layout — everything
except telemetry and clips. Much of it already exists as the show report's
JSON; the show file is that shape made round-trippable.

- **Push** from the Shows page ("Save to cloud"), **pull** from a cloud list
  ("Open from cloud"). Manual, explicit, named — not a background sync. An
  operator moving between venues wants "get my show from last week", not
  merge semantics on a live rig.
- Conflicts are not resolved automatically: a pull that would overwrite a
  local show with unsaved changes asks. Each push records a version; the
  cloud keeps history so a bad push is recoverable.
- Performer photos go with the file, resized as they already are.

### Profiles

A person's preferences follow them: layout, dense grid, meter settings,
solo groups, shortcuts, notification thresholds. Today these are in
`localStorage` per browser. With a person link they are also written to the
account and read back on sign-in elsewhere. The stores already exist
(`layoutStore`, `meterStore`, …); the work is a serialiser and a merge rule
(last write wins, per key, with the local copy always usable offline).

## The paid tier

### Notification relay

The C.2 dispatcher fans alerts out to webhooks and browser push. A third
target, `dispatchToCloud`, posts the same `OutboundAlert` to the organisation's
inbox at the cloud; the cloud applies the organisation's rules (who gets
email, who gets SMS, quiet hours, escalation) and sends. SMTP and SMS
credentials therefore never exist on a venue machine, and an organisation
configures recipients once for every rig it owns. Gated by
`entitled('notify-relay')`; without it the target is simply not attached.

### Regional data

Two feeds, both signed data packs the server fetches and caches:

- **TV/DTV occupancy by location.** The rig declares its venue location
  (postcode/coordinates, stored locally). The feed returns occupied TV
  channels for that location; the coordinator (C.13) offers "keep out of TV
  channels licensed here" as an exclusion source alongside scans. This is
  what makes a coordination plan lawful, not merely clean.
- **Device profiles.** The band tables in `hardware/coordination/profiles.ts`
  become the *shipped baseline*; the feed delivers updates (new bands, a
  corrected range, an unverified figure verified) as data, applied without
  a release. The profile module already flags what is assumed vs read; the
  feed is where "read" comes from over time.

Gated by `entitled('regional-data')`. Without it the coordinator works
exactly as it does today, against the shipped tables.

### Later, on the same foundations

A multi-rig dashboard (every linked rig of an organisation, live status),
and organisation-wide show-file libraries. Not planned here; noted so the
rig/org model is built to allow them.

## Where it lands in the code

Server (`apps/server/src/cloud/`):

| Module | Job |
|---|---|
| `client.ts` | HTTP client for the contract; attaches the access token; refreshes; reports "offline" as a state, not an exception |
| `link.ts` | Device flow: start, poll, store, unlink |
| `entitlements.ts` | Verify, cache, `entitled()`, grace handling |
| `showfiles.ts` | Build a show file from the database; apply one to it |
| `relay.ts` | The dispatcher's cloud target |
| `feeds.ts` | Fetch, verify and cache data packs; hand exclusions to the coordinator and updates to the profile table |

Routes `apps/server/src/routes/cloud.ts`: `/cloud/status`, `/cloud/link`
(start/poll/cancel), `/cloud/unlink`, `/cloud/showfiles` (list/push/pull),
`/cloud/feeds/refresh`. Socket event `cloud:status` so every open client sees
a link or an expiry at once.

Settings columns: `cloudRigId`, `cloudOrgId`, `cloudRefreshToken` (encrypted),
`cloudEntitlements` (the JWS text), `cloudLinkedAt`, `cloudLastRefreshAt`,
`venueLocation`.

Web: `stores/cloudStore.ts`; Settings → *Cloud* page (link, status, unlink,
venue location); header account menu (person sign-in); *Save to cloud* /
*Open from cloud* on Shows; the `useEntitled` hook.

Testing follows the E2E harness pattern already in `e2e/serve.mjs`: a tiny
fake cloud (Fastify, in-process) that speaks the contract, issues
entitlements signed with a test key, and can be told to go offline or revoke.
Every flow above is testable without a real cloud.

## Phases

| Phase | What | Size | Needs |
|---|---|---|---|
| D.0 | Contract package: types, OpenAPI, entitlement and show-file schemas; the fake cloud for tests | S | IdP and residency decisions |
| D.1 | Rig link (device flow), status UI, entitlement cache and `entitled()`; nothing gated yet | M | a cloud endpoint that speaks D.0 |
| D.2 | Show files: build/apply, push/pull UI, version history | M | D.1 |
| D.3 | Person link (PKCE) and profile sync | M | D.0 |
| D.4 | Notification relay target | S in the app; the sending lives in the cloud | D.1, cloud rules UI |
| D.5 | Regional data → coordinator exclusions; venue location | M | D.1, the occupancy data source |
| D.6 | Device-profile feed | S | D.5 |

D.0–D.3 and the *app side* of D.4–D.6 are open-source work: the free tier is
free, and the paid tier's gate is a signature check on data the cloud issues.
Nothing here requires the paid application repository — see the separation
plan for why that distinction matters.

## Decisions needed before D.0

- Identity provider (hosted vs self-hosted) and data residency.
- Cloud domain and API base.
- SMS provider (for D.4's cloud side).
- Source of TV occupancy data per region (for D.5) — this is the perishable,
  licensed data the paid tier exists to pay for.
- Whether the free tier has quotas (show files per account, storage).

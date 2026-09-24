# Cloud integration — plan

How RFDeck reaches Meros Cloud: what is linked to what, where the tokens live,
how a paid feature is gated, and in what order it gets built. Companion to
`docs/EDITIONS.md` (what is free and what is paid, and why) and
`docs/REPO_SEPARATION_PLAN.md` (how the paid *application* is built). This
document is about the *cloud*; almost all of it lands in the open-source
repository, because the free cloud tier is free.

> **Revised 2026-09-23 against the Meros hand-off.** The first version of this
> plan was written without knowing that Meros Cloud already existed, and so
> invented three things that were not ours to invent: an identity provider, a
> "rig" object, and an entitlement format. **meros.co is the cloud.** RFDeck
> consumes it as a relying party. Where this document and the hand-off
> disagree, the hand-off wins.
>
> Sources, in the `meros` repository:
>
> - `docs/handoff/rfdeck-cloud-integration.md` — the authority for this plan
> - `docs/handoff/meros-sso-oidc.md` — the SSO foundation everything sits on
> - `spec/phase-8-cloud-feature-services.md` — the shared feature services
>   (**status: design**; shapes are landing, not frozen — see below)

## What changed, for anyone who read the first version

| Was | Is |
|---|---|
| A *rig* is linked to an *organisation*; `rigId` + `orgId` | An **instance** is linked to an **account** (a person *or* an org); `account_id`. There is no rig object, and nothing links to a site |
| "Choose an OIDC provider — Auth0 / Clerk / WorkOS / Keycloak / Ory. Decision needed" | **meros.co is the provider.** Not our decision, and data residency is Meros's concern |
| We define an entitlement document: `{ orgId, rigId, plan, features }` | Meros issues account-scoped entitlements in a fixed shape; we consume it |
| Feature names `regional-data`, `notify-relay` | Namespaced: `rfdeck.regional-data`, `rfdeck.notify-relay` |
| `packages/cloud-contract` as a shared, versioned contract package | Internal types only. Meros is the source of truth for shapes; a formal shared package is **not yet** |
| Paid features gated on entitlement from day one | **Gating is deferred** (owner). Build the plumbing and the gate; grant liberally for testing; do not put up a paywall yet |

Everything in **Principles** below survived the review unchanged, which is the
part worth noting: the instincts were right, the cloud just already existed.

## Principles

1. **The application never needs the cloud.** A rig on a show LAN with no
   internet is the normal case, not a failure mode. Every cloud feature is an
   addition to a working application; nothing that works today acquires a
   network dependency. If the cloud is unreachable the UI says so once and
   carries on.
2. **Two links, not one.** An *instance* (an RFDeck server, whether headless or
   inside the desktop app) is linked to an **account**. A *person* (a browser)
   signs in to their Meros identity. Show files, regional data and
   notifications belong to the instance link; preferences and profiles belong
   to the person link. Conflating them puts a person's token on a shared venue
   machine, or a venue's entitlements in a freelancer's browser.
3. **The server is the cloud client for instance things; the browser for
   personal things.** Instance tokens are stored server-side, encrypted at rest
   with the existing `secretBox` key that already protects device passwords.
   Personal tokens never touch the server.
4. **Entitlements are data, verified offline.** Meros states what the account
   has paid for; the application honours it through an offline grace period.
   There is exactly one place in the code that answers "is this account
   entitled to X".
5. **Free features are never gated.** The gate exists only for the paid cloud
   tier in `docs/EDITIONS.md`. Diagnosis is never behind it.
6. **The contract is the boundary.** Application and cloud live in different
   repositories and talk through a versioned API. Either side can be rewritten
   behind it.
7. **What leaves the venue is listed, and short.** Show files and their
   metadata; alert events when relaying notifications; the instance's identity;
   nothing else. **Never audio, never clips, never rolling-buffer capture,
   never telemetry, never device passwords.** Meros Cloud stores state, not
   recordings — a hard rule on both sides.

## Identity

**meros.co is the OIDC provider.** RFDeck is a relying party / OAuth client,
like any other Meros product. We do not run, choose, or reason about an
identity provider, and data residency is not ours.

Endpoints are **discovered, never hard-coded**: fetch
`GET https://meros.co/.well-known/openid-configuration` and use what it
returns. Per `meros-sso-oidc.md` that is `authorization_endpoint`,
`token_endpoint`, `userinfo_endpoint`, `jwks_uri` and `end_session_endpoint`,
with grants including `device_code`, and PKCE `S256`.

Two caveats from the SSO doc that our client must respect:

- **`nonce` is not echoed** into the id_token. Because we use
  authorization-code + PKCE, nonce is not required — but a generic OIDC library
  sends and validates it by default. **Turn that off**, or the person link
  fails for a reason that looks like nothing.
- Identity comes from the `id_token` (RS256; verify against JWKS by `kid`,
  check `iss=https://meros.co` and `aud=<client_id>`) or from `/userinfo`.
  Either is fine.

Meros registers our client and issues the `client_id`. We supply the redirect
URIs — see the open question about what those can be for a server reached over
a show LAN.

## Instance link — OAuth 2.0 Device Authorization Grant (RFC 8628)

The right flow for a machine that may have no browser of its own and may be
reached only over a show LAN. Identical on the desktop app and a headless box,
which is the point.

1. Settings → Cloud → *Link this rig*. The server calls Meros's
   device-authorization endpoint (discovered from the well-known document,
   whose advertised grants include `device_code`).
2. The UI shows the user code, the verification URI (`https://meros.co/link`)
   and a QR of the same. The operator opens it on any device — their phone is
   fine — signs in, and **approves this instance into one of their accounts**.
   The approval screen resolves which account; RFDeck does not choose.
3. The server polls the token endpoint, receives tokens, stores the **refresh
   token** encrypted with `secretBox`, and records **`account_id`** and
   `linkedAt`.
4. Thereafter the server holds a short-lived access token it refreshes itself.
   Unlinking revokes at `POST https://meros.co/oauth/revoke` (RFC 7009) and
   deletes locally. A Meros-side revocation surfaces on the next refresh, and
   the UI reports it as "unlinked".

The linked instance **acts within an account context**. It does not become a
first-class object at Meros, and RFDeck should not build UI or data structures
that assume it is one.

### Alternative: device-signed activation, for appliances

If RFDeck ships appliances with a burned-in identity, the Ed25519
**device-signed activation** path (`/v1/device/activate`) is the
DrawLive-proven, fully-offline route, and it also returns a **signed entitlement
document**. Use the device grant for the general case (desktop, or a headless
install on someone else's hardware); use device-signed activation for
appliances. `docs/EDITIONS.md` already anticipates appliances as a product, so
this is worth designing for even though it is not the first thing built.

## Person link — Authorization Code + PKCE

Exactly `meros-sso-oidc.md`: header → account menu → *Sign in with Meros*.
Tokens are held in that browser only. RFDeck links its local person record by
the **`sub`** claim — a stable, opaque Meros user id. `sub` is the join key;
**email is a mutable claim** we may display or prefill, never key on.

Used for **profile sync**. A person can be signed in on an instance that is not
linked, and vice versa — that separation was the original insight and it holds.

RFDeck has no local person records today. Named users are an `rfdeck-pro`
feature (R.4 in the separation plan), so the person link initially has exactly
one job — carrying a profile — and the `sub` it stores is what R.4 should later
key its accounts on. Worth writing down now so R.4 does not invent a second
identity.

## Entitlements — consume, don't define

Meros answers "what has this account paid for", account-scoped, two ways.

**Online** — `GET https://meros.co/v1/entitlements` with the instance's access
token:

```json
{ "account_id": "<uuid>", "issued_at": "…",
  "entitlements": [ { "product": "rfdeck", "sku": "…", "kind": "subscription",
                      "features": ["rfdeck.regional-data", "rfdeck.notify-relay"],
                      "expires_at": "…" } ] }
```

**Offline / appliance** — the device-signed activation path returns an
**Ed25519-signed** entitlement statement, verified with a public key shipped in
the build and honoured through a grace period. This *is* the entitlement
document the first version of this plan wanted; it already exists, and we do not
design its crypto.

Feature names are namespaced `rfdeck.*` — `rfdeck.regional-data`,
`rfdeck.notify-relay`, `rfdeck.battery-prediction`, `rfdeck.cross-venue-rf`.

One module, `apps/server/src/cloud/entitlements.ts`, verifies, caches and
answers `entitled(feature)`. The UI reads `/api/cloud/status` →
`{ linked, account, features[], expiresAt, offline }` and gates through a single
`useEntitled(feature)` hook. After expiry plus the grace period with no
successful refresh, paid features switch off with a message saying exactly why.
Clock skew, and a rig that has been in a flight case for two months, are the
cases this is designed for.

**Gating is deferred.** Build `entitled()` and `useEntitled` now; expect
features to be granted liberally while testing. A gated control, when gating
does arrive, is shown disabled with the reason — never hidden. The operator
should know the feature exists and why it is off.

## Our features → Meros shared services

Meros is building generic, cross-product services so that each product wires up
a service rather than getting a bespoke backend
(`spec/phase-8-cloud-feature-services.md`). RFDeck's features map onto them:

| RFDeck feature | Meros service | Shape |
|---|---|---|
| **Show files** — push/pull, version history | **Document sync** (§8.2) — account-scoped, named, versioned JSON | `/v1/docs/rfdeck/shows/{key}` — PUT a new version carrying `base_version` (**409** if the head moved; never a silent overwrite), GET the head or `?version=`, GET `/versions`. Server-visible now. Small JSON only |
| **Profiles** — layout, meters, shortcuts, solo groups | **Profile sync** (§8.1) — person-scoped, last-write-wins per key | `/v1/profiles/rfdeck` — GET/PUT. Follows the person between venues |
| **Regional data** (TV/DTV occupancy) and **device-profile updates** | **Signed data-pack feed** (§8.3) | `/v1/feeds/rfdeck/{pack}` — signed, versioned, `ETag`. Verified offline with a shipped public key, exactly like an entitlement |
| **Notification relay** (email/SMS) | **Alerting + relay** (§8.5) | Post an alert event; Meros applies the account's recipient rules and sends. SMTP/SMS credentials never touch a venue machine. Browser push and webhooks stay local and free |
| Multi-instance dashboard, account-wide show libraries | **Roll-up** + document sync | Already the direction; largely free once the above exist |

**Do not write clients against §8.2, §8.3 or §8.5 yet.** Those endpoints are
landing, not frozen, and Phase 8 is still marked *design*. Build against the
fake-cloud harness to the shapes above and pin when Meros confirms them. The
**instance link, the person link and entitlements are stable** — start there.

Not writing clients against guessed contracts is the same call that saved a
rework on the event envelope, and it is the right one here too.

## Internal types, not a shared contract package

The first version proposed `packages/cloud-contract` as a versioned package
depended on by both sides. Keep the *idea* internally — one place that declares
the shapes RFDeck speaks — but Meros is the source of truth, and a formal shared
package is **not yet** (owner). Pin to the hand-off and `meros-sso-oidc.md`, and
keep our types in `apps/server/src/cloud/types.ts`, where a shape correction is
a one-file change rather than a package release.

## The free tier

### Show files

A show file is the portable form of a show: the show row, its periods, cast,
castings, channel assignments, quick changes, mic-check layout — everything
except telemetry and clips. Much of it already exists as the show report's JSON;
the show file is that shape made round-trippable.

- **Push** from the Shows page ("Save to cloud"), **pull** from a cloud list
  ("Open from cloud"). Manual, explicit, named — not a background sync. An
  operator moving between venues wants "get my show from last week", not merge
  semantics on a live rig.
- Conflicts are the client's call. A push carries the `base_version` it was
  edited from; a 409 means the head moved, and RFDeck asks rather than
  overwriting. A pull that would clobber unsaved local changes also asks.
- Performer photos go with the file, resized as they already are. **Nothing else
  binary** — this is where the no-media rule gets tested, and it holds.

### Profiles

A person's preferences follow them: layout, dense grid, meter settings, solo
groups, shortcuts, notification thresholds. Today these live in `localStorage`
per browser. With a person link they are also written to the Meros profile and
read back on sign-in elsewhere. The stores already exist (`layoutStore`,
`meterStore`, …); the work is a serialiser and the last-write-wins-per-key
merge, with the local copy always usable offline.

## The paid tier

### Notification relay

The C.2 dispatcher fans alerts out to webhooks and browser push. A third target,
`dispatchToCloud`, posts the same `OutboundAlert` to Meros; the account applies
its own rules (who gets email, who gets SMS, quiet hours, escalation) and Meros
sends. SMTP and SMS credentials therefore never exist on a venue machine, and an
account configures recipients once for every instance it owns. Gated by
`entitled('rfdeck.notify-relay')`; without it the target is simply not attached.

### Regional data

Two signed data packs the server fetches, verifies and caches:

- **TV/DTV occupancy by location.** The instance declares its venue location
  (postcode/coordinates, stored locally). The pack gives the occupied TV
  channels there, and the coordinator (C.13) offers "keep out of TV channels
  licensed here" as an exclusion source alongside scans. This is what makes a
  coordination plan lawful, not merely clean.
- **Device profiles.** The band tables in `hardware/coordination/profiles.ts`
  become the *shipped baseline*; the pack delivers updates — a new band, a
  corrected range, an assumed figure verified — as data, applied without a
  release. The profile module already flags what is assumed versus read; the
  feed is where "read" comes from over time.

Gated by `entitled('rfdeck.regional-data')`. Without it the coordinator works
exactly as it does today, against the shipped tables.

## Where it lands in the code

Server (`apps/server/src/cloud/`):

| Module | Job |
|---|---|
| `client.ts` | HTTP client; discovers endpoints from the well-known document; attaches the access token; refreshes; reports "offline" as a state, not an exception |
| `link.ts` | Device grant: start, poll, store, unlink |
| `entitlements.ts` | Verify, cache, `entitled()`, grace handling |
| `showfiles.ts` | Build a show file from the database; apply one to it |
| `relay.ts` | The dispatcher's cloud target |
| `feeds.ts` | Fetch, verify and cache data packs; hand exclusions to the coordinator and updates to the profile table |
| `types.ts` | The shapes we speak, per the hand-off |

Routes `apps/server/src/routes/cloud.ts`: `/cloud/status`, `/cloud/link`
(start/poll/cancel), `/cloud/unlink`, `/cloud/showfiles` (list/push/pull),
`/cloud/feeds/refresh`. Socket event `cloud:status`, so every open client sees a
link or an expiry at once.

Settings columns — **renamed**: `cloudAccountId`, `cloudRefreshToken`
(encrypted), `cloudEntitlements` (the cached statement), `cloudLinkedAt`,
`cloudLastRefreshAt`, `venueLocation`. `cloudRigId` and `cloudOrgId` are gone
before they were ever written.

Web: `stores/cloudStore.ts`; Settings → *Cloud* page (link, status, unlink,
venue location); header account menu (person sign-in); *Save to cloud* / *Open
from cloud* on Shows; the `useEntitled` hook.

Testing follows the E2E harness pattern already in `e2e/serve.mjs`: a small fake
Meros (Fastify, in-process) that serves a well-known document, the device grant,
`/v1/entitlements` and the Phase 8 shapes; signs entitlements with a test key;
and can be told to go offline or revoke. This is how the flows get built ahead
of frozen endpoints without guessing, and it is the reason building now is safe.

## Phases

Reordered: what Meros has confirmed as stable comes first, and the Phase 8
services wait for their shapes.

| Phase | What | Size | Needs |
|---|---|---|---|
| D.0 | Internal types + the fake Meros harness: well-known document, device grant, entitlements, signed statements | S | nothing — this is ours |
| D.1 | Instance link (device grant), Cloud settings page, status UI, entitlement cache, `entitled()` / `useEntitled`; **nothing gated** | M | `client_id` |
| D.2 | Person link (PKCE), link by `sub`, account menu | S | `client_id`; the redirect-URI answer below |
| D.3 | Profile sync | M | D.2; §8.1 shape confirmed |
| D.4 | Show files: build/apply, push/pull UI, version history, 409 handling | M | D.1; §8.2 shape confirmed |
| D.5 | Notification relay target | S here; the sending is Meros's | D.1; §8.5 shape; recipient rules at Meros |
| D.6 | Regional data → coordinator exclusions; venue location | M | D.1; §8.3 shape; the occupancy data source |
| D.7 | Device-profile feed | S | D.6 |

D.0–D.4 and the *app side* of D.5–D.7 are open-repository work: the free tier is
free, and the paid tier's gate is a signature check on data Meros issues.
Nothing here requires the paid application repository — see the separation plan
for why that distinction matters.

## Open questions

Ours to ask, not to assume. Several of the first version's "decisions needed"
are now answered and have been deleted: the identity provider, data residency,
the cloud domain and API base, and the entitlement format.

### For Meros

1. **Client registration.** RFDeck needs its `client_id`(s) — plausibly one for
   the desktop app and one for a server or appliance install, since they use
   different grants. Which, and confidential or public? A desktop build cannot
   keep a client secret, so if RFDeck is registered as a confidential client
   that is a problem to solve rather than a setting to fill in.
2. **Redirect URIs for the person link — the awkward one.** RFDeck's web UI is
   served by the venue's own server, and an operator often reaches it from a
   phone or laptop at `http://192.168.1.50:3000`. That origin is DHCP-assigned,
   differs per venue, and cannot be pre-registered, so an ordinary auth-code
   redirect cannot come back to it. A loopback redirect covers a browser on the
   RFDeck host and not much else.
   *A possible answer that keeps Principle 3 intact:* let the **person** link
   use the device grant as well — the RFDeck page shows a code and a QR, the
   operator approves on their phone, and the **browser** polls the token
   endpoint and keeps the tokens, so nothing personal lands on the shared venue
   machine. That needs the token endpoint to be reachable cross-origin from an
   arbitrary LAN origin for a public client. Is it? If not, what is the intended
   shape here?
3. **Scopes.** The hand-off does not name any. RFDeck expects to need
   `openid profile email`, `offline_access`, something for reading
   entitlements, and something for document and profile sync. What is the
   vocabulary, and are the scopes RFDeck needs registered against its client?
4. **Refresh-token policy.** If refresh tokens rotate on use, a crash between
   receiving a new one and committing it to SQLite means the next start presents
   a stale token. What happens then — a plain failure we recover from by
   re-linking, or something more severe? And is one account's refresh token safe
   to hold in two places (a desktop app and a headless service on the same box),
   or must that be prevented? This decides whether the link is a single-writer
   resource, and it is the kind of thing that fails at 19:45.
5. **The entitlement signing key.** Which public key does an RFDeck build ship
   in order to verify Meros's signed entitlements and data packs, what is its
   key id, and what is the rollover story? The hand-off refers to it slightly
   differently in two places ("the RFDeck public key you ship" in §4, "a
   Meros/RFDeck public key" in §5); we read both as *Meros's per-product public
   key for `rfdeck`, compiled into our build*. Confirm.
6. **Which tier are show files and profiles in?** `docs/EDITIONS.md` promises
   both in the **free** cloud tier. Phase 8 calls profile sync a free
   loss-leader and does not say either way for document sync. If document sync
   is paid, EDITIONS needs correcting before it is published anywhere.
7. **The relay's auth.** Does posting an alert event use the instance's OAuth
   access token, or a separate ingest credential? This changes `relay.ts`, and
   whether there is anything extra for an operator to configure.

### Tracked as owed by Meros

- Frozen shapes for document sync (§8.2), the data-pack feed (§8.3) and the
  relay's alert-post contract (§8.5).
- **The TV/DTV occupancy data source** — an open owner decision, and the
  perishable licensed data the paid tier exists to pay for. The feed
  *mechanism* is Meros's to build; the *data* behind the RFDeck packs is a
  separate sourcing question. Flagged, and the mechanism is not blocked on it.

### Still ours

- Whether the free tier has quotas (show files per account, storage).
- SMS provider, if that ever becomes RFDeck's question rather than Meros's.

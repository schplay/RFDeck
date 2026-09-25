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
> **Second pass, 2026-09-25.** Every open question this plan raised has been
> answered in the hand-off's §9, and some of those answers changed the design
> rather than merely confirming it — the person link, the refresh-token rules
> and the `nonce` handling in particular. Details are inline; the answers are
> collected under "Questions, answered" at the end. The relay answer was
> corrected on a second pass: there are two relays at Meros, and the one RFDeck
> wants needs no new credential.
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

Identity comes from the `id_token` (RS256; verify against JWKS by `kid`, check
`iss=https://meros.co` and `aud=<client_id>`) or from `/userinfo`. Either is
fine.

**Keep `nonce` validation on.** Meros echoes the OIDC `nonce` into the id_token
per OIDC Core §3.1.2.1 — send it, validate it, and leave the library's default
behaviour alone. (An earlier version of the SSO doc said the opposite, and an
earlier version of this plan repeated it. That was a Meros gap, now closed.)

### Clients: two of them, both public

Meros provides a seeder that registers **RFDeck Server** and **RFDeck Desktop**
and prints their `client_id`s. Both are **public clients with no secret**, with
the device grant enabled and a loopback redirect also allowed. Run per
environment: ids differ between staging and production.

```
php artisan db:seed --class=RfdeckClientsSeeder
```

Unqualified, deliberately. Laravel resolves the name against `Database\Seeders\`,
and passing the fully-qualified `Database\Seeders\RfdeckClientsSeeder` fails in a
POSIX shell, which eats the backslashes and turns it into a class name that does
not exist. The error says "class not found", which sends you looking for a
missing file rather than a quoting problem.

**Staging client ids** (obtained 2026-09-25):

| Client | `client_id` |
|---|---|
| RFDeck Server | `01a0d93a-4ea8-7313-92c7-c90b90c136ff` |
| RFDeck Desktop | `01a0d93a-4eb7-7280-880e-27984005adf3` |

These are recorded rather than treated as secrets because a public OAuth client
has none: the `client_id` travels in every authorization request and is visible
to the browser by design. They are still **environment configuration, not
constants** — production's will differ, and so will the Meros base URL that
discovery hangs off. Both belong in env config read at runtime, so that a
production build cannot ship staging ids. (If this repository goes open source as
`docs/REPO_SEPARATION_PLAN.md` intends, these two lines can move to env-only;
there is no need to publish staging infrastructure ids.)

Two clients rather than one is not tidiness. Refresh tokens rotate and a replay
revokes the whole token family (below), so a desktop app and a headless service
on the same box must be separate clients holding separate links, or they revoke
each other.

Public clients mean **no secret ships in a build**, which is the only workable
answer for a desktop application and removes the problem this plan previously
had to flag. Authorisation rests on the operator's consent and its granted
scopes, not on RFDeck keeping a secret.

### Scopes

Request only what a given link uses:

| Link | Scopes |
|---|---|
| **Person** (browser, profile sync) | `openid profile email profiles:read profiles:write` — plus `offline_access` only if the browser keeps a refresh token |
| **Instance** (server: show files, entitlements) | `openid offline_access backups:read backups:write entitlements:read` — plus `events:write` if RFDeck ever reports to roll-up |

Public data-pack feeds (regional data, device profiles) are read **without a
scope and without an account**. A private or entitled pack would use
`compat:read`.

### CORS, which the browser device flow depends on

Meros sends `Access-Control-Allow-Origin: *` (credentials disabled) on
`oauth/device/code`, `oauth/token`, `oauth/userinfo`, `oauth/revoke`, the
`.well-known` discovery and JWKS documents, and the `v1/*` API. These
authenticate by device code or bearer token and never by cookie, so the wildcard
is safe. `oauth/authorize` and `/cloud/*` are deliberately **not** CORS-enabled —
they are session-bearing, top-level navigation only.

This is what makes the person link work from a browser at an arbitrary venue
address, and it is worth knowing it is deliberate rather than incidental.

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

### Refresh tokens rotate, and a replay is treated as a breach

This is the part of the design most likely to fail in a venue at 19:45, so it is
spelled out rather than left to the HTTP client.

Meros **rotates the refresh token on every use**, and replaying an
already-rotated one **revokes the entire (user, client) token family** —
deliberately, as a breach response. Three consequences, all of which shape
`link.ts`:

1. **The link is a single-writer resource.** One process, one link. A desktop
   app and a headless service on the same machine must be separate clients with
   separate links (which is why there are two `client_id`s); two processes
   rotating the same token revoke each other. RFDeck must make sharing one
   impossible rather than merely discouraged — the link belongs to the process
   that owns the database.
2. **Persist the rotated token durably before acting on the new access token.**
   If we take the new access token and crash before the new refresh token is
   committed, the next start presents a stale one, the family is revoked, and
   the link is *dead* — not degraded. Commit first, then use.
3. **`invalid_grant` on refresh means "unlinked", not "retry".** It is surfaced
   to the operator as a link that has to be re-established by the device flow
   again, with the reason. Retrying cannot help, and a background retry loop
   would hide the one thing they need to know.

Meros is *considering* a short rotation grace window — accepting the immediately
previous refresh token for about 60 seconds, so a crash-before-commit heals
itself — at the cost of slightly softer reuse detection. That call is the
owner's and is not made. **Build for single-writer and re-link regardless:** it
is correct either way, and a grace window would only turn a rare hard failure
into a rare invisible recovery.

### Alternative: device-signed activation, for appliances

If RFDeck ships appliances with a burned-in identity, the Ed25519
**device-signed activation** path (`/v1/device/activate`) is the
DrawLive-proven, fully-offline route, and it also returns a **signed entitlement
document**. Use the device grant for the general case (desktop, or a headless
install on someone else's hardware); use device-signed activation for
appliances. `docs/EDITIONS.md` already anticipates appliances as a product, so
this is worth designing for even though it is not the first thing built.

## Person link — the device grant, in the browser

Header → account menu → *Sign in with Meros*. Tokens are held in **that browser
only**, and RFDeck links its local person record by the **`sub`** claim — a
stable, opaque Meros user id. `sub` is the join key; **email is a mutable claim**
we may display or prefill, never key on.

The mechanism is **not** the ordinary auth-code redirect, and the reason is
RFDeck-shaped. RFDeck's UI is served by the venue's own server and an operator
reaches it from a phone or laptop at something like `http://192.168.1.50:3000` —
DHCP-assigned, different at every venue, impossible to pre-register as a
redirect URI, and not loopback. So there is nowhere for a redirect to come back
to.

**The person link uses the RFC 8628 device grant too, browser-side** (confirmed
by Meros): the page shows a user code and a QR, the operator approves on their
phone, and the **browser** polls the token endpoint and keeps the tokens. No
redirect URI is involved, and nothing personal is written to the shared venue
machine — Principle 3 holds exactly. This works because Meros CORS-enables the
device, token, userinfo and revoke endpoints for a public client.

The desktop application is the one case that *can* use auth-code + PKCE with a
loopback redirect, since its browser is on the same machine and the seeded
clients allow loopback. Whether to have two code paths or one is an
implementation choice, not a design one — the device grant works in both places,
so **start with the device grant only** and add the redirect path only if the
desktop experience demands it.

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

### One key verifies both entitlements and data packs

Signed entitlement statements and signed data packs are both signed with the
**product's active Ed25519 key** for `rfdeck`, key id **`rfdeck-2026a`**. So a
build embeds **one** public key (32 bytes, handed over base64url) and it verifies
both. Staging uses a committed development key; production uses a generated one,
so the key is per-environment build configuration, not a constant.

**Rotation is additive, so ship a table keyed by `kid` from the start** — not a
single constant. A future `rfdeck-2026b` is then a data change rather than an
application update, which matters for a build sitting in a flight case. A pack or
statement carrying an unknown `kid` is refused, and says which key it wanted.

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
| **Notification relay** (email/SMS) | **Alerting + relay** (§8.5, extending the Phase 6 alerting engine) | Post an alert event **on the instance link's own token** — no separate credential. Meros applies the account's recipient rules and sends. SMTP/SMS credentials never touch a venue machine. Browser push and webhooks stay local and free. Not the Phase 4 *remote-access* relay, which is a different thing RFDeck does not use |
| Multi-instance dashboard, account-wide show libraries | **Roll-up** + document sync | Already the direction; largely free once the above exist |

**Do not write clients against §8.2, §8.3 or §8.5 yet.** Those bodies are
landing, not frozen, and Phase 8 is still marked *design*. Build against the
fake-cloud harness to the shapes above and pin when Meros confirms them. The
**instance link, the person link and entitlements are stable** — start there,
and note that §8.5's *auth* is settled even though its body is not.

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

**Auth is settled: the instance-link OAuth access token.** No separate relay
credential, nothing extra for an operator to configure — the instance posts alert
events on the link it already has, and the cloud applies the account's rules. The
notification relay extends the Phase 6 alerting engine, which exists.

There are **two different relays at Meros**, and conflating them cost a round
trip. This is the **notification relay** (Phase 8 §8.5, on the Phase 6 alerting
engine), and it is the one RFDeck wants. The **remote-access relay** (Phase 4) is
a separate, unbuilt subsystem whose auth is still undecided, and RFDeck has no
use for it. Worth naming both here so the next reader does not have to ask.

What is still missing is on Meros's side and behind the boundary: the account's
recipient rules and the SMS delivery configuration. That is a cloud-side build
and a UI at Meros, not a contract RFDeck writes against — so **the only thing
D.5 waits for is the alert-post body shape**, not permission and not a
credential.

One scope question, small: the instance scope table carries `events:write` "if
RFDeck reports telemetry or alerts to roll-up". Posting an alert event for relay
reads like exactly that, so `events:write` is presumably the scope the relay
target needs. Confirm when the body shape lands rather than guessing — it is one
string in a consent screen, and getting it wrong is a 403 in a venue.

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

A note on how packs are fetched: a **public** pack is read with no scope and no
account at all — so the device-profile feed does not require a link, and an
unlinked rig can still be up to date on band tables. Only a private or entitled
pack needs an account, with `compat:read`. That is a better arrangement than this
plan originally assumed, and it means the device-profile feed (D.7) has no
dependency on the link beyond the entitlement question.

## Where it lands in the code

Server (`apps/server/src/cloud/`):

| Module | Job |
|---|---|
| `client.ts` | HTTP client; discovers endpoints from the well-known document; attaches the access token; refreshes; reports "offline" as a state, not an exception |
| `link.ts` | Device grant: start, poll, store, unlink. Owns the rotation discipline — commit the new refresh token before using the new access token, and turn `invalid_grant` into "re-link required" |
| `entitlements.ts` | Verify (by `kid`, from a table so rotation is additive), cache, `entitled()`, grace handling |
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

The person link is entirely browser-side and has **no server module**: the
browser runs its own device flow against Meros and keeps the tokens in that
browser. Nothing about it passes through `apps/server`, which is the mechanical
form of Principle 3 — a personal token cannot end up on a shared venue machine
if the server has no code that could store one.

Testing follows the E2E harness pattern already in `e2e/serve.mjs`: a small fake
Meros (Fastify, in-process) that serves a well-known document, the device grant,
`/v1/entitlements` and the Phase 8 shapes; signs entitlements and packs with a
test key under a `kid`; and can be told to go offline or revoke. It must also
**rotate refresh tokens and revoke a replayed family**, because that is the
behaviour most likely to break a real venue and a hostile harness is the only
safe place to meet it. This is how the flows get built ahead of frozen endpoints
without guessing, and it is the reason building now is safe.

## Phases

Reordered: what Meros has confirmed as stable comes first, and the Phase 8
services wait for their shapes.

| Phase | What | Size | Needs |
|---|---|---|---|
| D.0 | Internal types + the fake Meros harness: well-known document, device grant, entitlements, signed statements, rotating refresh tokens | S | nothing — this is ours |
| D.1 | Instance link (device grant), Cloud settings page, status UI, entitlement cache, `entitled()` / `useEntitled`; **nothing gated** | M | nothing on staging — ids in hand. The Meros staging base URL |
| D.2 | Person link (browser-side device grant), link by `sub`, account menu | S | nothing on staging — ids in hand |
| D.3 | Profile sync | M | D.2; §8.1 shape confirmed |
| D.4 | Show files: build/apply, push/pull UI, version history, 409 handling | M | D.1; §8.2 shape confirmed |
| D.5 | Notification relay target | S here; the sending is Meros's | The alert-post body shape. Auth is settled (the instance link's own token) |
| D.6 | Regional data → coordinator exclusions; venue location | M | D.1; §8.3 shape; the occupancy data source |
| D.7 | Device-profile feed | S | §8.3 shape. No link needed — public packs are read without an account |

The fake Meros in D.0 should **rotate refresh tokens and revoke a replayed
family**, because that behaviour is the one most likely to break a real venue and
the only place it can be exercised safely is a test harness that is deliberately
hostile about it.

D.0–D.4 and the *app side* of D.5–D.7 are open-repository work: the free tier is
free, and the paid tier's gate is a signature check on data Meros issues.
Nothing here requires the paid application repository — see the separation plan
for why that distinction matters.

## Questions, answered

All seven questions this plan raised were answered by Meros on 2026-09-24
(hand-off §9). Recorded here because three of the answers are constraints rather
than facts, and a future reader should not have to reconstruct why the design
looks like this.

| We asked | Answer |
|---|---|
| Client registration — how many, confidential or public? | **Two, both public, no secret**: RFDeck Server and RFDeck Desktop, from a seeder, per environment. Device grant enabled, loopback also allowed. **Staging ids obtained 2026-09-25** — see Identity |
| Redirect URIs for a browser at a DHCP venue address | **Use the device grant for the person link too**, browser-side — and Meros has now CORS-enabled the device, token, userinfo, revoke, discovery and `v1/*` endpoints so that it works from any origin |
| Scope vocabulary | Given in full; see the table under Identity. Public packs need no scope and no account |
| Refresh-token policy | **Rotates, with reuse-detection family revocation.** Single-writer; commit the rotated token before using the new access token; `invalid_grant` means re-link. A ~60s grace window is under consideration but not decided |
| Which public key verifies entitlements and packs | **One key**, the active `rfdeck` Ed25519 key, kid `rfdeck-2026a`, per environment. Rotation is additive — key the verifier by `kid` |
| The relay's auth | **The instance link's own OAuth access token** — no separate credential (corrected 2026-09-25; the first answer described the unrelated Phase 4 remote-access relay). Only the account's recipient rules and SMS config remain to be built, on Meros's side |
| Which tier is document sync in? | **Ungated as built** — it works for any account, as does profile sync. The free-versus-paid line is a deferred pricing decision the owner owns |

Two of those answers changed this document rather than confirming it: the person
link is a device grant rather than a redirect flow, and `nonce` validation stays
**on** (the SSO doc's earlier advice to disable it was a Meros gap, since fixed).

### The tier question, and how to write about it

Document sync and profile sync are both ungated today, so `docs/EDITIONS.md`
promising show files and profiles in the free tier is consistent with what is
live. But the formal line is deliberately deferred, which has a consequence for
copy rather than for code: **"included today, pricing to be decided" is the
honest framing, and "free forever" is not.** EDITIONS says so now.

### Still owed by Meros

- Frozen shapes for document sync (§8.2), the data-pack feed (§8.3) and the
  notification relay's alert-post body (§8.5). The relay's *auth* is settled.
- The account's recipient rules and SMS delivery config, both on Meros's side of
  the boundary. RFDeck is not blocked on either: the target can be written and
  tested against the fake cloud, and it simply has nowhere to deliver until they
  exist.
- Whether the rotation grace window lands. It changes nothing we build.
- **The Meros staging base URL.** Every document says `https://meros.co`, but
  client ids and the signing key are per-environment, so staging is elsewhere.
  Discovery hangs off that origin, so a staging build cannot reach the cloud
  without it. The only thing now standing between D.1/D.2 and a real end-to-end
  link.
- **The TV/DTV occupancy data source** — an open owner decision, and the
  perishable licensed data the paid tier exists to pay for. The feed
  *mechanism* is Meros's to build; the *data* behind the RFDeck packs is a
  separate sourcing question. Flagged, and the mechanism is not blocked on it.

### Still ours

- Whether the free tier has quotas (show files per account, storage).
- SMS provider, if that ever becomes RFDeck's question rather than Meros's.

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

### Environment, not constants

The `client_id` and the Meros origin are **per-environment configuration** and
are never compiled in. A public OAuth client has no secret, so these are not
credentials — but a production build that shipped a staging id would still be
broken, and there is no reason for staging infrastructure ids to sit in a
repository that is intended to go open source.

| Variable | Meaning |
|---|---|
| `MEROS_BASE_URL` | Origin OIDC discovery hangs off. `https://staging.meros.co` for staging, `https://meros.co` for production |
| `MEROS_CLIENT_ID` | This install's client — the *RFDeck Server* id for a headless install, the *RFDeck Desktop* id for the desktop build |
| `MEROS_PACK_KEYS` | Meros's Ed25519 public key(s) for product `rfdeck`, as `<kid>=<base64url>` pairs. Verifies both signed entitlements and signed packs. Public by nature, but environment-specific — staging and production sign with different keys. A map rather than one value because rotation is additive |

Values live outside the repository. In production they are systemd
`Environment=` lines, which is how `PORT`, `HOST` and `DATABASE_URL` already
reach the server — `scripts/install-ubuntu.sh` writes the unit, and the cloud
variables belong in the same place. For development they are in
`apps/server/.env.local`, which is gitignored; note that `apps/server/.env` is
**tracked** and exists only for the Prisma CLI, so nothing environment-specific
goes there.

One thing D.1 has to add: **nothing loads a dotenv file at runtime today.** The
server reads `process.env` directly and Prisma reads `.env` itself, so
`.env.local` is a convention with no reader yet. D.1 either adds the loader
(preferring `.env.local`) or documents that developers export the variables
themselves. Production is unaffected — systemd provides them either way.

**Which client does the browser use?** Unresolved, and it matters more than it
looks. Refresh-token families are scoped to `(user, client)`, so if the browser
person link requests `offline_access` under the same `client_id` the server's
instance link uses, and the same Meros user is behind both, a rotation on one
could revoke the other — the single-writer hazard, arriving through the back
door. Two ways out: give the browser its own client, or **have the person link
not request `offline_access` at all**, so it holds no refresh token and there is
nothing to rotate. The second is simpler and costs a re-approval when the access
token expires. Ask Meros before building D.2.

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

Data-pack feeds split by whether the pack is public. A **public** pack is read
with no scope and no account at all; an **entitled** pack needs the bearer's
account to hold an active `rfdeck` entitlement and answers `401` or
`403 not_entitled` otherwise.

**Regional TV occupancy is an entitled pack**, so it needs the instance link and
a live entitlement — an earlier draft of this plan had it the other way round.
Whether the **device-profile** pack is public is not yet stated; it is not named
in either list in §8.3. That decides whether D.7 needs a link at all, so it is
worth one question rather than an assumption.

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
| **Regional data** (TV/DTV occupancy) and **device-profile updates** | **Signed data-pack feed** (§8.3) | `/v1/feeds/rfdeck/{pack}` — signed, versioned, `ETag`. Verified offline with a shipped public key, exactly like an entitlement. Regional data is **entitled**, **sharded on a 2° grid** (an index plus the venue's cell and its eight neighbours), and carries station contours rather than answers: RFDeck runs the point-in-polygon locally |
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

Two signed data packs the server fetches, verifies and caches. Both are gated by
`entitled('rfdeck.regional-data')`; without it the coordinator works exactly as
it does today, against the shipped tables and whatever scans the operator has.

#### TV/DTV occupancy — and the computation is ours

Meros's design is settled (full version: `spec/phase-10-regional-tv-occupancy.md`
in the meros repository). The shape of it matters to us because **RFDeck does the
geography, not the cloud**:

- **Source.** The FCC's LMS station registry — RF channel, service, status,
  coordinates — joined by application id to the FCC's TV Service Contour Data
  Points, which give the service-area polygon per station. Public domain.
  Deliberately *not* a live PAWS / white-space database: those have wound down
  (Key Bridge moved to CBRS, Nominet to RED), and an offline-first rig could not
  depend on one anyway.
- **What we fetch: an index, then a few cells.** A whole-US pack would be about
  9,300 stations by up to 360 contour points — 60–70 MB of JSON, 15–25 MB
  gzipped, on a venue machine, weekly. So it is **sharded on a fixed 2° lat/lon
  grid** and we only ever hold the neighbourhood.
  - **Index** — `GET /v1/feeds/rfdeck/regional-us-fcc`, fetched once on link.
    Small, and it doubles as confirmation that the domain is published:
    `{ domain, channel_plan, generated_at, source, cell_deg, cells: { "tn40w076": { stations }, … } }`.
  - **Cells** — `GET /v1/feeds/rfdeck/regional-us-fcc-<cell>` for the cell
    containing the venue **plus its eight neighbours**. A 6°×6° window far
    exceeds any TV contour's reach, so nothing that could cover the venue is
    missed, and a station is placed in *every* cell its contour overlaps so
    edge-spanning coverage is not lost either. Each cell is
    `{ domain, channel_plan, generated_at, source, cell, cell_deg, stations[] }`,
    each station carrying `facility_id`, `call_sign`, `rf_channel`, `service`
    and a `contour` of `[lat, lon]` points.

  Both are entitled and both verify offline with the embedded `rfdeck-2026a` key.
  This is the answer to the sizing question this plan raised: the cache is a
  handful of small files, not a store.
- **What we compute, at show time, with no network.** Union the stations across
  the fetched cells, then point-in-polygon of the venue location against each
  station's `contour`. The matching stations' `rf_channel`s are occupied; map
  channel to MHz via `channel_plan`; hand the result to the coordinator (C.13) as
  an exclusion source alongside scans.

  **`lat` and `lon` are null for FCC data.** The contour drives occupancy, not the
  transmitter's position, so there is no distance test to fall back on and no
  temptation to write one.
- **Refresh.** Meros republishes weekly — TV facilities change slowly. Cached
  cells keep working offline; `ETag` / `If-None-Match` makes a re-poll cheap per
  cell. Pre-fetch the index and the venue's cells on link and on a schedule
  whenever online. **A touring rig re-derives its cells when the venue location
  changes**, which makes venue location the trigger for a fetch rather than a
  field that sits there.
- **Multi-region.** Domain-tagged, same index-plus-cells scheme per domain:
  `US-FCC` now, `UK-OFCOM` next. Fetch the domains and cells actually operated
  in.
- **Optional online path.** `GET /v1/regional/tv-occupancy?lat=&lon=&domain=`
  returns `{ occupied_channels, exclusions, cell, source, generated_at }`, with
  Meros loading the venue's cell and running the polygon test. A convenience only;
  the offline cells are the show-critical path and the one that gets built.

This is the "keep out of TV channels licensed here" input, and it is the
regulator's own protection statement mirrored rather than anything RFDeck
invents. Not in v1: protected wireless-mic *registrations*, which are a separate
live licensed-user layer. Scanning stays on the rig.

**New work on our side that the earlier plan did not account for**, because it
assumed the cloud answered "which channels are occupied here":

| Piece | Note |
|---|---|
| Point-in-polygon | Ray casting over a per-station contour. Pure geometry, no dependency, and eminently unit-testable — a station whose contour is known, a venue inside it and one outside |
| Channel → MHz | Per `channel_plan`. A US table exists in the literature and the profile module is already the natural home for it |
| Cell cache | Index plus up to nine cells per domain, on disk beside the database, each with its own `ETag`. Files, not a store |
| Cell id arithmetic | `floor(lat/2)*2`, `floor(lon/2)*2`, encoded `t{n\|s}{lat:02}{e\|w}{lon:03}` from the south-west corner. Neighbours are ±2° on each axis. Three traps below |
| Venue location | Postcode or coordinates, stored locally, never sent — the polygon test is local, so the venue's position stays in the venue |

That last point is worth noting against Principle 7: taking the offline path
means the venue's location **never leaves the building**. The online convenience
endpoint would send it, which is a reason to treat that path as genuinely
optional rather than the default.

**Three things to get right in the cell arithmetic**, each of which fails quietly
rather than loudly:

1. **`floor`, never truncation.** For a western longitude these disagree:
   `Math.trunc(-76.3 / 2) * 2` is −76, `Math.floor(-76.3 / 2) * 2` is −78, and
   −78 is the correct south-west corner of the cell spanning `[-78, -76)`.
   Truncating returns a real, adjacent, plausible cell full of real stations —
   the wrong ones — for the entire western hemisphere, with nothing to indicate
   anything went wrong. This deserves a unit test naming the hemisphere.
2. **Derive neighbours in signed degrees, then encode.** Never by manipulating the
   cell-id string. The hemisphere letter flips at zero: a venue at longitude −0.5
   sits in `w002`, and its eastern neighbour is `e000`. `US-FCC` never crosses
   either zero, but `UK-OFCOM` is named as next and straddles the prime
   meridian — so a string-munging shortcut works right up until the feature it
   would break is the reason it was written.
3. **A missing cell is an answer, not a failure.** A cell absent from the index,
   or one that 404s, means no stations there and nothing to exclude. The cloud
   client reports unreachability as a state, so this must not be routed through
   that path and shown to an operator as a problem.

#### Device profiles

The band tables in `hardware/coordination/profiles.ts` become the *shipped
baseline*; the pack delivers updates — a new band, a corrected range, an assumed
figure verified — as data, applied without a release. The profile module already
flags what is assumed versus read; the feed is where "read" comes from over
time.

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
| D.1 | Instance link (device grant), Cloud settings page, status UI, entitlement cache, `entitled()` / `useEntitled`; **nothing gated** | M | **nothing — clear to start** |
| D.2 | Person link (browser-side device grant), link by `sub`, account menu | S | Which `client_id` the browser uses (see Identity) |
| D.3 | Profile sync | M | D.2; §8.1 shape confirmed |
| D.4 | Show files: build/apply, push/pull UI, version history, 409 handling | M | D.1; §8.2 shape confirmed |
| D.5 | Notification relay target | S here; the sending is Meros's | The alert-post body shape. Auth is settled (the instance link's own token) |
| D.6 | Regional TV occupancy: index and cell fetch per domain, cell arithmetic, point-in-polygon, channel→MHz, coordinator exclusions, venue location | **L** — the geography is ours, not the cloud's | D.1 **and a live entitlement** (the packs are gated). Contract fully specified |
| D.7 | Device-profile feed | S | §8.3 shape; whether that pack is public or entitled |

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
| Scope vocabulary | Given in full; see the table under Identity. Public packs need no scope and no account, but **regional data is an entitled pack** and does need both |
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

### The TV occupancy source, settled

This was the last genuinely open owner decision, and the answer is a good one:
**FCC public-domain data**, the LMS station registry joined to the TV Service
Contour Data Points. Curated and republished weekly by Meros, shipped as a signed
pack, and evaluated locally against the venue's coordinates.

Two consequences worth carrying forward. It makes the paid tier's case *stronger*
rather than weaker — see `docs/EDITIONS.md`, because charging for public-domain
data needs its reasoning stated plainly. And it moves real work onto our side of
the boundary: the cloud sends contours, not conclusions.

### Still owed by Meros

Written out endpoint by endpoint, with field-level specifics, in
[`docs/CLOUD_CONTRACT_QUESTIONS.md`](CLOUD_CONTRACT_QUESTIONS.md) — that is the
document to hand over, rather than this summary.

The sharpest one: **the `rfdeck-2026a` public key is in hand and verified as a
valid 32-byte Ed25519 key, and it is still unusable**, because nothing states
which bytes it signs. §8.3 describes a pack envelope carrying a `signature` field;
§10's payload examples show no signature at all. Until that is pinned — where the
signature travels, what is excluded before verifying, raw bytes or canonicalised
— D.6 and D.7 cannot verify a pack, and a verifier that is subtly too lenient is
worse than one that plainly does not work.


- Frozen shapes for document sync (§8.2), the data-pack feed (§8.3) and the
  notification relay's alert-post body (§8.5). The relay's *auth* is settled.
- The account's recipient rules and SMS delivery config, both on Meros's side of
  the boundary. RFDeck is not blocked on either: the target can be written and
  tested against the fake cloud, and it simply has nowhere to deliver until they
  exist.
- Whether the rotation grace window lands. It changes nothing we build.
- **Which `client_id` the browser person link should use**, given that refresh
  families are `(user, client)`-scoped — see Identity. A third client, or no
  `offline_access` in the browser.
- **Whether the device-profile pack is public or entitled**, which decides
  whether D.7 needs a link.
- Nothing further on regional data. The source is settled, the sharding answers
  the sizing question, and the index-plus-cells contract is fully specified — this
  one is ready to build as soon as D.1 lands and an account carries the
  entitlement.

### Still ours

- Whether the free tier has quotas (show files per account, storage).
- SMS provider, if that ever becomes RFDeck's question rather than Meros's.

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
7. **No mass media, ever — and device passwords never.** No audio, no clips, no
   rolling-buffer capture, no bulk media of any kind leaves the venue. That is a
   hard constraint on both sides: Meros Cloud offers no mass-media storage, and
   RFDeck has nothing to gain from sending any. Device passwords never leave
   either; they unlock somebody's hardware.

   **This principle used to say "never telemetry", and that was wrong.** It was
   RFDeck's invention rather than Meros's rule, and the owner has corrected it:
   *events are the full stream of what the product does*, not a short allow-list,
   and where they go is the user's choice. "Offline-first" means RFDeck **works**
   with no cloud — not that data never leaves it. Remote capability is the point
   of having a cloud account, and it needs the events.

   What survives is the narrower and more defensible rule: **media never travels,
   and what does travel is worth naming.** For RFDeck that naming has real
   content, because our event stream is not anonymous — channel names are
   routinely *performers' names*, taken straight off the cast list. See the open
   question about privacy tiers; it is a decision to make deliberately rather
   than discover.

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

Meros provides a seeder that registers **three** public clients and prints their
`client_id`s. All are **public with no secret**, with the device grant enabled and
a loopback redirect also allowed. Run per environment: ids differ between staging
and production.

| Client | Used by | Link |
|---|---|---|
| **RFDeck Server** | A headless install | Instance |
| **RFDeck Desktop** | The desktop build's embedded server | Instance |
| **RFDeck Browser** | The web UI in an operator's browser | Person |

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
| `MEROS_CLIENT_ID` | This install's client for the **instance** link — the *RFDeck Server* id for a headless install, the *RFDeck Desktop* id for the desktop build |
| `MEROS_CLIENT_ID_BROWSER` | The *RFDeck Browser* id, for the **person** link. The server does not use it; it serves it to the web UI, which runs its own device flow |
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

Three clients rather than one is not tidiness. Refresh-token families are scoped
to `(user, client)` and a replay revokes the whole family (below), so any two
things that hold their own refresh token for the same Meros user must be separate
clients or they revoke each other. That covers both hazards: a desktop app and a
headless service on the same box, and the browser's person link against the
server's instance link.

The browser having its own client is what closes the second hazard
**structurally** rather than by convention — it was previously going to depend on
the browser politely declining `offline_access`. It may still decline it, and
probably should (Principle 3: nothing personal persisted on a venue machine), but
that is now a free choice rather than the only safe option.

Public clients mean **no secret ships in a build**, which is the only workable
answer for a desktop application and removes the problem this plan previously
had to flag. Authorisation rests on the operator's consent and its granted
scopes, not on RFDeck keeping a secret.

### Scopes

Request only what a given link uses:

| Link | Scopes |
|---|---|
| **Person** (browser, profile sync) | `openid profile email profiles:read profiles:write` — plus `offline_access` only if the browser keeps a refresh token |
| **Instance** (server: show files, entitlements, alert relay) | `openid offline_access entitlements:read backups:read backups:write alerts:send` |

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

**And the token is user-scoped, not account-pinned** (§11.C.5) — a correction to
what this plan first assumed. The account is resolved per request: the
`X-Meros-Account` header if RFDeck sends one, otherwise the caller's **personal
account**. So `cloudAccountId` is a value RFDeck *learns* rather than a property of
the token, and it comes from the `account_id` field of `GET /v1/entitlements`,
which returns the account it resolved.

For v1 that means: send no header, get the personal account, which matches
"instance linked to an account" for every case RFDeck has. Acting inside an **org**
account means sending the header with that account's id — and there is no
list-my-accounts endpoint yet, so org selection is a later feature, not something
to build UI for now.

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

It uses its own **RFDeck Browser** client (§11.F), which is the point: with a
separate client the person link cannot revoke the server's instance link for the
same Meros user, however either side handles its tokens.

**`offline_access` is requested, and the session renews itself.** This was built
the other way round first — no refresh token, on the reasoning that a shared venue
machine should hold nothing personal. The consequence was re-approving with a phone
and a typed code **every hour**, which is not a trade; it is a broken feature, and
exactly the sort of thing that makes people stop using something mid-show.

The shared-machine concern is real and is handled by *where* the token lives:

- **Default: this tab only.** `sessionStorage`, so the session ends when the tab
  closes. A venue PC accumulates no identities, and the operator signs in once per
  sitting.
- **"Keep me signed in on this machine":** `localStorage`, for somebody's own
  laptop. Offered as a choice because the operator knows which kind of machine they
  are sitting at and RFDeck does not.

Tokens still never reach the RFDeck server either way, which is what Principle 3
actually asks for.

One hazard that came with this and is handled explicitly: refresh tokens rotate and
a replay revokes the whole family. With "keep me signed in" the token is visible to
every tab, so two tabs renewing at once would look exactly like a replay and sign
both out. A short cross-tab lock means one tab renews and the others read the
result.

The desktop application is the one case that *could* use auth-code + PKCE with a
loopback redirect, since its browser is on the same machine. Not worth a second
code path: the device grant works in both places, so **build the device grant
only**.

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

### How a signed pack is verified — confirmed against a test vector

The envelope was the missing piece: the payload is never signed in isolation, it
is **wrapped**. `GET /v1/feeds/{product}/{pack}` returns

```json
{ "product": "rfdeck", "pack": "regional-us-fcc-tn40w076", "version": 1,
  "kid": "rfdeck-2026a", "issued_at": "…",
  "payload": { "…the pack object…": true },
  "signature": "<base64url detached Ed25519>",
  "signed": "MEROSPACK1.<base64url(header)>.<base64url(payload)>" }
```

and verification is exactly:

```
Ed25519_verify(base64url_decode(signature), utf8_bytes(signed), pubkey)
```

Four rules that matter more than they look:

1. **The server hands us the signed string.** `signed` is not reconstructed from
   the response — no re-serialising, no sorting keys, no canonicalisation. Its
   raw ASCII bytes are the message. base64url is unpadded, `-_` alphabet.
2. **Read the payload out of `signed`, not out of the response's `payload`
   field.** Base64url-decode the third segment and parse that. The `payload` field
   is a convenience, and trusting it means a re-serialisation could drift from
   what was actually signed — a gap between "verified" and "used".
3. **`kid` lives inside the signed header**, so a swapped `kid` fails
   verification. Read it from the decoded header, look it up in `MEROS_PACK_KEYS`,
   and refuse an unknown one while naming which key it wanted.
4. **One verifier covers everything.** The same `MEROSPACK1.…` construction signs
   entitlement statements, the index and every cell — the index is an ordinary
   pack on the same terms.

Meros supplied a worked vector under a throwaway demo key, and **it has been run:
the signature verifies, a single flipped byte in `signed` is rejected, and the
header and payload decode as documented** (`kid: rfdeck-demo`, cell `tn40w076`,
one station on RF 26 with null `lat`/`lon`). It belongs in the D.0 harness as the
verifier's first unit test, since it is a known-good pair that does not depend on
any environment's real key.

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
| **Events**, and the alerts configured over them | **Events ingest + cloud alert rules** | `POST /v1/events` on the instance link with `events:write` — one envelope or a batch of 500 at most, `202 { accepted, duplicates, rejected, errors }`, deduped on `(source.instance, id)`. Free-tier. Alerts are rules the user configures in the cloud *over* the stream, so there is nothing to post and nothing to gate. A local **Imperio** speaks the same binding, so it is one emitter with a list of collectors |
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
- Conflicts are the client's call, and the contract is now specific enough to
  offer a real one. A version is a **monotonic integer per document from 1**, head
  is the largest, and a push carries the `base_version` it was edited from. A stale
  base returns **409 `version_conflict`** with the head attached —
  `{ version, updated_at, content_hash }` — so the prompt can say *"the cloud copy
  changed at 19:04, keep yours or take theirs?"* rather than just refusing.
  Comparing `head.content_hash` against the local body's sha256 detects the case
  where the bodies are identical and there is **no real conflict to raise**, which
  is the one worth getting right: an operator asked to resolve a non-conflict
  learns to click through the dialog.
- Creating a brand-new key with a non-zero `base_version` is also a 409, head 0.
- `body` is an arbitrary JSON object — not a string — capped at 1 MB
  (**413 `document_too_large`**). Keys match
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$`, so the show's uuid is fine.
- The list is `{ account_id, product, collection, documents: [ { key, head_version,
  updated_at } ] }`, newest-updated first; per-version detail (`content_hash`,
  `size_bytes`, `author_user_id`, `created_at`) comes from `GET …/{key}/versions`.
- **DELETE is soft.** History is retained, the key leaves the list, and a later
  PUT to the same key revives it and continues its version line. There is no
  restore call because pushing *is* the restore — worth knowing before building a
  "restore deleted show" button that does not need to exist.
- Performer photos go with the file, resized as they already are. **Nothing else
  binary** — this is where the no-media rule gets tested, and it holds.

### Profiles

A person's preferences follow them: layout, dense grid, meter settings, solo
groups, shortcuts, notification thresholds. Today these live in `localStorage`
per browser. With a person link they are also written to the Meros profile and
read back on sign-in elsewhere. The stores already exist (`layoutStore`,
`meterStore`, …); the work is a serialiser and the merge.

The contract, now settled — one namespace, `rfdeck`:

- `GET /v1/profiles/rfdeck` returns parallel maps, with the per-key timestamps in
  their own **`key_meta`** map rather than wrapped into the values:
  `{ namespace, keys: { layout: …, meters: … }, key_meta: { layout: "ISO", … }, updated_at }`.
  That settles the question this plan could not answer by guessing.
- `PUT` takes `{ keys: { … } }` as a **partial merge**: only the keys sent are
  touched, omitted keys are left alone, and a key sent as **`null` is removed**.
  So two machines editing different preferences genuinely cannot clobber each
  other — the property the whole feature depends on.
- PUT **returns the merged document** at 200, same shape as GET, so there is no
  read-back round trip and no guessing what the server decided.
- A first-ever GET is **200 with empty `keys` and `key_meta`**, not a 404. "No
  profile yet" never travels as an error, which keeps it out of the error path in
  the UI.
- The cap is 256 KB measured on the encoded `keys`, over which it is
  **413 `profile_too_large`** — worth surfacing as itself rather than as "failed",
  since the cause is a store that has grown something it should not be syncing.

## The paid tier

### Events, and the alerts configured over them

**The contract landed 2026-09-26.** It replaced a `POST /v1/alerts` relay that was
briefly specified and then retracted, and the corrected model is a better idea:

- **Events are the whole stream of what RFDeck does**, not a curated set of
  alert-worthy moments.
- **Alerts are rules the user configures in the cloud, over those events** —
  product, instance, type and minimum-severity filters. There is **no client call
  to make**: a matching event triggers the notification. Email and webhook are
  free; SMS is the paid channel.
- **Emitting is free-tier**, on any signed-in cloud account.

So RFDeck's whole job here is: emit good events. There is nothing to gate — which
also means `rfdeck.notify-relay` is no longer a gate this application applies.

#### The wire

`POST /v1/events` on the instance link, with the **`events:write`** scope. No site
token — sites turned out to be a portal label RFDeck neither sends nor receives.
Body is one envelope or an array batch of **at most 500**. Response is
`202 { accepted, duplicates, rejected, errors }`. The owner is the token's user and
`source.instance` is registered automatically.

#### The envelope (`event-envelope.md`, v1)

One flat JSON object, and the important rule is that **the envelope keys are
frozen**: anything RFDeck-specific goes inside `attrs`, never as a new top-level
key.

| Field | Req | For RFDeck |
|---|---|---|
| `envelope` | ✔ | Always `1` |
| `id` | ✔ | **ULID, generated by us.** It is the idempotency key — collectors dedupe on `(source.instance, id)`, so a retried batch after a link flap costs nothing |
| `occurred_at` | ✔ | RFC3339 UTC, millisecond, `Z`-suffixed, from our clock |
| `source.product` | ✔ | `rfdeck` |
| `source.version` | ✔ | The build, so behaviour correlates with a release |
| `source.instance` | ✔ | **A stable per-install id we generate on first run.** Explicitly never a MAC address. Needs a new Settings column |
| `source.edition` | | `desktop` \| `server` \| `appliance` |
| `type` | ✔ | `rfdeck.<subject>.<verb>`, lowercase, past tense. We own the namespace, and collectors never reject on an unknown value — so the vocabulary can grow without asking anyone |
| `severity` | ✔ | `debug` \| `info` \| `notice` \| `warning` \| `error` \| `critical`. Wider than RFDeck's internal three, so there is a mapping |
| `seq` | | Optional monotonic per-instance counter, which lets a collector spot a gap. We have a database, so we should keep one — "the events stopped" is exactly the failure a monitoring product should not be silent about |
| `subject` | | `{ kind, id, name? }` — the channel |
| `actor` | | `{ kind, id?, name? }`, `kind` ∈ `user`\|`system`\|`device`\|`external`. Note **absent is not the same as `system`** |
| `attrs` | | Ours, opaque to the collector, ≤ 16 KiB |
| `trace` | | Correlation id for a caused chain |

Whole event ≤ 64 KiB. Two smaller notes: `source.site` exists in the envelope as an
optional *local* operator label, but §0 says RFDeck neither sends nor receives a
site, so we leave it out; and the envelope's field table still describes the cloud
assigning a site from an ingest token, which §0 supersedes.

**There is no published TypeScript emitter** — the packages are PHP and Go. So
RFDeck implements the envelope itself and validates against the published JSON
Schema (`event-envelope-1.json`, draft 2020-12) in its own suite, which is what the
doc asks every product to do anyway.

#### A proposed catalogue

Ours to define, since we own the namespace. Drawn from what the application
already detects, so this is naming existing knowledge rather than new work:

| Type | Severity | Subject |
|---|---|---|
| `rfdeck.channel.dropped_out` / `.recovered` | `warning` / `info` | channel |
| `rfdeck.channel.muted` / `.unmuted` | `info` | channel |
| `rfdeck.battery.low` / `.critical` | `warning` / `critical` | channel |
| `rfdeck.audio.fault_detected` | `warning` | channel — with the kind (dropout, noise, click) in `attrs` |
| `rfdeck.device.went_offline` / `.came_online` | `error` / `info` | device |
| `rfdeck.device.auth_failed` | `error` | device |
| `rfdeck.frequency.changed` | `notice` | channel |
| `rfdeck.intermod.detected` | `warning` | channel |
| `rfdeck.show.went_live` / `.stood_down` | `notice` | show |
| `rfdeck.miccheck.completed` | `info` | show |

The doc's own example is `rfdeck.link.dropout`, which is not past tense; the stated
rule is, so the catalogue follows the rule.

#### Three destinations, and the user chooses

A collector is *whatever accepts the binding*: a local **Imperio**, the Meros cloud
ingest, both, or a script. Which matters more than it sounds — **an Imperio speaks
the same `POST /v1/events`**, so there is one emitter with a list of collectors
rather than two integrations.

- **Local Imperio** — takes events with no internet and no cloud account, and
  relays onward on the account's link if one is configured.
- **Direct to the cloud** — when the instance is linked.
- **Neither** — and this is the part that matches Principle 1 exactly: *"a product
  configured with zero collectors behaves exactly as it does today: no network
  attempts, no degradation."* Observability is opt-in and never load-bearing. The
  local paths RFDeck already has — browser push, webhooks, the alert feed — carry
  on untouched either way.

Emitting must never throw into the application's hot path. A collector being down
is not an RFDeck fault, and a dropout that goes unreported is much better than a
dropout that takes the dashboard down with it.

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

**Built as a public pack** (Meros's recommendation, and the right one): read with
no scope and no account, so an **unlinked rig stays current on band tables**. It
is a data-quality baseline, not a premium feature, and it is not in the paid list
in `docs/EDITIONS.md`. The pack does not exist yet, and the free/paid line remains
a deferred owner call — so build D.7 to read it as public, and if it is ever gated
the only change on our side is attaching the instance link. Not a blocker either
way.

Note this means D.7 is the one cloud feature with **no dependency on the link at
all**, which makes it the cheapest thing in Stage D to ship and the only one that
does something useful for an operator who never signs in.

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

| Phase | What | Status |
|---|---|---|
| D.0 | Internal types, and a fake Meros that rotates refresh tokens and family-revokes a replay | ✅ **Built** |
| D.1 | Instance link (device grant), Cloud settings, status, entitlement cache, the single `entitled()` gate | ✅ **Built** |
| D.2 | Person link — the device grant run browser-side on the *RFDeck Browser* client, joined on `sub` | ✅ **Built** |
| D.3 | Profile sync, last-write-wins per key | ✅ **Built** |
| D.4 | Show files: build, apply, push, pull, version history, conflict resolution | ✅ **Built** |
| D.5 | Events: the envelope, a persisted instance id and sequence, batching, a bounded queue, a collector list | ✅ **Built** |
| D.6 | Regional TV occupancy: signed packs, per-cell cache, cell arithmetic, point-in-polygon, coordinator exclusions, the RF panel | ✅ **Built** |
| D.7 | Device-profile feed, as a public pack with validated overrides | ✅ **Built** — waiting only on Meros publishing the pack |

**Stage D is complete.** What remains is not RFDeck's: Meros has to publish the
device-profile pack (D.7 reads it the moment it exists) and, when it wants to,
turn gating on — which is one constant on each side.

Two things are deliberately *not* built, and both are decisions rather than gaps.
**Imperio** is parked; the emitter takes a list of collectors, so adding one is
configuration rather than a rewrite. And **gating is deferred**, so `entitled()`
returns true for everything while `holds()` reports the truth beside it.

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

Everything RFDeck asked for in
[`docs/CLOUD_CONTRACT_QUESTIONS.md`](CLOUD_CONTRACT_QUESTIONS.md) has been
answered (hand-off §11), and profile sync, document sync and the feed are **built
and tested** on Meros's side. What is left is short:

- **The `RFDeck Browser` `client_id`** — the seeder gained a third client on
  2026-09-25 and has to be re-run per environment. This is the only thing blocking
  D.2, and it is one command.
- **The device-profile pack** — not published yet. D.7 is written to read it as a
  public pack.
- **Imperio — parked (owner, 2026-09-26).** Not a concern for now. The emitter is
  being built around a *list* of collectors rather than one cloud URL, so adding
  an Imperio later is configuration rather than a rewrite. The details to settle
  when it returns are discovery and what token a local one takes.
- Whether the **rotation grace window** lands. Changes nothing we build.

Nothing further on regional data: source settled, sharding answers the sizing
question, the index-and-cells contract is fully specified, and the signature
scheme has been verified against a test vector. It is ready to build as soon as
D.1 lands and an account carries the entitlement.

### Still ours

- Whether the free tier has quotas (show files per account, storage).

### Settled: the privacy tier

Asked and answered (owner, 2026-09-26): **not a concern.** Meros Cloud is not a
public portal, so the fact that RFDeck's channel names are frequently performers'
names does not call for a reduced privacy tier or an operator-facing switch.
Events go out at the ordinary tier with everything else.

Recorded rather than deleted, so it reads as a decision that was taken rather
than a question nobody thought of.

# What RFDeck needed from Meros to write the cloud clients

> **All answered, 2026-09-25** — hand-off §11. Kept as the record of what was
> asked and why, because the reasoning behind each question is what makes the
> answers checkable. The answers themselves live in
> [`CLOUD_INTEGRATION_PLAN.md`](CLOUD_INTEGRATION_PLAN.md), not here.
>
> | Asked | Answer |
> |---|---|
> | **A** Pack signature | A wrapped envelope: verify the server-supplied `signed` string (`MEROSPACK1.<b64url header>.<b64url payload>`) with detached Ed25519, no canonicalisation, and read the payload out of `signed` rather than the convenience field. **Verified here against Meros's test vector** |
> | **B** Profile sync | Parallel maps with timestamps in `key_meta`; partial merge, `null` removes; PUT returns the merged doc; first GET is 200-empty; 413 `profile_too_large` |
> | **C** Document sync | Monotonic integer versions from 1; 409 `version_conflict` carries the head; `body` is a JSON object, 1 MB; account resolved from `X-Meros-Account` or the personal account; soft delete, and a later PUT revives |
> | **D** Alert post | `POST /v1/alerts` and a body shape, both **planned not built**; scope is `alerts:write`, not the `events:write` we guessed, and not yet registered |
> | **E** Device-profile pack | Publish it **public** — an unlinked rig stays current on band tables |
> | **F** Browser client | A dedicated **RFDeck Browser** public client, so the person link can never revoke the instance link |

Companion to `docs/CLOUD_INTEGRATION_PLAN.md`. Every question here is answerable
without RFDeck writing any code first, and each one names the phase it blocks.

## What is being asked for, and why "the shape" matters

Earlier versions of the plan asked for "frozen shapes" or "frozen bodies", which
was unhelpfully vague. Concretely, for each endpoint RFDeck needs:

- the exact method and path,
- the **request** body, with field names and types,
- the **response** body, with field names and types,
- the error responses that are part of normal operation (not just 500s),
- and confirmation that the answer is settled enough to write code against.

"Settled enough" is the whole point: RFDeck can guess a shape and build to it, but
then every guess that turns out wrong is a rewrite, and the ones that fail
silently are worse than the ones that fail loudly.

A worked example of why field layout is not a detail. Profile sync stores "a
person's preferences, last-write-wins **per key**", and the response carries a
per-key `updated_at`. That could be either of these:

```json
// (a) parallel maps
{ "keys": { "layout": {…}, "meters": {…} },
  "updated_at": { "layout": "2026-09-20T…", "meters": "2026-09-21T…" } }

// (b) wrapped values
{ "keys": { "layout": { "value": {…}, "updated_at": "2026-09-20T…" },
            "meters": { "value": {…}, "updated_at": "2026-09-21T…" } } }
```

Both are reasonable. The merge code is different in each, and so is what RFDeck
writes on the way back up. There is no way to pick correctly by guessing.

---

## A. Pack signature verification — blocks D.6 and D.7

**The sharpest question, and it is now the only thing standing between RFDeck and
a working regional-data client.** The public key has been handed over
(`rfdeck-2026a`, verified as a valid 32-byte Ed25519 key). RFDeck still cannot
verify anything with it, because the key is useless without knowing precisely
which bytes it signs.

§8.3 describes a pack response as
`{ pack, version, issued_at, signature, payload | url }`, but §10's examples show
the payload fields at the top level with no `signature` anywhere:

```json
{ "domain":"US-FCC", "channel_plan":"US", "generated_at":"…", "cell":"tn40w076",
  "cell_deg":2, "stations":[ … ] }
```

So:

1. **Where does the signature travel** — a field in the JSON body, or an HTTP
   header?
2. **What exactly is signed?** If the signature is a field inside the same object
   it signs, that object must be reconstructed without it before verifying, and
   the rule for doing so has to be stated.
3. **Over what bytes?** The raw response body exactly as served, or a
   canonicalised form (sorted keys, normalised whitespace, specific unicode
   handling)? If canonical, which canonicalisation.
4. Is it a **detached raw Ed25519 signature**, base64url-encoded? Or a JWS?
5. Is the **index** signed on the same terms as a cell?
6. Does the signature cover the `kid`, so a swapped `kid` is detectable?

This is the one place where getting it subtly wrong is dangerous rather than
merely broken: a verifier that is too lenient accepts packs it should not, and
one that is too strict rejects every valid pack in a venue with no internet. A
worked example — one real pack body plus its signature, and the exact byte string
that was signed — would settle all six questions at once and is worth more than
prose.

---

## B. Profile sync — blocks D.3

Known: `GET` / `PUT` / `DELETE /v1/profiles/{namespace}`, person-scoped,
last-write-wins per top-level key, ~256 KB cap, scopes `profiles:read` /
`profiles:write`.

1. **The GET response envelope** — shape (a) or (b) above, or something else?
2. **Is `namespace` `rfdeck`, or `rfdeck.<kind>`?** The spec allows `product` or
   `product.kind`. RFDeck would use a single `rfdeck` namespace unless there is a
   reason to split.
3. **The PUT request body.** `{ keys: { … } }` — is a key omitted from the body
   left untouched (a partial merge), or removed? RFDeck needs partial-merge
   semantics, so that two machines editing different preferences do not clobber
   each other.
4. **Does PUT return the merged document**, or 204? Returning it saves a round
   trip and removes a guess about what the server decided.
5. **First-ever GET, before any profile exists** — 404, or 200 with an empty
   `keys`? This decides whether "no profile yet" travels as an error.
6. **Over the size cap** — what status and what body? RFDeck should say something
   useful rather than "failed".

## C. Document sync — blocks D.4

Known: `GET /v1/docs/{product}/{collection}` (list), `GET …/{key}` (head or
`?version=`), `GET …/{key}/versions`, `PUT …/{key}` with `{ body, base_version? }`,
`DELETE …/{key}`, 409 on a stale base, scopes `backups:read` / `backups:write`.

1. **What is a version id?** An incrementing integer, a uuid, a content hash?
   RFDeck stores it locally to send back as `base_version`, so its type and
   ordering semantics matter.
2. **The 409 body.** "Returns 409 with the current head" — in what shape? RFDeck
   wants to show the operator a real choice ("the cloud copy changed at 19:04 —
   keep yours, or take theirs?"), which needs at least the head version id and its
   timestamp, and ideally whether the bodies differ.
3. **The list response fields** — "keys, head version, sizes, timestamps" with
   their exact names and types.
4. **Is `body` an arbitrary JSON object, or a JSON string?** If a string, what
   encoding is assumed.
5. **How is the account resolved?** §8.2 says "from the token, or an
   `X-Meros-Account` header". For an instance token minted by the device grant —
   which was approved into one specific account — is the account implicit in the
   token, or must RFDeck send the header? If the header is required, RFDeck needs
   the account id at link time, which changes what the link stores.
6. **Constraints on `key`** — charset, length, case sensitivity. RFDeck would use
   the show's uuid, but a human-readable key would change the "Open from cloud"
   list.
7. **Is `DELETE` a soft delete?** The spec says history is retained per a
   retention policy. Does a deleted key still appear in the list, and can it be
   restored?

## D. Alert post for the notification relay — blocks D.5

The least specified of the four. The *credential* is settled (the instance link's
own OAuth access token, no separate credential), but nothing else is:

1. **The endpoint.** Method and path. Not `/v1/events` with a site token, which
   was confirmed to be a different subsystem.
2. **The request body.** RFDeck has an internal `OutboundAlert` — severity
   (INFO / WARNING / CRITICAL), type (DROPOUT, LOW_BATTERY, …), message, a
   channel id and name, a device id and name, and a timestamp. What does Meros
   want, and under what field names? If there is an existing envelope to conform
   to, naming it is enough.
3. **Which scope.** `events:write` is the plausible candidate from the instance
   scope table, but it is described there as "reporting telemetry or alerts to
   roll-up", which may be a different path. If it is a new scope, it has to be
   registered against the RFDeck clients before RFDeck can request it — a wrong
   guess is a 403 in a venue.
4. **The response**, and whether posting is idempotent on some client-supplied
   id. RFDeck retries when a venue's link flaps, and must not turn one dropout
   into five emails to a stage manager.
5. **Rate limits**, and whether `429` carries `Retry-After`.

## E. One small one — blocks D.7 only

**Is the device-profile pack public or entitled?** §8.3 lists the public packs
(quirk pack, fixture profiles, compatibility read) and names regional data as
private, but does not place RFDeck's device-profile pack in either. If it is
public, D.7 needs no link at all and an unlinked rig can stay current on band
tables — which would be a genuinely good outcome and worth knowing.

---

## What RFDeck already has and is not asking about

So these do not get re-answered:

- Discovery, the device grant, and `meros.co/link` — §2, §3, §9.1.
- CORS on the device, token, userinfo, revoke, discovery and `v1/*` endpoints.
- The entitlement response shape and `rfdeck.*` feature names — §4.
- Refresh-token rotation, family revocation, and the single-writer consequence —
  §9.2.
- Client ids and the scope vocabulary — §9.3. Staging ids are in hand.
- The `rfdeck-2026a` public key, and that one key verifies both entitlements and
  packs — §9.4.
- The regional occupancy design in full: source, sharding on a 2° grid, the index
  and cell payloads, cell-id arithmetic, weekly refresh, multi-region, the
  optional online query — §10. Only the *signature* mechanics (§A above) are
  missing.
- That document and profile sync are ungated today, and pricing is deferred —
  §9.6.

---

## Round 3 — two confirmations, raised 2026-09-26 during the D.4 build

Neither blocks anything: both have a safe default that is already implemented. But
both are assumptions about Meros's behaviour rather than facts, so they are here
rather than left as comments in the source.

### G. Does `content_hash` cover the bytes Meros received, or a re-serialisation? — ✅ ANSWERED

**It was a re-serialisation, and the assumption was wrong.** Meros decoded and
re-encoded the JSON before hashing, so our byte-hash could never have matched and
every 409 would have looked like a real conflict. Two things came back:

1. **The integer version is the authoritative conflict signal, not the hash.** A
   409 means the head advanced past our `base_version`, full stop. RFDeck already
   works this way — the 409 *is* the conflict — and `sameContent` only ever
   downgrades the prompt, never suppresses a conflict. That is now stated
   explicitly at the decision point rather than left implicit.
2. **`content_hash` is now canonical and reproducible** (Meros changed it):
   recursively sort object keys, leave array order alone, encode with unescaped
   slashes and unescaped unicode and no whitespace, then SHA-256.
   `canonicalJson()` in `documents.ts` implements exactly that, and the fake cloud
   hashes the same way so the tests mirror reality rather than agreeing with the
   client for the wrong reason.

One residual limit, handled as a failing test rather than a comment: PHP and
JavaScript do not always render the same float identically (`1.0` versus `1`), so
a document containing a float could hash differently on each side. Show files
contain none, and `showFile.test.ts` now asserts that — so if a future field
introduces one, the test fails and points at `contentHash`.

<details><summary>The original question, for the record</summary>



RFDeck computes the same sha256 locally (`contentHash()` in
`apps/server/src/cloud/documents.ts`) so that a **409 can be recognised as a
non-conflict**: when the head's `content_hash` equals the hash of the document we
were trying to push, two machines are holding the same show and there is nothing
for an operator to arbitrate. That case reports "already saved" and asks nothing.

The assumption is that the digest is over the bytes as sent. If Meros parses and
re-serialises before hashing — different unicode escaping, different key order,
different float formatting — the digests will never agree for the same document.

- **Degrades safely:** a mismatch just means every 409 is treated as a real
  conflict, so the operator gets a question they did not strictly need. It cannot
  lose a show.
- **What would settle it:** either a yes/no, or the `content_hash` Meros computes
  for one known body so we can compare. If it is a re-serialisation, naming the
  canonicalisation would let us match it.

</details>

### H. What does `GET /v1/docs/{product}/{collection}/{key}` actually return? — ✅ ANSWERED

**A stable envelope, and keying off it is now guaranteed rather than inferred:**

```json
{ "key": "show-123", "version": 7, "head_version": 7,
  "content_hash": "…", "size_bytes": 4096, "created_at": "2026-09-26T…",
  "body": { … the show file … } }
```

The document is read from `body`; the siblings are Meros's metadata. `PUT` returns
the same envelope without `body`, at **201**. A missing document or version is
**404 `not_found`**.

Three things changed as a result:

- The liberal wrapper-or-bare fallback is gone. Meros also made the point that
  sniffing for our own top-level keys was the wrong test regardless — a document
  that legitimately contained a `body` key would be misread, and the check would
  pass for years before meeting one.
- `head_version` is now captured. It is the only way to know that an older version
  was fetched on purpose, which matters for a future version-history UI: pulling an
  old version records *that* version, so a later push conflicts rather than
  silently promoting it over a newer head. Promoting one is a deliberate restore
  and should push against `head_version`.
- **404 is an ordinary answer, not a fault.** `DocumentNotFound` is its own type,
  because "this show has never been saved to the cloud" and "the cloud is broken"
  are different things to tell an operator.

<details><summary>The original question, for the record</summary>



§11.C specified the list response, the version-history response and the 409 body,
but not the single-document one. RFDeck currently accepts **either** shape — a
wrapper carrying `body` alongside `version` / `content_hash` / `updated_at`, or a
bare document — and prefers the wrapper when a `body` key is present.

- **Degrades safely:** being liberal costs nothing, and the wrapper is the more
  likely shape given the other responses.
- **The risk if we guessed wrong in a subtler way:** a bare document that happens
  to contain a top-level `body` key would be mis-read. A show file cannot (its keys
  are `showFile`, `exportedAt`, `show`, `players`, `micCheck`), so this is safe for
  RFDeck today — but it would not be safe for a product whose documents can.
- **What would settle it:** the response shape, with field names.

</details>

---

## Round 4 — the finalized tiers, raised 2026-09-26

The tier breakdown settled prices and what is paid. Four things it left open, and
the first materially changes behaviour rather than only copy.

### I. Is the backup cap per *document* or per *version*? — ✅ ANSWERED: per document

**Per document, where a document is keyed by `(account, product, collection, key)`**
(cloud agent, 2026-09-27). Pruning only ever touches that document's own version
history, so two documents at distinct paths never compete.

**No change needed in RFDeck, and no collision.** The two paths were already distinct:

| What | Path | Free tier |
|---|---|---|
| Install snapshot | `config/instance` | keep latest (1) |
| Show file | `shows/{showId}` | keep latest (1) each |

So a free account holds one config backup **and** one show file at the same time, and
on `rfdeck.backup.history` each independently keeps up to 100 FIFO versions.

The cloud agent's example wrote the config path as `config/app` where RFDeck uses
`config/instance`. That is only a key name and the quota is keyed on it either way, so
nothing breaks — **worth one confirmation that Meros has no presentation or rollup that
expects the literal key `app`**, since a mismatch there would be invisible rather than
an error.

The trap they named — putting both under the same collection and key, making them one
document sharing a single version slot so each push prunes the other — is the thing
RFDeck avoided by giving the install snapshot its own collection.

**Original question, kept for the record:**


"Showfile backup — 1 file, always the most recent (no history)" and "FIFO-capped by
tier (free 1 / paid 100)" can be read two ways, and they mean very different things
to a venue:

- **Per version:** a free account can back up every show it has, keeping only the
  latest version of each. 100 versions each when paid.
- **Per document:** a free account can back up **one show, total** — so pushing
  *Hamlet* silently discards the backup of *Wicked*. 100 shows when paid.

A repertory theatre with five productions on a free account would find the second
behaviour astonishing, and RFDeck would be the thing that appeared to lose their
work. If it is per document, RFDeck should say so plainly *before* the second push
rather than after — which is a real feature, and one worth not guessing at.

### J. What are the `rfdeck.*` flag names for the new paid features? — ✅ ANSWERED

Entitlements are consumed by feature flag, and the tier breakdown names features in
prose. `rfdeck.regional-data` is documented (§4) and spectrum data still maps to it.
The rest have no flag named: backup history, RF environment history, post-show RF
reports, online inventory listing, and the three Pro-only remote features. RFDeck
will not invent names for these — a guessed flag silently never matches, which
presents as a paid feature that is simply missing.

### K. Which tier is profile sync in? — ✅ ANSWERED

**Always free tier** (owner, 2026-09-26). It is not named in Meros's breakdown, which
is an omission rather than an exclusion. Nothing in RFDeck changes: profile sync was
never gated, and the account menu says nothing about tiers.

### L. Does gating switch on now? — ✅ ANSWERED

**Yes** (owner, 2026-09-26). `GATING_ENFORCED` is now `true` on both sides.

One consequence worth expecting rather than discovering: **spectrum data will now go
dark on any account without an active `rfdeck` entitlement**, including the staging
test account unless it has been given one. That is the gate working, not a fault —
the RF panel says which of the reasons applies rather than showing an empty list, and
`holds()` still reports the truth beside the gate.

Installs with no cloud configured, and linked ones that are not signed in, are
deliberately *not* gated: a paywall appearing because somebody has not signed in
would be a paywall nobody asked for, and an unlinked rig has no cloud data to
withhold in the first place.

### J-bis. The exact flag strings RFDeck needs — ✅ ANSWERED

Answered authoritatively (cloud agent, 2026-09-26) and implemented verbatim in
`apps/server/src/cloud/features.ts`, mirrored in `apps/web/src/hooks/useEntitled.ts`.
Quoted rather than paraphrased, because a flag string that does not match silently
never matches.

**Free**

| Capability | Flag |
|---|---|
| Whole-install configuration backup | `rfdeck.backup.config` |
| Show-file backup (most recent only) | `rfdeck.backup.showfile` |
| Email / webhook alerts | `rfdeck.alerts.basic` |
| Profile / preference sync | `rfdeck.profile` |

**Individual (paid)**

| Capability | Flag |
|---|---|
| Backup history, 100 versions FIFO | `rfdeck.backup.history` |
| SMS alerts | `rfdeck.alerts.sms` |
| Spectrum / TV-occupancy packs | `rfdeck.spectrum` |
| RF environment history | `rfdeck.rf.history` |
| Post-show RF reports | `rfdeck.rf.reports` |
| Online inventory listing | `rfdeck.inventory` |

**Paid, and only on an RFDeck Pro device**

| Capability | Flag |
|---|---|
| Remote restore / provisioning | `rfdeck.remote.restore` |
| Remote UI / control | `rfdeck.remote.control` |
| Attributed change history / audit | `rfdeck.audit` |

**Team add-on, account-level**

| Capability | Flag |
|---|---|
| Fleet view | `rfdeck.team.fleet` |
| Alert routing | `rfdeck.team.alert_routing` |
| Member management | `rfdeck.team.members` |

Resolved along with it:

- `rfdeck.regional-data` is **dead** and replaced by `rfdeck.spectrum`. RFDeck no
  longer references the old name anywhere.
- `rfdeck.notify-relay`, `rfdeck.battery-prediction` and `rfdeck.cross-venue-rf` from
  §4's examples correspond to nothing in the finalized tiers. RFDeck has stopped
  carrying them.
- Only the `TEAM_*` flags and `rfdeck.alerts.sms` are things Meros acts on rather
  than RFDeck — SMS is a delivery channel, and the team flags describe portal
  features. `GATED_BY_RFDECK` in `features.ts` names the five RFDeck actually checks,
  so nobody adds a gate for a flag that was never meant to control anything here.

**One consequence to expect rather than discover.** The names are pinned but the
Meros-side strategy that emits them is not built yet, so today an account receives
only the spectrum entitlement. With gating enforced, that means **the free-tier
features are currently gated off too** — configuration backup and show-file backup
both read as "your account does not include this" until the strategy ships. That is
the two changes landing in the wrong order rather than a fault in either, and it
resolves itself the moment Meros starts issuing the free flags.

### M. Does the show-file / config split need anything cloud-side? — ✅ ANSWERED, NO

RFDeck now writes two different documents for two different jobs:

- `shows/{showId}` — a **portable** production: cast, channel assignments, quick
  changes, mic-check state. Carries a show to another venue and deliberately does not
  touch the local inventory, because two venues have different hardware.
- `config/instance` — the **whole install**: inventory, roster, audio routing, alert
  thresholds, network and discovery settings. One document per account, so a restore
  has one obvious thing to take.

Nothing is needed from Meros. `/v1/docs/{product}/{collection}/{key}` already
namespaces by collection, `config` is an ordinary collection name, and the two
separate free flags (`rfdeck.backup.config`, `rfdeck.backup.showfile`) confirm the
split was anticipated on that side too.

The only thing still open that touches it is **question I** — whether the FIFO cap is
per document or per version. It matters more for `config` than for shows, because
`config/instance` is a single key that is rewritten repeatedly: per-version means a
free account keeps the latest snapshot and that is exactly right, whereas per-document
would mean backing up the install competes with backing up a show for the same slot.

### N. The inventory fields RFDeck holds, for the online listing endpoint — ✅ BUILT

**Answered and shipped on both sides** (cloud agent, 2026-09-27). `GET`/`PUT
/v1/inventory/rfdeck`, scopes `inventory:read` / `inventory:write`, account-private,
paid on an active `rfdeck` entitlement. RFDeck's client is `cloud/inventorySync.ts`.

Three things about the contract that shaped the client:

- **The push is a reconcile.** `PUT` sends the full set and the cloud drops anything
  absent, so RFDeck is the source of truth. Right direction for this data — the rig
  knows what hardware exists — but it means two rigs publishing to one account each
  erase the other, so publishing is an operator action and never a background sync.
- **There is no pull, by choice.** Meros offers `GET`, and RFDeck uses it only to show
  the operator what landed. A listing that could rewrite the local inventory would be
  a second, quieter path to the destruction `configBackup.restore()` makes them
  confirm.
- **Unknown fields are ignored rather than rejected**, so RFDeck can add a column
  before Meros mirrors it. The `device_type` and `band_source` enums are validated
  though, and a 422 refuses the whole batch naming one field — so a row with an
  unexpected value is sent as null rather than costing a push of two hundred good ones.

**The new scopes do not exist on already-linked installs.** A token minted before
2026-09-27 carries neither, and Meros answers `403 insufficient_scope`. RFDeck tells
that apart from `403 not_entitled` and says "unlink and link again" rather than
sending the operator to a billing page.

The field list below is what was supplied, and is kept for reference.


Asked for by the cloud agent, who declined to guess the payload — correctly. This is
what `InventoryDevice` actually holds, as of 2026-09-26:

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | RFDeck's own identifier. Stable; channel assignments are keyed on it. |
| `name` | string | Operator-assigned label, e.g. "Rack 2 SR". |
| `manufacturer` | string | "Sennheiser", "Shure", "Wisycom". |
| `model` | string | "EW-DX EM 2", "ULXD4Q", "AD4Q". |
| `deviceType` | `input` \| `output` | Receiver vs IEM transmitter. |
| `serial` | string \| null | Reported by the device, not always present. |
| `mac` | string \| null | Reported by the device. |
| `firmware` | string \| null | Reported by the device. |
| `band` | string \| null | e.g. "G50", "470-608". |
| `bandSource` | string \| null | `reported` or `manual` — whether the band was read or typed. |
| `carrierMinKHz` / `carrierMaxKHz` / `carrierStepKHz` | int \| null | The tuning range, in kHz. |
| `dense` | bool | Whether the unit supports dense/link mode. |
| `location` | string \| null | Free text: "SR wing", "FOH", "truck 2". |
| `notes` | string \| null | Free text. |
| `active` | bool | Whether RFDeck polls it. |
| `disabledSlots` | string | Comma-separated slot numbers switched off on a multi-channel unit. |
| `addedAt` | timestamp | When it entered this install's inventory. |
| `ip` / `port` | string / int | Venue-local addressing. |

There is no condition/status field and no asset id — RFDeck tracks hardware it can
talk to, not an asset register. If the listing wants either, they are new fields and
RFDeck would need to add them to the inventory UI first.

**`password` exists on the row and is not in this list.** Not on secrecy grounds —
a listing simply has no use for it, and neither does the event stream. It *is* in the
configuration backup, where dropping it would restore a rig whose devices silently
fall out. See the note on principle 7 in the integration plan.

**Every other field can be sent, including `serial`, `mac`, `ip` and `port`**
(owner, 2026-09-26). An earlier draft of this section recommended omitting the
identifying fields from a shareable variant; that was answering a question nobody
asked. **There is no public or client-facing view** — everything in a Meros account
is private by its nature, so the listing is account-private and there is no second,
redacted shape to design.

### O. The RF event prefix and attrs keys — ⚠️ WAS BROKEN, NOW FIXED

The cloud agent asked (2026-09-27) for the exact event-type prefix RFDeck's RF events
use, since Meros selects them by namespace prefix —
`identity.rollup.rf_event_prefix`, default `rfdeck.rf` — and said *"the features work
today against `rfdeck.rf.*`"*.

**They did not.** RFDeck emitted no event with that prefix at all. The RF events were
spread across four namespaces:

| Was | Now |
|---|---|
| `rfdeck.channel.dropped_out` | `rfdeck.rf.dropout` |
| `rfdeck.channel.recovered` | `rfdeck.rf.recovery` |
| `rfdeck.frequency.changed` | `rfdeck.rf.frequency_changed` |
| `rfdeck.intermod.detected` | `rfdeck.rf.intermod_detected` |
| `rfdeck.intermod.cleared` | `rfdeck.rf.intermod_cleared` |
| `rfdeck.audio.fault_detected` | `rfdeck.rf.audio_fault` |

No single prefix covered that spread, so **RF environment history and post-show RF
reports were matching nothing** while appearing wired up on both sides. Renamed rather
than asking Meros to widen the selector, because a prefix that has to enumerate four
namespaces is not a prefix. Nothing has launched, so there are no existing alert rules
to break.

`alertEvents.test.ts` now pins the contract in both directions, since each failure is
silent: every RF signal must land under `rfdeck.rf.`, and battery, mutes, connectivity,
show lifecycle and inventory must stay out of it — the prefix is a filter, and sweeping
those in would make an RF report a log of everything.

#### The attrs keys, per type

All types also carry `attrs.message`, a human sentence that reads on its own because it
is what reaches an email or a text.

| Type | Severity | `subject` | Other `attrs` |
|---|---|---|---|
| `rfdeck.rf.dropout` | `warning` | `channel` | `rfLevelA`, `rfLevelB` (int, dBm-ish as the receiver reports), `deviceId` |
| `rfdeck.rf.recovery` | `info` | `channel` | `rfLevelA`, `rfLevelB`, `deviceId` |
| `rfdeck.rf.frequency_changed` | `notice` | `channel` | `fromKHz`, `toKHz` (int, kHz), `deviceId` |
| `rfdeck.rf.intermod_detected` | `warning` | *none* | `hits` (int), `sourceCount` (int), `worst` (object: `formula`, `victimName`) |
| `rfdeck.rf.intermod_cleared` | `info` | *none* | `hits` (0), `sourceCount` |
| `rfdeck.rf.audio_fault` | from the detection | `channel` | `trigger`, `rfLevelA`, `rfLevelB`, `deviceId` |

`subject` is `{ kind: 'channel', id, name }` where `id` is the stable channel key
(`<device uuid>:<slot>`) — deliberately the channel rather than the device, because a
rule is most likely to be scoped to one performer's mic. The device rides in `attrs`.

**Two honest caveats about what actually fires today:**

1. **`rfdeck.rf.audio_fault` never fires yet.** Its signal is `rf:detection`, whose only
   trigger is `RF_DROPOUT`, and the handler skips that one because `rf:event` already
   reported it — mapping both would emit every dropout twice, and since each emit mints
   its own ULID a collector's dedupe could not catch it. Audio-signature triggers are
   future work (`schema.prisma`: *"RF_DROPOUT for now; audio-signature triggers
   later"*). The event is wired and named correctly so it starts flowing the day that
   detection lands; **do not build a presentation that assumes it is populated.**
2. **`rfdeck.rf.intermod_*` carries no `subject`.** Intermodulation is a property of the
   whole plan rather than one channel. `attrs.worst.victimName` names the affected
   channel when there is one, but there is no subject id to group on.

#### Still outside the prefix, deliberately

`rfdeck.battery.low`, `rfdeck.battery.critical`, `rfdeck.channel.muted`,
`rfdeck.device.went_offline`, `rfdeck.device.came_online`, `rfdeck.device.auth_failed`,
`rfdeck.device.firmware_changed`, `rfdeck.device.connection_unstable`,
`rfdeck.show.went_live`, `rfdeck.show.stood_down`, `rfdeck.inventory.{added,changed,removed}`,
and `rfdeck.alert.<lowercased type>` as the fallback for an unmapped alert.

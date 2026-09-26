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

### I. Is the backup cap per *document* or per *version*?

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

### J. What are the `rfdeck.*` flag names for the new paid features?

Entitlements are consumed by feature flag, and the tier breakdown names features in
prose. `rfdeck.regional-data` is documented (§4) and spectrum data still maps to it.
The rest have no flag named: backup history, RF environment history, post-show RF
reports, online inventory listing, and the three Pro-only remote features. RFDeck
will not invent names for these — a guessed flag silently never matches, which
presents as a paid feature that is simply missing.

### K. Which tier is profile sync in?

It is not named in either list. The free tier says "app config / settings backup",
which *might* be the person-scoped profile sync built in D.3, or might be something
else entirely — RFDeck has both a person profile and server settings, and they are
different things with different scopes. Phase 8 previously called profile sync a free
loss-leader, so free is the likely answer; confirmation would settle whether the
account menu should say anything about tiers at all.

### L. Does gating switch on now?

`GATING_ENFORCED` is still `false` on both sides, per the earlier deferral, so every
feature is granted. With tiers and prices finalized, is that still right? RFDeck will
not flip it unprompted: doing so would start withholding features from testers, and
turning it on is one constant on each side whenever the answer is yes.

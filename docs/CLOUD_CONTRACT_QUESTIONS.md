# What RFDeck still needs from Meros to write the cloud clients

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

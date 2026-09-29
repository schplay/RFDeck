# Manifold integration — plan

What RFDeck builds for manifold, and what it must not break. Companion to
`docs/manifold handoff.md`, which is manifold's side of the same contract.

Manifold is a **client** of RFDeck. RFDeck stays the source of truth for wireless
devices; the console shows what RFDeck last said and writes back only what an
operator asked for. Nothing here changes that direction.

## Verified against the code, not assumed

The hand-off was written against `5242955`. Each claim below was checked before
planning against it:

| Manifold's claim | State in the code |
|---|---|
| Socket.io polling transport must stay enabled | ✅ No `transports` option is set, so both polling and websocket are offered. **Undocumented and easy to break** — see M.0 |
| Tokens are in-memory only | ✅ `pinAuth.ts`, `const tokens = new Map<string, number>()`. Lost on restart |
| `reauthHours` default 0 means a token never expires | ✅ `expiry = reauthHours > 0 ? … : Infinity` |
| A channel's name comes from the receiver | ✅ `DeviceManagerService`, `name: rxData.name?.trim() ? rxData.name : fallbackName`. Nothing persists an operator's own name |
| No `GET /channels` or `GET /alerts` | ✅ Neither route exists. `DELETE /alerts` does |
| Channel id is `<inventory row id>:<slot>` | ✅ Stable across restarts and address changes; detections key on the same id |

## M.0 — Record what manifold depends on — **S**

Nothing to build; things to stop being broken by accident.

Manifold's engine has an HTTP client and no WebSocket client, so it connects over
Engine.IO **long polling**. That works today only because no `transports` option
is set. Someone tightening the socket config to `['websocket']` — a normal-looking
performance change — would disconnect the console with no error on RFDeck's side.

- A comment at the `new Server(...)` call saying polling is a contract, not a
  default.
- The same for the three unit conventions, which are genuinely easy to get wrong:
  telemetry `frequency` is **kHz**, `channel:frequency` control takes **Hz**,
  coordination routes take **kHz**.

## M.1 — Writable channel display name — **M** — *blocks manifold W13.4*

A console operator types "Vox Lead"; RFDeck shows whatever the receiver reports.
The two cannot be reconciled today because RFDeck keeps no name of its own.

**Storage.** A new table keyed by channel id, not a column on `InventoryDevice`:
a channel is a slot on a device, several to a row, and the id already exists as a
stable key that survives address changes and firmware updates.

```prisma
model ChannelSetting {
  channelKey  String  @id      // "<inventory row id>:<slot>"
  displayName String?
  updatedAt   DateTime @updatedAt
}
```

**Read path.** `Channel.name` becomes `displayName ?? <receiver's name> ?? fallback`.
Manifold reads `name` and needs no change — which is the point of overlaying the
existing field rather than adding a parallel one it would have to learn about.

RFDeck's own UI does want both, so the telemetry object also gains
`sourceName` — the receiver's own label, unchanged. Additive, so no existing
consumer is affected.

The overlay is applied where the `Channel` is assembled, from an in-memory map
loaded at startup and updated on write. Telemetry is built per packet per channel;
a database read there would be a query per channel per 500 ms.

**Write path.** `PUT /channels/:id/display-name { displayName: string | null }`,
behind the same auth as every other write. `null` clears it and the receiver's
name returns. The response is the updated `Channel`.

**Live update.** The write emits `channel:telemetry` for that channel immediately
rather than waiting for the next poll. Manifold's model is "a write shows up when
telemetry comes back changed", so this keeps that true without the console having
to special-case its own writes.

**Deliberately not in scope:** renaming the device on the hardware. RFDeck holds a
name beside the receiver's, it does not overwrite it.

**Also check:** alert messages currently use the channel name, so they should use
the display name too — an alert that names a channel differently from the strip it
came from is worse than no name.

## M.2 — Tokens that survive a restart — **M**

Every RFDeck restart logs the console out, and with `reauthHours` at its default a
token is otherwise meant to last forever. The two do not agree.

**Store a hash, never the token.** A token is a bearer credential: anything that
can read the row can log in. The DB already holds device passwords encrypted and a
PIN as a bcrypt hash, so a plaintext token table would be the weakest thing in it.
SHA-256 of the token is enough — it is high-entropy random, so a hash is not
guessable the way a password is, and RFDeck only ever needs to check equality.

```prisma
model AuthToken {
  tokenHash String   @id
  expiresAt DateTime?   // null = never, matching reauthHours = 0
  createdAt DateTime @default(now())
  lastSeenAt DateTime?
}
```

- `issueToken` writes the hash; `validateToken` looks it up and keeps the
  in-memory map as a cache so the hot path stays synchronous.
- Expired rows are deleted on validation and swept at startup.
- `revokeAll` clears the table as well as the map — it already exists and must keep
  meaning what it says.
- A restart loads nothing eagerly; the first request with a token resolves it.

**Worth deciding explicitly:** whether a persisted token should outlive a PIN
change. It should not — changing the PIN is how an operator revokes access, so
setting a new PIN clears the table.

## M.3 — Snapshot routes — **S** — *manifold says not needed today*

`GET /channels` and `GET /alerts`, returning what the socket would replay on
connect. Cheap, because both already exist in memory: `channelCache` in the device
manager and the alert log beside it.

Worth building even though manifold does not need it: a REST-only client, a health
check, and a support bundle all currently have to open a socket to see what RFDeck
thinks is connected. Last, since nothing is waiting on it.

## Order

M.0 first — it is a comment and a test, and it protects the contract while the
rest is being built. Then M.1, which is what manifold is blocked on. M.2 next.
M.3 when the rest is done.

## What manifold should be told changed since `5242955`

None of it breaks the contract, but the hand-off should not go stale:

- **New alert type `DEVICE_UNMATCHED`** — a discovered receiver that could not be
  matched to an offline inventory row. Manifold reads the whole `Alert`, so this
  arrives as data, but a console showing alert types by name will meet a new one.
- **New socket event `inventory:updated`** — emitted when the inventory is replaced
  wholesale by a configuration restore. Manifold already refetches `/inventory` on
  `device:*`; this is one more trigger worth handling the same way.
- **`Player` gained `stageX` / `stageY`** — additive, for the stage plot. Manifold
  reads named fields, so nothing to do.
- **Webhooks removed** from RFDeck entirely; they are a Meros Cloud feature now.
  Manifold does not use them.
- **Discovery and device-sync were substantially reworked** (address re-linking,
  probe pacing, socket buffers). No externally visible contract changed, but
  telemetry on a large network should be steadier than it was.

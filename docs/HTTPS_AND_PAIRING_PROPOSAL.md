# HTTPS everywhere, and how Manifold knows it is talking to the real RFDeck

**Proposal, 2026-10-03. Decided and mostly built; see the status note below.** Raised because the Manifold
cloud-login flow will carry a Meros **login token** over the RFDeck ↔ Manifold
connection, and that token redeems into a **one-year refresh token** for the
user's Meros account. David's instruction: *"we must address this and securely at
that; it must use HTTPS."* Refusing the endpoint over plain HTTP is not enough —
RFDeck has to actually provide HTTPS, in every deployment shape.

Three questions, answered in order: how every install serves HTTPS, how Manifold
authenticates the server it reached, and what happens to the traffic that works
today.

**Status.** All three are decided. The HTTPS work is built - certificates
generated and persisted per install with a stable key, the desktop sidecar
included, and Electron pinning its own. Manifold is building its side of the
pinning. Two things in the first draft were proposed and then rejected and are
kept here as rejected, because both are reasonable ideas somebody will have
again: a certificate-bound PIN proof, and publicly trusted per-install
certificates.

## Where RFDeck stood before this work

| Deployment | Scheme before | Why |
|---|---|---|
| Scripted Ubuntu install | **HTTPS** | `scripts/install-ubuntu.sh:498` generates a self-signed certificate with SANs for every address the machine answers on, and sets `TLS_CERT`/`TLS_KEY` in the systemd unit. Port 80 serves 301s |
| Appliance | **HTTPS** | Ships with Server pre-installed, so it inherits the above |
| Desktop (Electron) | **plain HTTP on 0.0.0.0:3000** | `apps/desktop/src/main.ts:152` sets `PORT` and no TLS variables, so `loadTlsConfig()` returns null. The sidecar deliberately serves the LAN, not just its own window |
| Manual install | **plain HTTP** unless the operator sets both variables | `apps/server/src/tls.ts:22`: "Returns null to mean 'serve plain HTTP', which stays a valid deployment" |

So TLS is a configuration outcome, not a property of the product. Two of the four
shapes serve the venue network in clear text, and Manifold's `x-rfdeck-token`
already crosses that way.

That has been an acceptable trade for the PIN token: it is install-scoped,
revocable locally, and worthless off the venue LAN. **A Meros login token is not
in that category.** It converts into a year of access to somebody's cloud
account, and the venue network is where RFDeck lives.

## 1. HTTPS in every deployment

**Move certificate provisioning out of the installer and into the server.** On
start, when `TLS_KEY`/`TLS_CERT` are not configured, RFDeck generates its own key
and self-signed certificate, persists them beside the database, and serves HTTPS.
`loadTlsConfig()` returning null stops meaning "serve HTTP" and starts meaning
"make one".

- **One code path, four deployments.** The desktop build, a manual install and a
  `git clone` all get HTTPS without anybody configuring anything, which is the
  only way "every deployment serves HTTPS" can be true. The installer keeps
  generating its certificate — an explicitly configured one always wins — but it
  stops being the only thing standing between RFDeck and plain text.
- **SANs:** every local IPv4 and IPv6 address, the hostname, `<hostname>.local`,
  `localhost`, `127.0.0.1`, `::1`. Regenerated when the address set changes, which
  on DHCP it will.
- **The private key is generated once and kept.** Certificate regeneration reuses
  it, so the public-key fingerprint survives an address change. This matters for
  §2: a pin that broke every time the venue's DHCP lease moved would be a pin
  nobody keeps.
- **Implementation:** generate in-process rather than shelling out to `openssl`,
  which a Windows desktop machine is not required to have. Node's
  `crypto.generateKeyPairSync` makes the key; the certificate needs a small
  library (`selfsigned`, or `node-forge` directly) since Node cannot assemble an
  X.509 certificate itself. That is a new dependency and worth naming as one.

**Also required before the desktop can serve HTTPS:** the sidecar is spawned with
`--tls-min-v1.0` (`apps/desktop/src/main.ts:145`), which exists for EW-DX
receivers that negotiate ancient TLS *outbound*. It is a process-wide minimum, so
it would apply to RFDeck's own *inbound* server too — a desktop install would
accept TLS 1.0 from any client on the network. That flag has to be removed and
the EW-DX exception scoped to the outbound agent in `SSCClient` instead, or
adding HTTPS here would be adding it badly.

## 2. How Manifold authenticates RFDeck

The hard part, and the reason a certificate alone is not an answer: **a
self-signed certificate proves possession of a key, not identity.** Accepting any
self-signed certificate is indistinguishable from accepting a man in the middle.

### What does not work here

- **A public CA (Let's Encrypt, ACME HTTP-01/TLS-ALPN).** A CA attests a *name*,
  and RFDeck has no stable public name. It sits on a DHCP address on a private
  network, frequently with no inbound internet at all. There is nothing to prove.
- **Trusting any self-signed certificate.** This is the status quo for browsers
  and it is exactly what David is objecting to.

### Publicly trusted certificates: ruled out (decided 2026-10-03)

An earlier draft proposed a **Meros-issued per-install certificate** - a name under
a Meros-operated zone resolving to the install private address, issued by ACME
DNS-01, delivered over the cloud link - as a later track to make browsers show no
warning. That is how Plex and Home Assistant solve the same problem.

**Dropped.** These products run on customers' own local networks, not on Meros
domains, so putting a Meros name in front of somebody's rig to satisfy a browser
is the wrong shape. It also required a cloud link, which free RFDeck does not have
at all. **Self-signed is the only option, and the browser warning stays.**

That makes key pinning the whole of certificate identity here rather than a
stopgap for machine clients while browsers waited for something better.

### Decided: pin the public key, silently, on first connect

Manifold is a program, not a browser, so it can do the thing browsers cannot:
remember a specific key. Pinning is **stronger** than a CA here, not weaker — a
CA would attest a name RFDeck does not have, while a pin attests *this install*,
which is what the operator actually means.

Pin the **SPKI SHA-256 fingerprint** (the public key), not the certificate.
Certificate regeneration on an address change then keeps the pin valid, and only
a genuine key change breaks it — which is the event that *should* break it.

**Establishing the pin — decided 2026-10-03: silently, on first connect.**

Manifold accepts RFDeck's certificate the first time it connects and pins the key
with no prompt, no displayed code and no approval. If a different key ever appears
it refuses the connection and warns. Nothing is shown in normal use.

The alternative, considered and rejected, was for the operator to confirm a
displayed fingerprint before Manifold pinned it. That catches an attacker who is in
the middle at the very first connection, which silent pinning does not — but it is
an approval step, and a Manifold instance pointed at a free RFDeck with no cloud
connection has to simply work.

**So the trade, stated once rather than buried:** the first connection is trusted
blind. An attacker already in the middle at that moment is pinned instead of the
real server, and nothing afterwards would notice. What pinning buys is every
connection after it — a key that changes later is refused, which covers a server
being impersonated on a network Manifold has used before. For a tool whose whole
premise is a trusted show LAN, that is a reasonable place to draw the line, and it
is drawn deliberately rather than by omission.

The fingerprint stays visible in RFDeck's Settings, at startup and from the
installer. It is not part of any flow and nobody is asked to look at it; it is
there for an operator who wants to check, and for diagnosing a refusal after a key
change.


**A PIN binding was also built here, and removed.**

It bound the PIN exchange to the certificate, so that an operator who skipped the
fingerprint check was still protected from anyone who did not know the PIN:
`HMAC-SHA256(scrypt(pin, salt), fingerprint)`, keyed on the hash the server
already stores, with the salt published at `/api/auth/pin-params`.

It was removed because it had no consumer, not because the mechanism was unsound.
**The PIN is RFDeck's auth for every client** - a browser, a Manifold console,
anything else reaching the API or the socket from another machine - and the bare
PIN form of `POST /api/auth/login` is permanent, with no deprecation. So Manifold
has no reason to send a proof, and a browser cannot compute one without a
dependency, Web Crypto having no scrypt. Unreachable code on an authentication path
is worse than none.

(An earlier draft of this paragraph said the PIN "gates RFDeck's UI" and "was never
meant for server-to-server callers". That was a premise under consideration for a
day and rejected; it is recorded here only because it is the reason the commit that
removed the proof is worded the way it is.)

A per-device credential issued at pairing was proposed as the replacement and
**rejected**: it is an approval step, and a console pointed at a free RFDeck with
no cloud connection should just work. So there is nowhere left for the binding to
move to - its objection, that a four-digit secret is too small to key a MAC
with, stands, and there is no higher-entropy secret in this system to key it with
instead. The mechanism is simply not needed.

**Once pinned:** Manifold refuses any certificate whose SPKI does not match, and
reports the mismatch as a security failure rather than a connection error. A key
change is a real event - a reinstalled server, a new machine, or an attack - so
recovering from one means clearing the pin deliberately, not retrying.

This also composes with the PKCE sequence meros.co has confirmed: with RFDeck
holding the `code_verifier` and never transmitting it, an intercepted login token
cannot be redeemed by whoever intercepted it. Pinning stops the interception;
PKCE makes a successful interception useless. Neither alone is sufficient for a
credential of this value.

## 3. What happens to traffic that works today

- **All API and Socket.IO traffic moves to HTTPS.** The HTTP listener keeps
  serving 301 redirects for bookmarks and typed addresses and nothing else: no
  API, no socket handshake, no upgrade. A redirect is correct for a browser and
  useless to an API client, which is the point — an API client should fail loudly
  rather than be silently downgraded.
- **Loopback is HTTPS too - built differently from this proposal.** The plan here
  was to keep plain HTTP on loopback, leaving the desktop window untouched. It was
  built as a single HTTPS listener instead, with Electron trusting the sidecar's
  certificate pinned to its exact fingerprint, because a plaintext API listener is
  reachable by any local process and the window does not need one once it trusts
  its own certificate. The certificate-error handler is scoped to loopback and to
  that one fingerprint, so it never becomes "trust everything".
- **`x-rfdeck-token` is unchanged**, and keeps working exactly as it does now.
  Only the scheme it crosses changes; the call that issues it is unchanged too.
- **`POST /api/auth/login` is unchanged and permanent.** It was going to become a
  channel-bound proof, which would have been breaking for Manifold; that is
  withdrawn. A per-device credential was proposed instead and rejected. So the
  Manifold contract does not change at all, and `docs/manifold handoff.md` is
  correct as written.
- **Micboard displays** connect without a PIN and are marked read-only
  (`apps/server/src/plugins/socket.ts`). They are unaffected beyond the scheme, and
  they do not pair, so they do not pin.

## What this needs from others

- **Manifold:** pin the SPKI fingerprint on first connect, compare it on every
  connection afterwards, and refuse with a warning if it changes. No pairing UI
  and nothing shown in normal use. Authentication is the PIN token, as it already
  is. Manifold is building this now.
- **David:** nothing outstanding. The PIN, the gate, the certificate question and
  the HTTPS work are all settled.
- **meros.co:** nothing. This is below the cloud contract.

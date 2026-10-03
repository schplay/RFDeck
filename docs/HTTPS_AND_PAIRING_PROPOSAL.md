# HTTPS everywhere, and how Manifold knows it is talking to the real RFDeck

**Proposal, 2026-10-03. Nothing here is built.** Raised because the Manifold
cloud-login flow will carry a Meros **login token** over the RFDeck ↔ Manifold
connection, and that token redeems into a **one-year refresh token** for the
user's Meros account. David's instruction: *"we must address this and securely at
that; it must use HTTPS."* Refusing the endpoint over plain HTTP is not enough —
RFDeck has to actually provide HTTPS, in every deployment shape.

Three questions, answered in order: how every install serves HTTPS, how Manifold
authenticates the server it reached, and what happens to the traffic that works
today.

## Where RFDeck stands now

| Deployment | Scheme today | Why |
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

### What would work for browsers, later

A **Meros-issued per-install certificate**: each linked install gets a name under
a Meros-operated zone — `<install-id>.rfdeck.meros.co` — whose DNS record points
at the install's private address, with the certificate issued by ACME **DNS-01**
(which needs no inbound reachability) and delivered to the install over its
existing cloud link. This is how Plex and Home Assistant solve the same problem,
and it is the only approach that makes a browser show no warning.

**It cannot be the mechanism for Manifold**, because it requires a cloud link and
internet access at setup, and RFDeck must work fully unlinked — free RFDeck needs
no cloud account at all. Recommend it as a **separate track for browser UX**, not
as part of this.

### Recommended: pin the public key at pairing, with a human check

Manifold is a program, not a browser, so it can do the thing browsers cannot:
remember a specific key. Pinning is **stronger** than a CA here, not weaker — a
CA would attest a name RFDeck does not have, while a pin attests *this install*,
which is what the operator actually means.

Pin the **SPKI SHA-256 fingerprint** (the public key), not the certificate.
Certificate regeneration on an address change then keeps the pin valid, and only
a genuine key change breaks it — which is the event that *should* break it.

**Establishing the pin — two mechanisms, both cheap, layered:**

**(a) Displayed fingerprint, confirmed by the operator.** At pairing, RFDeck shows
a short form of its fingerprint in its own UI (and prints it at startup, and the
installer prints it). Manifold shows the fingerprint it received. The operator
confirms they match, and Manifold pins it. This is SSH's model with the comparison
made easy, and its security does not depend on PIN entropy at all. **This is the
trust anchor.**

**(b) was built and then removed. Superseded 2026-10-03.**

It bound the PIN exchange to the certificate, so that an operator who clicked
through (a) was still protected from anyone who did not know the PIN:
`HMAC-SHA256(scrypt(pin, salt), fingerprint)`, keyed on the hash the server
already stores, with the salt published at `/api/auth/pin-params`.

It was removed because the premise was wrong, not because the mechanism was. **The
PIN gates RFDeck's UI** - it is how an install with no user accounts stops a
stranger's browser - and it was never meant for server-to-server callers. So (b)
was built for Manifold, which should not be using the PIN at all. With browsers the
only PIN users, and a browser unable to compute scrypt without a dependency since
Web Crypto has none, it had no consumer left; unreachable code on an
authentication path is worse than none.

What replaced it: nothing on the PIN path. The browser keeps the bare PIN over
HTTPS, which the browser's own certificate handling already protects, now with a
per-address throttle because four digits is 10,000 candidates. Manifold is to be
issued its own credential at pairing, which is not decided yet.

**The idea belongs in that pairing exchange, where the objection to it disappears.**
A pairing code can be 128 bits, so the offline brute force that makes a four-digit
PIN's binding weak is unavailable there. The mechanism was sound; it was attached
to the wrong secret.

(a), the fingerprint the operator confirms, stands unchanged and is the anchor.

**After pairing:** Manifold refuses any certificate whose SPKI does not match the
pin, and reports a mismatch as a security failure needing re-pairing rather than
as a connection error. A pin change is a real event — a reinstalled server, a new
machine, or an attack — and the operator has to be the one to accept it.

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
- **Loopback keeps plain HTTP**, because it never reaches a network interface. The
  desktop window talks to its own sidecar this way and need not change. The
  alternative — HTTPS on loopback with the window trusting its own fingerprint —
  is available and marginally cleaner, but it buys nothing against any threat and
  costs an Electron certificate-error handler that has to be scoped exactly right
  to avoid becoming "trust everything".
- **`x-rfdeck-token` is unchanged**, and keeps working exactly as it does now. Only
  the scheme it crosses changes, plus the login call that issues it.
- **`POST /auth/login` is a breaking change for Manifold**, since the bare PIN
  becomes a channel-bound proof. Proposal: accept both forms for one release,
  reject the bare PIN from non-loopback addresses once Manifold ships support, and
  version the change in the RFDeck ↔ Manifold contract. RFDeck has not launched
  and has no users, so the only coordination needed is with Manifold.
- **Micboard displays** connect without a PIN and are marked read-only
  (`apps/server/src/plugins/socket.ts`). They are unaffected beyond the scheme, and
  they do not pair, so they do not pin.

## What this needs from others

- **Manifold:** store a pin per RFDeck install, compare the SPKI fingerprint on
  every connection, show the fingerprint at pairing, and send the channel-bound
  proof. The display-and-confirm step needs UI.
- **David:** confirm the pinning approach over the alternatives above, and whether
  the Meros-issued-certificate track for browser trust is worth opening
  separately. Also whether PINs should be allowed to be longer than they are now,
  which is the one cheap way to raise the floor under (b).
- **meros.co:** nothing. This is below the cloud contract.

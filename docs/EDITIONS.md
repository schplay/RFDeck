# Editions, licensing and what is paid for

What RFDeck gives away, what it charges for, and — more usefully — **why the
line sits where it does**. The reasoning matters more than the list, because the
list will grow and every addition has to be placed without re-arguing the whole
thing.

Nothing here is implemented. All paid functionality is future work: it is
blocked on separating the repository and building licence enforcement, and
neither has started. This document exists so that features designed before then
are designed on the right side of a line that already exists, rather than
retrofitted onto one invented later.

---

## The principle

> **Free is what an operator needs. Paid is what an organisation needs.**

An A2 working a show alone should never hit a paywall in the middle of doing
their craft. What costs money is the machinery an organisation needs *around*
that work: named accounts, permissions, multiple venues, an audit trail,
somebody to call when it breaks.

The test for any new feature is one question: **does this only matter when more
than one person, or more than one venue, is involved?** If yes, it is a
candidate for paid. If no, it is free.

That test is worth defending literally. It is explicable in a sentence, it puts
the cost where the budget is — a venue has one, a freelance A2 does not — and it
is hard to erode, because the answer is rarely ambiguous. The moment there is
one exception "because it was expensive to build", the line stops being
explicable and every subsequent decision becomes an argument.

Cost to build is not a reason to charge. Ongoing cost to *run* is, but it
belongs in the cloud tier (below) rather than as a hostage taken in the
application.

---

## The editions

### Free — open source desktop application

The whole monitoring product. Discovery, telemetry, alerting, the mic check,
shows and performers, the Micboard and Backstage displays, rolling capture and
detections, the audio patch, frequency coordination.

### Paid — RFDeck Pro, the self-hosted server

A perpetual licence at **$499**, including twelve months of updates and support;
further year-long contracts afterwards at a discount. Not a subscription — see
"Paid application" below, and `docs/REPO_SEPARATION_PLAN.md`.

Aimed at organisations and venues: named user accounts, user and permission
management, and the things that follow from more than one person using the same
rig. Pro is also what unlocks three of the cloud's paid features — remote
restore, remote control and attributed audit — which a desktop install cannot
have because there is no always-on server to reach.

### Appliances

Pre-configured hardware with the paid version installed, for a venue that wants
to buy a working thing rather than build one.

### The cloud is Meros Cloud

RFDeck does not run a cloud of its own. meros.co is the identity provider and the
host of the shared services RFDeck's cloud features are built on; RFDeck is a
relying party. A Meros **account** — a person or an organisation — is what owns
entitlements and synced state. See `docs/CLOUD_INTEGRATION_PLAN.md`.

Billing is **à la carte per product**: an account pays for RFDeck's cloud
independently of any other Meros product.

### Cloud — free tier

Needs only a free Meros account.

- **App config and settings backup.**
- **Show file backup — one file, always the most recent.** No history.
- **Basic alerts** — email and webhook, configured in the cloud over RFDeck's
  event stream.

### Cloud — Individual, $15/month or $150/year

- **Backup history — 100 files, FIFO.** The oldest is dropped beyond that.
- **SMS alerts.** The paid delivery channel; email and webhook stay free.
- **Spectrum data** — the FCC-derived TV-occupancy packs that let coordination
  keep out of licensed channels.
- **RF environment history**, **post-show RF report generation**, and **online
  inventory listing**. 📋 *Not built — see the cloud plan's later phases.*
- **Only on RFDeck Pro** (the self-hosted server or an appliance): one-click
  remote restore and provisioning, remote UI and control, and attributed change
  history. Not available on desktop RFDeck. 📋 *Deferred with Pro.*

### Cloud — Team add-on, $20/month or $200/year

An **account-level** add-on rather than an RFDeck price: it layers multi-user
features across whatever products the account pays for. Shared fleet views,
shared alert routing, member management. With RFDeck Pro it can also move
RFDeck's local per-user permissions and auditing into the cloud — 📋 deferred
until Pro exists.

> **A correction worth noting.** This document used to describe the free cloud
> tier as "user profiles and show files", which was too generous on one count and
> silent on another: show file *backup* is free but its *history* is not, and the
> cap is one file rather than unlimited. Anything that reaches an operator should
> say "one file, the most recent" rather than imply a library.

## Two decisions worth recording, because they were nearly made the other way

### Frequency coordination is free

It was considered as a paid feature and it should not be. Coordination is one
operator doing their craft — it fails the test above outright.

It is also the worst possible candidate for an exception. Shure's Wireless
Workbench and Sennheiser's Wireless Systems Manager are both free: charging for
coordination would mean charging for the thing the manufacturers give away,
while giving away the organisational features they do not have. Exactly
backwards.

There is a further trap to avoid inside the feature itself. RFDeck already warns
when the rig's own transmitters land on each other (Stage C.6). Detection must
never be free while the remedy is paid — *"we have told you it is broken, pay to
find out how to fix it"* is the one shape users are right to resent. Diagnosis
is the core of a monitoring product and stays free.

The real recurring cost in coordination — maintaining per-model device profiles
and regional TV data — is met by the paid **cloud** tier. The solver is free and
works offline against whatever profiles shipped with the build; the maintained,
auto-updating data feed is the subscription. That charges for the ongoing cost
without withholding the capability.

#### A wrinkle worth answering out loud: the TV data is public domain

The TV/DTV occupancy pack is built from FCC public-domain data — the LMS station
registry joined to the FCC's own service-contour points. Anyone can download
both. So what exactly is being charged for?

**Curation and freshness, not access.** What the subscription buys is the join
between two datasets that are published separately, the contour geometry in a
form a rig can evaluate offline, a weekly rebuild as facilities change, and a
signature so the result can be trusted on a machine with no internet. Nobody is
being charged for the right to know which TV channels are licensed near them;
they are being charged for not having to assemble it every week.

That distinction is worth stating plainly rather than hoping nobody asks,
because the honest version is defensible and the evasive version is not. It is
also the same shape as the device profiles: the data is knowable, the
maintenance is the product.

The finalized tiers confirm it: **spectrum data is paid**, and an earlier draft of
Meros's own breakdown briefly said otherwise before correcting itself. So this
argument is load-bearing rather than decorative — it is the answer RFDeck will
actually have to give.

And it stays on the right side of the rule above — **diagnosis is never behind
the paywall.** The coordinator is free and works against the shipped band tables
and the operator's own scans. Without the feed RFDeck does not tell you that you
are on a licensed channel and then ask for money to say which one; it simply has
no opinion about broadcast licensing, and
[`docs/IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) already requires it to
say so plainly rather than implying it knows what is legal where you are
standing. The feed adds a regulatory layer; it does not unlock a withheld answer.

### Alerting is a cloud feature, not an application feature

Stage C.2 originally justified its tiering by what each delivery method costs to
run. That was a second principle competing with the first, and the outcome is
better reached through the same one: browser push and webhooks are
self-contained and free, while anything RFDeck would have to operate on the
customer's behalf belongs in the cloud tier.

Two refinements since, both from Meros and both narrowing what is paid:

- **Alerts are not something RFDeck sends.** They are rules the user configures
  in the cloud *over RFDeck's event stream*. So the question is not "which
  delivery methods do we charge for" but "which channels cost Meros money".
- **Only SMS does.** Basic channels are free-tier. Email was on the paid list
  here for no better reason than sitting next to SMS in the same sentence, which
  is exactly the kind of drift the principle at the top of this document exists
  to catch.

Confirmed by the finalized tiers (2026-09-26): email and webhook alerts are free,
SMS is the Individual lever.

---

## Sequencing

No gating, licence checking, or edition branching is to be built until the
repository separation and licensing implementation are designed. Both are now
planned — `docs/REPO_SEPARATION_PLAN.md` (the paid application: licence,
extension points, the pro repository, licence keys) and
`docs/CLOUD_INTEGRATION_PLAN.md` (Meros accounts, the instance and person
links, entitlements, the free and paid cloud tiers) — and neither has started.
Until they do:

- Build features on the free side of the line as normal.
- Where a feature is destined to be paid, note it in the plan and build nothing
  that assumes an enforcement mechanism.
- Do not scatter conditionals in anticipation. A licence check retro-fitted once,
  deliberately, is cheaper to get right than fifty guesses left lying around.

One correction from the cloud side, which points the same way: Meros has
**deferred gating** on cloud entitlements. The cloud plan builds the plumbing
and the single gate, and features are granted liberally while testing. So even
once that plumbing exists, nothing enforces a paywall until the owner says so —
which is the same instruction as above, arriving from the other direction.

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

### Paid — desktop and headless server

A single **lifetime licence**, including one year of updates and priority
support. Further year-long update and support contracts can be bought
afterwards at a discount.

The paid application is aimed at organisations and venues. Named user accounts,
user and permission management, and the things that follow from more than one
person using the same rig.

### Appliances

Pre-configured hardware with the paid version installed, for a venue that wants
to buy a working thing rather than build one.

### Cloud — free tier

User profiles and show files: the things an operator wants to follow them
between machines and between venues.

### Cloud — paid tier

Services with a genuine recurring cost behind them:

- **Regional data** — device profiles and TV/DTV occupancy, which are perishable,
  regional, and need maintaining as hardware and regulation change.
- **Advanced notifications** — email and SMS, which need a third-party service
  and cost per message.

---

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

### Email and SMS alerting is a cloud feature, not an application feature

Stage C.2 originally justified its tiering by what each delivery method costs to
run. That was a second principle competing with the first, and the outcome is
better reached through the same one: browser push and webhooks are
self-contained and free, while email and SMS are a hosted service RFDeck
operates on the customer's behalf. They belong in the paid cloud tier alongside
regional data.

---

## Sequencing

No gating, licence checking, or edition branching is to be built until the
repository separation and licensing implementation are designed. Until then:

- Build features on the free side of the line as normal.
- Where a feature is destined to be paid, note it in the plan and build nothing
  that assumes an enforcement mechanism.
- Do not scatter conditionals in anticipation. A licence check retro-fitted once,
  deliberately, is cheaper to get right than fifty guesses left lying around.

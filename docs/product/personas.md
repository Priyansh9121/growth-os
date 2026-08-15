# Personas

**Status:** Living document
**Last reviewed:** 2026-08-15

Archetypes, not real individuals. They exist to settle arguments about who a
screen is for. Every persona lists what makes them _cancel_, because retention
is decided by the failure mode, not the feature list.

---

## P1 — The Owner-Operator (primary buyer, direct channel)

**Archetype:** Owner of a 6–40 person local service business (plumbing,
electrical, HVAC, dental, legal). $800k–$8M revenue. Not a marketer.

**Context:** Runs the business from a phone, between jobs. Has been sold SEO
three times and cannot tell whether any of it worked. Currently judges marketing
by "does the phone ring".

**Jobs to be done**

- Know whether marketing spend produced customers.
- Stop losing calls when nobody can answer.
- Be told what to do next, in plain language, without learning a discipline.

**Success looks like:** opening Growth OS on a phone and seeing leads, calls,
booked jobs and attributed revenue for the month, plus one clear next action.

**Will cancel if:** the dashboard shows metrics they cannot connect to money;
they have to configure anything complicated; the AI produces obviously generic
advice; a missed-call promise is broken.

**Design implications**

- Mobile is a first-class operator surface, not a scaled-down desktop.
- Vocabulary: "calls", "booked jobs", "revenue" — never "sessions", "CTR",
  "conversion events" as the primary label.
- Every screen answers a money question first.

---

## P2 — The Agency Strategist (primary user, agency channel)

**Archetype:** Runs delivery for 15–60 client accounts at a digital agency.
Technically fluent, time-poor, judged on client retention.

**Context:** Currently stitches Ahrefs + GSC + GA4 + a CRM + Looker Studio per
client, monthly, by hand. Reporting is the single largest time cost and the
least valuable work they do.

**Jobs to be done**

- See which of 40 clients need attention this week, without opening 40 tabs.
- Produce a report that survives "what am I paying you for?".
- Apply a proven setup to a new client in minutes.

**Success looks like:** one portfolio view ranking clients by risk and
opportunity; one-click client reporting showing revenue, not rankings.

**Will cancel if:** cross-client operations require repetition; the platform
cannot be white-labelled; a client sees Growth OS branding before the agency
decides; data leaks between client workspaces (this ends the relationship
permanently, and probably the company).

**Design implications**

- Multi-workspace is the default mental model — hence membership-based access
  from day one, and a workspace switcher in the shell from the first commit.
- Bulk operations and templates (Stage 17) are retention-critical, not luxuries.
- Tenant isolation is the agency's professional liability. It is defended at
  three layers and tested as a negative.

---

## P3 — The Agency Owner (economic buyer, agency channel)

**Archetype:** Owns the agency. Buys tools on margin, delivery capacity and
differentiation.

**Jobs to be done:** raise revenue per account, cut delivery hours per account,
sell something competitors cannot.

**Success looks like:** replacing four subscriptions and a reporting analyst;
being able to sell "attributed revenue reporting" as a differentiator.

**Will cancel if:** per-seat or per-client pricing destroys the margin; the
platform competes with them for their clients; white-label is superficial.

**Design implications:** entitlements and usage metering must be real
architecture (Stage 18), because the commercial model depends on them.

---

## P4 — The In-House Marketer (secondary user, direct channel)

**Archetype:** The one marketing person at a 40–200 person company. Fluent in
GA4 and Search Console. Sceptical of AI recommendations.

**Jobs to be done:** prove contribution to pipeline; find leaks; not be replaced
by a black box.

**Will cancel if:** the tool is a black box; data cannot be exported; the AI
cannot show its working.

**Design implications:** every recommendation carries its evidence. Raw data is
always reachable underneath the summary. Export is not optional.

---

## P5 — The Front-Desk / Office Manager (daily operator)

**Archetype:** Answers the phone, books the jobs, chases the quotes. The
highest-frequency user of the CRM, calendar and inbox surfaces.

**Jobs to be done:** see today's appointments; know what the AI agent said to a
customer; not double-book.

**Will cancel if:** (they cannot — but they can quietly stop using it, which
kills the data quality the whole product depends on) the CRM is slower than a
notebook, or the AI books something impossible.

**Design implications:** this persona is why Principle 6 ("fast in the operator
surface") exists, and why the voice agent must book through the _same validated
service path_ a human uses.

---

## Anti-persona — The Enterprise SEO Team

Large in-house teams at national brands, with data warehouses and analysts.

**Explicitly not our customer.** They want API access to raw data, custom
modelling and log-file analysis, and they do not want opinionated
recommendations. Serving them would pull the product toward being a data source
rather than an operating system, and would dilute every principle above.

Revisit only if the strategy changes in a reviewed commit.

---

## Persona → surface mapping

| Surface                   | Primary | Secondary |
| ------------------------- | ------- | --------- |
| Dashboard home            | P1      | P2, P4    |
| Opportunities / Growth AI | P1, P2  | P4        |
| SEO modules               | P2, P4  | —         |
| Contacts / Pipeline       | P5      | P2        |
| Conversations / Inbox     | P5      | P2        |
| Calendar                  | P5      | P1        |
| Reports / Attribution     | P2, P3  | P1, P4    |
| Agency console (Stage 16) | P2, P3  | —         |
| Settings / Integrations   | P2, P4  | —         |

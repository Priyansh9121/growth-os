# System Context

**Status:** Current (Stage 1) plus planned integrations, clearly separated.

## Today

```
   ┌──────────┐        ┌─────────────────┐        ┌──────────────┐
   │ Operator │───────▶│    Growth OS    │───────▶│  PostgreSQL  │
   │ (browser)│  https │   apps/web      │        │   (+ RLS)    │
   └──────────┘        └─────────────────┘        └──────────────┘
```

One actor, one system, one datastore. **No external service is integrated.**
Growth OS makes no outbound network calls at all today, which is worth stating
because it is the last moment that will be true.

## Actors

| Actor               | Description                                      | Trust                                                  |
| ------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| Owner-operator      | Business owner (P1)                              | Authenticated, workspace-scoped                        |
| Agency strategist   | Operates many client workspaces (P2)             | Authenticated, multi-workspace, **audited distinctly** |
| Front-desk operator | Daily CRM/calendar user (P5)                     | Authenticated, workspace-scoped                        |
| Anonymous visitor   | An end customer on a client's website (Stage 10) | **Untrusted**                                          |
| Inbound caller      | An end customer phoning in (Stage 13)            | **Untrusted**                                          |
| Platform operator   | Us                                               | Elevated; every action must be audited and time-boxed  |

## Planned external systems

Listed with the trust posture each requires, because that is the part that is
expensive to add later.

| System                  | Stage | Direction                  | Trust posture                                                          |
| ----------------------- | ----- | -------------------------- | ---------------------------------------------------------------------- |
| Google Search Console   | 5     | inbound (OAuth)            | Trusted data; **credential custody is the risk**                       |
| PageSpeed / CrUX        | 5     | inbound                    | Trusted data                                                           |
| Google Business Profile | 9     | bidirectional              | Writes on the customer's behalf — needs explicit consent               |
| **Customer websites**   | 3     | **outbound crawl**         | **Untrusted, and an SSRF vector.** Requires egress restriction         |
| Rank data provider      | 6     | inbound                    | Trusted; abstracted so it can be swapped                               |
| Telephony               | 13    | bidirectional + webhooks   | **Webhooks must be signature-verified** — they can create appointments |
| Python voice service    | 13    | outbound + signed webhooks | Separate system; [own boundary doc](voice-architecture.md)             |
| LLM provider            | 7     | outbound                   | **Output is untrusted input.** Cost is a denial-of-wallet vector       |
| Email / SMS             | 12    | outbound                   | Deliverability and abuse controls                                      |
| Calendar providers      | 11    | bidirectional              | Timezone correctness is the hard part                                  |
| Payments                | 18    | webhooks                   | Signature verification; idempotency                                    |
| Accounting              | 21    | inbound                    | Revenue truth for attribution                                          |

## The trust boundaries that matter

Two of these are routinely underestimated:

1. **Crawled content is untrusted input** — it is attacker-controlled text that
   will later be fed near an LLM. Prompt injection enters here.
2. **Model output is untrusted input** — it is parsed and acted upon. The tool
   registry is the enforcement point.

Both are analysed in [../security/threat-model.md](../security/threat-model.md).

## Data residency

Not yet decided. Australian customers are the initial target and may expect
in-country storage. Deferred to
[deployment-architecture.md](deployment-architecture.md), and flagged now
because retrofitting residency is a migration, not a setting.

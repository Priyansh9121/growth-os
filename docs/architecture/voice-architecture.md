# Voice Architecture

**Status:** ⬜ **NOT BUILT.** Boundary specified. Target: Stage 13.

## The stance

The realtime voice system is a **separate system in a different language**,
integrated across an explicit API boundary. Growth OS does not implement
realtime audio, and the voice service does not implement business logic.

```
   Growth OS (TypeScript)                Voice Service (Python)
   ─────────────────────                 ──────────────────────
   agent config, CRM,          HTTP      realtime audio, STT/TTS,
   calendar, attribution   ◀─────────▶   turn detection, barge-in,
                          signed         telephony transport
                          webhooks
```

**Why separate:** realtime audio is a fundamentally different runtime profile —
latency-critical, long-lived connections, a Python ML ecosystem. Forcing it
into the Node monolith would compromise both. This is one of the two
pre-committed extractions in [ADR-0001](../decisions/ADR-0001-architecture-style.md).

## The critical rule

> **The voice agent books appointments through the same validated application
> service a human uses.** It gets no privileged path.

```
Caller: "Tuesday at 2 PM?"
   ▼
Voice service recognises intent
   ▼
POST /api/voice/tools/bookAppointment      ← signed, typed
   ▼
Growth OS: authorize → validate availability → transact
   ▼
committed, or REFUSED with real alternatives
   ▼
Agent says only what actually happened
```

If Growth OS refuses, the agent offers the alternatives the service returned —
it does not invent a time. This is the AI architecture's central principle
applied to the highest-stakes surface: a customer standing in a flooded kitchen
being told a plumber is booked when no such appointment exists is the worst
failure this product could produce.

## Boundary contract

**Growth OS → voice service:** start a session with agent configuration, the
tool manifest and workspace context. Voice never receives a database handle or
a session cookie.

**Voice service → Growth OS:** tool calls (book, qualify, look up availability)
and lifecycle webhooks (`call.started`, `call.ended`, transcript ready).

**Security requirements, all mandatory before the first call:**

- HMAC request signing in both directions, constant-time comparison
- Timestamp window to prevent replay
- Idempotency key per call event — a retried `call.ended` must not create two
  records
- Per-workspace scoping on every request; the voice service never chooses a
  tenant
- Rate and cost limits per workspace
- mTLS or a private network in production

An unsigned webhook that can create an appointment is a booking-fraud vector.

## Legal — not optional

Call recording is regulated and jurisdiction-specific; several jurisdictions
require **all-party** consent. Consent capture, disclosure at call start,
retention limits and deletion are **product requirements**, not settings.
Legal review precedes implementation. Transcripts and recordings are personal
data with full deletion obligations.

## Data model (planned)

`voice_agents` · `phone_numbers` · `calls` · `call_events` · `call_summaries` —
all workspace-scoped with RLS, per the standard checklist.

## Out of scope for Growth OS

Audio processing, STT/TTS model selection, turn detection, barge-in handling,
telephony transport. All belong to the voice service.

# Persisted claims prevent duplicate writes after Workflow replay

Investigated 10 November 2026 for `agent-harness-qdpp`. This is an isolated protocol prototype, not the Notes implementation. No Buffer, Telegram, OAuth grant, Calendar, or production configuration was changed.

Eight tests run in actual workerd through Miniflare, with SQLite Durable Object storage and Workflow persistence directories. Tests dispose and reconstruct Miniflare against the same stores. External requests are intercepted by an in-process fake provider; its counters survive the runtime reconstruction.

## The tested failure boundaries preserve conservative outcomes

| Boundary exercised | Persisted evidence after reconstruction | Observed external calls on replay |
| --- | --- | --- |
| Dispatch claimed before any create call | `dispatching`, without a provider ID | Zero creates, including eight competing replay callers |
| Fake provider accepted, before recording its response | `dispatching`, without a provider ID | One total create; no repeat |
| Eight competing create callers | `accepted`, with fake post ID | One total create |
| Accepted result recorded, Workflow step checkpoint deliberately fails | `accepted`; actual Workflow paused/reconstructed/resumed to completion | One total create despite step retry |
| Refresh claimed before provider call | `refreshing`, then `needs-auth` on a fresh object | Zero refresh calls; old token not reused |
| Provider rotated refresh token, before replacement was recorded | `refreshing`, then `needs-auth` | One refresh call; old token not reused |
| Grant replaced while refresh is in flight | New generation and replacement grant survive the late response and reconstruction | One old-generation refresh; eight live contenders dispatch none |
| Authenticated-envelope prototype consumed before forwarding; applied before ack; ack recorded | Original retained envelope and one durable application effect | Same update and pending same-action update resolve to the original event; replay does not apply twice |

The Workflow case uses a real Workflow binding. Its `guarded-create` step invokes the publication object, then deliberately throws after acceptance was stored. The test pauses that Workflow while retry is pending, disposes workerd, recreates it against the same stores, resumes, and observes `complete`. It does not substitute a fake `step.do`.

## The guard must own both the claim and the outbound request

The prototype claims dispatch with synchronous SQLite writes before its first network await. Later requests observe `dispatching` or the recorded result, never permission to dispatch again. A record already marked accepted remains accepted after another prepare request and reconstruction. Missing or mismatched prototype approval evidence cannot prepare or execute.

An interrupted claim cannot reveal whether the provider received a request. The tests intentionally preserve this uncertainty even when the fake counter tells the test harness that nothing was created. Production code must treat that record as unknown, perform only bounded evidence recovery, and then report failure to confirm if recovery fails. It must not expire the claim into Retry. This sacrifices automatic recovery in the zero-create case to avoid duplicates in the indistinguishable accepted case.

This supports the approved TDD protocol. It does not supply exactly-once delivery, a production adapter, or proof that Buffer accepted a real Note.

## Refresh needs a generation fence after the network await

The first prototype wrote a refreshed grant unconditionally after awaiting the provider. Inspection exposed a race: a newer OAuth authorization could be overwritten by that late result. The retained probe now compares persisted generation and state before committing. A held fake refresh response lets the test replace the grant concurrently and prove the old result cannot overwrite it.

Live callers encountering the same refresh claim receive a busy `refreshing` result and make no second request. After runtime reconstruction, a persisted claim with no live owner becomes `needs-auth`. Production integration should join the same live promise while it exists; that promise-joining API is not implemented by this probe. A restarted process must request reauthorization rather than assume a single-use refresh token remains usable.

## Retaining the original event repairs the consume/send/ack gap

Consume and envelope retention occur in one synchronous storage transaction. The retained event contains the fixed prototype owner, candidate version, action, and delivery ID. A duplicate update, or another update for the same still-pending action, returns this original event. It cannot resolve against a later candidate. A mismatched owner/version/action is rejected, and new updates after acknowledgement are rejected.

The delivery case uses an actual Workflow waiting for an approval event. Its step applies the retained delivery once. The test then reconstructs the runtime before acknowledgement and replays the retained event into the application boundary repeatedly. A separate durable deduplication record keeps the effect count at one; an invented delivery ID is rejected. A second reboot checks acknowledgement persistence.

The prototype models the persistence protocol with fixed owner/version values and a synthetic approval marker. It does **not** test Telegram webhook-secret validation, callback-token authenticity, dynamic fingerprint matching, full candidate invalidation, or the existing router implementation. Those remain production implementation requirements. In particular, retaining an event does not itself authorize publication: the Workflow must independently validate its owner, version, candidate fingerprint, phase, and deadline before creating an approval record.

## Reproduction and evidence

Run:

```sh
rtk pnpm exec vitest run --config vitest.integration.config.ts src/__integration__/notes-durability-spike.integration.test.ts
```

Observed: eight tests passed. Runtime versions: Miniflare `4.20260708.1`, workerd `1.20260708.1`, Vitest `3.2.7`; compatibility date `2026-07-08`. Targeted Biome check passed; worker formatting, `pnpm typecheck`, and `pnpm run docs` also passed.

Sources and reusable checks:

- [Protocol worker](../../tools/spikes/notes-durability/worker.js): synchronous claims, guarded create, generation fencing, retained delivery, real Workflow classes.
- [Runtime suite](../../src/__integration__/notes-durability-spike.integration.test.ts): injected faults, persistent-runtime reconstruction, concurrency, observable counters, and status assertions.
- [Existing Calendar runtime harness](../../src/__integration__/calendar-telegram-workflow.integration.test.ts): the repository pattern reused for Miniflare loading, persistent directories, pause/reconstruction/resume, and provider interception.

These are controlled boundary injections, not arbitrary operating-system kills during SQLite commits. The tests establish the observed local workerd semantics, not every production crash mode, deployment migration, storage failure, or retry interleaving. They do not test encryption, refresh revocation at Buffer, stale late create responses, real-provider rejection classification, timeout behavior, or production retention cleanup. No user input is required to finish this local spike; account-level authorization belongs to the separate Buffer contract spike.

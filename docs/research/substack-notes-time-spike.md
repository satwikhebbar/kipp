# Luxon covers the required scheduling contract with less added code than Temporal

Investigated 2026-11-10 for `agent-harness-c46p`, against Kipp HEAD
`5fa223f8a5e1aa36751cc32a0509b35b20b39c2a`.

Recommend **Luxon 3.7.2 behind the approved shared time interface**. Keep strict
input validation and explicitly enumerate ambiguous offsets. The comparison
does not justify Temporal's larger polyfill for this workflow, or maintaining
our own inverse time-zone algorithm. This is a recommendation for the design;
no production dependency, Calendar behavior or runtime binding changed.

## All three prototypes pass the common cases in actual workerd

The retained [runner](../../tools/spikes/notes-time/run.mjs) bundles each adapter
separately and executes it through Miniflare/workerd. The saved
[results](../../tools/spikes/notes-time/results.json) contain exact instants,
versions and an additional counterexample. This is executed evidence rather
than a conclusion based only on reading APIs.

| Candidate | Common checks | Standalone minified bytes | Gzip bytes | Code Kipp must own |
| --- | --- | ---: | ---: | --- |
| Extended `Intl` prototype | 19/19 | 3,237 | 1,495 | Validate civil fields, sample offsets, enumerate and round-trip candidates, scan missing midnight, add civil days |
| Luxon 3.7.2 adapter | 19/19 | 73,618 | 23,102 | Validate fields, reject normalized gaps, enumerate possible offsets, select typed result |
| `@js-temporal/polyfill` 0.5.1 adapter | 19/19 | 164,891 | 48,320 | Validate fields, compare earlier/later disambiguations and exact round trips, select typed result |

Sizes include the adapter, common assertion payload and response harness, with
esbuild minification. They are **standalone comparison bundles**, not measured
increments to Kipp's whole Worker deployment. Actual deployment size must be
measured when implementing the selected adapter. Recorded elapsed times include
runtime startup and are not a performance benchmark.

Versions: Node `24.18.0`, esbuild `0.28.1`, Miniflare `4.20260708.1`, workerd
`1.20260708.1`, compatibility date `2026-07-08`. `globalThis.Temporal` was
`undefined` inside this runtime, so the tested Temporal option requires its
polyfill here. This observation does not predict newer workerd builds.

## The cases cover the intended gaps, folds and calendar arithmetic

| Behavior | Observed result from all three prototypes |
| --- | --- |
| Kolkata, 2026-07-28 19:00 | Unique: 13:30Z |
| Invalid February 30, invalid time 24:00, unknown zone | Invalid, without an uncaught exception |
| New York 2026-03-08 02:30 | Nonexistent |
| New York 2026-11-01 01:30 | Ambiguous: 05:30Z and 06:30Z |
| Lord Howe 2026-10-04 02:15 | Nonexistent half-hour gap |
| Lord Howe 2026-04-05 01:45 | Ambiguous: candidates 30 minutes apart |
| New York spring/fall local day bounds | 23 / 25 elapsed hours |
| Sao Paulo 2018-11-04 missing midnight | Bounds start at local 01:00; day lasts 23 hours |
| Kolkata ordinary local day | 24 hours |
| Civil next day over DST, year end, leap day | March 8, January 1, February 29 respectively |
| Three weekly Sunday 09:00 New York starts across spring DST | 14:00Z, 13:00Z, 13:00Z; local time preserved |
| Samoa's completely skipped 2011-12-30 | Requested day rejected |

These are targeted cases, not exhaustive IANA history coverage. The recurrence
check resolves already-enumerated civil weekly dates; it does not exercise
Kipp's full recurrence policy, agent evaluation or Google Calendar API.

## Extending Intl remains small in bytes but makes Kipp own more edge cases

The prototype samples offsets every six hours within 48 hours of the requested
civil time. It round-trips candidate instants before accepting them. This finds
the tested gaps and folds, but there is no proof that this sampling captures
every historical time-zone transition. `Intl` supplies formatting and offsets,
not this inverse-resolution contract.

The extra counterexample is the **day before** Samoa skipped December 30.
December 29 should end at December 31's first instant. Luxon and Temporal return
a 24-hour interval. The Intl prototype fails because it asks for a first valid
minute on the nonexistent next date. Fixing it requires another policy and
search path. The runner records and asserts this failure rather than hiding it.
Scanning up to 1,440 minutes to find a missing midnight is also more code and
work to maintain. Passing the common cases alone is insufficient reason to
promote this prototype.

## Luxon needs a strict wrapper, but already exposes the useful primitives

Luxon's `getPossibleOffsets()` enumerates alternatives for ambiguous local
times. `fromObject()` may normalize a nonexistent wall time, so the adapter must
compare year, month, day, hour and minute against the request before using the
result. These behaviors are visible in the pinned
[3.7.2 implementation](https://github.com/moment/luxon/blob/3.7.2/src/datetime.js)
and [zone documentation](https://github.com/moment/luxon/blob/3.7.2/docs/zones.md).

Use `plus({ days })` for civil-day arithmetic, and the beginning of the following
local day for an exclusive end. Keep elapsed event duration as milliseconds.
Do not replace those concepts with `+24 hours`. Luxon's relevant operations are
documented in its [API reference](https://moment.github.io/luxon/api-docs/index.html).

The production wrapper should constrain accepted zones to the existing IANA/UTC
policy rather than silently expanding to Luxon's fixed-offset shorthand. Keep
`{ kind: unique | nonexistent | ambiguous | invalid }` and UTC instants as Kipp's
interface; library objects should not escape into persisted workflow state.

## Temporal is suitable, but its extra surface is unnecessary for this change

Temporal makes plain dates, exact instants and zoned times explicit. Its
documented disambiguation options support the strict resolver, and
`PlainDate.toZonedDateTime()` without a wall time finds a day's actual start.
See [ambiguity handling](https://tc39.es/proposal-temporal/docs/timezone.html)
and [PlainDate conversion](https://tc39.es/proposal-temporal/docs/plaindate.html#toZonedDateTime).

It passes the same tests and is a defensible choice if Kipp later standardizes
on Temporal more broadly. For this change its measured gzip comparison bundle
is roughly twice Luxon's, and existing code has no Temporal model to preserve.
The tested package is the
[JS Temporal polyfill](https://github.com/js-temporal/temporal-polyfill), not an
assumed native Worker API. No functional benefit shown by these cases outweighs
the extra dependency size today.

## Existing Calendar behavior confirms the fixes are needed

The runner also bundles the real exports from
[`src/calendar/scheduling.ts`](../../src/calendar/scheduling.ts) and observes:

- New York's overlapping 01:30 silently chooses 05:30Z instead of reporting both candidates.
- A spring-gap time returns `null`.
- Sao Paulo's valid day with a missing midnight returns `null` bounds.
- An invalid zone throws instead of returning a typed invalid result.

Implement the strict Luxon wrapper in the shared module, retain compatibility
exports where needed, and route explicit Calendar gaps/folds to clarification.
Resolve each recurring civil date independently and skip invalid inferred
slots. Retain Kolkata regression coverage. Those integration changes remain
implementation work; this spike makes no claim that Calendar is already fixed.

## Reproduction and user input

Run the two commands in the
[probe README](../../tools/spikes/notes-time/README.md). No credentials, paid API
calls, live Calendar writes or user decisions are required to finish this spike.
The libraries are installed only in an isolated temporary directory; Kipp's
package manifest and lockfile are unchanged.

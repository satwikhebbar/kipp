# Cloudflare D1 for Kipp meal planning: feasibility note

**Status:** research draft  
**Decision addressed:** whether Cloudflare D1 is suitable as the durable store for a personal meal-planning workflow.

## Recommendation

Use one D1 database as the canonical store for structured household configuration, plans, plan versions, and feedback. It is a good Free-tier fit for a personal deployment. Keep photos, voice audio, and other large binary inputs out of D1.

## Pricing and Free-tier fit

D1 is usage-priced by rows read, rows written, and storage. There is no D1 capacity/hour charge while idle and no D1 egress charge. Workers charges remain separate. On Workers Free, D1 includes **5 million rows read/day**, **100,000 rows written/day**, and **5 GB total storage**. Limits reset at 00:00 UTC. [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

For Workers Paid, the first 25 billion reads/month, 50 million writes/month, and 5 GB storage are included; subsequent usage is $0.001/million reads, $1.00/million writes, and $0.75/GB-month. [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

For one household, weekly plans and occasional Mini App reads/writes should be far below Free limits. The practical Free-tier risk is not normal use: it is an accidental tight polling loop or unindexed/full-scan query. D1 bills reads for rows *scanned*, not just returned, and index maintenance adds writes. [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

Free is a hard availability limit, not an overage bill: once daily read/write limits are reached, queries fail until reset; when storage is full, inserts and schema/index changes are blocked. Plan UI/API should therefore avoid polling, use indexed lookups, surface retryable failures clearly, and retain usage metrics. [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

## Relevant limits and caveats

- Free permits 10 databases/account, 500 MB/database, 5 GB/account, and 7 days of Time Travel. Paid permits 10 GB/database and 30 days of Time Travel. [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- A D1 database is single-threaded and handles queries one at a time. Excess concurrency queues and can return `overloaded`; throughput depends on query duration. This is no concern for a household workflow, but it rules out treating one database as an unbounded high-write coordination system. [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- SQL/batch calls are limited to 30 seconds. A Worker invocation can make 50 D1 queries on Free (1,000 Paid); individual row/string/BLOB size is capped at 2 MB. [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- D1 uses SQLite semantics but not every SQLite extension or `PRAGMA`; confirm ORM/migration assumptions. Foreign keys are enforced, and migrations that need deferred foreign-key checks require `PRAGMA defer_foreign_keys`. [Supported SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/) [Foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)
- JavaScript queries can lose integer precision beyond the 52-bit safe range. Raw SQLite files cannot be imported directly (use an SQL dump); exports are unavailable for databases with virtual tables and block other requests while running. [D1 import and export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)

## Implementation guardrails

1. Store normalized structured records only: profile, plan, plan-version, feedback batch, and audit metadata. Put media in a deliberately-retained object store only if needed.
2. Index the normal access paths: bot/owner identifier + active plan, plan + version, and plan + feedback status. Review D1 `rows_read`/`rows_written` metadata and dashboard metrics during development.
3. Do not use D1 as a lock or long-running job engine. Continue to use the existing workflow/coordinator mechanism for generation and revision execution; D1 is the durable record.
4. Create automated SQL exports/backups appropriate to the desired recovery period. Free Time Travel only covers seven days.

## Decision

No D1 feasibility spike is needed. Adopt D1 as the proposed durable store during planning, with the guardrails above captured in the architecture and schema design.

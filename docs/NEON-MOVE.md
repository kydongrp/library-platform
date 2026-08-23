# Moving the database to a Neon project we administer

Runbook for relocating the DLS Admin database out of Neon project
`autumn-frog-86115224` and into the Kydon organisation, which is already on the
Scale plan.

## Why

The database reports itself as project `autumn-frog-86115224`, Postgres 17.11.
That project is in none of the accounts available to us:

| Where we looked | What is there |
| --- | --- |
| Neon org `org-tiny-queen-44468184` "Kydon", plan **scale** | `ZilLearn Kydon Group` (`soft-dream-24298924`) and `ZilLearn` (`super-sea-42754053`), both Postgres 18 |
| Vercel team `zil-learn` → Storage | `libtwo-db` = Neon `jolly-heart-02510119`, plan **Free**, attached to `libtwo-revamp` |
| Vercel project `library-platform` | no marketplace resource; `DATABASE_URL` is a hand-added plain env var |

So the recovery window cannot be read or changed, the plan is unknown, and there
is no answer to "who else can delete this data" — which a government client will
ask. Moving it fixes all three and uses Scale capacity already paid for.

Two side effects worth having: the move **rotates the database credentials**,
retiring any connection string that leaked previously, and it brings the
database onto Postgres 18 in line with the org's other projects.

## Postgres 18, not 17

Neon has no in-place major-version upgrade; its documented path is "create a new
project on the target version, migrate, repoint" — exactly this exercise.
Creating on 17 would guarantee doing it again later on a larger catalogue.

The app's Postgres surface is version-inert: no extensions beyond `plpgsql`, no
generated columns, no triggers, no partitioning, no views or functions, no
sequences or identity columns (every id is a `cuid()` text), and search is done
in TypeScript with `ILIKE`, not `tsvector`. Prisma 7.8 supports 18.

`scripts/lib/db-compare.ts` was rewritten so a version difference does not
disable the row digests, otherwise the strongest check would switch itself off
exactly here.

## What is already established

- `npm run backup:drill` passes and now proves byte equality rather than
  sampling. `npm run test:compare` proves the comparison detects six kinds of
  damage. `npm run test:fidelity` proves the dump round-trips naive timestamps,
  jsonb integers past 2^53, `json` whitespace, NULL against empty string, text
  containing the 0x1F MARC delimiter, numeric trailing zeros and arrays.
- A **full dress rehearsal has been run**: dump, restore into a fresh database,
  compare. Result: 61 tables, 552 rows, digests compared on all 61, zero
  blocking differences. The only advisories were 10 column-order differences,
  which are expected — production's columns were added over time, a fresh schema
  push orders them as `schema.prisma` declares them. **That output is the noise
  baseline.** During the real cutover, expect those 10 plus a
  `server_version_num` advisory, and nothing else.
- The dataset is small: 34 KB. The freeze is seconds.
- No application code names a host, database or project. Every script resolves
  through `connectionString()` in `scripts/lib/dump.ts`.
- Objects a public-table dump does not carry, checked on the source: schema
  `neon_auth` (9 tables, all empty except one row of Neon's own
  `project_config`; Vercel reports Auth: False for this store), login roles
  `cloud_admin`/`neon_auth`/`neon_service`/`neondb_owner`, no views, no
  functions, no policies, no grants beyond the owner, `plpgsql` only. Nothing
  there is application data.
- Locale on the source: `C.UTF-8` / `C.UTF-8`, builtin provider, UTF8. The
  comparison checks this on both sides and blocks on a difference.

## The one thing you must provide

A **Neon API key for the account that owns the Kydon organisation**
(`tech-admin@zillearn.com`). Neon console → Account settings → API keys, then
`NEON_API_KEY=` in `.env` (git-ignored). The Vercel/Neon integration does not
expose one.

Do not use "Open in Neon" from the Vercel storage page: it starts a separate
Neon signup for the Vercel-managed org, dead-ends at an unverified-email wall,
and signs the existing console session out.

## Things that will bite

Read these before starting; each one has caught somebody.

**`git push origin master` auto-deploys to production.** Do not push between
changing the environment variables and being ready for that deploy.

**The crons are not stopped by an environment change.** `CRON_SECRET` is baked
into each deployment, so the four jobs in `vercel.json` keep firing at 02:00,
02:20, 02:40 and 03:00 UTC regardless. Disable them in the Vercel dashboard for
the window, or do the cutover well clear of that hour. `sftp-fetch` matters
most: `ImportedFile` is the only idempotency ledger and vendor files are never
removed, so an `ImportedFile` row written after the final dump means the new
database re-imports that file — and the re-import path runs
`updateMany({ where: { epExternal: true }, data: { epExternal: false } })`,
which would silently reclassify external Editor's Picks.

**The learner portal writes on read.** `src/lib/portal-auth.ts` updates
`ApiClient.lastUsedAt` on authenticated requests. So the portal is not a
read-only consumer, and during the freeze its requests will error rather than
serve stale data. Decide in advance whether that is acceptable for the window.
The upside: because the freeze is enforced at the database, that write cannot
sneak past the final dump and turn up later as a spurious `ApiClient`
difference.

**The old connection string cannot be regenerated.** There is no console access
and no API key that can see the project, so the role password cannot be reset.
Losing the string ends all access to pre-cutover data permanently. Put it in a
password manager as step zero, and never run `ALTER ROLE ... PASSWORD` on the
old project.

**`idle_in_transaction_session_timeout` is 5 minutes on the source** and the
restore runs as a single transaction. Irrelevant at 552 rows; check it on the
target before a restore that takes longer than that.

**Holds and bookings whose windows fall inside the freeze** will look wrong
afterwards. Decide whether to extend them rather than finding out at the counter.

## Steps

Everything is re-runnable. `npm run neon:move` prints hostnames only;
credentials go to `.env.migration` (git-ignored, mode 600).

### 1. Look before touching

```bash
npm run neon:move -- plan
```

Prints the source's own identity, everything a public-table dump would not
carry, and — once `NEON_API_KEY` is set — every organisation and project that
key can see. Confirm the destination org shows `plan=scale`; a 30-day window
needs it.

### 2. Save the current Vercel values while they are still readable

```bash
npx vercel env pull --environment=production .env.prod.bak --yes
```

Put `DATABASE_URL` and `POSTGRES_URL_NON_POOLING` into a password manager. They
exist nowhere in git. Delete the file afterwards.

### 3. Create the target project

```bash
npm run neon:move -- create --org org-tiny-queen-44468184 --name "DLS Admin"
```

Creates the project in `aws-ap-southeast-1` (matching the `sin1` pin in
`vercel.json`) with the history window set to 30 days **at creation**, waits for
Neon's operations to finish before connecting, reads the window back, checks the
role can `CREATE DATABASE` (the drill and the test-database provisioner both
need it), then applies the Prisma schema. Re-running adopts the project it
already made rather than creating a second one.

Expect `postgres : 18`, `window : 2592000s (30 days)`, `61 tables created`.

### 4. Rehearse against the real target, before the freeze

```bash
npm run neon:move -- sync
```

Yes, before the freeze — it warns that the source is still writable, and that is
fine. This is the run that discovers anything specific to the new project
(Postgres 18 behaviour, locale, restore duration, how much cosmetic noise the
catalogue views produce across major versions) with nobody waiting. Keep the
output: it is the baseline you diff the real run against.

It also leaves the target non-empty, which disarms the seed's
clear-everything branch if anything deploys early.

### 5. Freeze, and record the watermark

```bash
npm run neon:move -- watermark      # before
npm run neon:move -- freeze
```

`freeze` sets `default_transaction_read_only` on the old database and terminates
other backends. The setting is read at connect time, so cutting existing
sessions is the part that matters — Vercel's pooled connections would otherwise
keep writing. Reversible with `thaw`.

Close any local `next dev`, `prisma studio` or `psql` first; they hold their own
pools and will make a good migration look broken.

The watermark records `AuditLog` count and max timestamp, the WAL position, and
tuple activity. Take it again at cutover: any movement is a write that did not
travel. "We told everyone to stop" is not evidence.

### 6. Copy the data and prove it arrived intact

```bash
npm run neon:move -- sync
```

Dumps the frozen source, restores, then compares on shape, indexes,
constraints, sequences, extensions, locale, per-database settings, row counts,
an md5 over every row of every table, and an order-sensitive digest per table to
catch a collation change the row digest is deliberately blind to. Exits non-zero
on any blocking difference. Do not continue past a failure.

Read the `Content digests` line: it must say the digests were compared. Expect
the 10 column-order advisories and a `server_version_num` advisory. Anything
else is new since the rehearsal.

### 7. Take a restore point on the new database

```bash
npm run neon:move -- branch
```

A Neon branch, which does not depend on the history window and is instant to
restore. This is the cheap insurance against the next step going wrong.

### 8. Repoint Vercel

Two variables, **different values**: `DATABASE_URL` is the pooled host
(`-pooler` in the name), `POSTGRES_URL_NON_POOLING` is the direct host. Getting
them the wrong way round leaves the app on a direct connection that runs out of
sockets under load, or the build pushing DDL through pgbouncer — and both look
fine in a smoke test.

Use `vercel env update`, not `env add --force` and not remove-then-add. On CLI
55 the Production default is **Sensitive**, and `add --force` would silently
convert these Encrypted variables to Sensitive, after which you can no longer
read them back to verify.

```bash
read -rs -p 'new pooled DATABASE_URL: ' NEW_POOLED; echo
printf '%s' "$NEW_POOLED" | npx vercel env update DATABASE_URL production --yes
```

```bash
read -rs -p 'new direct POSTGRES_URL_NON_POOLING: ' NEW_DIRECT; echo
printf '%s' "$NEW_DIRECT" | npx vercel env update POSTGRES_URL_NON_POOLING production --yes
```

`read -s` is a shell builtin, so the value never reaches argv or shell history.
`printf '%s'` adds no trailing newline; the CLI stores stdin verbatim, and
`echo` would append `\n` and corrupt the connection string.

Production is the only scope with values today (`npx vercel env ls` to confirm).
If Preview or Development ever gain one, point it at the **test** database, not
production — a preview deployment writing to live data is the defect the test
database exists to prevent.

### 9. Deploy

```bash
npx vercel redeploy <latest production deployment url>
```

Git auto-deploy is on, so the latest production deployment is already `HEAD`;
`redeploy` re-uses that exact source snapshot, holding code constant so the
database is the only variable. Environment variables are re-injected on every
deploy — the build cache holds `node_modules` and framework files, not env
values — and the build command runs in full.

`npx vercel --prod` also works now that `.vercelignore` excludes `.env*`, but it
uploads the working tree, which is a second variable you do not need today.

Then read the build log:

- `prisma db push` must succeed against the new project.
- `seed-if-empty` must report that it **skipped**. If it says it seeded, the
  build found an empty database. Stop before anyone signs in.

### 10. Verify from inside the deployed function

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://library.zillearn.com/api/diagnostics/database
```

Reports the Neon project, branch and endpoint ids the *deployed* app is talking
to, whether its host is pooled, the Postgres version, the region, and row
counts. Checking locally only proves what `.env` says. This is the check that
would have caught the original mix-up, and the only one that catches a
pooled/direct swap.

The project id must be the new one, and `pooled` must be `true`.

### 11. Take the watermark again

```bash
npm run neon:move -- watermark
```

Compare with step 5. Audit rows and WAL position should be unchanged. If they
moved, something wrote to the old database after the dump: find it, and decide
whether to replay it or repeat the sync.

### 12. Local files, in this order

1. `.env` — all three variables, from `.env.migration`. Never change one alone:
   `prisma.config.ts` prefers `POSTGRES_URL_NON_POOLING` while
   `scripts/lib/dump.ts` prefers `DATABASE_URL_UNPOOLED`, so a partial edit aims
   `db push` or a restore at whichever project the stale variable still names.
2. `.env.development.local` — the one everybody forgets. It re-declares all
   three variables pointing at the old `neondb_test`, and `next dev` loads it
   **ahead of** `.env`.
3. `npm run db:test:provision` — recreates `neondb_test` on the new server and
   rewrites `.env.test`. The old test database was a sibling database inside the
   project being left behind and does not travel.
4. `rm -rf .next` — the turbopack dev cache holds the old hostname.
5. Delete `.vercel/.env.production.local` (a stale pull holding old production
   credentials in plaintext), `.env.prod.bak`, and `.env.migration`.

### 13. Re-establish the recovery baseline

```bash
npm run backup:drill      # now against the new server
npm run backup            # first backup of the new database
```

### 14. Lock the old database open-but-read-only

Leave `default_transaction_read_only` set on the old project permanently. A
stale `.env` on somebody's laptop three weeks from now would otherwise produce
two databases with divergent rows and no way to adjudicate which is
authoritative — and no console to investigate with. It is reversible, enforced
at the server, and it is also the BR-3 (immutable backup) answer.

Add a weekly `SELECT 1` plus row count against the old project, so if access
disappears — unpaid invoice, account deletion, inactive-branch archiving, with
nobody reachable to answer the notice — you find out while you still care.

## Rollback

The old database is untouched by everything up to step 8, so before that point
rollback is `npm run neon:move -- thaw`.

After step 8, if no writes have landed on the new database: put the two Vercel
variables back, redeploy, thaw.

If writes **have** landed on the new database, do not simply revert — that
abandons those rows. Back up the new database, restore it into the old one with
`RESTORE_URL=<old direct> npm run backup:restore -- <file>
--i-understand-this-overwrites`, then revert the variables and redeploy. Or
restore the Neon branch from step 7 if the problem is on the new side.

Vercel's Instant Rollback is **not** a database rollback. It reverts code only;
a promoted older deployment still reads whatever environment variables the
project currently holds.

## Evidence to keep

This is a Singapore government deliverable and BR-2 asks for restore-test
evidence. A migration is the best restore test that will ever be run here, so
capture it rather than throwing it away:

- the sha256 of each dump file, and each manifest's `takenAt`, `totalRows` and
  `serverVersion`
- the full output of `backup:drill`, `test:compare`, `test:fidelity` and both
  `db:compare` runs
- the `neon:retention` identity lines before and after
- both watermarks
- the `/api/diagnostics/database` response after cutover

Also worth doing while the move is fresh: take one `pg_dump -Fc` with a
Postgres 17 client alongside the NDJSON dump, so there is an artifact any DBA
can read with standard tools, and keep copies of `scripts/lib/dump.ts` and
`scripts/lib/crypt.ts` with the backups. Right now recovery depends on one
bespoke format, one custom script, and one passphrase whose location is not
written down anywhere — establish where `BACKUP_KEY` lives, and prove the
existing `.enc` dump still decrypts with it.

## Known limits, for later

`backup()` accumulates every row into memory before gzip, and `readLines()`
decompresses the whole dump into one string. At 34 KB that is irrelevant; at the
528k-bib parity target it fails as a V8 string-length error rather than
gracefully. Before the catalogue grows, decide the threshold above which
`pg_dump -Fc` becomes the primary path, and make `CHUNK_THRESHOLD` in
`db-compare.ts` size-aware rather than row-count-aware — Postgres's 1 GB
aggregate limit can be reached on wide MARC rows well below 200k rows.

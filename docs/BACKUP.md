# Backup and recovery runbook

Applies to the DLS Admin database (Neon Postgres, `neondb`, region
`ap-southeast-1`).

## Which database this is

Ask the database, not the console. These values come from Neon's own GUCs on the
running compute, so they cannot be confused with a similarly-named project:

| | |
| --- | --- |
| Neon project | **`autumn-frog-86115224`** |
| Branch | `br-fragrant-fire-aod0jl58` |
| Endpoint | `ep-wispy-unit-ao028bf0` |
| Postgres | **17.11** |

```bash
npm run neon:retention
```

prints all four (no API key needed for that part). See the ownership problem in
"Still open" below: nothing we can currently log into owns this project.

## The one thing to understand first

**Neon takes no traditional backups.** There is no nightly dump to download.
Recovery on Neon rests entirely on the project's *history window* (instant
restore / point-in-time restore), and **the default is short on every plan**:

| Neon plan | History window default | Maximum |
| --- | --- | --- |
| Free | 6 hours | 6 hours (also capped at 1 GB of change history) |
| Launch | 1 day | 7 days |
| Scale | **1 day** | **30 days** |

**The plan on `autumn-frog-86115224` is unknown.** See "Still open" below. Until
that project is reachable, treat the recovery range as the short default.

> **Upgrading a plan does not apply the window.** The default stays at 1 day
> until someone raises it. Buying Scale and not moving the slider leaves you
> with the same 1-day window you had before. Check it, do not assume it.
>
> And check *which project* you raised it on. A Scale upgrade on 23 Aug 2026
> went to an organisation that does not own this database.

Set it in Neon console -> project -> Settings -> Instant restore, or via the
API (see the checklist below). Values: `86400` = 1 day, `604800` = 7 days,
`2592000` = 30 days. It is a project-wide setting, not per branch.

Scheduled snapshots (daily/weekly/monthly, 35-day retention, $0.09/GB-month)
are available on paid plans and are the closest thing Neon has to an
automatic backup.

## What is in place

| Command | What it does |
| --- | --- |
| `npm run backup` | Full logical backup to `backups/` (git-ignored) |
| `npm run backup:drill` | Proves a backup restores, end to end, then cleans up |
| `npm run backup:restore -- <file>` | Restores a dump into `RESTORE_URL` |
| `npm run db:which` | Prints which database `.env` resolves to |
| `npm run db:test:which` | Same for `.env.test` |
| `npm run db:test:provision` | Creates/refreshes `neondb_test` and writes `.env.test` |
| `npm run test:crypt` | Encryption round-trip tests |
| `npm run db:compare` | Prove two databases hold the same thing (read only) |
| `npm run test:compare` | Proves the comparison actually detects damage |
| `npm run neon:retention` | Show or set the Neon history window (recovery range) |

### Taking a backup

```bash
npm run backup
```

Writes `backups/dls-backup-<timestamp>.ndjson.gz`. The dump is a single
consistent snapshot (`REPEATABLE READ`), so it cannot contain a child row whose
parent it missed.

**Always set `BACKUP_KEY` if the file will leave the machine.** With a key set
the output is AES-256-GCM ciphertext named `.ndjson.gz.enc`; without one it is
plain gzip holding member names and email addresses.

```bash
BACKUP_KEY='<long passphrase>' npm run backup
```

Store that key somewhere the backups are not. A backup and its key in the same
place is one theft away from being neither private nor recoverable.

### Verifying a backup

```bash
npm run backup:drill
```

An untested backup is a guess. The drill:

1. backs up the live database,
2. creates a throwaway database on the same server,
3. applies the current Prisma schema to it,
4. restores the dump into it,
5. compares the restored copy against the live database **in full** (tables,
   columns and types, indexes, constraints, sequences, extensions, row counts,
   and an md5 over every row of every table), then spot checks a few real
   values because a hash is not readable,
6. drops the throwaway database.

It exits non-zero if any check fails. Run it after any schema change.

### Why the full comparison is there

Until 24 Aug 2026 the drill compared row counts and null counts, and passed
every time. It was passing while the restore path shifted **every timestamp in
the database by eight hours**.

node-postgres reads `timestamp without time zone` as a *local* time, and the
dump wrote it back with `Date.toISOString()`, which is UTC. Inserting
`2026-08-09T00:59:08.954Z` into a naive timestamp column stores the UTC wall
clock, so `08:59` came back as `00:59`. The schema has 91 naive timestamp
columns: due dates, fine calculations, audit trails, loan history, hold expiry,
booking windows. Restoring twice shifted them twice.

Dumps now keep date and time values as the server's own text and pin the
session to UTC, so a dump taken anywhere restores identically. Two consequences:

- The dump format is now `dls-ndjson-2`. Restoring a `dls-ndjson-1` dump fails
  with an explanation instead of silently shifting time. Any dump in `backups/`
  from before this date is a v1 dump and is wrong about time.
- `npm run test:compare` exists to keep the verifier honest. It builds a real
  copy, proves it compares clean, then damages it six ways and proves each one
  is caught. A checker that only ever says "identical" is worse than none,
  because it launders a bad restore into a signed-off one.

### Restoring

```bash
RESTORE_URL='<target database url>' npm run backup:restore -- backups/<file>
```

`RESTORE_URL` is deliberately separate from `DATABASE_URL`: a restore replaces
data, and defaulting to the app's own database is how a drill becomes an
outage. Restoring over the live database additionally requires
`--i-understand-this-overwrites`.

To recover production from a dump:

1. Take a fresh backup first: you may need to get back to the current state.
2. Drill the dump you intend to use, so you know it is good.
3. Put the app in a state where staff are not writing (Vercel: promote a
   maintenance deployment, or accept the window).
4. `RESTORE_URL=<production> npm run backup:restore -- <file> --i-understand-this-overwrites`
5. Confirm with `npm run db:which` and spot-check the admin UI.

## The test database

`.env` points at **production**. Before this was set up, every test suite that
created a fixture was writing to live data.

```bash
npm run db:test:provision      # creates neondb_test, writes .env.test
npx tsx --env-file=.env.test prisma/seed.ts
```

Run suites against it:

```bash
npx tsx --env-file=.env.test <script>
```

`npm run db:which` and `npm run db:test:which` print the resolved database, so
there is never a guess about which one a command is about to touch.

**Trap worth knowing:** `prisma.config.ts` prefers `POSTGRES_URL_NON_POOLING`
over `DATABASE_URL`. Overriding only `DATABASE_URL` when shelling out to the
Prisma CLI will send `db push` at production. Override all three
(`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `POSTGRES_URL_NON_POOLING`), as
`scripts/backup-drill.ts` and `scripts/provision-test-db.ts` do.

## Still open: decisions and credentials

These need a person, not a script.

### 1. Nobody we can log into owns this database  *(blocks the 30-day window)*

This is the one to fix first, because every other recovery decision sits on
top of it.

The database reports itself as Neon project **`autumn-frog-86115224`**,
Postgres **17.11**. Searching for it on 23 Aug 2026 found it in none of the
places it should have been:

| Where we looked | What is there | Ours? |
| --- | --- | --- |
| Neon org `org-tiny-queen-44468184` "Kydon", plan **scale**, as `tech-admin@zillearn.com` | `ZilLearn Kydon Group` (`soft-dream-24298924`, PG 18, window 1 day) and `ZilLearn` (`super-sea-42754053`, PG 18, window 6 hours) | **No** |
| Vercel team `zil-learn` → Storage (the only Neon store) | `libtwo-db`, Neon ID `jolly-heart-02510119`, plan **Free**, region sin1, attached to the `libtwo-revamp` project | **No** |
| Vercel project `library-platform` → integrations | no marketplace resources; `DATABASE_URL` is a hand-added plain env var | n/a |

So the Scale upgrade bought on 23 Aug 2026 applies to two projects that are not
this one, and the production library database is sitting in an account we have
no console or API access to. Its plan, its history window, and whether anyone
else can delete it are all unknown.

Consequences, stated plainly:

- **The 30-day history window cannot be set.** It is a project-level setting and
  we cannot reach the project.
- **We do not know the current recovery range.** It could be 6 hours.
- `npm run backup` still works (it only needs the connection string), so the
  verified logical backups are, for now, the *only* recovery path we control.

**The move is planned and the tooling is built**: see
[NEON-MOVE.md](NEON-MOVE.md) for the runbook and `npm run neon:move`. It needs a
Neon API key for the account that owns the Kydon organisation; nothing else is
outstanding.

To resolve, one of:

1. **Log into the Neon account that owns `autumn-frog-86115224`**, create an API
   key there, and run the script below. Likely a different Neon login than
   `tech-admin@zillearn.com` (note the Postgres version: 17.11 here, 18 on the
   Kydon-org projects, so this project was created earlier or elsewhere).
2. **Move the database into the Kydon org**, which is already paid up to Scale:
   create a project there, `npm run backup`, restore into it, repoint
   `DATABASE_URL`/`POSTGRES_URL_NON_POOLING` on Vercel, redeploy. The
   backup/restore path is drilled (`npm run backup:drill`), so this is a short
   write-freeze rather than a risk. It also buys scheduled snapshots and IP
   Allow, and puts the database under an account we administer, which is the
   answer KLSI will want when they ask who can delete their data.

Note that "Open in Neon" from the Vercel storage page starts a *separate* Neon
signup for the Vercel-managed org and, on 23 Aug 2026, ended at an unverified
email-address wall. It also signed the existing console session out. Do not
click it while relying on the console session.

Once the project is reachable:

```bash
npm run neon:retention                 # identify the project, show the window
npm run neon:retention -- 30d          # set it, then read it back to confirm
```

The script asks the running database for its own `neon.project_id` and refuses
to touch anything else: if the key cannot see that project it lists what the
key *can* see and exits without writing. That guard is what surfaced this
problem. It needs `NEON_API_KEY` in `.env` (git-ignored); create one at Neon
console → Account settings → API keys. The Vercel/Neon integration does **not**
expose a key. Accepted spans: `0`, `6h`, `1d`, `7d`, `14d`, `30d`.

### 2. IP Allow would not protect the app tier even once it is available

Scale includes IP Allow (so it comes with (1), not before it), and the instinct
is to lock the database to the
application's addresses. That does not work here: Vercel does not give
functions static egress IPs below Enterprise **Secure Compute**, so there is
no stable address to allowlist. Applying IP Allow now would lock out the app
itself.

Two things it *can* usefully do today:

- restrict access to known administrator machines for direct `psql`/tooling
  access, while leaving the application path open, or
- become genuinely useful once the app runs somewhere with a fixed egress
  address (Secure Compute, or a small proxy with a static IP).

Private networking has the same shape: it needs the compute side to support
it.

### 3. Decide where offsite copies live

The repo is **public**, so GitHub Actions artifacts are effectively public:
anyone with a free GitHub account can download them, and services exist that
strip even the login requirement. A dump of member records must never go
there.

Recommended target: **AWS S3 in `ap-southeast-1`** with GitHub OIDC role
assumption (no long-lived key in CI), Object Lock for immutable retention, and
the file already encrypted by `BACKUP_KEY` before upload. S3 is the only
common option that gives a hard Singapore residency guarantee. Cloudflare R2
treats APAC as a best-effort location hint, not a commitment.

### 4. Get the IM8 parameters in writing from KLSI

IM8 binds KLSI and reaches this project through the contract. Ask the system
owner for:

- the system's data classification and risk tier,
- the DP-1 data-residency country, and whether backups encrypted at source may
  sit outside Singapore,
- the BR-1/BR-2/BR-3 values: backup frequency, restore-test frequency, and how
  many days backups must be immutable.

The relevant public control catalog is
<https://info.standards.tech.gov.sg/control-catalog/cybersecurity/>: BR-1
(backup and store separately), BR-2 (test recovery), BR-3 (prevent
modification/deletion), DP-1 (residency), DP-2/3 (encryption at rest and in
transit).

### 5. Scheduling

Vercel's Hobby cron quota is full (2/2: `sftp-fetch` 03:00 UTC, `link-check`
02:00 UTC, the latter already chaining renewal alerts and serial claims). A
serverless function also has no persistent disk to write a dump to, so the
backup job belongs wherever the offsite target is decided (the Vercel cron
quota is no longer the constraint: Pro allows 40). A GitHub Actions schedule
pushing to S3 is the natural home once (2) is settled.

Until then, the honest position: **backups are verified but manual.** Run
`npm run backup` with `BACKUP_KEY` set before and after any risky change.

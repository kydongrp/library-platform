# Backup and recovery runbook

Applies to the DLS Admin database (Neon Postgres, `neondb`, region
`ap-southeast-1`).

## The one thing to understand first

**Neon takes no traditional backups.** There is no nightly dump to download.
Recovery on Neon rests entirely on the project's *history window* (instant
restore / point-in-time restore), and **the default is short on every plan**:

| Neon plan | History window default | Maximum |
| --- | --- | --- |
| Free | 6 hours | 6 hours (also capped at 1 GB of change history) |
| Launch | 1 day | 7 days |
| Scale | **1 day** | **30 days** |

This project is on **Scale** (upgraded 23 Aug 2026), so 30 days is available.

> **The upgrade does not apply it.** The default stays at 1 day until someone
> raises it. Buying Scale and not moving the slider leaves you with the same
> 1-day window you had before — check it, do not assume it.

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
5. checks every table's row count against the manifest, then compares real
   values (resource titles, member emails, copy barcodes, loan due dates,
   audit timestamps, JSON detail, MARC subfield arrays), confirms timestamps
   and integers came back as timestamps and integers rather than strings, and
   confirms no orphaned rows,
6. drops the throwaway database.

It exits non-zero if any check fails. Run it after any schema change.

### Restoring

```bash
RESTORE_URL='<target database url>' npm run backup:restore -- backups/<file>
```

`RESTORE_URL` is deliberately separate from `DATABASE_URL`: a restore replaces
data, and defaulting to the app's own database is how a drill becomes an
outage. Restoring over the live database additionally requires
`--i-understand-this-overwrites`.

To recover production from a dump:

1. Take a fresh backup first — you may need to get back to the current state.
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

## Still open — decisions and credentials

These need a person, not a script.

### 1. Raise the history window to 30 days  *(still outstanding)*

The plan is Scale, so 30 days is available — but the window is still at the
1-day default until it is changed. Neon console → project → Settings →
Instant restore.

Or use the script, which finds the right project by matching the compute
endpoint in `DATABASE_URL` (so a multi-project account cannot get the wrong
one reconfigured) and reads the value back instead of trusting the write:

```bash
npm run neon:retention                 # show the current window
npm run neon:retention -- 30d          # set it, then confirm
```

It needs `NEON_API_KEY` — create one at Neon console -> Account settings ->
API keys and add it to `.env` (git-ignored). The Vercel/Neon integration does
**not** expose a key. Accepted spans: `0`, `6h`, `1d`, `7d`, `14d`, `30d`.

### 2. IP Allow is available now, but cannot protect the app tier yet

Scale includes IP Allow, and the instinct is to lock the database to the
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

The repo is **public**, so GitHub Actions artifacts are effectively public —
anyone with a free GitHub account can download them, and services exist that
strip even the login requirement. A dump of member records must never go
there.

Recommended target: **AWS S3 in `ap-southeast-1`** with GitHub OIDC role
assumption (no long-lived key in CI), Object Lock for immutable retention, and
the file already encrypted by `BACKUP_KEY` before upload. S3 is the only
common option that gives a hard Singapore residency guarantee — Cloudflare R2
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
<https://info.standards.tech.gov.sg/control-catalog/cybersecurity/> — BR-1
(backup and store separately), BR-2 (test recovery), BR-3 (prevent
modification/deletion), DP-1 (residency), DP-2/3 (encryption at rest and in
transit).

### 5. Scheduling

Vercel's Hobby cron quota is full (2/2: `sftp-fetch` 03:00 UTC, `link-check`
02:00 UTC, the latter already chaining renewal alerts and serial claims). A
serverless function also has no persistent disk to write a dump to, so the
backup job belongs wherever the offsite target is decided (the Vercel cron quota is no longer the constraint — Pro allows 40) — a GitHub Actions
schedule pushing to S3 is the natural home once (2) is settled.

Until then, the honest position: **backups are verified but manual.** Run
`npm run backup` with `BACKUP_KEY` set before and after any risky change.

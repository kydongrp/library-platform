# DLS Admin

An integrated library system for library staff, built for KLSI to replace the Vibrant
ILS. The functional shape follows the DSTA DLS@Internet System Design Document v1.8.

**This is the staff side only.** The learner-facing portal is a separate system that
already exists; this application serves it through a read-only REST API at
`/api/portal/v1`. There is no patron interface here.

Live at <https://library.zillearn.com>.

---

## Status, honestly

The system is broad: 24 staff modules, 61 database tables, roughly 194 distinct
capabilities. A full capability register, compiled by reading the code rather than the
specification, records which of those are complete and which are not.

Five things to know before treating any of it as production-ready:

1. **There is no authentication.** `/admin/signin` lists the active staff accounts and one
   click becomes that person. The session cookie holds the account id, unsigned. This is a
   deliberate placeholder: authorisation on top of it is fully built and enforced
   server-side on every page and every action, so swapping in Azure AD replaces the
   sign-in flow without touching the permission model. Nothing should reach a real
   deployment until it is replaced.
2. **Two pages disclose data without a session**, both consequences of (1): the sign-in
   page lists staff names and email addresses, and `/` shows live counts of titles,
   copies, members and active loans. There is no `middleware.ts`; each page guards itself.
3. **No mail is sent.** Notices are generated and recorded in an outbox. No SMTP is
   configured, so email is simulated end to end.
4. **Nothing sets a timezone.** Due-today and overdue calculations use the server clock, so
   on a UTC runtime a loan due today reads as overdue between midnight and 8am Singapore
   time. The scheduled jobs are pinned to the Singapore region but their cron expressions
   are UTC.
5. **`Resource` and `Member` carry no indexes.** Fine for the demo dataset, not for the
   528,000-record parity target. Index design has not been done.

---

## Tech stack

| Layer     | Choice                                                            |
| --------- | ----------------------------------------------------------------- |
| Framework | Next.js 16 (App Router, React 19, Server Components and Actions)  |
| Language  | TypeScript                                                        |
| Database  | Postgres via Prisma 7 driver adapters (`@prisma/adapter-pg`), Neon in production |
| Styling   | Tailwind CSS v4, hand-built component set                         |
| Hosting   | Vercel, functions pinned to `sin1` (Singapore)                    |

There is no separate backend. Pages read the database directly in Server Components and
every mutation goes through a server action in `src/app/actions/`. The Prisma client is
generated to `src/generated/prisma` and the schema ships via `prisma db push` in the build
command, so there is no migrations directory.

> **Working on this codebase?** See `AGENTS.md`. This is Next.js 16, and the guides in
> `node_modules/next/dist/docs/` are the reference, not what you remember of Next 14.

---

## Getting started

You need a Postgres database. [Neon](https://neon.tech) is the quickest free option.

```bash
npm install
cp .env.example .env      # then fill in DATABASE_URL
npm run db:push           # create the tables
npm run db:seed           # load the demo catalogue, members, loans and holds
npm run dev               # http://localhost:3000/admin
```

`npm run db:reset` returns the database to the seeded demo state. It runs
`prisma db push --force-reset`, which **drops every table first**, so never point it at
data you want to keep.

### Environment

Only `DATABASE_URL` is required. Everything in `.env.example` beyond it is optional and
each feature it gates degrades to a clear "not configured" state rather than failing.

Three connection-string variables exist and are not interchangeable:

| Variable                   | Used by                                              |
| -------------------------- | ---------------------------------------------------- |
| `DATABASE_URL`             | the application at runtime; use the **pooled** host  |
| `POSTGRES_URL_NON_POOLING` | `prisma.config.ts`, so every Prisma CLI command      |
| `DATABASE_URL_UNPOOLED`    | the backup and restore scripts                       |

`prisma.config.ts` prefers `POSTGRES_URL_NON_POOLING` and the dump library prefers
`DATABASE_URL_UNPOOLED`. Changing only `DATABASE_URL` therefore leaves `db push` and every
backup pointed at whatever the other two still name. Change all three together.

---

## Scripts

| Command                            | What it does                                             |
| ---------------------------------- | -------------------------------------------------------- |
| `npm run dev`                      | Dev server                                               |
| `npm run build`                    | `prisma db push`, seed-if-empty, then the production build |
| `npm run lint`                     | ESLint                                                   |
| `npm run db:push`                  | Apply the schema                                         |
| `npm run db:seed`                  | Load demo data                                           |
| `npm run db:reset`                 | Drop everything, re-apply, re-seed                       |
| `npm run db:which`                 | Print which database `.env` resolves to                  |
| `npm run db:test:provision`        | Create `neondb_test` and write `.env.test`               |
| `npm run db:test:which`            | Same as `db:which`, for `.env.test`                      |
| `npm run backup`                   | Full logical backup to `backups/` (git-ignored)          |
| `npm run backup:drill`             | Prove a backup restores, end to end, then clean up       |
| `npm run backup:restore -- <file>` | Restore a dump into `RESTORE_URL`                        |
| `npm run db:compare`               | Prove two databases hold the same thing (read only)      |
| `npm run test:crypt`               | Backup encryption round-trip tests                       |
| `npm run test:compare`             | Prove the comparison detects six kinds of damage         |
| `npm run test:fidelity`            | Prove the dump round-trips awkward values                |
| `npm run neon:retention`           | Show or set the point-in-time recovery window            |
| `npm run neon:move`                | Move the database to another Neon project                |

The three `test:*` suites cover the operational tooling. **Nothing under `src/` has a
test.** The pure rule libraries (`calendar-core`, `fines`, `booking-core`,
`stocktake-core`, `item-import`, `member-import`, `routing-core`, `flexi-core`) take no
database and were written to be testable, so they are the cheapest place to start.

CI (`.github/workflows/ci.yml`) runs lint and a production build on every push and pull
request against `master`, on Node 24 to match the Vercel builder. It points the three
connection strings at a closed port, so a green run proves the build never needed a
database. It does not run the `test:*` suites, which need one.

---

## What is in it

Twenty-four modules, gated by a per-module view/edit matrix.

**Catalogue and metadata.** Bibliographic records with a full MARC 21 field editor working
against a staff-editable tag dictionary (33 seeded tags including the five DSTA local 9XX
fields). Authority types and headings. Batch find-and-replace across one tag, with a run
history because it has no undo. Duplicate detection and record merging, with a merge log.
Six ways in: hand entry, external scholarly search across Crossref, OpenAlex and IEEE, an
AI-assisted draft from a DOI or citation, bulk CSV/JSON/XML/MARCXML file import, a
scheduled SFTP vendor drop, and MARCXML or ISO 2709 export back out.

**Items and stocktake.** Copies and generated barcodes, collection, location and item-type
code lists, batch property changes, weeding with a permanent log, and a scan-based
stocktake that reconciles the shelf against the catalogue and freezes the result.

**Circulation.** Check out, check in with a condition, renew, recall. A loan policy matrix
keyed on member type and item type. Due dates rolled off days the library is closed.
Hourly loans for equipment. Fines that accrue only on open days, with grace and cap, and
settlement by payment or a recorded waiver. Claimed returns, which freeze the fine clock
at the claim date rather than the day the item turns up. A hold shelf with queue promotion
and pickup expiry. Bookings of one specific item over a definite window.

**Members.** Records, staff-defined statuses with a borrowing flag, member types, per-member
loan ceilings, location and department code lists, CSV import, and a per-member account
view.

**Serials and acquisitions.** Issue prediction from the publication pattern, receipting,
late detection and vendor claims, routing lists that move an issue between named
subscribers, and the money trail from fund and account through purchase order to invoice.

**E-resources and integration.** Subscription registry with renewal runway, COUNTER R5
usage import and cost-per-use, a nightly link scan that finds broken access before a
learner does, licence-seat limits on digital loans, the read-only portal API, API client
keys, and outbound signed webhooks with a delivery log.

**Reporting.** Thirteen standard reports (five core: loans by period, overdue loans,
reservations, member activity, catalogue inventory; eight module reports: fines ledger,
item inventory, weeding log, fund utilisation, purchase orders, invoices, subscription
holdings, issue arrivals), six operational dashboards, FlexiReports for cross-tab
questions nobody anticipated, contribution tracking, and CSV export on everything that
lists.

**Administration.** Staff accounts and groups, a twelve-area view/edit permission matrix
enforced server-side on every page and re-checked inside every action, an append-only
audit trail with over 130 recording points across 20 action families, twelve editable
notice templates, the batch console, and the search vocabulary (stop words and variant
spellings) that decides what a catalogue search matches.

---

## Driving the demo

Sign in at `/admin/signin`. Three seeded accounts show the access matrix from three angles:

| Account          | Group         | Sees                                  |
| ---------------- | ------------- | ------------------------------------- |
| Sarah Admin      | Administrators | everything                            |
| Liam Librarian   | Librarians     | operations, not admin settings        |
| Rita Reports     | Reports Only   | dashboards and reports, read-only     |

Signing in as Rita is the fastest way to see the permission model working: the sidebar
shrinks, pages render disabled with a read-only banner, and the export endpoints return
403.

1. **Circulation Desk.** Pick a member, paste an available barcode from the panel into
   Check out, then return it with the same barcode and a condition.
2. **Catalogue.** Search, open a title, edit its MARC fields, add copies, then try
   **Global change** and **Merge** from the same module.
3. **Current Loans.** Four tabs: all active, overdue, hourly, and claimed returns. Overdue
   rows show the fine accruing live with the open-day count behind it.
4. **Library Calendar.** Add a closure, then check out something: the due date rolls past
   it, and a fine stops counting across it.
5. **Items > Stocktake.** Open a stocktake scoped to a collection or location, scan
   barcodes, and watch the missing list build.
6. **Batch Processes.** Run the end-of-day process and inspect the run history, the mail
   outbox and the notification feed.
7. **FlexiReports.** Build a cross-tab, then export it.
8. **Audit Trail.** Everything above is there, with a before-and-after extract where the
   calling code passed one.

---

## Data model

61 tables. The core of it:

```
Resource ──< Copy              a catalogue title and its physical holdings
Resource ──< MarcField         the MARC record, against MarcTagDef
Resource ──< Loan              digital loans have no Copy
Resource ──< Reservation       a hold, queued by the time it was placed
Copy     ──< Booking           one item held for a definite window
Member   ──< Loan, Reservation, Booking
Serial   ──< SerialIssue ──< IssueRoutingStop
AcqFund  ──< PurchaseOrder ──< PoLine, Invoice
Stocktake ──< StocktakeScan
```

Every controlled vocabulary is stored as a plain `String`. There are no Prisma enums and
no database check constraints, so `src/lib/constants.ts` is the only place a status is
defined and the only thing enforcing it is application code.

Where the rules live:

| Concern                              | File                          |
| ------------------------------------ | ----------------------------- |
| Loan periods, limits, renewals, fines | `src/lib/policies.ts` plus the `LoanPolicy` table |
| Due dates and open-day counting      | `src/lib/calendar-core.ts`    |
| Fine accrual, grace and cap          | `src/lib/fines.ts`            |
| Booking windows and overlap          | `src/lib/booking-core.ts`     |
| Search tokenising and variants       | `src/lib/search-terms.ts`     |
| Controlled vocabularies              | `src/lib/constants.ts`        |

Seeded policies: Default and Student 14 days / 5 loans / 2 renewals, Staff 30 / 10 / 3,
External 7 / 3 / 1. Fine rates seed at zero, so fines are off until a rate is entered on
the Loan Policies page.

---

## Operations

The database has no traditional backups: Neon's recovery rests on the project's history
window. `docs/BACKUP.md` is the runbook, and it leads with the thing that catches people,
which is that buying a bigger plan does not widen that window.

What is in place: a portable logical backup that does not depend on `pg_dump`, optional
AES-256-GCM encryption at source, a drill that restores into a throwaway database and
compares every row of every table against the live one, and a comparison tool that is
itself tested against six kinds of deliberate damage.

`docs/NEON-MOVE.md` covers relocating the database to another Neon project, which is
currently outstanding: the production database sits in a project no reachable account
owns.

`/api/diagnostics/database` (bearer `CRON_SECRET`) makes the deployed application report
which Neon project, branch and endpoint it is actually talking to. Checking locally only
proves what `.env` says.

---

## Deploying

The repo is git-connected to the Vercel project, so **`git push origin master` deploys to
production**. The build runs `prisma db push`, then a seed that skips itself when the
database already holds data, then the Next build.

For a fresh deployment: import the repo on Vercel, set `DATABASE_URL` and
`POSTGRES_URL_NON_POOLING` in the project environment, and deploy. `vercel.json` pins
`framework: nextjs` (without it the routes 404 despite a green build), pins functions to
`sin1`, and schedules four cron jobs.

Note that `CRON_SECRET` must be set for those four jobs to run at all: the shared guard is
fail-closed and refuses rather than executing anonymously.

---

## Known gaps

Beyond the five at the top:

- **No screen places a hold.** The queueing, promotion, expiry and notification logic is
  complete and correct; nothing calls it.
- **Digital loans cannot be started from any screen.** The licence-seat logic works and the
  return-side seat handover runs, but the desk form posts a barcode where the digital path
  needs a title.
- **The end-of-day process is a manual button.** Overdue notices, due-soon reminders and
  hold expiry only advance when someone presses it.
- **The catalogue and member lists are unpaginated**, and the catalogue list loads every
  matching record with all its copies plus a second full-table scan for the provider
  filter.
- **No error or not-found boundaries**, so a stale bookmark lands on the framework's bare
  404 outside the admin chrome.
- **No mobile navigation.** Below 768px the sidebar and the sign-out control are hidden, so
  a staff member on a phone can open a page by URL but cannot navigate or sign out.
- **No print path and no PDF.** Data leaves as CSV and MARC only.
- **No live region for assistive technology.** Toasts are the only feedback channel for
  every mutation and they carry no role, so a screen-reader user gets no confirmation of a
  save, a refusal or an import result.
- **The acquisitions budget position reads only the 100 most recent orders and invoices.**
  The Fund utilisation report is the authoritative figure.
- Two remaining rows from the client parity workbook: importing a PDF to create a
  bibliographic record, and the PDF help guides.

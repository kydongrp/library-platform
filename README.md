# Athenaeum — Library Management Platform

A modern library system with **two front doors** built as a single Next.js app:

- **Learner Portal** (`/portal`) — a discovery experience for patrons: search & browse,
  borrow digital titles instantly, reserve titles that are out, and track loans & holds.
- **Admin Panel** (`/admin`) — a back-office for staff: manage the catalogue and members,
  run the circulation desk (check-out / check-in), and watch loans, holds, and overdues.

It's a from-scratch variation on the reference functional specs (Admin Panel + Learner
Portal), scoped to the **core loop**: Catalogue → Members → Circulation (loans, returns,
renewals, reservations) → Search & discovery.

---

## Tech stack

| Layer     | Choice                                              |
| --------- | --------------------------------------------------- |
| Framework | Next.js 16 (App Router, React 19, Server Actions)   |
| Language  | TypeScript                                          |
| Database  | Postgres via Prisma 7 (node-postgres adapter); Neon in production |
| Styling   | Tailwind CSS v4, hand-built component set           |

There is no separate backend — pages read the database directly in Server Components, and
all mutations go through type-safe **Server Actions** in `src/app/actions/`.

---

## Getting started

You need a Postgres database. The quickest free option is [Neon](https://neon.tech).

```bash
npm install
# put your Postgres connection string in .env (see .env.example):
#   DATABASE_URL="postgresql://user:pass@host/db?sslmode=require"
npm run db:push     # create the tables
npm run db:seed     # load demo catalogue, members, loans, holds
npm run dev         # http://localhost:3000
```

Open **/** for the landing page, then enter either portal.

> To reset the database back to the demo state: `npm run db:reset`.

## Deploy to Vercel

1. **Create a Postgres database** at [neon.tech](https://neon.tech) (free tier) and copy the
   **pooled** connection string.
2. **Deploy the code** — either import the repo on [vercel.com/new](https://vercel.com/new),
   or from this folder run `npx vercel` (then `npx vercel --prod`).
3. In the Vercel project, add an environment variable **`DATABASE_URL`** = your Neon string.
4. The build runs `prisma db push`, so the schema is created on first deploy.
5. **Seed once**: locally set `DATABASE_URL` to the same Neon string and run `npm run db:seed`
   (or run it from Vercel's build once). Your live URL now has the demo data.

### Useful scripts

| Command             | What it does                                  |
| ------------------- | --------------------------------------------- |
| `npm run dev`       | Start the dev server                          |
| `npm run build`     | Production build (also type-checks)           |
| `npm run db:seed`   | Reset demo data to a known state              |
| `npm run db:reset`  | Drop & re-create the database from migrations |
| `npx prisma studio` | Browse/edit the database in a GUI             |

---

## How to drive the demo

**As staff (`/admin`):**

1. **Circulation Desk** — pick a member, paste one of the listed *available barcodes*
   (e.g. `LIB-001004`) into **Check out**. Return it via **Check in** with the same barcode.
2. **Catalogue** — search/filter, open a title to edit it, add/remove copies, mark a copy
   lost/maintenance, or add a brand-new title (with a live cover preview).
3. **Members** — add members, see each member's active loans/holds, renew or return for them.
4. **Current Loans / Reservations** — renew, return, or cancel holds; overdue items are flagged.

**As a learner (`/portal`):**

1. **Sign in** — pick an account to act as (no real auth in this MVP).
2. **Browse / search** — filter by category, format, and availability; sort results.
3. **Open a title** — borrow a digital title instantly, borrow an available physical copy,
   or **place a hold** when everything is out. The action adapts to live availability.
4. **My Loans / My Holds** — renew, return digital loans, or cancel holds.

The two portals share one database, so a checkout at the admin desk immediately changes a
title's availability in the learner portal, and a learner's hold shows up in the staff
reservations queue.

---

## Domain model

```
Resource  ──< Copy            a catalogue title and its physical holdings
Resource  ──< Loan            a borrowing transaction (digital loans have no Copy)
Resource  ──< Reservation     a hold placed when no copy is available
Member    ──< Loan, Reservation
```

Business rules live in `src/app/actions/circulation.ts`:

- Loan periods by member type (Student 14d, Staff 30d, External 7d); digital 14d.
- Loan limits per member; suspended members can't borrow.
- Returns auto-promote the next hold in the queue to **Ready for pickup**.
- Renewals are blocked when someone else is waiting (max 2 renewals).

See `src/lib/constants.ts` for the tunable vocabulary and policies.

---

## Project layout

```
prisma/
  schema.prisma        data model
  seed.ts              demo data
src/
  app/
    page.tsx           landing gateway
    admin/             Admin Panel (dashboard, circulation, catalogue, members, loans, reservations)
    portal/            Learner Portal (home, search, resource, my-loans, my-reservations, signin)
    actions/           server actions: circulation, catalogue, members, session
  components/          UI primitives, forms, toasts, nav, cards
  lib/                 db client, constants, formatting, availability, session
```

---

## What's MVP vs. later

**Built:** catalogue & copy management, members, full circulation (check-out/in, renew,
reserve, hold queue), search with filters/sort, dashboards, and a polished two-portal UI.
Also supports **externally-subscribed content** — IEEE Xplore journals, transactions,
conference papers, and standards (plus ACM / JSTOR) — catalogued with a `provider` and
access URL. These are accessed via the provider (a "Read on IEEE Xplore" link) rather than
loaned, and staff can filter the catalogue by source.

**Deliberately deferred** (natural next steps, mirroring the reference spec):
real authentication (Azure AD / email sign-up), reviews & ratings, notifications &
email templates, acquisitions & serials modules, fines/payments, and richer reporting.

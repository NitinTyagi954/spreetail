# DECISIONS.md — Decision Log

Every significant decision made during this project, the options considered, and why one was chosen. Written as decisions were made, not reconstructed at the end.

---

## Decision 1 — Database: Relational vs NoSQL

**Context:** Needed to pick a database before any schema work.

**Options considered:**
- MongoDB (document store, flexible schema)
- PostgreSQL (relational, strict schema)

**Chose:** PostgreSQL (via Neon)

**Why:** The assignment explicitly requires relational DBs. Beyond compliance, the data model has real relational structure — expenses reference users, splits reference expenses, memberships have foreign keys to both groups and users. Joins are the natural operation here. A document store would require manually maintaining referential integrity that PostgreSQL enforces for free.

**Trade-off accepted:** More upfront schema design required. Worth it for data integrity.

---

## Decision 2 — ORM: Prisma vs Sequelize vs raw SQL

**Context:** Needed an ORM to work with PostgreSQL from Node.js.

**Options considered:**
- Raw SQL (pg library directly)
- Sequelize (mature, widely used)
- Prisma (schema-first, newer)

**Chose:** Prisma 7

**Why:** Schema-first approach means the schema file is the source of truth — readable, version-controlled, and easy to explain in an interview. Migrations are auto-generated from schema diffs. The Prisma adapter pattern works cleanly with Neon's serverless PostgreSQL. Sequelize requires more boilerplate model definitions.

**Trade-off accepted:** Prisma 7 required a `prisma.config.ts` and separate `DIRECT_URL` for Neon — slightly more setup than Sequelize. Worth it for the cleaner developer experience.

---

## Decision 3 — Membership tracking: date-based vs flag-based

**Context:** Sam moved in mid-April. Meera moved out end of March. The app needs to know who was active on any given expense date.

**Options considered:**
- Boolean `isActive` flag on membership (simple, but loses history)
- Separate join/leave event log table
- `joinedAt` + `leftAt` fields on GroupMembership (date range per member)

**Chose:** `joinedAt` + `leftAt` on GroupMembership

**Why:** A boolean flag cannot answer "was this person a member on March 15?" — it only knows current state. An event log is more flexible but more complex to query. The date-range approach answers the membership question with a single WHERE clause: `joinedAt <= expense.date AND (leftAt IS NULL OR leftAt >= expense.date)`. This is exactly what Sam's requirement needs.

**Trade-off accepted:** A member who left and rejoined needs two separate GroupMembership records. Acceptable for this use case.

---

## Decision 4 — Negative amounts: error vs refund

**Context:** Row 26 has amount = -30 USD. Two interpretations exist.

**Options considered:**
- Treat as a data error, block import
- Treat as a refund/credit

**Chose:** Treat as refund, set `isRefund = true`

**Why:** The notes field says "one slot got cancelled" — context unambiguously confirms this is an intentional refund, not a mistake. A blanket error policy would silently lose valid financial data. The `isRefund` flag on the Expense model allows the balance calculation to handle these correctly (subtract from what the payer is owed rather than add to what they paid).

**Rule documented:** Any negative amount with a note explaining the reason → refund. Any negative amount with no context → flag for user confirmation.

---

## Decision 5 — Missing payer: guess vs block

**Context:** Row 13 has no paid_by. Note says "can't remember who paid."

**Options considered:**
- Default to group creator
- Split the cost as "unknown" and ignore the payer field
- Block this row until user assigns a payer

**Chose:** Block the row, require user to assign payer before import

**Why:** The payer field directly determines who gets reimbursed. Guessing wrong corrupts every member's balance. There is no safe default. The cost of blocking one row (user must make one decision) is much lower than the cost of a silently wrong balance that nobody notices until much later.

---

## Decision 6 — Duplicate resolution: auto vs user approval

**Context:** Two types of duplicates exist in the CSV — exact duplicates (same amount) and conflicting duplicates (same description, different amounts).

**Options considered:**
- Auto-delete exact duplicates, flag conflicting ones
- Flag all duplicates for user approval

**Chose:** Flag all duplicates for user approval (Meera's explicit requirement)

**Why:** Meera's requirement was "I want to approve anything the app deletes or changes." Auto-deleting even exact duplicates violates this. The cost is one extra click per duplicate. The benefit is the user never discovers a silent deletion after the fact.

---

## Decision 7 — Currency conversion: fixed rate vs live rate

**Context:** Several expenses are in USD. Priya's requirement: the sheet treated $1 = ₹1, which is wrong.

**Options considered:**
- Hard-code a fixed exchange rate (e.g. 1 USD = 83 INR)
- Fetch live rate from an API at import time
- Let user enter the rate manually

**Chose:** Fetch live rate at import time + let user override

**Why:** A fixed rate becomes wrong the moment exchange rates move. Fetching live ensures the conversion is accurate for when the expense actually occurred. The override option handles cases where the user knows the exact rate used (e.g. the rate their credit card charged). Both the original amount and the converted amount are stored, so the conversion is always auditable.

**Implementation note:** Rate is fetched once per import session and applied to all USD expenses in that session.

---

## Decision 8 — Percentage normalization: auto vs block

**Context:** Row 15 has percentages that sum to 110%, not 100%.

**Options considered:**
- Block the row, require user to fix percentages manually
- Auto-normalize proportionally and flag the change

**Chose:** Auto-normalize with user notification

**Why:** The note says "percentages might be off" — the user is aware it's approximate. Auto-normalizing (30/110, 30/110, 30/110, 20/110 → each divided by 1.1) preserves the intended ratio while making the math work. The change is shown to the user before confirmation. This is more useful than forcing the user to manually recalculate six decimal places.

---

## Decision 9 — Guest users (Kabir): create account vs ignore share

**Context:** Row 23 includes "Dev's friend Kabir" in the split. Kabir is not a flat member.

**Options considered:**
- Ignore Kabir's share, split only among flat members
- Create a guest User record for Kabir

**Chose:** Create guest User (`isGuest = true`)

**Why:** Ignoring Kabir's share means the flat members collectively absorb his cost — inaccurate. Creating a guest account lets the system track that Kabir owes his share without giving him login access. The `isGuest` flag keeps guest accounts clearly separated from real members in the UI.

---

## Decision 10 — Import flow: one-shot vs review-and-confirm

**Context:** The importer detects anomalies. The question is whether to apply all changes immediately or show them to the user first.

**Options considered:**
- Apply all auto-corrections immediately, show a report after
- Show all anomalies first, require user to approve each one, then import

**Chose:** Review-and-confirm (Meera's requirement)

**Why:** Meera explicitly said "I want to approve anything the app deletes or changes." A one-shot import with a post-hoc report cannot be undone easily if the user disagrees with a decision. The review step adds friction but prevents irreversible mistakes. The ImportSession status machine (PENDING → IN_REVIEW → COMPLETED) supports pausing at the review stage.

---

## Decision 11 — Split conflict resolution (Row 42): type wins vs details win

**Context:** Row 42 has `split_type = equal` but `split_details` contains individual share counts.

**Options considered:**
- Trust split_type, ignore split_details
- Trust split_details, override split_type

**Chose:** split_details takes priority

**Why:** split_details is more specific than split_type. If someone took the time to write out individual shares, those shares represent their intent more precisely than the type label. The type label is likely a data entry error (forgot to change "equal" to "share"). Flag the conflict and correct the type to SHARE.

---

## Decision 12 — `amountInINR` column: store vs compute

**Context:** USD expenses need to show as INR in balances. Two options for where this conversion lives.

**Options considered:**
- Store only original amount, compute INR on every balance query
- Store both original and converted amount in the Expense row

**Chose:** Store both in the Expense row (`amount`, `amountInINR`, `exchangeRate`)

**Why:** Computing on every query requires the exchange rate to be stored somewhere anyway. Storing it in the row makes every expense self-contained — you can always see what rate was used, when, and reproduce the exact calculation. Balance queries become simpler (just sum `amountInINR`) with no risk of a rate change retroactively altering historical balances.

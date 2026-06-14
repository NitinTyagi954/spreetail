# SCOPE.md — Anomaly Log and Database Schema

---

## Part 1: Database Schema

### Overview

8 tables, 4 enums. Every table exists because the CSV or a user requirement forced it to exist.

---

### User

```prisma
model User {
  id           String   @id @default(uuid())
  name         String
  email        String   @unique
  passwordHash String
  isGuest      Boolean  @default(false)
  createdAt    DateTime @default(now())
}
```

`isGuest = true` is used for people like Kabir (Dev's friend, Row 23) who appear in a split but are not flatmates and cannot log in. They exist in the system so their share is tracked but they have no account.

---

### Group

```prisma
model Group {
  id          String  @id @default(uuid())
  name        String
  description String?
  createdAt   DateTime @default(now())
}
```

A group represents the flat. One group for the flatmates. A trip (Goa) is not a separate group — it is a set of expenses inside the same group, filtered by date.

---

### GroupMembership

```prisma
model GroupMembership {
  id       String    @id @default(uuid())
  groupId  String
  userId   String
  joinedAt DateTime
  leftAt   DateTime?
}
```

This is the most important table in the schema. `leftAt` being null means the member is still active. This is what makes Sam's requirement possible — any expense dated before his `joinedAt` (mid-April) is excluded from his balance calculation. Meera's `leftAt` is set to 2026-03-31.

---

### Expense

```prisma
model Expense {
  id              String    @id @default(uuid())
  groupId         String
  description     String
  amount          Float
  currency        String    @default("INR")
  amountInINR     Float
  exchangeRate    Float     @default(1.0)
  date            DateTime
  paidById        String
  splitType       SplitType
  notes           String?
  isRefund        Boolean   @default(false)
  createdAt       DateTime  @default(now())
  importSessionId String?
}
```

`amountInINR` stores the converted amount. `amount` stores the original (e.g. $84 USD). `exchangeRate` records what rate was used so the conversion is always auditable. `isRefund` is set true for negative-amount rows (e.g. Row 26, parasailing refund).

---

### ExpenseSplit

```prisma
model ExpenseSplit {
  id         String @id @default(uuid())
  expenseId  String
  userId     String
  amount     Float
  percentage Float?
  shares     Int?
}
```

`amount` is always populated — it is the final INR amount this person owes for this expense, regardless of split type. `percentage` and `shares` are stored for auditability (Rohan's requirement: show exactly which numbers produced the final amount).

---

### Settlement

```prisma
model Settlement {
  id           String   @id @default(uuid())
  groupId      String
  paidById     String
  receivedById String
  amount       Float
  currency     String   @default("INR")
  date         DateTime
  notes        String?
  createdAt    DateTime @default(now())
  importSessionId String?
}
```

Row 14 of the CSV ("Rohan paid Aisha back ₹5000") is imported as a Settlement, not an Expense. The importer detects the note "this is a settlement not an expense" and routes it here.

---

### ImportSession

```prisma
model ImportSession {
  id        String       @id @default(uuid())
  groupId   String
  fileName  String
  status    ImportStatus @default(PENDING)
  totalRows Int          @default(0)
  imported  Int          @default(0)
  skipped   Int          @default(0)
  flagged   Int          @default(0)
  createdAt DateTime     @default(now())
}
```

Every CSV upload creates one ImportSession. Status moves: PENDING → IN_REVIEW (anomalies shown to user) → COMPLETED or CANCELLED. The import report is generated from this record plus its anomalies.

---

### ImportAnomaly

```prisma
model ImportAnomaly {
  id              String        @id @default(uuid())
  importSessionId String
  rowNumber       Int
  anomalyType     AnomalyType
  description     String
  rawData         String
  suggestedAction String
  status          AnomalyStatus @default(PENDING)
  resolvedAction  String?
  createdAt       DateTime      @default(now())
}
```

One record per anomaly detected. `rawData` stores the original CSV row as a string so nothing is ever lost. `resolvedAction` is written when the user approves or rejects the suggested action. This table is what produces the import report.

---

### Enums

```prisma
enum SplitType {
  EQUAL
  UNEQUAL
  PERCENTAGE
  SHARE
}

enum ImportStatus {
  PENDING
  IN_REVIEW
  COMPLETED
  CANCELLED
}

enum AnomalyStatus {
  PENDING
  APPROVED
  REJECTED
  MODIFIED
}

enum AnomalyType {
  DUPLICATE
  SETTLEMENT
  NEGATIVE_AMOUNT
  ZERO_AMOUNT
  MISSING_CURRENCY
  MISSING_PAYER
  INVALID_DATE
  AMBIGUOUS_DATE
  NAME_MISMATCH
  MEMBERSHIP_VIOLATION
  SPLIT_CONFLICT
  PERCENTAGE_MISMATCH
  EXTERNAL_MEMBER
  AMOUNT_FORMAT
}
```

---

## Part 2: Anomaly Log

15 data problems were found in `expenses_export.csv`. The assignment stated "at least 12." Every problem below was found by manually reading the CSV before writing any code.

---

### Anomaly 1 — Duplicate expense (Rows 5 & 6)

**Problem:** "Dinner at Marina Bites" appears twice. Same date (2026-02-08), same paid_by (Dev), same amount (₹3200). The second row has no notes, the first has "Dev visiting for the weekend."

**Detection method:** Compare description (case-insensitive) + date + amount across all rows in the session.

**Policy:** Flag both rows. Suggest keeping Row 5 (has notes, more complete). Require user approval before Row 6 is discarded. AnomalyType: `DUPLICATE`.

---

### Anomaly 2 — Conflicting duplicate (Rows 24 & 25)

**Problem:** Thalassa dinner logged by Aisha (₹2400) and by Rohan (₹2450). Same date, different amounts, different payers. Rohan's note says "Aisha also logged this I think hers is wrong."

**Detection method:** Same description + same date, different amounts. Cannot auto-resolve because amounts differ.

**Policy:** Flag both. Cannot suggest a winner automatically — amounts differ. User must pick which row is correct. AnomalyType: `DUPLICATE`.

---

### Anomaly 3 — Settlement logged as expense (Row 14)

**Problem:** "Rohan paid Aisha back" ₹5000. The notes field explicitly says "this is a settlement not an expense??" Split_type is blank.

**Detection method:** Notes field contains the word "settlement". Split_type is empty.

**Policy:** Import as a `Settlement` record (paidBy: Rohan, receivedBy: Aisha, amount: 5000). Do not create an Expense record. Flag for user confirmation. AnomalyType: `SETTLEMENT`.

---

### Anomaly 4 — Negative amount / refund (Row 26)

**Problem:** "Parasailing refund" amount = -30 USD. Note says "one slot got cancelled."

**Detection method:** amount < 0.

**Policy:** Treat as a refund. Set `isRefund = true`. Split equally among same members as Row 23 (the original parasailing expense). Do not treat as an error — context confirms it is intentional. AnomalyType: `NEGATIVE_AMOUNT`.

---

### Anomaly 5 — Zero amount (Row 31)

**Problem:** "Dinner order Swiggy" amount = 0. Note says "counted twice earlier - fixing later."

**Detection method:** amount === 0.

**Policy:** Skip this row entirely. A zero-amount expense affects no balances and is a placeholder note. Flag as skipped. AnomalyType: `ZERO_AMOUNT`.

---

### Anomaly 6 — Missing currency (Row 28)

**Problem:** Groceries DMart ₹2105 — currency column is blank.

**Detection method:** currency field is empty or null.

**Policy:** Default to INR. All other domestic expenses in the file are INR. Flag as auto-corrected so the user can see the assumption. AnomalyType: `MISSING_CURRENCY`.

---

### Anomaly 7 — Missing payer (Row 13)

**Problem:** "House cleaning supplies" ₹780 — paid_by is blank. Note says "can't remember who paid."

**Detection method:** paid_by field is empty.

**Policy:** Block this row from import. Do not guess the payer — a wrong guess silently corrupts every member's balance. User must assign a payer before this row can be imported. AnomalyType: `MISSING_PAYER`.

---

### Anomaly 8 — Mixed date formats

**Problem:** Three different date formats appear in the file:
- `2026-02-01` (ISO, rows 1–15, 35 onwards)
- `01/03/2026` (DD/MM/YYYY, rows 16–34)
- `Mar 14` (no year, Row 27)

**Detection method:** Attempt to parse with all known formats. If none match, flag as invalid.

**Policy:** Parse all known formats into a standard UTC DateTime. For "Mar 14" with no year, infer 2026 from surrounding rows. Flag all non-ISO rows as auto-corrected. AnomalyType: `INVALID_DATE`.

---

### Anomaly 9 — Ambiguous date (Row 34)

**Problem:** "Deep cleaning service" date = `04/05/2026`. Could be April 5 (DD/MM) or May 4 (MM/DD). The note says "is this April 5 or May 4? format is a mess."

**Detection method:** Date matches both DD/MM and MM/DD interpretations and surrounding rows use DD/MM format.

**Policy:** Flag for user confirmation. Cannot auto-resolve. Suggest April 5 based on DD/MM pattern of surrounding rows. Block import of this row until confirmed. AnomalyType: `AMBIGUOUS_DATE`.

---

### Anomaly 10 — Name mismatch: "Priya S" (Row 11)

**Problem:** paid_by = "Priya S" instead of "Priya". All other rows use "Priya".

**Detection method:** Fuzzy match paid_by against known member names. "Priya S" is close enough to "Priya" to be a match.

**Policy:** Normalize to "Priya". Flag as auto-corrected. AnomalyType: `NAME_MISMATCH`.

---

### Anomaly 11 — Name casing / whitespace (Rows 9, 27)

**Problem:** Row 9: paid_by = "priya" (lowercase). Row 27: paid_by = "rohan " (trailing space).

**Detection method:** After trim and title-case normalization, check if the result matches a known member.

**Policy:** Trim whitespace and normalize to Title Case silently. Log as auto-corrected. AnomalyType: `NAME_MISMATCH`.

---

### Anomaly 12 — Membership violation (Row 36)

**Problem:** April grocery (2026-04-02) — split_with includes "Meera" who left the flat on 2026-03-31.

**Detection method:** For each member in split_with, check if expense date falls within their `joinedAt`–`leftAt` window.

**Policy:** Remove Meera from the split. Re-split equally among Aisha, Rohan, Priya (active April members). Flag change for user approval. AnomalyType: `MEMBERSHIP_VIOLATION`.

---

### Anomaly 13 — Split type conflict (Row 42)

**Problem:** Furniture for common room — split_type = "equal" but split_details contains "Aisha 1; Rohan 1; Priya 1; Sam 1" (share notation). The two fields contradict each other.

**Detection method:** split_type is EQUAL but split_details is non-empty.

**Policy:** split_details takes priority over split_type. Treat as SHARE split. Flag as auto-corrected. AnomalyType: `SPLIT_CONFLICT`.

---

### Anomaly 14 — Percentage does not sum to 100% (Row 15)

**Problem:** Pizza Friday percentage split: Aisha 30% + Rohan 30% + Priya 30% + Meera 20% = 110%. Note says "percentages might be off."

**Detection method:** Sum all percentages in split_details. If result ≠ 100, flag.

**Policy:** Normalize each percentage proportionally so they sum to 100%. Show before/after to user and require approval. AnomalyType: `PERCENTAGE_MISMATCH`.

---

### Anomaly 15 — External/guest member (Row 23)

**Problem:** Parasailing split_with includes "Dev's friend Kabir" — not a registered flat member.

**Detection method:** split_with member name does not match any known User in the group.

**Policy:** Create a guest User record (`isGuest = true`, no email, no password). Kabir's share is tracked but he cannot log in. Flag for user awareness. AnomalyType: `EXTERNAL_MEMBER`.

---

### Anomaly 16 — Amount formatting (Rows 7, 29)

**Problem:** Row 7: amount = "1,200" (comma as thousands separator). Row 29: amount = " 1450 " (leading/trailing spaces).

**Detection method:** amount field fails direct float parse.

**Policy:** Strip commas and whitespace, then parse as float. Auto-corrected silently, logged in session.

---

*Total anomalies found: 16 (assignment required minimum 12)*

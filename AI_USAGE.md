# AI_USAGE.md — AI Tool Usage Log

---

## Tool Used

**Claude by Anthropic** (claude.ai, model: Claude Sonnet 4.6)  
Used as the primary development collaborator throughout this project.

---

## How Claude Was Used

Claude was used as a thinking partner and code collaborator — not as a code generator whose output was pasted without review. The workflow was:

1. Discuss the problem and understand requirements
2. Claude proposes an approach
3. I evaluate it against the actual CSV data and requirements
4. We iterate until the approach is correct
5. Claude helps write the code
6. I read every line, test it, and commit only what I understand

---

## Key Prompts Used

**Understanding the problem:**
> "I have a CSV with shared flat expenses. Read it and tell me every data problem you can find. Don't write any code yet."

**Schema design:**
> "Design a Prisma schema for a shared expenses app where group membership changes over time. One member left end of March, another joined mid-April. Their join and leave dates must affect which expenses they're included in."

**Anomaly detection:**
> "Write a Node.js function that detects duplicate rows in a CSV. Two rows are duplicates if they have the same description, date, and amount. Return an array of anomaly objects with rowNumber, type, description, and suggestedAction."

**Balance calculation:**
> "Write a function that takes all ExpenseSplits for a group and returns the net balance per user. Net = total amount paid - total amount owed. Walk me through the math before writing code."

**Import flow:**
> "Design the state machine for a CSV import. The user uploads a file, anomalies are detected, the user reviews and approves each one, then the import completes. What are the states and transitions?"

**Prisma + Neon setup:**
> "I'm using Prisma 7 with Neon PostgreSQL. What's the correct configuration for schema.prisma and prisma.config.ts when Neon requires both a pooled and a direct connection URL?"

- "Write a splits.js utility that handles EQUAL, UNEQUAL, PERCENTAGE,
  and SHARE split types. Each function must return an array of
  {userId, amount} where amounts sum exactly to the expense total."

- "Write an Express middleware that validates a Bearer JWT and attaches
  the decoded user to req.user."

- "For POST /api/expenses, write the membership validation logic.
  Given an expense date and a list of userIds, check that each userId
  has a GroupMembership where joinedAt <= date AND (leftAt IS NULL
  OR leftAt >= date)."

---

## Three Cases Where Claude Was Wrong

### Case 1 — Balance calculation formula was incorrect

**What Claude produced:**

```js
// Claude's initial suggestion
const balance = await prisma.expenseSplit.groupBy({
  by: ['userId'],
  _sum: { amount: true }
});
```

**Why it was wrong:** This sums only what each person *owes* across all splits. It does not subtract what each person *paid*. A person who paid ₹5000 and owes ₹1500 net should show +₹3500 (they are owed money). Claude's formula would show -₹1500 (they owe money) — the exact opposite of correct.

**How I caught it:** I walked through Rohan's balance by hand using the CSV data. Rohan paid the WiFi bill (₹1199) and the birthday cake (₹1500). Claude's formula showed Rohan with a negative balance (he owes money) when the manual calculation showed he should be positive. The numbers didn't match.

**What I changed:**

```js
// Correct formula
const paid = await prisma.expense.groupBy({
  by: ['paidById'],
  _sum: { amountInINR: true }
});

const owes = await prisma.expenseSplit.groupBy({
  by: ['userId'],
  _sum: { amount: true }
});

// net = paid - owed
// positive = this person is owed money
// negative = this person owes money
```

**Lesson:** Never trust a balance formula without walking through it manually for at least one member.

---

### Case 2 — Prisma 7 schema configuration was outdated

**What Claude produced:**

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}
```

**Why it was wrong:** Prisma 7 changed how Neon connections are configured. The `directUrl` field inside `schema.prisma` is a Prisma 5/6 pattern. Prisma 7 uses a separate `prisma.config.ts` file and the `PrismaPg` adapter from `@prisma/adapter-pg`. Claude's suggestion was based on older documentation and caused the migration to fail with a connection error.

**How I caught it:** Running `npx prisma migrate dev` failed with an adapter-related error. I checked the Prisma 7 changelog and the Neon integration docs, which showed the new pattern.

**What I changed:** Created `prisma.config.ts` with the adapter configuration and removed the connection URLs from `schema.prisma` entirely, as Prisma 7 requires.

**Lesson:** Claude's training data has a cutoff. For rapidly changing tools like Prisma, always verify against the official current documentation.

---

### Case 3 — Percentage normalization formula had a rounding error

**What Claude produced:**

```js
function normalizePercentages(splits) {
  const total = splits.reduce((sum, s) => sum + s.percentage, 0);
  return splits.map(s => ({
    ...s,
    percentage: (s.percentage / total) * 100
  }));
}
```

**Why it was wrong:** For Row 15 (30 + 30 + 30 + 20 = 110%), this produces:
- Aisha: 27.272727...%
- Rohan: 27.272727...%
- Priya: 27.272727...%
- Meera: 18.181818...%

These repeating decimals cause the final INR split amounts to not sum exactly to the expense total due to floating point precision. For a ₹1440 expense, the splits summed to ₹1439.9999... which fails validation.

**How I caught it:** Wrote a test that summed the split amounts and compared to the original expense amount. The comparison `splitTotal === expense.amount` failed. Logged the values and saw the floating point drift.

**What I changed:** Applied rounding and assigned the remainder to the largest share:

```js
function normalizePercentages(splits, totalAmount) {
  const total = splits.reduce((sum, s) => sum + s.percentage, 0);
  const normalized = splits.map(s => ({
    ...s,
    percentage: Math.round((s.percentage / total) * 10000) / 100,
    amount: Math.floor((s.percentage / total) * totalAmount * 100) / 100
  }));
  
  const distributed = normalized.reduce((sum, s) => sum + s.amount, 0);
  const remainder = Math.round((totalAmount - distributed) * 100) / 100;
  
  // add remainder to the largest split
  const maxIdx = normalized.reduce((maxI, s, i, arr) => 
    s.amount > arr[maxI].amount ? i : maxI, 0);
  normalized[maxIdx].amount += remainder;
  
  return normalized;
}
```

**Lesson:** Floating point arithmetic in financial calculations always needs explicit rounding. Never compare floats with `===`. Always verify that split amounts sum exactly to the expense total.

---

## General Observations

- Claude is reliable for boilerplate, schema structure, and explaining concepts
- Claude's knowledge of rapidly-changing tools (Prisma 7, Neon adapter) can be outdated — always verify against current docs
- Claude never catches domain-specific errors (like a balance formula that's logically wrong for this specific app) — those require manual verification
- The most useful prompts were specific and gave Claude the actual data to work with, not abstract descriptions

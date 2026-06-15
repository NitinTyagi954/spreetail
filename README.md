# Spreetrail — Shared Expenses App

Spreetrail is a shared expenses management web application designed for housemates to track communal costs, manage date-based memberships, detect spreadsheet export anomalies, and calculate settle-up balances accurately.

## Technology Stack
- **Backend**: Node.js, Express.js
- **Database ORM**: Prisma 7
- **Database**: Neon Serverless PostgreSQL
- **Verification**: Native Node.js test scripts

---

## AI Collaboration Log
This project was developed in close collaboration with **Claude (Anthropic)**.
For details on key prompts, revision patterns, and learning logs, see [AI_USAGE.md](file:///c:/Users/hp/Desktop/Spreetree/AI_USAGE.md).

---

## Split Types Supported
The application natively handles and validates four split formats:

| Split Type | Description | Schema Representation |
| :--- | :--- | :--- |
| **EQUAL** | Cost is divided evenly among participants. | `splitType = EQUAL`, splits have equal base amounts with remainder adjusted. |
| **UNEQUAL** | Participants owe specific absolute values. | `splitType = UNEQUAL`, splits have user-defined amounts summing to the total. |
| **PERCENTAGE** | Participants owe split shares by percentage. | `splitType = PERCENTAGE`, sum of percentages must equal 100%. |
| **SHARE** | Participants owe split shares weighted by integer values. | `splitType = SHARE`, proportional to the sum of shares. |

---

## API Endpoints (implemented so far)

### Auth
- POST /api/auth/register — create account
- POST /api/auth/login — returns JWT

### Groups
- POST /api/groups — create group
- GET /api/groups/:id — get group with members
- POST /api/groups/:id/members — add member (with joinedAt)
- DELETE /api/groups/:id/members/:userId — remove member (sets leftAt)

### Expenses
- POST /api/expenses — create expense with split validation

All routes except register and login require:
Authorization: Bearer <token>

---

## Setup and Running Instructions

### Backend Setup
1. Navigate to the `backend/` directory:
   ```bash
   cd backend
   ```
2. Install the Node.js packages:
   ```bash
   npm install
   ```
3. Configure the `.env` file with your connection strings (e.g. copying `.env` values).
4. Run the database migrations to synchronize your Neon database:
   ```bash
   npx prisma migrate dev
   ```
5. Generate the Prisma Client:
   ```bash
   npx prisma generate
   ```

### Running Locally
- Start the development server (runs on port 5000):
  ```bash
  npm run dev
  ```
- Run the splits unit tests:
  ```bash
  npm run test
  ```
- Run the integration endpoint validation tests:
  ```bash
  node verify-endpoints.js
  ```

### Troubleshooting
- **Database Connection Issues (DNS Resolution & Transactions)**:
  - Ensure that `DIRECT_URL` in your `.env` points to the direct (non-pooler) host (`ep-...neon.tech`). Neon's pooler URL (`-pooler`) runs in **Transaction Mode**, which does not support Prisma's multi-statement interactive transactions (`prisma.$transaction`).
  - Avoid overriding runtime DNS settings (e.g., forcing `8.8.8.8`) at the application layer if your local network restricts/blocks external DNS lookups.


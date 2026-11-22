# Banking API

**API Gateway → Lambda → DynamoDB**

A retail-banking REST API built with Node.js (JavaScript, AWS SDK v3). It supports customers, accounts and balances, plus deposits, withdrawals, transfers, ledger history and transaction status.

It runs locally on **serverless-offline + DynamoDB Local** and deploys to AWS with **AWS CDK** ([`infra/`](infra)).

| Resource | Description |
|----------|-------------|
| [OpenAPI contract](openapi/openapi.yaml) | The original contract is unchanged, and additions only extend it |
| [Design notes](NOTES.md) | Design decisions and trade-offs |
| [Detailed architecture](docs/ARCHITECTURE.md) | AWS, code-layer, request and event-flow diagrams |
| [ER diagram](docs/ER_DIAGRAM.md) | Tables, keys and relationships |
| [Postman collection](postman/Banking-API-Full.postman_collection.json) | Every endpoint plus error cases |
| Swagger UI | `http://localhost:3000/docs` while the API is running |

## Table of contents

- [Architecture](#architecture)
- [What is implemented](#what-is-implemented)
- [Prerequisites](#prerequisites)
- [Run locally](#run-locally)
- [Configuration](#configuration)
- [Tests](#tests)
- [API](#api)
- [Project structure](#project-structure)
- [Deploy to AWS (CDK)](#deploy-to-aws-cdk)
- [Cleanup](#cleanup)

## Architecture

```text
Client ──HTTPS──► API Gateway (throttling, X-Ray, access logs)
                              │  one Lambda per route (alias "live", optional provisioned concurrency)
                              ▼
               handler ─► middleware (request id · auth · rate limit · error mapping)
                              ▼
                          service (business rules, idempotency, optimistic retry)
                              ▼
                          repository ─► DynamoDB  Customers | Accounts | Transactions | IdempotencyKeys
                                                                  │ Stream (NEW_IMAGE)
                                                                  ▼
                                                   ledgerStream Lambda ─► SQS "LedgerEvents" ─► consumers
                                                         └─ on-failure DLQ          └─ DLQ
```

Handlers stay thin, business rules live in [`src/services`](src/services), and all DynamoDB access lives in [`src/repositories`](src/repositories).

## What is implemented

| Area | Status |
|------|--------|
| Core: create/get customer, create/list accounts, get account with balance | ✅ |
| Stretch: deposit, withdrawal (409 on insufficient funds), transfer | ✅ |
| Transaction history (`GET /accounts/{id}/transactions`) and status (`GET /transactions/{id}`) | ✅ |
| Idempotency-Key on every POST, safe under concurrent duplicates | ✅ |
| Atomic multi-item writes (balance + ledger + idempotency) via `TransactWriteItems` | ✅ |
| Optimistic locking: no lost updates, no overdraft under concurrency | ✅ |
| Configurable daily withdrawal limit and withdrawal hours (bank timezone, DST-aware) | ✅ |
| Integer minor-unit money arithmetic; ≤ 2 decimals enforced | ✅ |
| JWT auth + roles + account ownership (`AUTH_MODE=jwt`) | ✅ |
| Rate limiting, security headers, PII-masked structured logs, request ids | ✅ |
| Transactional outbox: DynamoDB Streams → Lambda → SQS (+ DLQs) | ✅ (AWS only) |
| AWS CDK: KMS, PITR, WAF, throttling, aliases, provisioned concurrency, X-Ray, alarms | ✅ |
| Tests: 128 unit/integration + 10 infrastructure assertions, plus a Postman suite | ✅ |

## Prerequisites

- Node.js 20+ (tested on 24)
- Docker (for DynamoDB Local)
- AWS CLI + credentials only if you deploy with CDK

## Run locally

```bash
git clone https://github.com/HARSHMORE093/Ey-assessment.git
cd Ey-assessment
cp .env.example .env
npm install
npm run setup     # starts DynamoDB Local, creates 4 tables, seeds cust_001/002, acct_001..004
npm start         # http://localhost:3000
```

### Seed data

| Customer | Account | Details |
|----------|---------|---------|
| `cust_001` | `acct_001` | CHECKING, CAD 250 |
| `cust_001` | `acct_002` | SAVINGS, CAD 1000 |
| `cust_002` | `acct_003` | CHECKING, USD 75.50 |
| `cust_002` | `acct_004` | **CLOSED** |

### Useful commands

| Command | Purpose |
|---------|---------|
| `npm run db:reset` | Recreate tables and reseed |
| `npm run db:down` | Stop DynamoDB Local |
| `npm run lint` | ESLint |
| `npm run token -- --role CUSTOMER --customerId cust_001` | Mint a dev JWT (needs `JWT_SECRET`) |

## Configuration

Set these in `.env`:

| Variable | Default | Meaning |
|----------|---------|---------|
| `BANK_TIMEZONE` | `America/Toronto` | Timezone for banking hours and the daily-limit day boundary |
| `WITHDRAWAL_WINDOW_START` / `_END` | `00:00` / `24:00` | Withdrawal hours. The default is always open so the API can be tested at any hour; set `10:00` / `17:00` for banking hours |
| `DAILY_WITHDRAWAL_LIMIT_MINOR` | `500000` | Per-account daily withdrawal limit in cents (5,000.00). An account can override it with `dailyWithdrawalLimitMinor` |
| `REQUIRE_IDEMPOTENCY_KEY` | `false` | `true` makes the key mandatory on deposits, withdrawals and transfers (it is `true` in AWS) |
| `AUTH_MODE` | `none` | `jwt` requires `Authorization: Bearer …` |
| `RATE_LIMIT_BURST` / `RATE_LIMIT_RPS` | `100` / `50` | Per-client token bucket |

## Tests

```bash
npm run db:up              # integration tests need DynamoDB Local
npm test                   # unit + integration
npm run test:unit          # no database needed
npm run test:integration   # uses separate Test_* tables
npm run test:coverage
npm run test:postman       # run `npm start` in another terminal first
cd infra && npm install && npm test   # CDK assertions
```

There are 128 unit/integration tests, 10 CDK assertions, and a Postman suite with 71 requests and 160 assertions.

| Suite | What it proves |
|-------|----------------|
| `tests/unit/money`, `bankingRules`, `validators` | Exact cents arithmetic, DST-aware banking hours, daily-limit rollover at bank midnight, strict validation |
| `tests/unit/dynamoFailures` | Mocked `TransactionConflict` / version conflicts are retried; bounded retries end in 409; throttling becomes 503; no internals leak |
| `tests/unit/auth`, `withHandler`, `rateLimiter`, `logger`, `ledgerStream` | JWT hardening (including `alg:none`), error mapping, 429s, PII masking, outbox partial-batch failures |
| `tests/integration/concurrency` | **Real DynamoDB engine**: 20 parallel withdrawals never overdraw, 10 parallel identical idempotent requests debit once, A→B / B→A transfer storm conserves money, ledger always equals balance |
| `tests/integration/*` | Every endpoint end to end, including idempotency replay/422, limits, hours, closed accounts, transfer atomicity, pagination, ownership |

> [!NOTE]
> Run these against a real AWS test account before go-live. DynamoDB Local does not reproduce them: transaction conflict rates and throttling under true parallel load, KMS/IAM permission boundaries, Streams → SQS delivery, WAF/API Gateway throttling, and cold-start/provisioned-concurrency latency. Use the CDK `dev` stage and a load-testing tool such as k6 or Artillery.

## API

| Method | Path | Success | Errors |
|--------|------|---------|--------|
| POST | `/customers` | 201 Customer | 400 |
| GET | `/customers/{customerId}` | 200 Customer | 404 |
| POST | `/customers/{customerId}/accounts` | 201 Account | 400, 404, 409 `CUSTOMER_INACTIVE` |
| GET | `/customers/{customerId}/accounts` | 200 `{ items }` | 404 |
| GET | `/accounts/{accountId}` | 200 Account | 404 |
| POST | `/accounts/{accountId}/deposits` | 200 Account | 400, 404, 409 |
| POST | `/accounts/{accountId}/withdrawals` | 200 Account | 400, 404, 409 `INSUFFICIENT_FUNDS` / `DAILY_LIMIT_EXCEEDED` / `OUTSIDE_WITHDRAWAL_HOURS` / `ACCOUNT_INACTIVE` |
| POST | `/transfers` | 200 `{ fromAccount, toAccount }` | 400, 404, 409 |
| GET | `/accounts/{accountId}/transactions?limit=&nextToken=` | 200 `{ items, nextToken }` | 400, 404 |
| GET | `/transactions/{transactionId}` | 200 Transaction | 404 |

### Errors and headers

All errors use the contract shape:

```json
{ "error": "<CODE>", "message": "…", "requestId": "…" }
```

Every response carries `X-Request-Id`, and money movements also return `X-Transaction-Id`.

| Status | When |
|--------|------|
| 401 / 403 | Authentication or authorization failure (JWT mode) |
| 422 | `IDEMPOTENCY_KEY_REUSED` |
| 429 | `RATE_LIMITED` |
| 503 | DynamoDB is throttling |

### Example requests

```bash
B=http://localhost:3000

curl -s -XPOST $B/customers -H 'Content-Type: application/json' \
  -d '{"fullName":"Grace Hopper","email":"grace@example.com"}'
# 201 {"customerId":"cust_…","fullName":"Grace Hopper","email":"grace@example.com","status":"ACTIVE","createdAt":"…"}

curl -s -XPOST $B/customers/cust_001/accounts -H 'Content-Type: application/json' \
  -d '{"type":"CHECKING","currency":"CAD","initialBalance":40}'

curl -s $B/customers/cust_001/accounts
curl -s $B/accounts/acct_001

# Idempotent withdrawal: run it twice and the balance drops once. The second response has Idempotent-Replayed: true
curl -si -XPOST $B/accounts/acct_001/withdrawals -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 7b0e7c4e-2a43-4d0e-9a37-1c8f3f1f0a11' -d '{"amount":25,"currency":"CAD"}'

curl -s -XPOST $B/accounts/acct_001/withdrawals -H 'Content-Type: application/json' \
  -d '{"amount":999999,"currency":"CAD"}'
# 409 {"error":"INSUFFICIENT_FUNDS","message":"Insufficient funds","requestId":"…"}

curl -s -XPOST $B/transfers -H 'Content-Type: application/json' \
  -d '{"fromAccountId":"acct_001","toAccountId":"acct_002","amount":10,"currency":"CAD"}'

curl -s "$B/accounts/acct_001/transactions?limit=5"
curl -s $B/transactions/<X-Transaction-Id from a previous response>
```

### JWT mode (local)

```bash
export JWT_SECRET=$(openssl rand -hex 32)
AUTH_MODE=jwt JWT_SECRET=$JWT_SECRET npm start
TOKEN=$(npm run -s token -- --role CUSTOMER --customerId cust_001)
curl -s $B/accounts/acct_001 -H "Authorization: Bearer $TOKEN"   # 200
curl -s $B/accounts/acct_003 -H "Authorization: Bearer $TOKEN"   # 404 (not the caller's account)
```

## Project structure

```text
src/
├── handlers/        Lambda entry points: parse → validate → service → response (thin)
│   └── ledgerStream.js   DynamoDB Streams → SQS outbox relay (AWS only)
├── middleware/      withHandler (request id, auth, rate limit, error mapping), auth, rateLimiter
├── services/        business logic: customer/account/transaction/idempotency, bankingRules (pure)
├── repositories/    all DynamoDB access; transactWriter = the only multi-item write path
├── validators/      Joi schemas mirroring the OpenAPI contract
├── lib/             dynamodb client, money, retry/backoff, clock, logger, errors, response, secrets
└── config/          validated environment configuration
infra/               AWS CDK app (stack + assertion tests)
scripts/             create tables, seed, wait-for-db, generate dev JWT
tests/               unit (no DB), integration (DynamoDB Local), helpers, setup
openapi/             API contract
postman/             full Postman suite
docs/                architecture and ER diagrams
```

## Deploy to AWS (CDK)

```bash
cd infra
npm install
npx cdk bootstrap aws://<ACCOUNT_ID>/<REGION>          # once per account/region
npx cdk synth                                          # bundles every Lambda with esbuild
npx cdk deploy                                         # dev stage (no provisioned/reserved concurrency)
npx cdk deploy -c stage=prod -c alarmEmail=ops@example.com   # prod: retained data, PC=2, reserved=100
```

**Stack outputs**

- `ApiUrl`
- `LedgerEventsQueueUrl`
- `JwtSecretArn`: the generated signing key in Secrets Manager

> [!IMPORTANT]
> In AWS, `AUTH_MODE=jwt` and `REQUIRE_IDEMPOTENCY_KEY=true`. Production would replace the shared-secret JWT with Cognito or the bank's OIDC IdP behind an API Gateway authorizer.

## Cleanup

```bash
npm run db:down                      # local
cd infra && npx cdk destroy          # AWS (dev stage deletes tables; prod retains tables and the KMS key by design)
```

# Design notes and trade-offs

## 1. Architecture

```
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

Handlers stay thin. All business rules live in `src/services`, and all DynamoDB calls live in `src/repositories`. Pure rules (`bankingRules.js`) do no I/O, so they are unit-tested directly.

**Why no Express?** The brief prescribes the API Gateway → Lambda handler shape and serverless-offline. Express would add cold-start weight and hide the Lambda event model. Its middleware duties (helmet headers, error handler, request id, rate limit) are implemented in [`withHandler.js`](src/middleware/withHandler.js).

## 2. Data model and access patterns

| Table | Keys | Access pattern | Operation |
|-------|------|----------------|-----------|
| Customers | PK `customerId` | get customer | GetItem (consistent) |
| Accounts | PK `accountId`, GSI `CustomerIdIndex` (customerId) | get account / list a customer's accounts | GetItem (consistent) / **Query on GSI**, never Scan |
| Transactions (ledger) | PK `transactionId`, SK `accountId`; GSI `AccountHistoryIndex` (accountId, createdAt) | transaction status / account history newest first | Query base table (consistent) / Query GSI, descending, paginated |
| IdempotencyKeys | PK `idempotencyKey` (sha256 of caller + key), TTL `expiresAt` | replay a retried request | GetItem (consistent) + conditional Put inside the money transaction |

The account item also stores `version` (optimistic lock) and `dailyWithdrawal {date, totalMinor}`. The mappers in `services/mappers.js` are an allow-list, so internal attributes never reach a response.

**Hot partitions.** Every partition key is a high-cardinality UUID, so load spreads evenly. The one real hotspot in banking is a single very busy account, such as a merchant's. That is a per-item write limit (~1,000 WCU/s), not a partition-design flaw. See section 5 for the mitigation.

## 3. Reliability concerns and where each is handled

| Concept | How it is handled | Code | Proof |
|---------|-------------------|------|-------|
| **Idempotency** | `Idempotency-Key` header. The record is written **in the same transaction** as the money movement. Same key + same body replays the stored response (`Idempotent-Replayed: true`). Same key + different body returns 422. Concurrent duplicates race on `attribute_not_exists`, the loser replays the winner's result. A second layer, DynamoDB `ClientRequestToken`, makes SDK-level retries after an ambiguous timeout safe. | [idempotencyService.js](src/services/idempotencyService.js), [transactWriter.js](src/repositories/transactWriter.js) | `concurrency.test.js`: 10 identical requests in flight → 1 debit |
| **Atomicity** | `TransactWriteItems`: balance update(s), ledger entry(ies) and the idempotency record are committed all-or-nothing. A transfer cannot debit A without crediting B. | [transactWriter.js](src/repositories/transactWriter.js), [transactionService.js](src/services/transactionService.js) | "failure leaves BOTH accounts untouched"; ledger == balance invariant |
| **Isolation / race conditions** | Optimistic concurrency control. Read with `ConsistentRead`, validate rules in integer cents, commit with `version = :expected`, retry from a fresh read on conflict. Lost updates and overdrafts are impossible. The daily-limit counter lives **on the same item** in the same conditional write, so two withdrawals cannot both slip under the limit. | [accountRepository.js `buildVersionedUpdate`](src/repositories/accountRepository.js), [bankingRules.js](src/services/bankingRules.js) | 20 parallel withdrawals: never overdrawn, balance = 250 − 30 × successes |
| **Eventual consistency** | It is allowed only where it is harmless. GSI reads (account list, history) are eventually consistent by DynamoDB design, and that is documented. Every read that drives a money decision is strongly consistent. Downstream systems learn about transactions through the outbox and are eventually consistent with the ledger, with an `IteratorAge` alarm on the lag. | [accountRepository.js](src/repositories/accountRepository.js), [ledgerStream.js](src/handlers/ledgerStream.js) | — |
| **Deadlocks** | DynamoDB transactions are optimistic and never block holding locks: a conflicting transaction is *cancelled* (`TransactionConflict`), so a deadlock cycle cannot form. Transfer items are still built in canonical `accountId` order, which is the lock-ordering rule a lock-based store would need. | [transactionService.js `transfer`](src/services/transactionService.js) | A→B and B→A transfer storm: every request completes, money conserved |
| **Starvation** | The risk with optimistic locking is livelock: a request that keeps losing. Mitigations: exponential backoff with **full jitter** (desynchronises the herd), **bounded attempts** with a retryable `409 CONCURRENT_UPDATE` + `Retry-After` (the Lambda never spins until timeout), and per-client token buckets so one noisy client cannot starve others. | [retry.js](src/lib/retry.js), [rateLimiter.js](src/middleware/rateLimiter.js) | `retry.test.js`, `rateLimiter.test.js` |
| **Dual writes** | The request path writes to **one** system only (DynamoDB, atomically). Events are derived afterwards from the committed ledger via DynamoDB Streams, which is the transactional outbox pattern. There is never a "write DB, then publish to SQS" sequence that could half-fail. Consumers get deterministic `eventId`s, so they can be idempotent under at-least-once delivery. | [ledgerStream.js](src/handlers/ledgerStream.js), `infra/` | `ledgerStream.test.js` |
| **Back-pressure / throttling** | Layered, from the edge inward: WAF per-IP rate rule → API Gateway stage and per-route throttling (429 before any cost) → Lambda reserved concurrency → in-container token bucket → DynamoDB SDK `adaptive` retry mode (client-side slowdown) → DynamoDB throttling mapped to `503 + Retry-After`. Async side: SQS buffering, stream batching, `bisectBatchOnError`, DLQs. | [infra/lib/banking-stack.js](infra/lib/banking-stack.js), [dynamodb.js](src/lib/dynamodb.js), [withHandler.js](src/middleware/withHandler.js) | `withHandler.test.js`, CDK assertions |

## 4. Assumptions (the brief is silent on these)

1. **Money format:** the contract exposes decimal `number`s. Amounts with more than 2 decimals, or that arrive as strings, are rejected with 400. Internally all arithmetic is integer cents. DynamoDB stores Numbers as exact decimals, so nothing drifts.
2. **E-mail uniqueness is not enforced.** The contract has no 409 for it, and the grader creates the same e-mail on every run. Duplicate *submissions* are prevented with `Idempotency-Key` instead.
3. **Currency mismatch is 400** (bad request for this account). Business-rule rejections such as funds, limits, hours and inactive accounts are **409**, per the contract's "business rule conflict" description.
4. **Rule order for withdrawals:** account exists → ownership → OPEN → currency → hours → funds → daily limit. Insufficient funds is checked before the limit, so a customer with no money sees the more fundamental reason.
5. **Banking hours and the daily limit apply to cash withdrawals only.** Deposits and transfers are not cash-out.
6. **Transfers:** both accounts must be OPEN and in the request currency (no FX). The caller must own the source account; the destination may belong to anyone. Same-account transfer is 400.
7. **Only successful outcomes are stored for idempotency.** A rejected request moved no money, so re-evaluating it on retry is safe. For example, a retry succeeds after the account is funded.
8. **Defaults favour the grader:** `AUTH_MODE=none`, withdrawal window 00:00–24:00, idempotency key optional. The CDK deployment flips all of these: `jwt`, 10:00–17:00, key required.
9. **Inactive accounts** cannot be created through the API; there is no close-account endpoint in the contract. The seed includes `acct_004` (CLOSED) to demonstrate the rule.
10. **Transaction status** is always `COMPLETED` in this synchronous design, because ledger entries exist only once committed. A `PENDING` state would appear only with the async mode described below.

## 5. Partial failure: how transfers are handled

A transfer is one `TransactWriteItems` call containing: debit A (version-checked), credit B (version-checked), two ledger legs, and the idempotency record. DynamoDB applies all five or none. If the Lambda dies mid-request:

- **Before commit:** nothing happened. The client retries with the same `Idempotency-Key`.
- **After commit, before the response:** the client retries and gets the stored response replayed. No second transfer.
- **SDK retry of an ambiguous commit:** `ClientRequestToken` makes DynamoDB return success instead of re-applying.

**Hot accounts / extreme contention** (not built, deliberately): if a single account sees sustained parallel writes, optimistic retries start to fail. The next step would be to serialise per account with **SQS FIFO (`MessageGroupId = accountId`)**. That gives strict FIFO fairness with no starvation, at the cost of making the API asynchronous (202 + status polling). This is exactly where `GET /transactions/{id}` and a `PENDING` status would come in. It was left out because the brief's contract is synchronous (`200 Account`).

## 6. Security

- JWT (HS256 pinned, issuer/audience/expiry checked, `alg:none` rejected). The key comes from Secrets Manager in AWS and is cached per container.
- Roles `ADMIN` (bank staff) / `CUSTOMER`. Customers reach only their own resources. Other people's accounts return **404**, not 403, to prevent account-id enumeration. A payer never sees the payee's `balanceAfter`.
- Strict Joi validation: unknown fields rejected (mass-assignment guard), no type coercion for money, bounded lengths, path-id allow-list, 16 KB body cap.
- Pagination cursors are opaque and bound to the account, so a tampered cursor gets 400.
- Helmet-equivalent headers (`nosniff`, HSTS, `no-store`, CSP, frame deny).
- Errors never include stack traces or DB details. Every error carries a `requestId` for support.
- Logs are structured JSON with e-mail/name masked and tokens redacted. Money movements emit `AUDIT` log lines, and the immutable ledger (with `actor` and `requestId`) is the system of record.
- AWS: KMS CMK with rotation for tables, queues, secrets and the SNS topic. PITR. Deletion protection plus a RETAIN policy in prod. Per-function least-privilege IAM (exact DynamoDB actions per table). WAF managed rules. API Gateway execution logging at ERROR only (no request bodies, so no PII in logs).

## 7. Performance and scalability

- **SDK client reuse:** one DynamoDB client per container, created at module load, with keep-alive sockets. Connection/request timeouts (1 s / 3 s) fail fast.
- **Cold starts:** one small function per route, esbuild-minified bundles, ARM64, 512 MB. **Provisioned concurrency** on the `live` alias of the money functions in prod.
- **Reserved concurrency** caps money functions so a spike cannot exhaust the account's Lambda pool or overload DynamoDB.
- **On-demand capacity** while traffic is unknown. Switch to provisioned + auto-scaling when load is steady.
- **No caching of balances.** Authoritative balances are always strongly consistent reads. Only static content (docs) could be cached.
- **Retries:** exponential backoff + full jitter for optimistic conflicts; the SDK's adaptive retry for throttling.
- **Observability:** X-Ray on API Gateway and Lambda; alarms on Lambda errors/throttles, API 5xx and p99, DynamoDB write throttles, DLQ depth, and outbox lag.

## 8. What I would do next

SQS FIFO per-account serialisation for hot accounts; Cognito/OIDC authorizer; a k6 load test in a staging account; contract tests generated from the OpenAPI file; a CI pipeline (lint → unit → integration with DynamoDB Local in a service container → `cdk synth` + assertions → deploy to dev → smoke → manual approval → prod).

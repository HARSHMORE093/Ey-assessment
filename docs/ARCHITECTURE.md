# Architecture

Serverless banking API on AWS: **API Gateway → Lambda (Node.js) → DynamoDB**, with a DynamoDB Streams
outbox that publishes ledger events to SQS. Infrastructure is AWS CDK ([infra/lib/banking-stack.js](../infra/lib/banking-stack.js));
local development uses `serverless-offline` + DynamoDB Local ([serverless.yml](../serverless.yml), [docker-compose.yml](../docker-compose.yml)).

Data model: see [ER_DIAGRAM.md](ER_DIAGRAM.md).

---

## 1. System architecture (AWS deployment)

```mermaid
flowchart LR
    client([Client / Mobile / Partner])

    subgraph edge["Edge & back-pressure"]
        waf["AWS WAF<br/>managed rules + 2000 req/5min per IP"]
        apigw["API Gateway (REST, regional)<br/>stage throttle 500 rps<br/>money routes 50 rps"]
    end

    subgraph compute["Lambda functions (Node 22, ARM64, X-Ray)"]
        direction TB
        cust["Customers<br/>create / get"]
        acct["Accounts<br/>create / list / get"]
        money["Money paths<br/>deposit / withdraw / transfer<br/>reserved + provisioned concurrency"]
        read["Reads<br/>history / status"]
    end

    subgraph data["DynamoDB (on-demand, KMS CMK, PITR)"]
        tCust[(Customers)]
        tAcct[(Accounts<br/>GSI CustomerIdIndex)]
        tTxn[(Transactions ledger<br/>GSI AccountHistoryIndex)]
        tIdem[(IdempotencyKeys<br/>TTL expiresAt)]
    end

    subgraph events["Async events (transactional outbox)"]
        stream{{DynamoDB Stream<br/>NEW_IMAGE, INSERT only}}
        relay["LedgerStreamRelay Lambda"]
        sqs[["SQS LedgerEvents"]]
        dlq[["DLQs<br/>events + stream failures"]]
        downstream([Notifications / Fraud / Reporting])
    end

    subgraph ops["Security & operations"]
        sm["Secrets Manager<br/>JWT signing key"]
        kms["KMS CMK"]
        cw["CloudWatch logs + alarms<br/>→ SNS email"]
    end

    client -->|HTTPS + Bearer JWT<br/>+ Idempotency-Key| waf --> apigw
    apigw --> cust & acct & money & read
    cust --> tCust & tIdem
    acct --> tCust & tAcct & tTxn & tIdem
    money --> tAcct & tTxn & tIdem
    read --> tAcct & tTxn
    tTxn -.-> stream --> relay --> sqs --> downstream
    relay -.on failure.-> dlq
    sqs -.after 5 receives.-> dlq
    compute -.-> sm
    data -.-> kms
    compute -.-> cw
```

Each function gets **least-privilege IAM**: only the exact DynamoDB actions on the exact tables it uses
(e.g. `getCustomer` can only `GetItem` on `Customers`).

---

## 2. Code architecture (layers inside one Lambda)

```mermaid
flowchart TB
    evt[/API Gateway event/]

    subgraph h["handlers/  (thin: parse + call service)"]
        handlers["customers.js · accounts.js · transactions.js · docs.js"]
    end

    subgraph m["middleware/withHandler.js  (cross-cutting)"]
        direction LR
        rid["Request ID<br/>+ structured logs"] --> auth["auth.js<br/>JWT → principal<br/>(ADMIN / CUSTOMER)"] --> rl["rateLimiter.js<br/>token bucket"] --> val["validators/<br/>Joi schemas"]
        err["Central error → HTTP mapping<br/>(no stack traces leak)"]
    end

    subgraph s["services/  (business logic)"]
        direction LR
        svc["customerService · accountService<br/>transactionService"]
        rules["bankingRules<br/>status, currency, funds,<br/>hours, daily limit"]
        idem["idempotencyService"]
        map["mappers (DTO allow-list)"]
    end

    subgraph r["repositories/  (data access)"]
        direction LR
        repos["customer · account · ledger<br/>idempotency repositories"]
        tw["transactWriter<br/>single TransactWriteItems"]
    end

    subgraph l["lib/"]
        libs["dynamodb · money (integer minor units)<br/>retry (backoff + jitter) · secrets · clock · hash"]
    end

    db[(DynamoDB)]

    evt --> m --> h --> s --> r --> db
    s -.-> l
    r -.-> l
```

**Why this split:** handlers know HTTP, services know banking, repositories know DynamoDB. Business rules
are pure functions, so they are unit-tested without a database.

---

## 3. Request flow: a money movement (withdraw / transfer)

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant L as Lambda (withHandler)
    participant I as idempotencyService
    participant S as transactionService
    participant DB as DynamoDB

    C->>L: POST /accounts/{id}/withdrawals<br/>Idempotency-Key: abc
    L->>L: request id, auth (JWT), rate limit, validate body
    L->>I: execute(key, payload)
    I->>DB: GetItem IdempotencyKeys
    alt key already used, same payload
        DB-->>I: stored response
        I-->>C: original response (Idempotent-Replayed: true)
    else key used with different payload
        I-->>C: 422 IDEMPOTENCY_KEY_REUSED
    else new key
        loop Optimistic retry (bounded, jittered backoff)
            S->>DB: READ GetItem Account (ConsistentRead, gets version v)
            S->>S: VALIDATE rules in integer minor units
            S->>DB: COMMIT TransactWriteItems:<br/>Update account IF version = v → v+1<br/>Put ledger entry(ies)<br/>Put idempotency record
            alt version changed (concurrent request won)
                DB-->>S: ConditionalCheckFailed → retry from READ
            else committed
                DB-->>S: OK
            end
        end
        S-->>C: 200 + X-Transaction-Id
    end
```

---

## 4. Event flow: transactional outbox

```mermaid
flowchart LR
    w["Money transaction commits<br/>(balance + ledger entry, atomic)"] --> t[(Transactions table)]
    t -->|DynamoDB Stream INSERT| r["LedgerStreamRelay<br/>batch 100, bisect on error,<br/>report item failures"]
    r -->|eventId = transactionId:accountId| q[["SQS LedgerEvents"]]
    q --> c([Idempotent consumers<br/>de-dupe on eventId])
    r -.5 retries failed.-> d1[["LedgerStreamFailures DLQ"]]
    q -.5 receives failed.-> d2[["LedgerEvents DLQ"]]
```

The API never does "write DB, then publish to SQS" (a **dual write** that can half-fail). It writes only to
DynamoDB; the ledger entry *is* the event, and the stream relays it. Delivery is at-least-once, so consumers
de-duplicate.

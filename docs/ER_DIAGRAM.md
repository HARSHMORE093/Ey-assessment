# Entity-Relationship Diagram

Data model for the Banking API (DynamoDB). Source of truth: [scripts/create-tables.js](../scripts/create-tables.js),
[src/repositories/](../src/repositories/) and the services that build the items.

DynamoDB does not enforce foreign keys. The relationships below are **logical**: they are kept consistent by
the application, mostly by writing related items in a single `TransactWriteItems` call
([transactWriter.js](../src/repositories/transactWriter.js)).

```mermaid
erDiagram
    CUSTOMERS ||--o{ ACCOUNTS : "owns (GSI CustomerIdIndex)"
    ACCOUNTS ||--o{ TRANSACTIONS : "has ledger entries (GSI AccountHistoryIndex)"
    ACCOUNTS |o--o{ TRANSACTIONS : "is counterparty of (transfers)"
    CUSTOMERS ||--o{ TRANSACTIONS : "denormalised owner (authZ)"
    IDEMPOTENCY_KEYS }o--o| TRANSACTIONS : "records result of"

    CUSTOMERS {
        string customerId PK "cust_<uuid>"
        string fullName
        string email "not unique"
        string status "ACTIVE | ..."
        string createdAt "ISO-8601"
    }

    ACCOUNTS {
        string accountId PK "acct_<uuid>"
        string customerId FK "GSI CustomerIdIndex (HASH)"
        string type
        string currency
        number balance "major units"
        string status "OPEN | ..."
        number version "optimistic lock"
        map dailyWithdrawal "{ date, totalMinor }"
        number dailyWithdrawalLimitMinor "optional override"
        string createdAt "ISO-8601"
        string updatedAt "ISO-8601"
    }

    TRANSACTIONS {
        string transactionId PK "txn_<uuid> (HASH)"
        string accountId PK, FK "RANGE key; GSI AccountHistoryIndex (HASH)"
        string createdAt "GSI AccountHistoryIndex (RANGE)"
        string customerId FK "owner of this leg"
        string type "DEPOSIT | WITHDRAWAL | TRANSFER | ACCOUNT_OPENING"
        string direction "DEBIT | CREDIT"
        number amount
        string currency
        number balanceAfter
        string status "COMPLETED"
        string counterpartyAccountId FK "transfers only"
        string actor "principal.sub"
        string requestId
    }

    IDEMPOTENCY_KEYS {
        string idempotencyKey PK "sha256(principal.sub | rawKey)"
        string requestHash "sha256(canonical payload)"
        number statusCode
        string responseBody "JSON"
        string transactionId FK "optional"
        string createdAt "ISO-8601"
        number expiresAt "epoch s, TTL attribute"
    }
```

## Tables and keys

| Table | Partition key | Sort key | Secondary index | Notes |
|---|---|---|---|---|
| `Customers` | `customerId` | — | — | Created by ADMIN only |
| `Accounts` | `accountId` | — | `CustomerIdIndex` (`customerId`) | Versioned updates (optimistic locking) |
| `Transactions` | `transactionId` | `accountId` | `AccountHistoryIndex` (`accountId`, `createdAt`) | Append-only ledger; Streams `NEW_IMAGE` → [ledgerStream.js](../src/handlers/ledgerStream.js) → SQS |
| `IdempotencyKeys` | `idempotencyKey` | — | — | TTL on `expiresAt` |

## Relationship notes

- **Customer → Account (1 : 0..N)**: `Accounts.customerId`. An account can only be opened while the customer is
  `ACTIVE`, checked atomically by a `ConditionCheck` in the same transaction.
- **Account → Ledger entry (1 : 0..N)**: `Transactions.accountId`. Deposits, withdrawals and account openings
  write one item; a transfer writes **two items with the same `transactionId`** (a DEBIT leg and a CREDIT leg),
  which is why the table key is `(transactionId, accountId)`.
- **Counterparty (0..1)**: transfer legs carry `counterpartyAccountId`, pointing to the other account.
- **Customer on ledger entries**: `customerId` is copied onto each leg so a customer can look up a transaction
  without reading the account.
- **Idempotency record → Transaction (0..1)**: stores the original response (and `transactionId` for money
  movements) so a retried request is replayed instead of executed twice. It is committed in the same
  transaction as the money movement.

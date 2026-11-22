"use strict";

const path = require("path");
const cdk = require("aws-cdk-lib");
const { Duration, RemovalPolicy, CfnOutput } = cdk;
const dynamodb = require("aws-cdk-lib/aws-dynamodb");
const lambda = require("aws-cdk-lib/aws-lambda");
const { NodejsFunction, OutputFormat } = require("aws-cdk-lib/aws-lambda-nodejs");
const apigw = require("aws-cdk-lib/aws-apigateway");
const kms = require("aws-cdk-lib/aws-kms");
const sqs = require("aws-cdk-lib/aws-sqs");
const sns = require("aws-cdk-lib/aws-sns");
const subs = require("aws-cdk-lib/aws-sns-subscriptions");
const logs = require("aws-cdk-lib/aws-logs");
const secretsmanager = require("aws-cdk-lib/aws-secretsmanager");
const cloudwatch = require("aws-cdk-lib/aws-cloudwatch");
const cwActions = require("aws-cdk-lib/aws-cloudwatch-actions");
const wafv2 = require("aws-cdk-lib/aws-wafv2");
const { DynamoEventSource, SqsDlq } = require("aws-cdk-lib/aws-lambda-event-sources");

const PROJECT_ROOT = path.join(__dirname, "..", "..");

/**
 * Banking API: API Gateway → Lambda → DynamoDB, plus an outbox relay (Streams → Lambda → SQS).
 *
 * Context (cdk.json or `-c key=value`):
 *   stage                     dev | prod  (prod = retain data, deletion protection, longer log retention)
 *   provisionedConcurrency    warm instances for the money-path functions (0 = off, avoids cost in dev)
 *   reservedConcurrency       hard cap per money function (0 = off; new AWS accounts often have a
 *                             10-concurrency quota where any reservation fails to deploy)
 *   alarmEmail                optional e-mail subscribed to the alarm topic
 *   withdrawalWindowStart/End, bankTimezone, dailyWithdrawalLimitMinor
 */
class BankingStack extends cdk.Stack {
  constructor(scope, id, props = {}) {
    super(scope, id, props);

    const ctx = (key, fallback) => this.node.tryGetContext(key) ?? fallback;
    const stage = ctx("stage", "dev");
    const isProd = stage === "prod";
    const provisioned = Number(ctx("provisionedConcurrency", isProd ? 2 : 0));
    const reserved = Number(ctx("reservedConcurrency", isProd ? 100 : 0));
    const removalPolicy = isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    // ── Encryption: one customer-managed KMS key (rotated yearly) for data at rest ──────────────
    // CMK instead of the AWS-owned key: key usage is auditable in CloudTrail, access can be revoked
    // centrally, and it is what bank security teams typically require.
    const dataKey = new kms.Key(this, "DataKey", {
      alias: `alias/banking-api-${stage}`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN, // never auto-delete the key that protects retained data
    });

    // ── DynamoDB tables ─────────────────────────────────────────────────────────────────────────
    // On-demand capacity: absorbs unpredictable spikes without capacity planning. Switch to
    // provisioned + auto-scaling once traffic is steady and predictable (cheaper at sustained load).
    // Partition keys are high-cardinality UUIDs (customerId / accountId / transactionId), so load
    // spreads evenly across partitions. There is no "status" or "date" PK that would create a hot partition.
    const tableDefaults = {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: dataKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }, // restore to any second in the last 35 days
      deletionProtection: isProd,
      removalPolicy,
    };

    const customers = new dynamodb.Table(this, "Customers", {
      ...tableDefaults,
      partitionKey: { name: "customerId", type: dynamodb.AttributeType.STRING },
    });

    const accounts = new dynamodb.Table(this, "Accounts", {
      ...tableDefaults,
      partitionKey: { name: "accountId", type: dynamodb.AttributeType.STRING },
    });
    accounts.addGlobalSecondaryIndex({
      indexName: "CustomerIdIndex",
      partitionKey: { name: "customerId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const transactions = new dynamodb.Table(this, "Transactions", {
      ...tableDefaults,
      partitionKey: { name: "transactionId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "accountId", type: dynamodb.AttributeType.STRING },
      stream: dynamodb.StreamViewType.NEW_IMAGE, // transactional outbox: every committed ledger entry becomes an event
    });
    transactions.addGlobalSecondaryIndex({
      indexName: "AccountHistoryIndex",
      partitionKey: { name: "accountId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const idempotency = new dynamodb.Table(this, "IdempotencyKeys", {
      ...tableDefaults,
      partitionKey: { name: "idempotencyKey", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "expiresAt", // keys auto-expire (default 24h) at no cost
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false }, // ephemeral data
    });

    // ── Secrets ─────────────────────────────────────────────────────────────────────────────────
    const jwtSecret = new secretsmanager.Secret(this, "JwtSigningKey", {
      description: "HS256 signing key for API JWTs (replace with an OIDC IdP / Cognito for production)",
      encryptionKey: dataKey,
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
      removalPolicy,
    });

    // ── Async event pipeline (outbox relay) ─────────────────────────────────────────────────────
    const eventsDlq = new sqs.Queue(this, "LedgerEventsDlq", {
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: dataKey,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    const eventsQueue = new sqs.Queue(this, "LedgerEvents", {
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: dataKey,
      enforceSSL: true,
      visibilityTimeout: Duration.seconds(60),
      // A downstream consumer that fails 5 times sends the message to the DLQ instead of retrying forever.
      deadLetterQueue: { queue: eventsDlq, maxReceiveCount: 5 },
    });
    const streamFailures = new sqs.Queue(this, "LedgerStreamFailures", {
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: dataKey,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });

    // ── Lambda functions ────────────────────────────────────────────────────────────────────────
    const commonEnv = {
      NODE_OPTIONS: "--enable-source-maps",
      CUSTOMERS_TABLE: customers.tableName,
      ACCOUNTS_TABLE: accounts.tableName,
      TRANSACTIONS_TABLE: transactions.tableName,
      IDEMPOTENCY_TABLE: idempotency.tableName,
      AUTH_MODE: "jwt",
      JWT_SECRET_ARN: jwtSecret.secretArn,
      REQUIRE_IDEMPOTENCY_KEY: "true", // every money-moving POST must be retry-safe in AWS
      BANK_TIMEZONE: ctx("bankTimezone", "America/Toronto"),
      WITHDRAWAL_WINDOW_START: ctx("withdrawalWindowStart", "10:00"),
      WITHDRAWAL_WINDOW_END: ctx("withdrawalWindowEnd", "17:00"),
      DAILY_WITHDRAWAL_LIMIT_MINOR: String(ctx("dailyWithdrawalLimitMinor", 500000)),
      LOG_LEVEL: isProd ? "info" : "debug",
      CORS_ORIGIN: ctx("corsOrigin", "https://example.com"),
    };

    const alarmTopic = new sns.Topic(this, "AlarmTopic", { masterKey: dataKey });
    if (ctx("alarmEmail")) alarmTopic.addSubscription(new subs.EmailSubscription(ctx("alarmEmail")));
    const alarmAction = new cwActions.SnsAction(alarmTopic);

    const makeFunction = (name, file, handler, { moneyPath = false, environment = {} } = {}) => {
      const logGroup = new logs.LogGroup(this, `${name}Logs`, {
        retention: isProd ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_MONTH,
        removalPolicy,
      });
      const fn = new NodejsFunction(this, name, {
        entry: path.join(PROJECT_ROOT, "src", "handlers", file),
        handler,
        projectRoot: PROJECT_ROOT,
        depsLockFilePath: path.join(PROJECT_ROOT, "package-lock.json"),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64, // Graviton: ~20% cheaper, same or better latency
        memorySize: 512, // more memory = more CPU = faster cold start and crypto (JWT, hashing)
        timeout: Duration.seconds(10), // well under API Gateway's 29s limit; OCC retries are bounded
        tracing: lambda.Tracing.ACTIVE, // X-Ray: end-to-end trace API GW → Lambda → DynamoDB
        logGroup,
        environment: { ...commonEnv, ...environment },
        // Cap concurrency on money paths: protects DynamoDB and downstream from a traffic storm
        // and stops one function from starving the rest of the account's Lambda pool.
        reservedConcurrentExecutions: moneyPath && reserved > 0 ? reserved : undefined,
        bundling: {
          minify: true,
          sourceMap: true,
          target: "node22",
          format: OutputFormat.CJS,
          // The AWS SDK is bundled (not taken from the runtime), so the deployed SDK version is
          // pinned and tested. Smaller cold starts are possible by marking @aws-sdk/* external.
          externalModules: [],
        },
      });
      jwtSecret.grantRead(fn);

      // Version + alias. API Gateway invokes the alias, so deployments are atomic and roll-backable,
      // and provisioned concurrency (pre-initialised instances, no cold start) attaches to the alias.
      const alias = new lambda.Alias(this, `${name}Live`, {
        aliasName: "live",
        version: fn.currentVersion,
        provisionedConcurrentExecutions: moneyPath && provisioned > 0 ? provisioned : undefined,
      });

      new cloudwatch.Alarm(this, `${name}Errors`, {
        metric: fn.metricErrors({ period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `${name}: unhandled errors`,
      }).addAlarmAction(alarmAction);
      new cloudwatch.Alarm(this, `${name}Throttles`, {
        metric: fn.metricThrottles({ period: Duration.minutes(5) }),
        threshold: 5,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `${name}: Lambda throttling (concurrency exhausted)`,
      }).addAlarmAction(alarmAction);

      return { fn, alias };
    };

    /** Least privilege: exact DynamoDB actions per table + the KMS operations they need. */
    const allow = (fn, table, actions) => {
      table.grant(fn, ...actions.map((a) => `dynamodb:${a}`));
      const writes = actions.some((a) => ["PutItem", "UpdateItem"].includes(a));
      if (writes) dataKey.grantEncryptDecrypt(fn);
      else dataKey.grantDecrypt(fn);
    };
    const moneyWrite = (fn) => {
      allow(fn, accounts, ["GetItem", "UpdateItem"]);
      allow(fn, transactions, ["PutItem"]);
      allow(fn, idempotency, ["GetItem", "PutItem"]);
    };

    const f = {
      createCustomer: makeFunction("CreateCustomer", "customers.js", "create"),
      getCustomer: makeFunction("GetCustomer", "customers.js", "get"),
      createAccount: makeFunction("CreateAccount", "accounts.js", "create"),
      listAccounts: makeFunction("ListAccounts", "accounts.js", "list"),
      getAccount: makeFunction("GetAccount", "accounts.js", "get"),
      deposit: makeFunction("Deposit", "transactions.js", "deposit", { moneyPath: true }),
      withdraw: makeFunction("Withdraw", "transactions.js", "withdraw", { moneyPath: true }),
      transfer: makeFunction("Transfer", "transactions.js", "transfer", { moneyPath: true }),
      history: makeFunction("AccountHistory", "transactions.js", "history"),
      status: makeFunction("TransactionStatus", "transactions.js", "status"),
    };

    allow(f.createCustomer.fn, customers, ["PutItem"]);
    allow(f.createCustomer.fn, idempotency, ["GetItem", "PutItem"]);
    allow(f.getCustomer.fn, customers, ["GetItem"]);
    allow(f.createAccount.fn, customers, ["GetItem", "ConditionCheckItem"]);
    allow(f.createAccount.fn, accounts, ["PutItem"]);
    allow(f.createAccount.fn, transactions, ["PutItem"]);
    allow(f.createAccount.fn, idempotency, ["GetItem", "PutItem"]);
    allow(f.listAccounts.fn, customers, ["GetItem"]);
    allow(f.listAccounts.fn, accounts, ["Query"]);
    allow(f.getAccount.fn, accounts, ["GetItem"]);
    [f.deposit, f.withdraw, f.transfer].forEach(({ fn }) => moneyWrite(fn));
    allow(f.history.fn, accounts, ["GetItem"]);
    allow(f.history.fn, transactions, ["Query"]);
    allow(f.status.fn, transactions, ["Query"]);

    // Outbox relay: DynamoDB Stream → Lambda → SQS
    const relayLogs = new logs.LogGroup(this, "LedgerStreamRelayLogs", {
      retention: isProd ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_MONTH,
      removalPolicy,
    });
    const relay = new NodejsFunction(this, "LedgerStreamRelay", {
      entry: path.join(PROJECT_ROOT, "src", "handlers", "ledgerStream.js"),
      handler: "handler",
      projectRoot: PROJECT_ROOT,
      depsLockFilePath: path.join(PROJECT_ROOT, "package-lock.json"),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      logGroup: relayLogs,
      environment: { EVENTS_QUEUE_URL: eventsQueue.queueUrl, NODE_OPTIONS: "--enable-source-maps" },
      bundling: { minify: true, sourceMap: true, target: "node22" },
    });
    eventsQueue.grantSendMessages(relay);
    relay.addEventSource(
      new DynamoEventSource(transactions, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 100,
        maxBatchingWindow: Duration.seconds(1), // micro-batching: fewer invocations under load
        parallelizationFactor: 2, // up to 2 concurrent batches per shard (order kept per key)
        bisectBatchOnError: true, // isolate a poison record by splitting the batch
        retryAttempts: 5,
        reportBatchItemFailures: true, // only failed records are retried
        onFailure: new SqsDlq(streamFailures), // nothing is silently dropped
        filters: [lambda.FilterCriteria.filter({ eventName: lambda.FilterRule.isEqual("INSERT") })],
      })
    );

    // ── API Gateway ─────────────────────────────────────────────────────────────────────────────
    const accessLogs = new logs.LogGroup(this, "ApiAccessLogs", {
      retention: isProd ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_MONTH,
      removalPolicy,
    });

    const moneyThrottle = { throttlingRateLimit: 50, throttlingBurstLimit: 100 };
    const api = new apigw.RestApi(this, "BankingApi", {
      restApiName: `banking-api-${stage}`,
      cloudWatchRole: true,
      endpointTypes: [apigw.EndpointType.REGIONAL],
      deployOptions: {
        stageName: stage,
        // BACK-PRESSURE: requests beyond these limits get 429 at the edge, before any Lambda or
        // DynamoDB cost. Stage-wide default plus tighter limits on money-moving routes.
        throttlingRateLimit: 500,
        throttlingBurstLimit: 1000,
        methodOptions: {
          "/accounts/{accountId}/withdrawals/POST": moneyThrottle,
          "/accounts/{accountId}/deposits/POST": moneyThrottle,
          "/transfers/POST": moneyThrottle,
        },
        tracingEnabled: true,
        metricsEnabled: true,
        loggingLevel: apigw.MethodLoggingLevel.ERROR, // never INFO + dataTrace: that would log bodies (PII)
        dataTraceEnabled: false,
        accessLogDestination: new apigw.LogGroupLogDestination(accessLogs),
        accessLogFormat: apigw.AccessLogFormat.jsonWithStandardFields({
          caller: false,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: false,
        }),
      },
    });

    const route = (resource, method, { alias }) => resource.addMethod(method, new apigw.LambdaIntegration(alias));
    const customersRes = api.root.addResource("customers");
    const customerRes = customersRes.addResource("{customerId}");
    const customerAccounts = customerRes.addResource("accounts");
    const accountsRes = api.root.addResource("accounts");
    const accountRes = accountsRes.addResource("{accountId}");
    const transactionsRes = api.root.addResource("transactions");

    route(customersRes, "POST", f.createCustomer);
    route(customerRes, "GET", f.getCustomer);
    route(customerAccounts, "POST", f.createAccount);
    route(customerAccounts, "GET", f.listAccounts);
    route(accountRes, "GET", f.getAccount);
    route(accountRes.addResource("deposits"), "POST", f.deposit);
    route(accountRes.addResource("withdrawals"), "POST", f.withdraw);
    route(accountRes.addResource("transactions"), "GET", f.history);
    route(api.root.addResource("transfers"), "POST", f.transfer);
    route(transactionsRes.addResource("{transactionId}"), "GET", f.status);

    // ── WAF: managed rule sets + per-IP rate limiting (distributed back-pressure) ───────────────
    const webAcl = new wafv2.CfnWebACL(this, "ApiWaf", {
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `banking-api-${stage}`, sampledRequestsEnabled: true },
      rules: [
        managedRule("AWSManagedRulesCommonRuleSet", 0),
        managedRule("AWSManagedRulesKnownBadInputsRuleSet", 1),
        {
          name: "RateLimitPerIp",
          priority: 2,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: 2000, aggregateKeyType: "IP" } }, // per 5-minute window
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: "RateLimitPerIp", sampledRequestsEnabled: true },
        },
      ],
    });
    new wafv2.CfnWebACLAssociation(this, "ApiWafAssociation", {
      resourceArn: api.deploymentStage.stageArn,
      webAclArn: webAcl.attrArn,
    });

    // ── Platform alarms ─────────────────────────────────────────────────────────────────────────
    const alarm = (id, metric, threshold, description) =>
      new cloudwatch.Alarm(this, id, {
        metric,
        threshold,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: description,
      }).addAlarmAction(alarmAction);

    alarm("Api5xx", api.metricServerError({ period: Duration.minutes(5) }), 5, "API 5xx responses");
    alarm("ApiLatencyP99", api.metricLatency({ period: Duration.minutes(5), statistic: "p99" }), 2000, "API p99 latency > 2s");
    alarm("EventsDlqNotEmpty", eventsDlq.metricApproximateNumberOfMessagesVisible(), 1, "Ledger events failed downstream processing");
    alarm("StreamFailuresNotEmpty", streamFailures.metricApproximateNumberOfMessagesVisible(), 1, "Ledger stream records could not be relayed");
    alarm(
      "RelayIteratorAge",
      relay.metric("IteratorAge", { period: Duration.minutes(5), statistic: "Maximum" }),
      60000,
      "Outbox relay is falling behind (eventual-consistency lag > 60s)"
    );
    for (const table of [accounts, transactions]) {
      alarm(
        `${table.node.id}WriteThrottles`,
        new cloudwatch.Metric({
          namespace: "AWS/DynamoDB",
          metricName: "WriteThrottleEvents",
          dimensionsMap: { TableName: table.tableName },
          period: Duration.minutes(5),
          statistic: "Sum",
        }),
        1,
        `${table.node.id}: DynamoDB write throttling (hot partition or capacity)`
      );
    }

    cdk.Tags.of(this).add("app", "banking-api");
    cdk.Tags.of(this).add("stage", stage);
    cdk.Tags.of(this).add("data-classification", "confidential");

    new CfnOutput(this, "ApiUrl", { value: api.url });
    new CfnOutput(this, "LedgerEventsQueueUrl", { value: eventsQueue.queueUrl });
    new CfnOutput(this, "JwtSecretArn", { value: jwtSecret.secretArn });
  }
}

function managedRule(name, priority) {
  return {
    name,
    priority,
    overrideAction: { none: {} },
    statement: { managedRuleGroupStatement: { vendorName: "AWS", name } },
    visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: name, sampledRequestsEnabled: true },
  };
}

module.exports = { BankingStack };

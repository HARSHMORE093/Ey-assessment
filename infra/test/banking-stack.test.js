"use strict";

const cdk = require("aws-cdk-lib");
const { Template, Match } = require("aws-cdk-lib/assertions");
const { BankingStack } = require("../lib/banking-stack");

/**
 * Infrastructure assertions: they guard the security / resilience settings against regressions.
 * Bundling is skipped ("aws:cdk:bundling-stacks": []) so the test runs in seconds.
 */
function synth(context = {}) {
  const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [], ...context } });
  return Template.fromStack(new BankingStack(app, "Test"));
}

describe("BankingStack", () => {
  const t = synth();

  test("4 DynamoDB tables, on-demand, KMS-encrypted", () => {
    t.resourceCountIs("AWS::DynamoDB::Table", 4);
    t.allResourcesProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      SSESpecification: Match.objectLike({ SSEEnabled: true, SSEType: "KMS" }),
    });
  });

  test("point-in-time recovery on business tables; TTL on idempotency keys; stream on ledger", () => {
    t.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [{ AttributeName: "accountId", KeyType: "HASH" }],
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
    t.hasResourceProperties("AWS::DynamoDB::Table", {
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    });
    t.hasResourceProperties("AWS::DynamoDB::Table", {
      StreamSpecification: { StreamViewType: "NEW_IMAGE" },
    });
  });

  test("KMS key rotation enabled", () => {
    t.hasResourceProperties("AWS::KMS::Key", { EnableKeyRotation: true });
  });

  test("Lambdas: X-Ray tracing, ARM64, Node 22, JWT auth, idempotency required", () => {
    t.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      TracingConfig: { Mode: "Active" },
      Environment: { Variables: Match.objectLike({ AUTH_MODE: "jwt", REQUIRE_IDEMPOTENCY_KEY: "true" }) },
    });
  });

  test("API Gateway stage throttling + tighter limits on money routes", () => {
    t.hasResourceProperties("AWS::ApiGateway::Stage", {
      MethodSettings: Match.arrayWith([
        Match.objectLike({ HttpMethod: "*", ThrottlingRateLimit: 500, ThrottlingBurstLimit: 1000 }),
        Match.objectLike({ ResourcePath: "/~1accounts~1{accountId}~1withdrawals", HttpMethod: "POST", ThrottlingRateLimit: 50 }),
      ]),
      TracingEnabled: true,
    });
  });

  test("WAF with rate-based rule attached to the API stage", () => {
    t.hasResourceProperties("AWS::WAFv2::WebACL", {
      Rules: Match.arrayWith([Match.objectLike({ Name: "RateLimitPerIp" })]),
    });
    t.resourceCountIs("AWS::WAFv2::WebACLAssociation", 1);
  });

  test("outbox relay: stream mapping with bisect, partial-batch failures and on-failure DLQ", () => {
    t.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      BisectBatchOnFunctionError: true,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      MaximumRetryAttempts: 5,
      DestinationConfig: { OnFailure: Match.objectLike({ Destination: Match.anyValue() }) },
    });
  });

  test("SQS queues encrypted with KMS and SSL enforced", () => {
    t.allResourcesProperties("AWS::SQS::Queue", { KmsMasterKeyId: Match.anyValue() });
    t.resourceCountIs("AWS::SQS::QueuePolicy", 3);
  });

  test("least privilege: the GetAccount function cannot write", () => {
    const policies = t.findResources("AWS::IAM::Policy");
    const getAccountPolicy = Object.entries(policies).find(([id]) => id.startsWith("GetAccountServiceRoleDefaultPolicy"));
    const actions = JSON.stringify(getAccountPolicy[1].Properties.PolicyDocument.Statement.map((s) => s.Action));
    expect(actions).toContain("dynamodb:GetItem");
    expect(actions).not.toMatch(/dynamodb:(PutItem|UpdateItem|DeleteItem|Scan)/);
  });

  test("prod: provisioned concurrency on money aliases, reserved concurrency, retained data", () => {
    const prod = synth({ stage: "prod" });
    prod.hasResourceProperties("AWS::Lambda::Alias", {
      Name: "live",
      ProvisionedConcurrencyConfig: { ProvisionedConcurrentExecutions: 2 },
    });
    prod.hasResourceProperties("AWS::Lambda::Function", { ReservedConcurrentExecutions: 100 });
    prod.hasResource("AWS::DynamoDB::Table", { DeletionPolicy: "Retain", Properties: Match.objectLike({ DeletionProtectionEnabled: true }) });
  });
});

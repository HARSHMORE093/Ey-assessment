#!/usr/bin/env node
"use strict";

const cdk = require("aws-cdk-lib");
const { BankingStack } = require("../lib/banking-stack");

const app = new cdk.App();
const stage = app.node.tryGetContext("stage") || "dev";

new BankingStack(app, `BankingApi-${stage}`, {
  // Account/region from the CLI profile (`cdk deploy --profile ...`); env-agnostic synth otherwise.
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION || "us-east-1" },
  description: "Banking API (API Gateway → Lambda → DynamoDB) — EY assessment",
});

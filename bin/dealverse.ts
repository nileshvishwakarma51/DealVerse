#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DealverseStack } from '../lib/dealverse-stack';

const app = new cdk.App();

new DealverseStack(app, 'DealverseStack', {
  stackName: 'dealverse-stack',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    // Hard-pinned so the stack always deploys to Mumbai regardless of the
    // AWS CLI default region (the CDK CLI sets CDK_DEFAULT_REGION at deploy time).
    region: 'ap-south-1',
  },
});

app.synth();

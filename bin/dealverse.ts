#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DealverseStack } from '../lib/dealverse-stack';

const app = new cdk.App();

new DealverseStack(app, 'DealverseStack', {
  stackName: 'dealverse-stack',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'ap-south-1',
  },
});

app.synth();

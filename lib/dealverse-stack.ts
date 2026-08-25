import * as path from 'path';
import { Construct } from 'constructs';
import { Stack, StackProps, Duration, CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';

export class DealverseStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // DynamoDB — stores a single "latest" config record (overwritten on save).
    const configTable = new dynamodb.Table(this, 'ConfigTable', {
      tableName: 'dealverse-dynamodb',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const helloFn = new lambda.Function(this, 'HelloFunction', {
      functionName: 'dealverse-lambda',
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'hello.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda')),
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        TABLE_NAME: configTable.tableName,
      },
    });

    // Let the Lambda read/write the config table.
    configTable.grantReadWriteData(helloFn);

    // Periodic tick for listener automation. Fires every 5 minutes; the Lambda
    // itself decides whether to run (admin enable + configurable interval) and
    // uses a DynamoDB lock to prevent overlapping runs.
    new events.Rule(this, 'AutomationTick', {
      ruleName: 'dealverse-automation',
      description: 'Ticks dealverse-lambda so it can run listener automation on the admin-configured interval.',
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new targets.LambdaFunction(helloFn)],
    });

    // API Gateway (proxy) — any path/method invokes dealverse-lambda.
    const api = new apigateway.LambdaRestApi(this, 'HelloApi', {
      handler: helloFn,
      proxy: true,
      restApiName: 'dealverse-apigateway',
      description: 'API Gateway that triggers dealverse-lambda.',
      // Serve image assets (logo/favicon) as binary regardless of the client's
      // Accept order. '*/*' also base64-encodes incoming request bodies, which
      // the Lambda decodes (see rawBody() in hello.js).
      binaryMediaTypes: ['*/*'],
    });

    new CfnOutput(this, 'HelloFunctionName', {
      value: helloFn.functionName,
    });

    new CfnOutput(this, 'HelloApiUrl', {
      value: api.url,
      description: 'Invoke URL for dealverse-lambda via API Gateway.',
    });

    new CfnOutput(this, 'ConfigTableName', {
      value: configTable.tableName,
      description: 'DynamoDB table storing the saved config.',
    });
  }
}

import * as path from 'path';
import { Construct } from 'constructs';
import { Stack, StackProps, Duration, CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

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

    // API Gateway (proxy) — any path/method invokes dealverse-lambda.
    const api = new apigateway.LambdaRestApi(this, 'HelloApi', {
      handler: helloFn,
      proxy: true,
      restApiName: 'dealverse-apigateway',
      description: 'API Gateway that triggers dealverse-lambda.',
      // Allow the Lambda to serve image assets (logo/favicon) as binary.
      binaryMediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/x-icon'],
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

import * as path from 'path';
import { Construct } from 'constructs';
import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';

export class DealverseStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const helloFn = new lambda.Function(this, 'HelloFunction', {
      functionName: 'dealverse-lambda',
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'hello.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda')),
      timeout: Duration.seconds(10),
      memorySize: 128,
    });

    new CfnOutput(this, 'HelloFunctionName', {
      value: helloFn.functionName,
    });
  }
}

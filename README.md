# DealVerse

A simple AWS CDK (TypeScript) project.

## Naming convention

All resources are prefixed with `dealverse-` followed by the service, e.g.
`dealverse-lambda`, `dealverse-apigateway`.

## Structure

```
bin/dealverse.ts        CDK app entry point
lib/dealverse-stack.ts  Stack definition (resources live here)
lambda/hello.js         Lambda handler code (plain JS, no dependencies)
```

## Current resources

| Service     | Name                   | Description                                          |
| ----------- | ---------------------- | ---------------------------------------------------- |
| Lambda      | `dealverse-lambda`       | Node.js 24 function: hello + save/get config         |
| API Gateway | `dealverse-apigateway`   | Proxy REST API that triggers the Lambda              |
| DynamoDB    | `dealverse-dynamodb`     | Stores a single "latest" config record (overwritten) |

## API

| Method | Path       | Body                | Description                          |
| ------ | ---------- | ------------------- | ------------------------------------ |
| GET    | `/`        | –                   | Hello World health check             |
| POST   | `/config`  | `{ "curl": "..." }` | Save (overwrite) the config          |
| GET    | `/config`  | –                   | Read the saved config                |

## Commands

```bash
npm install          # install dependencies
npm run synth        # synthesize the CloudFormation template
npm run deploy       # deploy to AWS (requires credentials + bootstrap)
npm run destroy      # tear down the stack
```

### First-time AWS setup

```bash
npx cdk bootstrap    # once per account/region
npm run deploy
```

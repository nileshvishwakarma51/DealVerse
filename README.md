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

| Service | Name             | Description                          |
| ------- | ---------------- | ------------------------------------ |
| Lambda  | `dealverse-lambda` | Node.js 24 hello-world function      |

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

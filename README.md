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
| Lambda      | `dealverse-lambda`       | Node.js 24: serves the React app + affiliate API     |
| API Gateway | `dealverse-apigateway`   | Proxy REST API that triggers the Lambda              |
| DynamoDB    | `dealverse-dynamodb`     | Stores the Amazon SiteStripe session config          |

The single Lambda serves both the React frontend (baked into the asset) and the
backend API. Amazon-only affiliate generation, modelled on the reference project
(`D:\projects\dealverse\auto deal`).

## Panels

- **User panel** (default): paste an amazon.in product link → get an affiliate link.
- **Admin panel** (password `abc`): paste the SiteStripe `getShortUrl` cURL to save the session.

## API

| Method | Path                             | Auth   | Body               | Description                              |
| ------ | -------------------------------- | ------ | ------------------ | ---------------------------------------- |
| GET    | `/hello`                         | –      | –                  | Health check                             |
| POST   | `/api/admin/login`               | –      | `{ secret }`       | Login; returns `{ token }` (base64 pw)   |
| GET    | `/api/admin/amazon/sitestripe`   | Bearer | –                  | Masked status of the saved session       |
| POST   | `/api/admin/amazon/sitestripe`   | Bearer | `{ curl }`         | Parse + save the SiteStripe session      |
| GET    | `/api/affiliate/status`          | –      | –                  | Whether a session is configured          |
| POST   | `/api/affiliate/generate-link`   | –      | `{ url }`          | amazon.in link → affiliate short link    |

Admin auth: `Authorization: Bearer base64(password)` (password hardcoded
`poras860`, overridable via the `ADMIN_SECRET` Lambda env var).

## Telegram bot (admin-configured, dynamic)

The bot token is saved from the admin panel (stored in DynamoDB, never logged or
returned). Setup flow: **Add bot** → enter token + API base URL (registers the
webhook) → message the bot to confirm the round-trip → Save. **Add channel**
(bot must be a channel admin) → post in the channel to detect its id → test →
save. Generated links (from `/home` or the bot) are also published to every
configured channel.

| Method | Path                                     | Auth   | Description                          |
| ------ | ---------------------------------------- | ------ | ------------------------------------ |
| GET    | `/api/admin/telegram`                    | Bearer | Bot status + suggested base URL      |
| POST   | `/api/admin/telegram/connect`            | Bearer | Validate token + register webhook    |
| POST   | `/api/admin/telegram/save`               | Bearer | Finalize bot setup                   |
| POST   | `/api/admin/telegram/remove`             | Bearer | Remove bot + webhook                 |
| POST   | `/api/admin/telegram/test-message`       | Bearer | Send a test message to a chat/channel|
| POST   | `/api/admin/telegram/channel/add`        | Bearer | Add a publish channel                |
| POST   | `/api/admin/telegram/channel/remove`     | Bearer | Remove a channel                     |
| POST   | `/telegram/webhook`                       | secret | Telegram updates (verified header)   |

Webhook requests are verified against a random `secret_token` set at
registration (`X-Telegram-Bot-Api-Secret-Token`).

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

'use strict';

// Installs the Lambda's RUNTIME dependencies into lambda/node_modules so they
// ship inside the CDK asset (lambda.Code.fromAsset('lambda')).
//
// Why this exists: the Lambda used to be dependency-free (only the AWS SDK
// provided by the runtime). The MTProto (beta) feature adds GramJS (`telegram`),
// a real dependency that must be present in the deployed asset. This script is
// run by `npm run lambda:install` (and by `npm run deploy`) BEFORE `cdk deploy`.
//
// Trap avoided (see project memory "lambda-packaging-gitignore-trap"): on a
// fresh clone the deployed asset has NO node_modules, so a missing dep only
// shows up in AWS as "Cannot find module 'telegram'". Running this before every
// deploy guarantees the dependency is packaged.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const lambdaDir = path.join(__dirname, '..', 'lambda');
const pkgPath = path.join(lambdaDir, 'package.json');

if (!fs.existsSync(pkgPath)) {
  console.error('lambda/package.json not found — nothing to install.');
  process.exit(1);
}

console.log('Installing Lambda runtime dependencies into lambda/node_modules …');
// --omit=dev: only runtime deps. --no-audit/--no-fund: quieter, faster.
// Runs in lambda/ so node_modules lands inside the CDK asset directory.
execSync('npm install --omit=dev --no-audit --no-fund', {
  cwd: lambdaDir,
  stdio: 'inherit',
});

const nm = path.join(lambdaDir, 'node_modules', 'telegram');
if (!fs.existsSync(nm)) {
  console.error('ERROR: telegram was not installed into lambda/node_modules.');
  process.exit(1);
}
console.log('Lambda dependencies installed (lambda/node_modules/telegram present).');

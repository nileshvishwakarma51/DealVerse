'use strict';

// Copies the built React app (frontend/dist) into the Lambda code asset
// (lambda/public) so the single Lambda can serve the frontend. No deps.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'frontend', 'dist');
const dest = path.join(root, 'lambda', 'public');

if (!fs.existsSync(src)) {
  console.error('frontend/dist not found. Run the frontend build first.');
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });

console.log(`Copied ${src} -> ${dest}`);

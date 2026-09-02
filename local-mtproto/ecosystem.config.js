// pm2 config for the always-on MTProto listener.
//   pm2 start ecosystem.config.js
//   pm2 save && pm2 startup   (run the printed line -> start on boot)
module.exports = {
  apps: [
    {
      name: 'mtproto-listener',
      script: 'index.js',
      cwd: __dirname,
      instances: 1, // NEVER more than 1 — multiple share the Telegram session and split updates
      autorestart: true,
      restart_delay: 5000, // wait 5s between restarts (avoid hammering Telegram on a bad session)
      max_restarts: 20,
      min_uptime: '15s',
      // .env is loaded by the app itself (dotenv); nothing secret is set here.
      env: { NODE_ENV: 'production' },
      out_file: './logs/out.log',
      error_file: './logs/err.log',
      merge_logs: true,
      time: true,
    },
  ],
};

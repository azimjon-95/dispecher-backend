module.exports = {
  apps: [
    {
      name:        'dispecher-server',
      script:      'server.js',
      cwd:         '/root/gilam/dispecher-backend',
      instances:   1,
      autorestart: true,
      watch:       false,
      max_restarts: 10,
      restart_delay: 3000,
      env: {
        NODE_ENV: 'production',
      },
      error_file:  '/root/.pm2/logs/dispecher-server-error.log',
      out_file:    '/root/.pm2/logs/dispecher-server-out.log',
      time:        true,
    },
    {
      name:        'dispecher-bot',
      script:      'bot/index.js',
      cwd:         '/root/gilam/dispecher-backend',
      instances:   1,
      autorestart: true,
      watch:       false,
      max_restarts: 20,
      restart_delay: 5000,   // bot xato bo'lsa 5s kutib qayta urinadi
      exp_backoff_restart_delay: 100,
      env: {
        NODE_ENV: 'production',
      },
      error_file:  '/root/.pm2/logs/dispecher-bot-error.log',
      out_file:    '/root/.pm2/logs/dispecher-bot-out.log',
      time:        true,
    },
  ],
}

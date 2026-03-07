module.exports = {
  apps: [
    {
      name: 'baileys-manager',
      script: 'server.js',
      watch: false,
      restart_delay: 5000,
      max_restarts: 20,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
  ],
};

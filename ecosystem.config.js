
module.exports = {
  apps: [
    {
      name: 'scraper',
      script: './scraper.mjs',
      cron_restart: '*/15 * * * *', // Every 15 minutes
      watch: false,
    },
    {
      name: 'llm_response_context',
      script: './llm_response_context.mjs',
      cron_restart: '*/20 * * * *', // Every 20 minutes
      watch: false,
    },
    {
      name: 'generate_responses',
      script: './generate_responses.mjs',
      cron_restart: '*/25 * * * *', // Every 25 minutes
      watch: false,
    },
    {
      name: 'xresponder',
      script: './xresponder.mjs',
      cron_restart: '*/30 * * * *', // Every 30 minutes
      watch: false,
    },
    {
      name: 'author_notes',
      script: './author_notes.mjs',
      cron_restart: '0 0 * * *', // Every day at midnight
      watch: false,
    },
  ],
};
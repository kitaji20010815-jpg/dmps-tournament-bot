import { checkForNewCompetitions } from './bot.js';

checkForNewCompetitions()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[FATAL]', err);
    process.exit(1);
  });

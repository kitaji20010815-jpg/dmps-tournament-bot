import { checkHourlyReminders } from './bot.js';

checkHourlyReminders()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[FATAL]', err);
    process.exit(1);
  });

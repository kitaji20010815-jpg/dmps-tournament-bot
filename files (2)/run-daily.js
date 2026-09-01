import { checkDailyReminders } from './bot.js';

checkDailyReminders()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[FATAL]', err);
    process.exit(1);
  });

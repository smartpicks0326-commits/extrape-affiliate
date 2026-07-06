const cron = require('node-cron');
const importDeals = require('../jobs/importDeals');
const generateContent = require('../jobs/generateContent');
const generateImages = require('../jobs/generateImages');
const publishPinterest = require('../jobs/publishPinterest');
const backupDatabase = require('../jobs/backupDatabase');

const CYCLE_CRON = process.env.CRON_INTERVAL || '*/30 * * * *';
const BACKUP_CRON = process.env.BACKUP_CRON || '0 3 * * *';

let running = false;

async function runCycle() {
  if (running) {
    console.warn('[scheduler] previous cycle still running, skipping this tick');
    return;
  }
  running = true;
  const startedAt = new Date().toISOString();
  console.log(`[scheduler] cycle started at ${startedAt}`);

  try {
    await importDeals();
    await generateContent();
    await generateImages();
    await publishPinterest();
    console.log(`[scheduler] cycle completed at ${new Date().toISOString()}`);
  } catch (err) {
    console.error('[scheduler] cycle failed:', err);
  } finally {
    running = false;
  }
}

function start() {
  cron.schedule(CYCLE_CRON, runCycle);
  cron.schedule(BACKUP_CRON, () => {
    backupDatabase().catch((err) => console.error('[scheduler] backup failed:', err));
  });
  console.log(`[scheduler] pipeline scheduled: ${CYCLE_CRON}, backups: ${BACKUP_CRON}`);
}

module.exports = { start, runCycle };

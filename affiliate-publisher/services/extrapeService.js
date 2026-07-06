const extrapeConfig = require('../config/extrape');

// NOTE: Extrape's terms of service should be verified before relying on
// this in production (per earlier discussion). This stub returns an empty
// list until that's confirmed and real API details are available.
async function fetchDeals({ limit = 10 } = {}) {
  if (extrapeConfig.mockMode) {
    console.warn('[extrapeService] mock mode — no Extrape API key configured, returning []');
    return [];
  }

  throw new Error('Extrape live integration not yet implemented — confirm API docs first.');
}

module.exports = { fetchDeals };

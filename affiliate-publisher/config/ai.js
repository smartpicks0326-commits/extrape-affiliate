require('dotenv').config();

module.exports = {
  apiKey: process.env.ANTHROPIC_API_KEY || null,
  model: process.env.AI_MODEL || 'claude-haiku-4-5-20251001',
  mockMode: !process.env.ANTHROPIC_API_KEY,
};

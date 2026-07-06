require('dotenv').config();

module.exports = {
  apiKey: process.env.EXTRAPE_API_KEY || null,
  baseUrl: process.env.EXTRAPE_BASE_URL || null,
  mockMode: !process.env.EXTRAPE_API_KEY,
};

require('dotenv').config();

module.exports = {
  associateTag: process.env.AMAZON_ASSOCIATE_TAG,
  accessKey: process.env.AMAZON_ACCESS_KEY || null,
  secretKey: process.env.AMAZON_SECRET_KEY || null,
  region: process.env.AMAZON_REGION || 'us-east-1',
  // mockMode stays true automatically if credentials are missing,
  // regardless of the .env flag, so the pipeline never fails silently
  // by trying to sign requests with empty keys.
  mockMode:
    process.env.AMAZON_MOCK_MODE === 'true' ||
    !process.env.AMAZON_ACCESS_KEY ||
    !process.env.AMAZON_SECRET_KEY,
};

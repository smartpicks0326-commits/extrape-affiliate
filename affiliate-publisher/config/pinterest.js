require('dotenv').config();

module.exports = {
  appId: process.env.PINTEREST_APP_ID || null,
  appSecret: process.env.PINTEREST_APP_SECRET || null,
  accessToken: process.env.PINTEREST_ACCESS_TOKEN || null,
  refreshToken: process.env.PINTEREST_REFRESH_TOKEN || null,
  boardId: process.env.PINTEREST_BOARD_ID || null,
  apiBase: 'https://api.pinterest.com/v5',
  mockMode:
    process.env.PINTEREST_MOCK_MODE === 'true' ||
    !process.env.PINTEREST_ACCESS_TOKEN,
};

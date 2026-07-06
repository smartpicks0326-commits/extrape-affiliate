const axios = require('axios');
const fs = require('fs');
const pinterestConfig = require('../config/pinterest');

async function refreshAccessToken() {
  if (pinterestConfig.mockMode) return pinterestConfig.accessToken;

  const res = await axios.post('https://api.pinterest.com/v5/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: pinterestConfig.refreshToken,
    client_id: pinterestConfig.appId,
    client_secret: pinterestConfig.appSecret,
  });

  return res.data.access_token;
}

async function publishPin({ title, description, imagePath, link }) {
  if (pinterestConfig.mockMode) {
    console.warn(
      `[pinterestService] mock mode — no Pinterest API app registered yet. ` +
      `Would publish: "${title}" -> ${link}`
    );
    return { id: `mock-${Date.now()}`, mock: true };
  }

  const imageBase64 = fs.readFileSync(imagePath, { encoding: 'base64' });

  const res = await axios.post(
    `${pinterestConfig.apiBase}/pins`,
    {
      board_id: pinterestConfig.boardId,
      title,
      description,
      link,
      media_source: {
        source_type: 'image_base64',
        content_type: 'image/jpeg',
        data: imageBase64,
      },
    },
    {
      headers: { Authorization: `Bearer ${pinterestConfig.accessToken}` },
    }
  );

  return res.data;
}

module.exports = { publishPin, refreshAccessToken };

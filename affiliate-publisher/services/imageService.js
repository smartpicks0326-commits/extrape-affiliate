const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const OUTPUT_DIR = path.join(__dirname, '..', 'generated', 'images');
const CANVAS_WIDTH = 1000;
const CANVAS_HEIGHT = 1500;

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function downloadImage(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

function buildOverlaySvg({ discount, brand }) {
  // SVG overlay for discount badge + branding text, composited onto the product photo.
  return Buffer.from(`
    <svg width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}">
      <style>
        .badge { fill: #E60023; }
        .badge-text { fill: white; font-size: 42px; font-weight: bold; font-family: sans-serif; }
        .brand-text { fill: white; font-size: 30px; font-weight: bold; font-family: sans-serif; }
        .brand-bg { fill: rgba(0,0,0,0.55); }
      </style>
      ${discount ? `
        <circle cx="150" cy="150" r="90" class="badge" />
        <text x="150" y="140" text-anchor="middle" class="badge-text">-${discount}%</text>
        <text x="150" y="180" text-anchor="middle" class="badge-text" font-size="24">OFF</text>
      ` : ''}
      <rect x="0" y="${CANVAS_HEIGHT - 100}" width="${CANVAS_WIDTH}" height="100" class="brand-bg" />
      <text x="30" y="${CANVAS_HEIGHT - 40}" class="brand-text">SmartPickDeals.live</text>
    </svg>
  `);
}

async function generatePinImage(product, filenamePrefix) {
  const productImageBuffer = await downloadImage(product.image_url);

  const resizedProduct = await sharp(productImageBuffer)
    .resize(CANVAS_WIDTH, CANVAS_HEIGHT - 100, { fit: 'cover', position: 'top' })
    .toBuffer();

  const canvas = sharp({
    create: {
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  });

  const overlay = buildOverlaySvg({ discount: product.discount, brand: 'SmartPickDeals' });

  const outputPath = path.join(OUTPUT_DIR, `${filenamePrefix}-${Date.now()}.jpg`);

  await canvas
    .composite([
      { input: resizedProduct, top: 0, left: 0 },
      { input: overlay, top: 0, left: 0 },
    ])
    .jpeg({ quality: 85 })
    .toFile(outputPath);

  return outputPath;
}

module.exports = { generatePinImage };

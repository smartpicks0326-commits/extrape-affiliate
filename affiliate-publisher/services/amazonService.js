const amazonConfig = require('../config/amazon');

// Sample data used while PA-API access is pending (mockMode = true).
// Swap fetchDeals() body for a real PA-API SearchItems/GetItems call once
// your access key + secret are approved.
const SAMPLE_DEALS = [
  {
    asin: 'B0SAMPLE001',
    title: 'Samsung Galaxy S25 Ultra',
    price: 89999,
    discount: 15,
    rating: 4.5,
    image_url: 'https://via.placeholder.com/600x600.png?text=Galaxy+S25',
    category: 'electronics',
    brand: 'Samsung',
  },
  {
    asin: 'B0SAMPLE002',
    title: 'Sony WH-1000XM5 Headphones',
    price: 24999,
    discount: 20,
    rating: 4.7,
    image_url: 'https://via.placeholder.com/600x600.png?text=Sony+XM5',
    category: 'electronics',
    brand: 'Sony',
  },
];

function buildAffiliateUrl(asin) {
  return `https://www.amazon.in/dp/${asin}?tag=${amazonConfig.associateTag}`;
}

async function fetchDeals({ limit = 10 } = {}) {
  if (amazonConfig.mockMode) {
    console.warn('[amazonService] running in MOCK MODE — no live PA-API credentials configured');
    return SAMPLE_DEALS.slice(0, limit).map((d) => ({
      ...d,
      source: 'amazon',
      affiliate_url: buildAffiliateUrl(d.asin),
    }));
  }

  // --- Real PA-API integration goes here once approved ---
  // PA-API requires SigV4 request signing. Recommended: use the official
  // 'paapi5-nodejs-sdk' package rather than hand-rolling signing logic.
  throw new Error(
    'Live Amazon PA-API integration not yet implemented. ' +
    'Set AMAZON_MOCK_MODE=true in .env until credentials are approved.'
  );
}

module.exports = { fetchDeals, buildAffiliateUrl };

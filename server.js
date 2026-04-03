const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());
app.use(cors());

const EXTRAPE_ACCESS_TOKEN   = process.env.EXTRAPE_ACCESS_TOKEN;
const EXTRAPE_REMEMBER_TOKEN = process.env.EXTRAPE_REMEMBER_TOKEN;
const BACKEND_URL             = process.env.BACKEND_URL || '';
const AVG_SECONDS_PER_REQUEST = 2;

const SUPPORTED_DOMAINS = [
  'amazon.in','amazon.com','amzn.in','amzn.to',
  'flipkart.com','dl.flipkart.com',
  'myntra.com','ajio.com',
  'nykaa.com','nykaafashion.com','nykaabeauty.com',
  'tatacliq.com','tatacliq.luxury',
  'croma.com','snapdeal.com','boat-lifestyle.com',
  'makemytrip.com','cleartrip.com',
  'netflix.com','sonyliv.com','hotstar.com',
  'netmeds.com','1mg.com','pharmeasy.in',
  'mamaearth.in','wowskinscience.com',
  'meesho.com','jiomart.com',
  'bigbasket.com','firstcry.com',
  'lenskart.com','pepperfry.com',
];

function isSupported(url) {
  try {
    const h = new URL(url).hostname.replace('www.','');
    return SUPPORTED_DOMAINS.some(d => h.includes(d));
  } catch { return false; }
}

// ── Short URL store ──
const shortLinks = {};

function makeShortCode(len = 8) {
  const c = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += c[Math.floor(Math.random() * c.length)];
  return shortLinks[s] ? makeShortCode(len) : s;
}

// ── Queue ──
const queue = [];
const requests = {};
let isProcessing = false;

function createRequest(url, store) {
  const id = uuidv4();
  requests[id] = { id, url, store, state:'pending', position:0, affiliateLink:null, displayLink:null, error:null, createdAt:Date.now() };
  queue.push(id);
  updatePositions();
  return id;
}

function updatePositions() {
  queue.forEach((id, i) => { if (requests[id]) requests[id].position = i + 1; });
}

function getStatus(id) {
  const r = requests[id];
  if (!r) return null;
  const pos = r.state === 'pending' ? r.position : 0;
  return { id:r.id, state:r.state, position:pos, queueLength:queue.length,
    estimatedSeconds:pos * AVG_SECONDS_PER_REQUEST,
    affiliateLink: r.affiliateLink,
    displayLink:   r.displayLink || r.affiliateLink,
    error: r.error };
}

setInterval(() => {
  const tenMins = 10*60*1000;
  Object.keys(requests).forEach(id => { if (Date.now()-requests[id].createdAt > tenMins) delete requests[id]; });
}, 60000);

// ── Clean affiliate URL — keep only essential params ──
function cleanAffiliateUrl(url, originalInput) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;

    // ── Native short links ExtraPe returns — pass through directly ──
    // Flipkart native: fkrt.co/xxxxx
    if (host.includes('fkrt.co')) return url;

    // Amazon native short links: amzn.in/d/xxx or amzn.to/xxx
    if (host === 'amzn.in' || host === 'amzn.to') return url;

    // Any short URL under 55 chars — return as-is
    if (url.length < 55) return url;

    // ── Long Amazon URLs with visible tags ──
    if (host.includes('amazon')) {
      const dpMatch = parsed.pathname.match(/\/dp\/([A-Z0-9]{10})/i);
      if (dpMatch) {
        const asin = dpMatch[1];
        const code = makeShortCode();
        shortLinks[code] = url; // full URL with tag stored server-side
        const frontendUrl = process.env.FRONTEND_URL || BACKEND_URL;
        // Use frontend domain for the redirect link — looks branded, not backend
        const shortLink = frontendUrl + '/go/' + code;
        return {
          displayUrl: shortLink,  // what user sees & copies — branded clean URL
          clickUrl:   shortLink   // same URL — always earns commission
        };
      }
    }

    // ── Other long URLs — use frontend branded short link ──
    const code = makeShortCode();
    shortLinks[code] = url;
    const frontendUrl = process.env.FRONTEND_URL || BACKEND_URL;
    return frontendUrl + '/go/' + code;

  } catch(e) { return url; }
}

// ── Core: Call ExtraPe API ──
async function convertUrl(productUrl) {
  console.log('Converting: ' + productUrl);
  const encodedUrl = encodeURIComponent(productUrl);

  const response = await fetch('https://www.extrape.com/handler/convertText', {
    method: 'POST',
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Accesstoken': EXTRAPE_ACCESS_TOKEN,
      'Content-Type': 'application/json',
      'Origin': 'https://www.extrape.com',
      'Referer': 'https://www.extrape.com/link-converter',
      'Remembermetoken': EXTRAPE_REMEMBER_TOKEN,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
    body: JSON.stringify({ inputText: encodedUrl, bitlyConvert: false, advanceMode: false })
  });

  if (!response.ok) throw new Error('ExtraPe API error: ' + response.status);

  const data = await response.json();
  const raw = data.convertedText || data.outputText || data.result || data.link || data.url ||
    (typeof data === 'string' ? data : null);

  if (!raw) throw new Error('No link in response: ' + JSON.stringify(data));

  const decoded = decodeURIComponent(raw.trim());
  console.log('ExtraPe raw: ' + decoded);

  const result = cleanAffiliateUrl(decoded, productUrl);

  // If result is an object (Amazon dual-link), return both displayUrl and clickUrl
  if (result && typeof result === 'object') {
    console.log('Display URL: ' + result.displayUrl);
    console.log('Click URL: ' + result.clickUrl);
    return result; // { displayUrl, clickUrl }
  }

  console.log('Final link: ' + result);
  return result;
}

// ── Queue Processor ──
async function processQueue() {
  if (isProcessing || queue.length === 0) return;
  isProcessing = true;
  const id = queue.shift();
  updatePositions();
  const req = requests[id];
  if (!req) { isProcessing = false; processQueue(); return; }
  req.state = 'processing';
  try {
    const linkResult = await convertUrl(req.url);
    // Handle dual-link object (Amazon) vs plain string
    if (linkResult && typeof linkResult === 'object') {
      req.affiliateLink = linkResult.clickUrl;   // actual click URL with tag
      req.displayLink   = linkResult.displayUrl; // clean URL shown to user
    } else {
      req.affiliateLink = linkResult;
      req.displayLink   = linkResult;
    }
    req.state = 'done';
  } catch(err) {
    req.state = 'error'; req.error = err.message;
    console.error('Failed:', err.message);
  } finally {
    isProcessing = false; processQueue();
  }
}

// ── Flash.co API Integration ──
// Add FLASH_AUTH_TOKEN and FLASH_DEVICE_ID to Render environment variables
const FLASH_AUTH_TOKEN = process.env.FLASH_AUTH_TOKEN || '';
const FLASH_DEVICE_ID  = process.env.FLASH_DEVICE_ID  || '';

const FLASH_API_HEADERS = () => ({
  'Accept': 'application/json',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Authorization': 'Bearer ' + FLASH_AUTH_TOKEN,
  'Channel-Type': 'web',
  'Origin': 'https://flash.co',
  'Referer': 'https://flash.co/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36',
  'X-Country-Code': 'IN',
  'X-Device-Id': FLASH_DEVICE_ID,
  'X-Timezone': 'Asia/Calcutta',
});

// Step 1: Submit URL to flash.co and get pageHash via SSE stream
async function flashSearch(productUrl) {
  const params = new URLSearchParams({
    source: 'APPEND',
    context: 'HOME_URL_PASTE',
    user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36',
    device_type: 'DESKTOP',
    country_code: 'IN',
  });

  const url = 'https://apiv3.flash.tech/agents/chat/stream?' + params.toString();
  console.log('Flash search URL:', url);

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      ...FLASH_API_HEADERS(),
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify({
      message: productUrl,
      context: 'HOME_URL_PASTE',
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!r.ok) {
    const txt = await r.text();
    throw new Error('Flash stream error ' + r.status + ': ' + txt.substring(0, 200));
  }

  // Read SSE stream and extract pageHash/productId
  const text = await r.text();
  console.log('Flash stream raw (first 800):', text.substring(0, 800));

  // Parse SSE events to find pageHash
  let pageHash = null;
  let productId = null;
  let productName = null;
  let productImage = null;

  // Look for redirect URL pattern: flash.co/price-compare/{id}/h/{hash} or flash.co/item/{id}/{slug}/h/{hash}
  const redirectMatch = text.match(/flash\.co\/(?:price-compare|item)\/(\d+)\/[^\/]+\/h\/([A-Za-z0-9_-]+)/);
  if (redirectMatch) {
    productId = redirectMatch[1];
    pageHash  = redirectMatch[2];
    console.log('Found from redirect - productId:', productId, 'pageHash:', pageHash);
  }

  // Also try parsing JSON chunks in the SSE
  if (!pageHash) {
    const lines = text.split("\n"); // parse SSE lines
    for (const match of jsonMatches) {
      try {
        const d = JSON.parse(match[1]);
        if (d.pageHash) { pageHash = d.pageHash; }
        if (d.productId) { productId = d.productId; }
        if (d.name || d.productName) { productName = d.name || d.productName; }
        if (d.image || d.imageUrl) { productImage = d.image || d.imageUrl; }
      } catch(e) {}
    }
  }

  // Try finding pageHash in any form in the response
  if (!pageHash) {
    const hashMatch = text.match(/"pageHash":\s*"([A-Za-z0-9_-]+)"/);
    if (hashMatch) pageHash = hashMatch[1];
  }

  if (!pageHash) throw new Error('Could not extract pageHash from flash stream. Response: ' + text.substring(0, 400));

  return { pageHash, productId, productName, productImage };
}

// Step 2: Get product details + store prices using pageHash
async function flashGetPrices(pageHash) {
  const url = 'https://apiv3.flash.tech/api/v1/customer/feedback/fetch?scope=PRODUCT_DETAILS&referenceId=' + pageHash;
  console.log('Flash prices URL:', url);

  const r = await fetch(url, {
    headers: FLASH_API_HEADERS(),
    signal: AbortSignal.timeout(15000),
  });

  if (!r.ok) throw new Error('Flash prices error ' + r.status);
  const data = await r.json();
  console.log('Flash prices response (first 600):', JSON.stringify(data).substring(0, 600));
  return data;
}

// Main compare endpoint
app.get('/compare/search', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Pass ?url=' });

  if (!FLASH_AUTH_TOKEN) {
    return res.status(503).json({
      error: 'FLASH_AUTH_TOKEN not configured. Add it to Render environment variables.',
      needsKey: true
    });
  }

  try {
    // Step 1: Search and get pageHash
    console.log('Searching flash.co for:', url);
    const { pageHash, productId, productName: pName, productImage: pImg } = await flashSearch(url);
    console.log('Got pageHash:', pageHash, 'productId:', productId);

    // Step 2: Get prices
    const priceData = await flashGetPrices(pageHash);

    // Step 3: Parse stores from flash response
    // Flash returns data in various shapes - try all
    const rawStores =
      priceData?.stores ||
      priceData?.data?.stores ||
      priceData?.priceComparisons ||
      priceData?.data?.priceComparisons ||
      priceData?.comparisons ||
      priceData?.storeDetails ||
      priceData?.retailers ||
      [];

    const productTitle = priceData?.productName || priceData?.name ||
      priceData?.data?.name || priceData?.data?.productName || pName || 'Product';
    const productImage = priceData?.image || priceData?.imageUrl ||
      priceData?.data?.image || pImg || '';

    console.log('Raw stores count:', rawStores.length, 'Product:', productTitle);
    console.log('Full priceData keys:', Object.keys(priceData || {}));

    let stores = [];
    if (rawStores.length > 0) {
      stores = rawStores.map(s => ({
        name: normalizeStoreName(s.storeName || s.name || s.store || s.retailer || s.source || ''),
        price: parseInt((s.price || s.amount || s.salePrice || s.mrp || s.offerPrice || '0').toString().replace(/[^0-9]/g, '')) || 0,
        url: s.url || s.link || s.buyUrl || s.storeUrl || s.productUrl || '',
        image: s.image || s.thumbnail || productImage || '',
      })).filter(s => s.price > 0 && s.name);
    }

    // If no stores parsed, return the raw data for debugging
    if (stores.length === 0) {
      return res.json({
        stores: [],
        productName: productTitle,
        productImage,
        pageHash,
        debug: { keys: Object.keys(priceData || {}), rawSample: JSON.stringify(priceData).substring(0, 500) }
      });
    }

    stores.sort((a, b) => a.price - b.price);

    return res.json({
      stores,
      productName: productTitle,
      productImage,
      totalStores: stores.length,
      pageHash,
    });

  } catch(e) {
    console.error('Compare error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// Normalize store names to match our known stores
function normalizeStoreName(source) {
  const s = source.toLowerCase();
  if (s.includes('amazon')) return 'Amazon';
  if (s.includes('flipkart')) return 'Flipkart';
  if (s.includes('myntra')) return 'Myntra';
  if (s.includes('ajio')) return 'Ajio';
  if (s.includes('nykaa')) return 'Nykaa';
  if (s.includes('tatacliq') || s.includes('tata cliq')) return 'TataCliq';
  if (s.includes('croma')) return 'Croma';
  if (s.includes('snapdeal')) return 'Snapdeal';
  if (s.includes('meesho')) return 'Meesho';
  if (s.includes('jiomart')) return 'JioMart';
  if (s.includes('bigbasket')) return 'BigBasket';
  if (s.includes('firstcry')) return 'FirstCry';
  if (s.includes('netmeds')) return 'Netmeds';
  if (s.includes('lenskart')) return 'Lenskart';
  if (s.includes('reliance')) return 'Reliance Digital';
  if (s.includes('vijay')) return 'Vijay Sales';
  if (s.includes('shopsy')) return 'Shopsy';
  if (s.includes('pepperfry')) return 'Pepperfry';
  if (s.includes('boat')) return 'Boat';
  if (s.includes('mamaearth')) return 'Mamaearth';
  if (source.length > 2) return source; // keep unknown stores
  return '';
}

// ── Debug: see raw ExtraPe output ──
app.get('/test-link', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.json({ error: 'Pass ?url=...' });
  try {
    const encodedUrl = encodeURIComponent(url);
    const r = await fetch('https://www.extrape.com/handler/convertText', {
      method: 'POST',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accesstoken': EXTRAPE_ACCESS_TOKEN,
        'Content-Type': 'application/json',
        'Origin': 'https://www.extrape.com',
        'Referer': 'https://www.extrape.com/link-converter',
        'Remembermetoken': EXTRAPE_REMEMBER_TOKEN,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      body: JSON.stringify({ inputText: encodedUrl, bitlyConvert: false, advanceMode: false })
    });
    const data = await r.json();
    const raw = data.convertedText || data.outputText || data.result || data.link || data.url || JSON.stringify(data);
    const decoded = decodeURIComponent(raw.trim());
    const final = cleanAffiliateUrl(decoded, url);
    res.json({ input: url, rawFromExtraPe: decoded, finalLink: final, fullResponse: data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Routes ──
app.post('/generate', async (req, res) => {
  const { url, store } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL.' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL.' }); }
  if (!isSupported(url)) return res.status(400).json({ error: 'Store not supported.' });
  if (!EXTRAPE_ACCESS_TOKEN) return res.status(500).json({ error: 'EXTRAPE_ACCESS_TOKEN not set.' });
  const id = createRequest(url, store || 'Unknown');
  processQueue();
  return res.json({ requestId: id, ...getStatus(id) });
});

app.get('/status/:id', (req, res) => {
  const s = getStatus(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found.' });
  return res.json(s);
});

app.get('/s/:code', (req, res) => {
  const url = shortLinks[req.params.code];
  if (url) res.redirect(301, url);
  else res.status(404).send('Link not found or expired.');
});

// ── /go/:code — same as /s/ but served from branded frontend domain via proxy ──
app.get('/go/:code', (req, res) => {
  const url = shortLinks[req.params.code];
  if (url) res.redirect(301, url);
  else res.status(404).send('Link not found or expired.');
});

// ── API: resolve a /go/ code (called by Cloudflare Pages function) ──
app.get('/resolve/:code', (req, res) => {
  const url = shortLinks[req.params.code];
  if (url) res.json({ url });
  else res.status(404).json({ error: 'Not found' });
});

app.get('/', (req, res) => res.send('Smart Pick Deals backend ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server on port ' + PORT));
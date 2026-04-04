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
const FLASH_AUTH_TOKEN = process.env.FLASH_AUTH_TOKEN || '';
const FLASH_DEVICE_ID  = process.env.FLASH_DEVICE_ID  || 'a44d3a70-b94f-4089-96d7-8e253768505d';

function flashHeaders() {
  return {
    'Accept': 'application/json',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-GB,en;q=0.9',
    'Authorization': 'Bearer ' + FLASH_AUTH_TOKEN,
    'Channel-Type': 'web',
    'Origin': 'https://flash.co',
    'Referer': 'https://flash.co/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    'X-Country-Code': 'IN',
    'X-Device-Id': FLASH_DEVICE_ID,
    'X-Timezone': 'Asia/Calcutta',
  };
}

// Step 1: POST URL to flash.co SSE stream, extract pageHash
async function flashSearchUrl(productUrl) {
  const qs = new URLSearchParams({
    source: 'APPEND',
    context: 'HOME_URL_PASTE',
    user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36',
    device_type: 'DESKTOP',
    country_code: 'IN',
  }).toString();

  const endpoint = 'https://apiv3.flash.tech/agents/chat/stream?' + qs;
  console.log('[Flash] Stream POST:', endpoint);

  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { ...flashHeaders(), 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
    body: JSON.stringify({ message: productUrl, context: 'HOME_URL_PASTE' }),
    signal: AbortSignal.timeout(35000),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error('Flash stream ' + r.status + ': ' + t.substring(0, 300));
  }

  const rawText = await r.text();
  console.log('[Flash] SSE raw (1000 chars):', rawText.substring(0, 1000));

  // Extract pageHash from various patterns in the SSE response
  let pageHash = null;
  let productId = null;
  let productName = null;
  let productImage = null;

  // Pattern 1: URL in stream like /price-compare/81683/h/QdlzUMgS or /item/81683/slug/h/QdlzUMgS
  const urlMatch = rawText.match(/flash\.co\/(?:price-compare|item)\/(\d+)\/[^\/\s"]*\/h\/([A-Za-z0-9_-]{4,})/);
  if (urlMatch) {
    productId = urlMatch[1];
    pageHash  = urlMatch[2];
    console.log('[Flash] Found via URL pattern - id:', productId, 'hash:', pageHash);
  }

  // Pattern 2: JSON field "pageHash" anywhere in stream
  if (!pageHash) {
    const m = rawText.match(/"pageHash"\s*:\s*"([A-Za-z0-9_-]+)"/);
    if (m) { pageHash = m[1]; console.log('[Flash] Found pageHash in JSON:', pageHash); }
  }

  // Pattern 3: "referenceId" field
  if (!pageHash) {
    const m = rawText.match(/"referenceId"\s*:\s*"([A-Za-z0-9_-]+)"/);
    if (m) { pageHash = m[1]; console.log('[Flash] Found referenceId:', pageHash); }
  }

  // Extract product info from SSE lines
  for (const line of rawText.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const d = JSON.parse(line.slice(5).trim());
      if (!productName) productName = d.productName || d.name || d.title || null;
      if (!productImage) productImage = d.image || d.imageUrl || d.thumbnail || null;
      if (!pageHash) pageHash = d.pageHash || d.referenceId || null;
    } catch(e) {}
  }

  if (!pageHash) {
    throw new Error('pageHash not found in stream. Raw (400): ' + rawText.substring(0, 400));
  }

  return { pageHash, productId, productName, productImage };
}

// Step 2: GET product details + store prices from flash.co
async function flashGetProductDetails(pageHash) {
  const url = 'https://apiv3.flash.tech/api/v1/customer/feedback/fetch?scope=PRODUCT_DETAILS&referenceId=' + pageHash;
  console.log('[Flash] GET details:', url);

  const r = await fetch(url, {
    headers: flashHeaders(),
    signal: AbortSignal.timeout(20000),
  });

  if (!r.ok) throw new Error('Flash details ' + r.status);
  const data = await r.json();
  console.log('[Flash] Details keys:', Object.keys(data || {}));
  console.log('[Flash] Details (800):', JSON.stringify(data).substring(0, 800));
  return data;
}

// Step 3: Try the price-compare endpoint directly with pageHash
async function flashGetPriceCompare(pageHash) {
  const url = 'https://apiv3.flash.tech/api/v1/customer/feedback/fetch?scope=PRICE_COMPARE&referenceId=' + pageHash;
  console.log('[Flash] GET price-compare:', url);
  try {
    const r = await fetch(url, { headers: flashHeaders(), signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const data = await r.json();
    console.log('[Flash] Price compare keys:', Object.keys(data || {}));
    console.log('[Flash] Price compare (800):', JSON.stringify(data).substring(0, 800));
    return data;
  } catch(e) {
    console.log('[Flash] Price compare failed:', e.message);
    return null;
  }
}

// Raw debug endpoint — call this to see exactly what flash returns
app.get('/flash/raw', async (req, res) => {
  const { url, hash, scope } = req.query;
  if (!FLASH_AUTH_TOKEN) return res.json({ error: 'FLASH_AUTH_TOKEN not set' });

  const result = {};
  try {
    if (url) {
      const { pageHash, productId, productName, productImage } = await flashSearchUrl(url);
      result.pageHash = pageHash;
      result.productId = productId;
      result.productName = productName;
      result.productImage = productImage;

      // Auto-fetch details with found hash
      const details = await flashGetProductDetails(pageHash);
      result.detailsKeys = Object.keys(details || {});
      result.detailsFull = details;

      const prices = await flashGetPriceCompare(pageHash);
      result.priceCompareKeys = Object.keys(prices || {});
      result.priceCompareFull = prices;
    } else if (hash) {
      const s = scope || 'PRODUCT_DETAILS';
      const endpoint = 'https://apiv3.flash.tech/api/v1/customer/feedback/fetch?scope=' + s + '&referenceId=' + hash;
      const r = await fetch(endpoint, { headers: flashHeaders() });
      result.status = r.status;
      result.data = await r.json();
    }
    res.json(result);
  } catch(e) {
    res.json({ error: e.message, partial: result });
  }
});

// Main compare endpoint
app.get('/compare/search', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Pass ?url=' });
  if (!FLASH_AUTH_TOKEN) return res.status(503).json({ error: 'FLASH_AUTH_TOKEN not configured', needsKey: true });

  try {
    console.log('[Compare] Searching:', url);

    // Step 1: Get pageHash
    const { pageHash, productId, productName: streamName, productImage: streamImg } = await flashSearchUrl(url);

    // Step 2: Get product details (contains product info + stores)
    const details = await flashGetProductDetails(pageHash);

    // Step 3: Also try price-compare scope
    const priceCompare = await flashGetPriceCompare(pageHash);

    // Deep-search both responses for store arrays
    function findStores(obj, depth) {
      if (!obj || depth > 5) return [];
      if (Array.isArray(obj) && obj.length > 0 && (obj[0].price || obj[0].storeName || obj[0].name)) return obj;
      for (const key of Object.keys(obj)) {
        const found = findStores(obj[key], depth + 1);
        if (found.length > 0) return found;
      }
      return [];
    }

    const rawStores = findStores(details, 0).length > 0
      ? findStores(details, 0)
      : findStores(priceCompare || {}, 0);

    // Deep-search for product name and image
    function deepGet(obj, keys, depth) {
      if (!obj || depth > 4) return null;
      for (const k of keys) { if (obj[k]) return obj[k]; }
      for (const key of Object.keys(obj)) {
        if (typeof obj[key] === 'object') {
          const v = deepGet(obj[key], keys, depth + 1);
          if (v) return v;
        }
      }
      return null;
    }

    const productName  = deepGet(details, ['productName','name','title'], 0) || streamName || 'Product';
    const productImage = deepGet(details, ['image','imageUrl','thumbnail','img'], 0) || streamImg || '';
    const updatedAt    = deepGet(details, ['updatedAt','lastUpdated','updated'], 0) || null;

    console.log('[Compare] Stores found:', rawStores.length, '| Product:', productName);

    let stores = [];
    if (rawStores.length > 0) {
      stores = rawStores.map(s => {
        const priceRaw = (s.price || s.amount || s.salePrice || s.mrp || s.offerPrice || 0).toString().replace(/[^0-9.]/g, '');
        const price = parseInt(priceRaw) || 0;
        const name = s.storeName || s.name || s.store || s.retailer || s.source || '';
        return {
          name: name,
          normalizedName: normalizeStoreName(name) || name,
          price,
          url: s.url || s.link || s.buyUrl || s.storeUrl || s.productUrl || '',
          logo: s.logo || s.storeLogo || s.icon || '',
          isSource: false,
        };
      }).filter(s => s.price > 0 && s.name);
    }

    // Mark source store
    try {
      const srcHost = new URL(url).hostname.replace('www.', '');
      stores = stores.map(s => ({
        ...s,
        isSource: s.normalizedName.toLowerCase() === detectStoreName(srcHost).toLowerCase() ||
                  s.name.toLowerCase().includes(srcHost.split('.')[0])
      }));
    } catch(e) {}

    stores.sort((a, b) => a.price - b.price);
    if (stores.length > 0) stores[0].isBest = true;

    // Savings amount
    const srcStore = stores.find(s => s.isSource);
    const bestStore = stores[0];
    const savings = srcStore && bestStore && !srcStore.isBest ? srcStore.price - bestStore.price : 0;

    return res.json({
      stores,
      productName,
      productImage,
      updatedAt,
      savings: savings > 0 ? savings : 0,
      bestStoreName: bestStore?.name || '',
      totalStores: stores.length,
      pageHash,
      // Include debug info if no stores found
      debug: stores.length === 0 ? {
        detailsKeys: Object.keys(details || {}),
        priceKeys: Object.keys(priceCompare || {}),
        sample: JSON.stringify(details).substring(0, 600)
      } : undefined
    });

  } catch(e) {
    console.error('[Compare] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

function detectStoreName(hostname) {
  if (hostname.includes('amazon')) return 'Amazon';
  if (hostname.includes('flipkart')) return 'Flipkart';
  if (hostname.includes('myntra')) return 'Myntra';
  if (hostname.includes('ajio')) return 'Ajio';
  return hostname.split('.')[0];
}


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
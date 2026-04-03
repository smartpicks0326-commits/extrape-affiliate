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

// ── SerpAPI Google Shopping — real prices across Indian stores ──
// Get free API key at: https://serpapi.com (100 free searches/month)
const SERP_API_KEY = process.env.SERP_API_KEY || '';

app.get('/compare/search', async (req, res) => {
  const { url, q } = req.query;
  if (!url && !q) return res.status(400).json({ error: 'Pass ?url= or ?q=' });

  if (!SERP_API_KEY) {
    return res.status(503).json({ error: 'SERP_API_KEY not configured. Get a free key at serpapi.com', needsKey: true });
  }

  try {
    // Build search query from URL or direct query
    let searchQuery = q || '';
    let productUrl = url || '';

    // If URL provided, extract product name from it
    if (url && !q) {
      const parsed = new URL(url);
      const path = parsed.pathname;
      // Try to extract product name from URL path
      const parts = path.split('/').filter(p => p && p.length > 3 && !p.match(/^[A-Z0-9]{10}$/));
      searchQuery = parts.slice(0, 3).join(' ').replace(/-/g,' ').replace(/[^a-zA-Z0-9 ]/g,' ').trim();
      if (!searchQuery || searchQuery.length < 5) searchQuery = 'product'; // fallback
    }

    console.log('Shopping search query:', searchQuery);

    // Call SerpAPI Google Shopping India
    const serpUrl = 'https://serpapi.com/search.json'
      + '?engine=google_shopping'
      + '&q=' + encodeURIComponent(searchQuery)
      + '&gl=in'
      + '&hl=en'
      + '&location=India'
      + '&api_key=' + SERP_API_KEY;

    const r = await fetch(serpUrl);
    if (!r.ok) throw new Error('SerpAPI error: ' + r.status);
    const data = await r.json();

    // Extract shopping results
    const results = data.shopping_results || [];
    console.log('SerpAPI returned', results.length, 'shopping results');

    if (results.length === 0) {
      return res.json({ stores: [], productName: searchQuery, query: searchQuery });
    }

    // Find the best matching product (first result)
    const topProduct = results[0];

    // Group results by store — find lowest price per store
    const storeMap = {};
    results.slice(0, 20).forEach(item => {
      const storeName = normalizeStoreName(item.source || '');
      if (!storeName) return;
      const price = parseFloat((item.price || '0').replace(/[₹,\s]/g, '')) || 0;
      if (!storeMap[storeName] || price < storeMap[storeName].price) {
        storeMap[storeName] = {
          name: storeName,
          price,
          url: item.link || item.product_link || '',
          image: item.thumbnail || '',
          productName: item.title || topProduct.title || searchQuery,
        };
      }
    });

    const stores = Object.values(storeMap)
      .filter(s => s.price > 0)
      .sort((a, b) => a.price - b.price);

    return res.json({
      stores,
      productName: topProduct.title || searchQuery,
      productImage: topProduct.thumbnail || '',
      totalStores: stores.length,
      query: searchQuery,
    });

  } catch(e) {
    console.error('Compare search error:', e.message);
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
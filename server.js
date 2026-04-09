const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());
app.use(cors());

// ── Environment ──
const EXTRAPE_ACCESS_TOKEN   = process.env.EXTRAPE_ACCESS_TOKEN   || '';
const EXTRAPE_REMEMBER_TOKEN = process.env.EXTRAPE_REMEMBER_TOKEN || '';
const FRONTEND_URL            = process.env.FRONTEND_URL           || 'https://smartpickdeals.live';
const BACKEND_URL             = process.env.BACKEND_URL            || 'https://extrape-affiliate.onrender.com';
const SERP_API_KEY            = process.env.SERP_API_KEY           || '';

// ── Supported stores ──
const SUPPORTED_DOMAINS = [
  'amazon.in','amazon.com','amzn.in','amzn.to',
  'flipkart.com','dl.flipkart.com',
  'myntra.com','ajio.com','nykaa.com','nykaafashion.com',
  'tatacliq.com','croma.com','snapdeal.com',
  'netmeds.com','lenskart.com','mamaearth.in',
  'boat-lifestyle.com','pepperfry.com','jiomart.com',
  'bigbasket.com','firstcry.com','meesho.com',
  'makemytrip.com','cleartrip.com','hotstar.com',
];

function isSupported(url) {
  try {
    const h = new URL(url).hostname.replace('www.','');
    return SUPPORTED_DOMAINS.some(d => h.includes(d));
  } catch { return false; }
}

// ── Short link store ──
const shortLinks = {};

function makeCode(len = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return shortLinks[s] ? makeCode(len) : s;
}

function storeShortLink(fullUrl) {
  const code = makeCode();
  shortLinks[code] = fullUrl;
  return FRONTEND_URL + '/go/' + code;
}

// ── Clean affiliate URL ──
function cleanAffiliateUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname;

    // Amazon native short links — pass through unchanged
    if (host === 'amzn.in' || host === 'amzn.to') return rawUrl;

    // Flipkart native short links — pass through
    if (host === 'fkrt.co') return rawUrl;

    // Any short URL (< 55 chars) — pass through
    if (rawUrl.length < 55) return rawUrl;

    // Long Amazon URL with tag — hide tag behind /go/ short link
    if (host.includes('amazon')) {
      const dpMatch = parsed.pathname.match(/\/dp\/([A-Z0-9]{10})/i);
      if (dpMatch) {
        const tag = parsed.searchParams.get('tag');
        const fullAffiliateUrl = 'https://www.amazon.in/dp/' + dpMatch[1] + (tag ? '?tag=' + tag : '');
        return {
          displayUrl: FRONTEND_URL + '/go/' + (() => { const c = makeCode(); shortLinks[c] = fullAffiliateUrl; return c; })(),
          clickUrl:   FRONTEND_URL + '/go/' + (() => { const c = makeCode(); shortLinks[c] = fullAffiliateUrl; return c; })(),
        };
      }
    }

    // Other long URLs — wrap in /go/ short link
    return storeShortLink(rawUrl);

  } catch(e) { return rawUrl; }
}

// ── Queue system ──
const queue = [];
const requests = {};
let isProcessing = false;

function enqueue(url, store) {
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
  return {
    id: r.id, state: r.state, position: r.state === 'pending' ? r.position : 0,
    queueLength: queue.length, estimatedSeconds: r.position * 2,
    affiliateLink: r.affiliateLink, displayLink: r.displayLink || r.affiliateLink, error: r.error
  };
}

// Clean up old requests every 10 min
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  Object.keys(requests).forEach(id => { if (requests[id].createdAt < cutoff) delete requests[id]; });
}, 60000);

// ── ExtraPe API call ──
async function convertViaExtraPe(productUrl) {
  const encoded = encodeURIComponent(productUrl);
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
    body: JSON.stringify({ inputText: encoded, bitlyConvert: false, advanceMode: false })
  });
  if (!r.ok) throw new Error('ExtraPe error: ' + r.status);
  const data = await r.json();
  const raw = data.convertedText || data.outputText || data.result || data.link || data.url ||
    (typeof data === 'string' ? data : null);
  if (!raw) throw new Error('No link in ExtraPe response: ' + JSON.stringify(data).substring(0, 100));
  const decoded = decodeURIComponent(raw.trim());
  console.log('ExtraPe raw:', decoded);
  const result = cleanAffiliateUrl(decoded);
  if (result && typeof result === 'object') {
    console.log('Display:', result.displayUrl, '| Click:', result.clickUrl);
    return result;
  }
  console.log('Final link:', result);
  return result;
}

// ── Queue processor ──
async function processQueue() {
  if (isProcessing || queue.length === 0) return;
  isProcessing = true;
  const id = queue.shift();
  updatePositions();
  const req = requests[id];
  if (!req) { isProcessing = false; processQueue(); return; }
  req.state = 'processing';
  try {
    const result = await convertViaExtraPe(req.url);
    if (result && typeof result === 'object') {
      req.affiliateLink = result.clickUrl;
      req.displayLink   = result.displayUrl;
    } else {
      req.affiliateLink = result;
      req.displayLink   = result;
    }
    req.state = 'done';
  } catch(err) {
    req.state = 'error';
    req.error = err.message;
    console.error('Queue error:', err.message);
  } finally {
    isProcessing = false;
    processQueue();
  }
}

// ── Compare: fetch product title ──
async function fetchProductTitle(productUrl) {
  try {
    const r = await fetch(productUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'en-IN,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    const html = await r.text();
    let m = html.match(/<meta[^>]+property=.og:title.[^>]+content=.([^"'<]+)/i);
    if (m && m[1].trim().length > 5) return m[1].trim();
    m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (m) return m[1].trim()
      .replace(/\s*[|\-–]\s*(Amazon|Flipkart|Myntra|Ajio|Nykaa|Croma|TataCliq|Snapdeal|Online Shopping|India|Buy).*/i, '')
      .trim();
    return null;
  } catch(e) {
    console.log('[Title] Failed:', e.message);
    return null;
  }
}

// ── Compare: normalize store names ──
function normalizeStore(source) {
  const s = (source || '').toLowerCase();
  if (s.includes('amazon'))               return 'Amazon';
  if (s.includes('flipkart'))             return 'Flipkart';
  if (s.includes('myntra'))               return 'Myntra';
  if (s.includes('ajio'))                 return 'Ajio';
  if (s.includes('nykaa'))               return 'Nykaa';
  if (s.includes('tatacliq') || s.includes('tata cliq')) return 'TataCliq';
  if (s.includes('croma'))                return 'Croma';
  if (s.includes('snapdeal'))             return 'Snapdeal';
  if (s.includes('reliance'))             return 'Reliance Digital';
  if (s.includes('vijay'))                return 'Vijay Sales';
  if (s.includes('netmeds'))              return 'Netmeds';
  if (s.includes('lenskart'))             return 'Lenskart';
  if (s.includes('jiomart'))              return 'JioMart';
  if (s.includes('meesho'))               return 'Meesho';
  if (s.includes('boat'))                 return 'Boat';
  return '';
}

// ── Compare: build store search URL (fallback) ──
function storeSearchUrl(storeName, query) {
  const q = encodeURIComponent(query);
  const s = storeName.toLowerCase();
  if (s.includes('amazon'))    return 'https://www.amazon.in/s?k=' + q;
  if (s.includes('flipkart'))  return 'https://www.flipkart.com/search?q=' + q;
  if (s.includes('myntra'))    return 'https://www.myntra.com/' + q;
  if (s.includes('ajio'))      return 'https://www.ajio.com/search/?text=' + q;
  if (s.includes('nykaa'))     return 'https://www.nykaa.com/search/result/?q=' + q;
  if (s.includes('tatacliq'))  return 'https://www.tatacliq.com/search/?text=' + q;
  if (s.includes('croma'))     return 'https://www.croma.com/searchB?q=' + q;
  if (s.includes('snapdeal'))  return 'https://www.snapdeal.com/search?keyword=' + q;
  return 'https://www.google.com/search?q=' + q + '+' + encodeURIComponent(storeName);
}

// ── Routes ──

app.get('/', (req, res) => res.send('Smart Pick Deals backend ✅'));

// Keep-alive ping — cron-job.org or UptimeRobot hits this every 5-14 min
app.get('/ping', (req, res) => res.json({ status: 'awake', time: new Date().toISOString() }));

// Generate affiliate link
app.post('/generate', (req, res) => {
  const { url, store } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided.' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL.' }); }
  if (!isSupported(url)) return res.status(400).json({ error: 'Store not supported by ExtraPe.' });
  if (!EXTRAPE_ACCESS_TOKEN) return res.status(500).json({ error: 'EXTRAPE_ACCESS_TOKEN not configured.' });
  const id = enqueue(url, store || 'Unknown');
  processQueue();
  return res.json({ requestId: id, ...getStatus(id) });
});

// Poll queue status
app.get('/status/:id', (req, res) => {
  const s = getStatus(req.params.id);
  if (!s) return res.status(404).json({ error: 'Request not found.' });
  return res.json(s);
});

// Short link redirect — /go/:code → affiliate URL
app.get('/go/:code', (req, res) => {
  const url = shortLinks[req.params.code];
  if (url) return res.redirect(301, url);
  return res.status(404).send('Link expired or not found.');
});

// Resolve short link (used by Cloudflare function)
app.get('/resolve/:code', (req, res) => {
  const url = shortLinks[req.params.code];
  if (url) return res.json({ url });
  return res.status(404).json({ error: 'Not found' });
});

// Debug: test ExtraPe conversion
app.get('/test-link', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.json({ error: 'Pass ?url=...' });
  try {
    const result = await convertViaExtraPe(url);
    res.json({ input: url, result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Price comparison ──
app.get('/compare/search', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Pass ?url=' });
  if (!SERP_API_KEY) return res.status(503).json({ error: 'SERP_API_KEY not configured', needsKey: true });

  try {
    console.log('[Compare] URL:', url);

    // Step 1: Get product title
    const title = await fetchProductTitle(url);
    let shortQuery = '';
    if (title && title.length > 5) {
      const core = title
        .replace(/\|.*/g, '').replace(/[\(\[].*?[\)\]]/g, '')
        .replace(/\b(with|for|up to|upto|comes|get|buy|online|india|featuring)\b.*/i, '')
        .replace(/,.*/, '').replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      shortQuery = core.split(' ').filter(w => w.length > 0).slice(0, 5).join(' ');
    }

    // Fallback: extract from URL slug
    if (!shortQuery || shortQuery.length < 3) {
      try {
        const segs = new URL(url).pathname.split('/')
          .filter(s => s.length > 3 && !/^[A-Z0-9]{6,}$/.test(s) && !/^(dp|p|product|item|buy|s|ip|d)$/i.test(s));
        shortQuery = (segs[0]||'').replace(/-/g,' ').trim().split(' ').slice(0,5).join(' ');
      } catch(e) {}
    }
    if (!shortQuery || shortQuery.length < 3) return res.status(400).json({ error: 'Could not identify product' });

    const fullTitle = title || shortQuery;

    // Extract ASIN for Amazon (most precise identifier across stores)
    let asin = null;
    try {
      const parsed = new URL(url);
      const m = parsed.pathname.match(/\/dp\/([A-Z0-9]{10})/i) ||
                parsed.pathname.match(/\/([A-Z0-9]{10})(?:\/|$)/i);
      if (m) asin = m[1];
    } catch(e) {}

    // Source store detection
    const srcHost = (() => { try { return new URL(url).hostname.replace('www.',''); } catch(e) { return ''; } })();
    const srcStore = (() => {
      if (srcHost.includes('amazon') || srcHost.includes('amzn')) return 'Amazon';
      if (srcHost.includes('flipkart')) return 'Flipkart';
      return normalizeStore(srcHost.split('.')[0]);
    })();

    // Build queries — ASIN query is very precise, title query is broad
    const asinQuery  = asin ? (asin + ' ' + shortQuery.split(' ').slice(0,3).join(' ')) : shortQuery;
    const titleQuery = shortQuery;

    console.log('[Compare] ASIN:', asin || 'none', '| Query:', asinQuery);

    // Run both Google Shopping searches in parallel
    const [r1, r2] = await Promise.all([
      fetch('https://serpapi.com/search.json?engine=google_shopping'
        + '&q=' + encodeURIComponent(asinQuery)
        + '&gl=in&hl=en&currency=INR&num=40&api_key=' + SERP_API_KEY,
        { signal: AbortSignal.timeout(15000) }).then(r => r.json()).catch(() => null),
      fetch('https://serpapi.com/search.json?engine=google_shopping'
        + '&q=' + encodeURIComponent(titleQuery)
        + '&gl=in&hl=en&currency=INR&num=40&api_key=' + SERP_API_KEY,
        { signal: AbortSignal.timeout(15000) }).then(r => r.json()).catch(() => null),
    ]);

    const allResults = [...(r1?.shopping_results||[]), ...(r2?.shopping_results||[])];
    const productImage = r1?.shopping_results?.[0]?.thumbnail || r2?.shopping_results?.[0]?.thumbnail || '';
    console.log('[Compare] Total results:', allResults.length);

    // Title similarity filter — reject knockoffs and similar products
    const queryWords = shortQuery.toLowerCase().split(' ').filter(w => w.length > 2);
    function titleSim(t) {
      if (!t) return 0;
      const tl = t.toLowerCase();
      if (asin && tl.includes(asin.toLowerCase())) return 1.0;
      return queryWords.filter(w => tl.includes(w)).length / queryWords.length;
    }

    const TARGET_STORES = ['Amazon','Flipkart','Myntra','Ajio','Nykaa','TataCliq','Croma','Snapdeal'];
    const storeMap = {};

    allResults.forEach(item => {
      const store = normalizeStore(item.source || '');
      if (!TARGET_STORES.includes(store)) return;
      const price = item.extracted_price || 0;
      if (price === 0) return;

      const sim = titleSim(item.title);
      console.log('[Compare]', store, '₹'+price, 'sim:'+Math.round(sim*100)+'%', (item.title||'').substring(0,45));
      if (sim < 0.5) { console.log('  → SKIPPED'); return; }

      const link = (item.product_link && !item.product_link.includes('google.com'))
        ? item.product_link : storeSearchUrl(store, fullTitle);

      if (!storeMap[store] || price < storeMap[store].price) {
        storeMap[store] = { name: store, normalizedName: store, price, url: link, sim };
      }
    });

    let stores = Object.values(storeMap)
      .sort((a, b) => a.price - b.price)
      .map((s, i) => ({ ...s, isBest: i === 0, isSource: s.name === srcStore }));

    const src = stores.find(s => s.isSource);
    const savings = src && !src.isBest ? src.price - stores[0].price : 0;

    console.log('[Compare] Final:', stores.map(s => s.name+':₹'+s.price+(s.isSource?'[src]':'')+(s.isBest?'[best]':'')).join(' | '));

    return res.json({
      stores, productName: fullTitle, productImage,
      totalStores: stores.length, savings: savings > 0 ? savings : 0,
      searchQuery: shortQuery,
    });

  } catch(e) {
    console.error('[Compare] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Debug SerpAPI
app.get('/serp/debug', async (req, res) => {
  const { url, q } = req.query;
  if (!SERP_API_KEY) return res.json({ error: 'No SERP_API_KEY' });
  let query = q || '';
  if (url && !q) {
    const t = await fetchProductTitle(url).catch(() => null);
    if (t) {
      const core = t.replace(/\|.*/g,'').replace(/[\(\[].*?[\)\]]/g,'').replace(/,.*$/,'').replace(/[^a-zA-Z0-9 ]/g,' ').trim();
      query = core.split(' ').slice(0,5).join(' ');
    }
  }
  const r = await fetch('https://serpapi.com/search.json?engine=google_shopping&q='+encodeURIComponent(query)+'&gl=in&hl=en&currency=INR&num=20&api_key='+SERP_API_KEY);
  const d = await r.json();
  res.json({ query, count: (d.shopping_results||[]).length, results: (d.shopping_results||[]).slice(0,10).map(x => ({ source: x.source, price: x.price, extracted: x.extracted_price, title: (x.title||'').substring(0,60), link: (x.product_link||'').substring(0,80) })) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Smart Pick Deals backend running on port ' + PORT));
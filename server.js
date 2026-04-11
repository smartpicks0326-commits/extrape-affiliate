const express  = require('express');
const cors     = require('cors');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');

const app = express();
app.use(express.json());
app.use(cors());

// ── Env vars ──
const EXTRAPE_ACCESS_TOKEN   = process.env.EXTRAPE_ACCESS_TOKEN   || '';
const EXTRAPE_REMEMBER_TOKEN = process.env.EXTRAPE_REMEMBER_TOKEN || '';
const FRONTEND_URL            = process.env.FRONTEND_URL           || 'https://smartpickdeals.live';
const SERP_API_KEY            = process.env.SERP_API_KEY           || '';

// ── Encode affiliate URL as base64url (no memory needed for redirect) ──
function makeGoLink(affiliateUrl) {
  // base64url-encode the full affiliate URL
  // Cloudflare Pages function decodes it and redirects directly
  const b64 = Buffer.from(affiliateUrl).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return FRONTEND_URL + '/go/' + b64;
}

// ── Supported stores ──
const SUPPORTED = [
  'amazon.in','amazon.com','amzn.in','amzn.to',
  'flipkart.com','dl.flipkart.com','fkrt.co',
  'myntra.com','ajio.com','nykaa.com','nykaafashion.com',
  'tatacliq.com','croma.com','snapdeal.com',
  'netmeds.com','lenskart.com','mamaearth.in',
  'boat-lifestyle.com','pepperfry.com','jiomart.com',
  'bigbasket.com','firstcry.com','meesho.com',
  'makemytrip.com','cleartrip.com',
];

function isSupported(url) {
  try { const h = new URL(url).hostname.replace('www.',''); return SUPPORTED.some(d => h.includes(d)); }
  catch { return false; }
}

// ── Clean affiliate URL ──
// Returns { displayUrl, clickUrl } or a plain string.
// displayUrl = what user SEES and COPIES — always clean (no tag, no redirect domain)
// clickUrl   = what Visit button uses — contains affiliate tag for commission
function cleanLink(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const host   = parsed.hostname;

    // ── Flipkart native short (fkrt.co/xxxxx) ──
    // Clean already. Display & click are the same.
    if (host === 'fkrt.co') {
      return { displayUrl: rawUrl, clickUrl: rawUrl };
    }

    // ── Amazon native short (amzn.in/d/xxx or amzn.to/xxx) ──
    // ExtraPe already embedded the tag inside these — they're clean-looking.
    if (host === 'amzn.in' || host === 'amzn.to') {
      return { displayUrl: rawUrl, clickUrl: rawUrl };
    }

    // ── Long Amazon URL (amazon.in/dp/ASIN?tag=xxx&...) ──
    if (host.includes('amazon')) {
      const asin = (parsed.pathname.match(/\/dp\/([A-Z0-9]{10})/i) || [])[1];
      const tag  = parsed.searchParams.get('tag');
      if (asin) {
        const cleanDisplay  = 'https://www.amazon.in/dp/' + asin;       // no tag
        const affiliateClick = cleanDisplay + (tag ? '?tag=' + tag : ''); // with tag
        return {
          displayUrl: cleanDisplay,       // user sees/copies this — perfectly clean
          clickUrl:   makeGoLink(affiliateClick), // Visit button — tag hidden in base64
        };
      }
    }

    // ── Flipkart long URL ──
    if (host.includes('flipkart')) {
      // Extract pid for clean product URL
      const pid = parsed.searchParams.get('pid');
      const slug = parsed.pathname.split('/').filter(s => s && s !== 'p')[0] || '';
      if (pid && slug) {
        const cleanDisplay = 'https://www.flipkart.com/' + slug + '/p/' + pid;
        return {
          displayUrl: cleanDisplay,
          clickUrl:   makeGoLink(rawUrl), // full affiliate URL hidden
        };
      }
    }

    // ── Other short URLs (< 55 chars, e.g. other store short links) ──
    if (rawUrl.length < 55) {
      return { displayUrl: rawUrl, clickUrl: rawUrl };
    }

    // ── Everything else ── wrap in go link, display the domain only
    return {
      displayUrl: rawUrl,           // best we can do
      clickUrl:   makeGoLink(rawUrl),
    };

  } catch(e) { return { displayUrl: rawUrl, clickUrl: rawUrl }; }
}

// ── MongoDB Atlas connection ──
const MONGO_URI = process.env.MONGO_URI || '';

// ── Mongoose Schemas ──
const counterSchema = new mongoose.Schema({
  _id:     { type: String },   // 'main'
  pageVisits:  { type: Number, default: 0 },
  conversions: { type: Number, default: 0 },
  clicks:      { type: Number, default: 0 },
  compares:    { type: Number, default: 0 },
  storeBreakdown: { type: Map, of: Number, default: {} },
}, { timestamps: true });

const eventSchema = new mongoose.Schema({
  type:   { type: String, enum: ['conversion', 'click', 'visit', 'compare'] },
  url:    String,
  store:  String,
  state:  String,
  dest:   String,
  ts:     { type: Date, default: Date.now },
});
eventSchema.index({ ts: -1 });        // fast recent queries
eventSchema.index({ type: 1, ts: -1 }); // fast type+date queries

let Counter, Event;
let dbConnected = false;

// In-memory fallback (used if MongoDB not configured or connection fails)
const memAnalytics = {
  pageVisits: 0, conversions: 0, clicks: 0, compares: 0,
  storeBreakdown: {}, recentConversions: [], recentClicks: [],
};

async function connectDB() {
  if (!MONGO_URI) {
    console.log('[DB] MONGO_URI not set — using in-memory analytics');
    return;
  }
  if (MONGO_URI.includes('<password>')) {
    console.error('[DB] MONGO_URI still has placeholder <password> — replace it with real password in Render env vars');
    return;
  }
  // Log URI shape for debugging (hide password)
  const uriSafe = MONGO_URI.replace(/:([^@]+)@/, ':****@');
  console.log('[DB] URI shape:', uriSafe);
  try {
    console.log('[DB] Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 30000,
      connectTimeoutMS: 15000,
    });
    Counter = mongoose.model('Counter', counterSchema);
    Event   = mongoose.model('Event',   eventSchema);
    // Ensure main counter doc exists
    await Counter.findOneAndUpdate(
      { _id: 'main' },
      { $setOnInsert: { _id: 'main', pageVisits: 0, conversions: 0, clicks: 0, compares: 0 } },
      { upsert: true, new: true }
    );
    dbConnected = true;
    console.log('[DB] ✅ MongoDB connected successfully');
    // Log DB name
    console.log('[DB] Database:', mongoose.connection.name);
  } catch(e) {
    console.error('[DB] ❌ MongoDB connection failed:', e.message);
    console.error('[DB] Check: 1) Password replaced in URI  2) IP 0.0.0.0/0 whitelisted in Atlas  3) Cluster is running');
    console.log('[DB] Falling back to in-memory analytics');
    // Retry after 30 seconds
    setTimeout(connectDB, 30000);
  }
}
connectDB();

// ── Track functions ──
async function trackVisit(page) {
  if (dbConnected) {
    await Counter.updateOne({ _id: 'main' }, { $inc: { pageVisits: 1 } })
      .catch(e => console.error('[DB] trackVisit:', e.message));
    await new Event({ type: 'visit', url: page || '/', ts: new Date() }).save()
      .catch(e => console.error('[DB] visit event:', e.message));
  } else {
    memAnalytics.pageVisits++;
    memAnalytics.recentConversions; // keep in sync
  }
}

async function trackConversion(url, store, state) {
  if (dbConnected) {
    const inc = { conversions: 1 };
    if (store && state === 'done') inc['storeBreakdown.' + store] = 1;
    await Counter.updateOne({ _id: 'main' }, { $inc: inc }).catch(e => console.error('[DB] trackConversion:', e.message));
    await new Event({ type: 'conversion', url, store, state, ts: new Date() }).save().catch(() => {});
  } else {
    memAnalytics.conversions++;
    if (store && state === 'done') memAnalytics.storeBreakdown[store] = (memAnalytics.storeBreakdown[store]||0) + 1;
    memAnalytics.recentConversions.unshift({ url, store, state, ts: Date.now() });
    if (memAnalytics.recentConversions.length > 50) memAnalytics.recentConversions.pop();
  }
}

async function trackClick(dest, store) {
  const d = (dest || 'unknown').substring(0, 300);
  const s = store || '';
  if (dbConnected) {
    await Counter.updateOne({ _id: 'main' }, { $inc: { clicks: 1 } })
      .catch(e => console.error('[DB] trackClick:', e.message));
    await new Event({ type: 'click', dest: d, store: s, ts: new Date() }).save()
      .catch(e => console.error('[DB] click event:', e.message));
  } else {
    memAnalytics.clicks++;
    memAnalytics.recentClicks.unshift({ dest: d, store: s, ts: Date.now() });
    if (memAnalytics.recentClicks.length > 50) memAnalytics.recentClicks.pop();
  }
  console.log('[Track] Click:', s || 'unknown', d.substring(0, 60));
}

async function trackCompare() {
  if (dbConnected) {
    await Counter.updateOne({ _id: 'main' }, { $inc: { compares: 1 } }).catch(e => console.error('[DB] trackCompare:', e.message));
  } else {
    memAnalytics.compares++;
  }
}

// ── Request queue ──
const queue    = [];
const requests = {};
let processing = false;

function enqueue(url, store) {
  const id = uuidv4();
  requests[id] = { id, url, store, state:'pending', position:0,
    affiliateLink:null, displayLink:null, error:null, createdAt:Date.now() };
  queue.push(id);
  updatePos();
  return id;
}

function updatePos() {
  queue.forEach((id, i) => { if (requests[id]) requests[id].position = i + 1; });
}

function getStatus(id) {
  const r = requests[id];
  if (!r) return null;
  return { id:r.id, state:r.state, position:r.state==='pending'?r.position:0,
    queueLength:queue.length, estimatedSeconds:r.position*2,
    affiliateLink:r.affiliateLink, displayLink:r.displayLink||r.affiliateLink, error:r.error };
}

setInterval(() => {
  const cut = Date.now() - 10*60*1000;
  Object.keys(requests).forEach(id => { if (requests[id].createdAt < cut) delete requests[id]; });
}, 60000);

// ── ExtraPe API ──
async function convertExtraPe(productUrl) {
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
    body: JSON.stringify({ inputText: encodeURIComponent(productUrl), bitlyConvert:false, advanceMode:false })
  });
  if (!r.ok) throw new Error('ExtraPe ' + r.status);
  const data = await r.json();
  const raw = data.convertedText || data.outputText || data.result || data.link || data.url ||
    (typeof data === 'string' ? data : null);
  if (!raw) throw new Error('No link returned: ' + JSON.stringify(data).substring(0,100));
  const decoded = decodeURIComponent(raw.trim());
  console.log('ExtraPe raw:', decoded);
  return cleanLink(decoded);
}

// ── Queue processor ──
async function processQueue() {
  if (processing || queue.length === 0) return;
  processing = true;
  const id = queue.shift();
  updatePos();
  const req = requests[id];
  if (!req) { processing = false; processQueue(); return; }
  req.state = 'processing';
  try {
    const result = await convertExtraPe(req.url);
    // cleanLink always returns an object now
    if (result && typeof result === 'object') {
      req.affiliateLink = result.clickUrl;   // Visit button — earns commission
      req.displayLink   = result.displayUrl; // shown to user — always clean
    } else {
      req.affiliateLink = req.displayLink = result;
    }
    req.state = 'done';
    trackConversion(req.url, req.store, 'done');
  } catch(e) {
    req.state = 'error'; req.error = e.message;
    trackConversion(req.url, req.store, 'error');
    console.error('Queue error:', e.message);
  } finally {
    processing = false; processQueue();
  }
}

// ── Compare helpers ──
async function fetchTitle(url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html', 'Accept-Language': 'en-IN,en;q=0.9' },
      redirect: 'follow', signal: AbortSignal.timeout(10000)
    });
    const html = await r.text();
    let m = html.match(/<meta[^>]+property=.og:title.[^>]+content=.([^"'<]+)/i);
    if (m && m[1].trim().length > 5) return m[1].trim();
    m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (m) return m[1].trim().replace(/\s*[|\-–]\s*(Amazon|Flipkart|Myntra|Ajio|Nykaa|Croma|TataCliq|Snapdeal|Online Shopping|India|Buy).*/i,'').trim();
    return null;
  } catch(e) { return null; }
}

function normalizeStore(s) {
  s = (s||'').toLowerCase();
  if (s.includes('amazon'))   return 'Amazon';
  if (s.includes('flipkart')) return 'Flipkart';
  if (s.includes('myntra'))   return 'Myntra';
  if (s.includes('ajio'))     return 'Ajio';
  if (s.includes('nykaa'))    return 'Nykaa';
  if (s.includes('tatacliq') || s.includes('tata cliq')) return 'TataCliq';
  if (s.includes('croma'))    return 'Croma';
  if (s.includes('snapdeal')) return 'Snapdeal';
  return '';
}

function storeSearchUrl(store, q) {
  const eq = encodeURIComponent(q);
  if (store==='Amazon')   return 'https://www.amazon.in/s?k='+eq;
  if (store==='Flipkart') return 'https://www.flipkart.com/search?q='+eq;
  if (store==='Myntra')   return 'https://www.myntra.com/'+eq;
  if (store==='Ajio')     return 'https://www.ajio.com/search/?text='+eq;
  if (store==='Nykaa')    return 'https://www.nykaa.com/search/result/?q='+eq;
  if (store==='TataCliq') return 'https://www.tatacliq.com/search/?text='+eq;
  if (store==='Croma')    return 'https://www.croma.com/searchB?q='+eq;
  if (store==='Snapdeal') return 'https://www.snapdeal.com/search?keyword='+eq;
  return 'https://www.google.com/search?q='+eq;
}

// ── Routes ──
app.get('/', (req, res) => res.send('Smart Pick Deals ✅'));
app.get('/ping', (req, res) => res.json({ status:'ok', time:new Date().toISOString() }));

// ── Flash.co Backend Proxy ──
// Routes flash.co API calls through Render using the user's session token
// Requires FLASH_AUTH_TOKEN and FLASH_DEVICE_ID env vars on Render
// Note: Only works if Render's IP is not blocked by flash.co
// For better success rate, optionally configure PROXY_URL (residential proxy)

const FLASH_AUTH_TOKEN = process.env.FLASH_AUTH_TOKEN || '';
const FLASH_DEVICE_ID  = process.env.FLASH_DEVICE_ID  || 'web-spd-backend';
const PROXY_URL        = process.env.PROXY_URL         || ''; // optional: residential proxy

// Proxy: POST stream to flash.co to get pageHash
// GET test endpoint — open in browser to test flash.co proxy
// Usage: https://extrape-affiliate.onrender.com/flash/test?url=https://amzn.in/d/01zArQtK
app.get('/flash/test', async (req, res) => {
  const productUrl = req.query.url;
  if (!productUrl) {
    return res.json({
      usage: 'Add ?url=YOUR_PRODUCT_URL to test',
      example: '/flash/test?url=https://amzn.in/d/01zArQtK',
      token_set: !!FLASH_AUTH_TOKEN,
      device_set: !!FLASH_DEVICE_ID,
      token_preview: FLASH_AUTH_TOKEN ? FLASH_AUTH_TOKEN.substring(0,20)+'...' : 'NOT SET — add FLASH_AUTH_TOKEN to Render env',
      device_id: FLASH_DEVICE_ID || 'NOT SET — add FLASH_DEVICE_ID to Render env',
    });
  }
  if (!FLASH_AUTH_TOKEN) {
    return res.json({ error: 'FLASH_AUTH_TOKEN not set in Render environment variables' });
  }

  try {
    // Step 1: Get pageHash via stream
    const params = new URLSearchParams({
      source: 'APPEND', context: 'HOME_URL_PASTE',
      user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36',
      device_type: 'DESKTOP', country_code: 'IN',
    });
    const headers = {
      'Authorization': 'Bearer ' + FLASH_AUTH_TOKEN,
      'Channel-Type': 'web',
      'Content-Type': 'application/json',
      'Origin': 'https://flash.co',
      'Referer': 'https://flash.co/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36',
      'X-Country-Code': 'IN',
      'X-Device-Id': FLASH_DEVICE_ID || 'web-spd',
      'X-Timezone': 'Asia/Calcutta',
      'Accept': 'application/json, text/event-stream, */*',
    };

    console.log('[Flash Test] Searching:', productUrl);
    const sr = await fetch('https://apiv3.flash.tech/agents/chat/stream?' + params, {
      method: 'POST', headers,
      body: JSON.stringify({ query: productUrl, context: 'HOME_URL_PASTE' }),
      signal: AbortSignal.timeout(35000),
    });

    const streamStatus = sr.status;
    const streamText = sr.ok ? await sr.text() : await sr.text();
    console.log('[Flash Test] Stream status:', streamStatus, 'length:', streamText.length);

    if (!sr.ok) {
      return res.json({
        step: 'stream',
        status: streamStatus,
        error: streamText.substring(0, 200),
        diagnosis: streamStatus === 401 ? 'Token is invalid or IP-bound. Try refreshing FLASH_AUTH_TOKEN in Render.' : 'Unexpected error',
      });
    }

    // Extract pageHash — flash uses /product-search/:hash in INT_NAVIGATION event
    let pageHash = null;
    const navPatterns = [
      /product-search\/([A-Za-z0-9_-]{4,})/,
      /price-compare\/([A-Za-z0-9_-]{4,})/,
      /\/h\/([A-Za-z0-9_-]{4,})/,
    ];
    for (const pat of navPatterns) {
      const m = streamText.match(pat);
      if (m) { pageHash = m[1]; console.log('[Flash Test] pageHash:', pageHash, 'via', pat); break; }
    }
    if (!pageHash) {
      for (const line of streamText.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const d = JSON.parse(line.slice(5).trim());
          pageHash = d.pageHash || d.referenceId || d.hash ||
            (d.data && (d.data.pageHash || d.data.referenceId)) || null;
          if (pageHash) break;
        } catch(e) {}
      }
    }

    if (!pageHash) {
      return res.json({
        step: 'stream_parse',
        status: streamStatus,
        pageHash: null,
        streamSample: streamText.substring(0, 600),
        error: 'Could not extract pageHash from flash stream response',
      });
    }

    // Step 2: Get prices
    const priceHeaders = { ...headers };
    delete priceHeaders['Content-Type'];

    // Step 2a: The product-search hash is a SEARCH RESULTS page.
    // We need to poll it to get the actual product pageHash, then fetch prices.
    // Flash.co polls this endpoint until results appear.
    let productPageHash = null;
    let productName = null;
    let productImage = null;

    const searchResultEndpoints = [
      'https://apiv3.flash.tech/api/v1/pages/' + pageHash + '/product-search',
      'https://apiv3.flash.tech/api/v1/search-results?referenceId=' + pageHash,
      'https://apiv3.flash.tech/api/v1/customer/feedback/fetch?scope=PRODUCT_SEARCH&referenceId=' + pageHash,
      'https://apiv3.flash.tech/api/v1/customer/feedback/fetch?scope=SEARCH_RESULTS&referenceId=' + pageHash,
      'https://apiv3.flash.tech/api/v2/pages/' + pageHash + '/details',
      'https://apiv3.flash.tech/api/v1/customer/feedback/fetch?referenceId=' + pageHash,
    ];

    let searchResultData = null;
    for (const ep of searchResultEndpoints) {
      try {
        console.log('[Flash Test] Trying search result endpoint:', ep);
        const sr2 = await fetch(ep, { headers: priceHeaders, signal: AbortSignal.timeout(8000) });
        const sr2Text = await sr2.text();
        console.log('[Flash Test] Endpoint', ep.substring(50), '→ status:', sr2.status, 'body:', sr2Text.substring(0, 200));
        if (sr2.ok) {
          try {
            const d = JSON.parse(sr2Text);
            // Look for a product hash in the response
            const str = JSON.stringify(d);
            const productHash = str.match(/product-details[^"]*\/h\/([A-Za-z0-9_-]{4,})/)?.[1] ||
                                str.match(/price-compare\/([A-Za-z0-9_-]{4,})/)?.[1];
            if (productHash) {
              productPageHash = productHash;
              console.log('[Flash Test] Found product pageHash:', productPageHash);
            }
            searchResultData = { endpoint: ep, status: sr2.status, data: d };
            break;
          } catch(e) {
            searchResultData = { endpoint: ep, status: sr2.status, raw: sr2Text.substring(0, 300) };
            break;
          }
        }
      } catch(e) { console.log('[Flash Test] Endpoint error:', e.message); }
    }

    // Step 2b: If we found a product pageHash, fetch its prices
    // Otherwise try price endpoints on the original search hash
    const hashToUse = productPageHash || pageHash;
    let pr = null;
    const priceEndpoints = [
      'https://apiv3.flash.tech/api/v1/customer/feedback/fetch?scope=PRICE_COMPARE&referenceId=' + hashToUse,
      'https://apiv3.flash.tech/api/v1/customer/feedback/fetch?scope=PRODUCT_DETAILS&referenceId=' + hashToUse,
      'https://apiv3.flash.tech/api/v1/customer/feedback/fetch?scope=PRICE_COMPARE&referenceId=' + pageHash,
    ];
    for (const ep of priceEndpoints) {
      try {
        pr = await fetch(ep, { headers: priceHeaders, signal: AbortSignal.timeout(12000) });
        if (pr.ok) { console.log('[Flash Test] Price endpoint worked:', ep); break; }
      } catch(e) {}
    }
    if (!pr) pr = { ok: false, status: 0 };
    const priceStatus = pr.status;
    const priceData = pr.ok ? await pr.json() : await pr.text();

    return res.json({
      success: pr.ok,
      searchHash: pageHash,
      productHash: productPageHash || null,
      hashUsed: hashToUse,
      streamStatus,
      priceStatus,
      searchResultData: searchResultData || null,
      priceKeys: pr.ok ? Object.keys(priceData || {}) : undefined,
      priceSample: pr.ok ? JSON.stringify(priceData).substring(0, 1000) : String(priceData || '').substring(0, 200),
      streamSample: streamText.substring(0, 400),
    });

  } catch(e) {
    return res.json({ error: e.message, step: 'exception' });
  }
});

app.post('/flash/search', async (req, res) => {
  const { url: productUrl } = req.body;
  if (!productUrl) return res.status(400).json({ error: 'Pass url in body' });
  if (!FLASH_AUTH_TOKEN) return res.status(503).json({ error: 'FLASH_AUTH_TOKEN not set in Render env' });

  try {
    const params = new URLSearchParams({
      source: 'APPEND', context: 'HOME_URL_PASTE',
      user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      device_type: 'DESKTOP', country_code: 'IN',
    });

    const headers = {
      'Authorization': 'Bearer ' + FLASH_AUTH_TOKEN,
      'Channel-Type': 'web',
      'Content-Type': 'application/json',
      'Origin': 'https://flash.co',
      'Referer': 'https://flash.co/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      'X-Country-Code': 'IN',
      'X-Device-Id': FLASH_DEVICE_ID,
      'X-Timezone': 'Asia/Calcutta',
      'Accept': 'application/json, text/event-stream, */*',
      'Accept-Language': 'en-GB,en;q=0.9',
    };

    console.log('[Flash Proxy] Searching:', productUrl);
    const sr = await fetch(
      'https://apiv3.flash.tech/agents/chat/stream?' + params.toString(),
      { method: 'POST', headers, body: JSON.stringify({ query: productUrl, context: 'HOME_URL_PASTE' }), signal: AbortSignal.timeout(35000) }
    );

    console.log('[Flash Proxy] Stream status:', sr.status);
    if (!sr.ok) {
      const errText = await sr.text().catch(() => '');
      console.log('[Flash Proxy] Stream error body:', errText.substring(0, 200));
      return res.status(sr.status).json({ error: 'Flash stream ' + sr.status, detail: errText.substring(0, 100) });
    }

    const text = await sr.text();
    console.log('[Flash Proxy] Stream length:', text.length, 'sample:', text.substring(0, 300));

    // Extract pageHash from flash SSE stream
    let pageHash = null;
    const navPats = [
      /product-search\/([A-Za-z0-9_-]{4,})/,
      /price-compare\/([A-Za-z0-9_-]{4,})/,
      /\/h\/([A-Za-z0-9_-]{4,})/,
    ];
    for (const pat of navPats) {
      const m = text.match(pat);
      if (m) { pageHash = m[1]; break; }
    }
    if (!pageHash) {
      for (const line of text.split("\n")) {
        if (!line.startsWith('data:')) continue;
        try {
          const d = JSON.parse(line.slice(5).trim());
          pageHash = d.pageHash || d.referenceId || (d.data && (d.data.pageHash || d.data.referenceId)) || null;
          if (pageHash) break;
        } catch(e) {}
      }
    }

    console.log('[Flash Proxy] pageHash:', pageHash);
    if (!pageHash) return res.status(422).json({ error: 'No pageHash found in flash response', streamSample: text.substring(0, 500) });

    return res.json({ ok: true, pageHash });
  } catch(e) {
    console.error('[Flash Proxy] search error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// Proxy: GET prices from flash.co for a given pageHash
app.get('/flash/prices/:pageHash', async (req, res) => {
  const { pageHash } = req.params;
  if (!FLASH_AUTH_TOKEN) return res.status(503).json({ error: 'FLASH_AUTH_TOKEN not set' });

  const headers = {
    'Authorization': 'Bearer ' + FLASH_AUTH_TOKEN,
    'Channel-Type': 'web',
    'Origin': 'https://flash.co',
    'Referer': 'https://flash.co/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'X-Country-Code': 'IN',
    'X-Device-Id': FLASH_DEVICE_ID,
    'X-Timezone': 'Asia/Calcutta',
    'Accept': 'application/json',
  };

  const endpoints = [
    'https://apiv3.flash.tech/api/v1/customer/feedback/fetch?scope=PRICE_COMPARE&referenceId=' + pageHash,
    'https://apiv3.flash.tech/api/v1/customer/feedback/fetch?scope=PRODUCT_DETAILS&referenceId=' + pageHash,
  ];

  for (const ep of endpoints) {
    try {
      console.log('[Flash Proxy] Fetching prices from:', ep);
      const r = await fetch(ep, { headers, signal: AbortSignal.timeout(15000) });
      console.log('[Flash Proxy] Prices status:', r.status);
      if (r.ok) {
        const data = await r.json();
        console.log('[Flash Proxy] Price data keys:', Object.keys(data || {}));
        console.log('[Flash Proxy] Price sample:', JSON.stringify(data).substring(0, 500));
        return res.json({ ok: true, data });
      }
    } catch(e) {
      console.log('[Flash Proxy] endpoint failed:', e.message);
    }
  }
  return res.status(502).json({ error: 'Could not fetch prices from flash.co' });
});

// Proxy: One-shot — search + get prices in one call
app.post('/flash/compare', async (req, res) => {
  const { url: productUrl } = req.body;
  if (!productUrl) return res.status(400).json({ error: 'Pass url in body' });
  if (!FLASH_AUTH_TOKEN) return res.status(503).json({ error: 'FLASH_AUTH_TOKEN not set in Render env', setup: 'Add FLASH_AUTH_TOKEN and FLASH_DEVICE_ID to Render environment variables' });

  try {
    // Step 1: Get pageHash
    const searchResp = await fetch('http://localhost:' + (process.env.PORT || 3000) + '/flash/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: productUrl }),
      signal: AbortSignal.timeout(40000),
    });
    const searchData = await searchResp.json();
    if (!searchResp.ok || !searchData.pageHash) {
      return res.status(searchResp.status).json({ error: searchData.error || 'Flash search failed', detail: searchData });
    }

    // Step 2: Get prices
    const pricesResp = await fetch('http://localhost:' + (process.env.PORT || 3000) + '/flash/prices/' + searchData.pageHash, {
      signal: AbortSignal.timeout(20000),
    });
    const pricesData = await pricesResp.json();
    if (!pricesResp.ok) return res.status(pricesResp.status).json({ error: pricesData.error });

    return res.json({ ok: true, pageHash: searchData.pageHash, priceData: pricesData.data });
  } catch(e) {
    console.error('[Flash Proxy] compare error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// Track page visits
app.post('/track/visit', async (req, res) => {
  const page = req.body?.page || req.headers?.referer || '/';
  await trackVisit(page).catch(() => {});
  res.json({ ok: true });
});

// Track link clicks — called from frontend before opening affiliate link
// Accepts POST (from Cloudflare function) and GET (from index.html img-beacon)
const clickCors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

app.options('/track/click', (req, res) => res.set(clickCors).sendStatus(204));

app.post('/track/click', async (req, res) => {
  res.set(clickCors);
  const dest = (req.body?.dest || req.body?.url || req.query?.dest || 'unknown').substring(0, 300);
  const store = req.body?.store || req.query?.store || '';
  await trackClick(dest, store).catch(e => console.error('[DB] /track/click POST:', e.message));
  res.json({ ok: true });
});

// GET version — called as a fire-and-forget beacon from frontend
app.get('/track/click', async (req, res) => {
  res.set(clickCors);
  const dest = (req.query?.dest || req.query?.url || 'unknown').substring(0, 300);
  const store = req.query?.store || '';
  await trackClick(dest, store).catch(e => console.error('[DB] /track/click GET:', e.message));
  res.json({ ok: true });
});

// Dashboard stats — supports ?from=ISO&to=ISO date range
app.get('/dashboard/stats', async (req, res) => {
  // Default: today from midnight to now (IST = UTC+5:30)
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const nowUTC = Date.now();
  const nowIST = nowUTC + IST_OFFSET;
  const midnightIST = nowIST - (nowIST % (24*60*60*1000));
  const defaultFrom = new Date(midnightIST - IST_OFFSET); // back to UTC
  const defaultTo   = new Date(nowUTC);

  const from = req.query.from ? new Date(req.query.from) : defaultFrom;
  const to   = req.query.to   ? new Date(req.query.to)   : defaultTo;
  const dateFilter = { ts: { $gte: from, $lte: to } };

  try {
    if (dbConnected) {
      // Count events in date range
      const [visitsCount, conversionsCount, clicksCount, comparesCount] = await Promise.all([
        Event.countDocuments({ type: 'visit',      ...dateFilter }),
        Event.countDocuments({ type: 'conversion', state: 'done', ...dateFilter }),
        Event.countDocuments({ type: 'click',      ...dateFilter }),
        Event.countDocuments({ type: 'compare',    ...dateFilter }),
      ]);

      // Store breakdown in date range
      const storeAgg = await Event.aggregate([
        { $match: { type: 'conversion', state: 'done', ...dateFilter } },
        { $group: { _id: '$store', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]);
      const storeBreakdown = {};
      storeAgg.forEach(s => { if (s._id) storeBreakdown[s._id] = s.count; });

      // Recent events in date range
      const [recentConversions, recentClicks, recentVisits] = await Promise.all([
        Event.find({ type: 'conversion', ...dateFilter }).sort({ ts: -1 }).limit(50).lean(),
        Event.find({ type: 'click',      ...dateFilter }).sort({ ts: -1 }).limit(50).lean(),
        Event.find({ type: 'visit',      ...dateFilter }).sort({ ts: -1 }).limit(50).lean(),
      ]);

      return res.json({
        pageVisits:   visitsCount,
        conversions:  conversionsCount,
        clicks:       clicksCount,
        compares:     comparesCount,
        storeBreakdown,
        recentConversions: recentConversions.map(e => ({ url: e.url, store: e.store, state: e.state, ts: e.ts?.getTime() })),
        recentClicks:      recentClicks.map(e => ({ dest: e.dest, ts: e.ts?.getTime() })),
        recentVisits:      recentVisits.map(e => ({ url: e.url, ts: e.ts?.getTime() })),
        dbConnected:  true,
        dateRange:    { from: from.toISOString(), to: to.toISOString() },
        serverUptime: Math.round(process.uptime() / 60) + ' min',
        generatedAt:  new Date().toISOString(),
      });
    }
  } catch(e) {
    console.error('[DB] dashboard/stats error:', e.message);
  }

  // Fallback in-memory
  res.json({
    pageVisits:        memAnalytics.pageVisits,
    conversions:       memAnalytics.conversions,
    clicks:            memAnalytics.clicks,
    compares:          memAnalytics.compares,
    storeBreakdown:    memAnalytics.storeBreakdown,
    recentConversions: memAnalytics.recentConversions,
    recentClicks:      memAnalytics.recentClicks,
    recentVisits:      [],
    dbConnected:       false,
    serverUptime:      Math.round(process.uptime() / 60) + ' min',
    generatedAt:       new Date().toISOString(),
  });
});

app.post('/generate', (req, res) => {
  const { url, store } = req.body;
  if (!url) return res.status(400).json({ error:'No URL.' });
  try { new URL(url); } catch { return res.status(400).json({ error:'Invalid URL.' }); }
  if (!isSupported(url)) return res.status(400).json({ error:'Store not supported by ExtraPe.' });
  if (!EXTRAPE_ACCESS_TOKEN) return res.status(500).json({ error:'EXTRAPE_ACCESS_TOKEN not set.' });
  const id = enqueue(url, store||'Unknown');
  processQueue();
  return res.json({ requestId:id, ...getStatus(id) });
});

app.get('/status/:id', (req, res) => {
  const s = getStatus(req.params.id);
  if (!s) return res.status(404).json({ error:'Not found.' });
  return res.json(s);
});

// Legacy in-memory short code redirect (kept for backwards compat)
const shortLinks = {};
app.get('/go/:code', (req, res) => {
  // First try base64 decode (new format)
  try {
    const decoded = Buffer.from(
      req.params.code.replace(/-/g,'+').replace(/_/g,'/'), 'base64'
    ).toString();
    if (decoded.startsWith('http')) {
      trackClick(decoded); // full URL
      return res.redirect(302, decoded);
    }
  } catch(e) {}
  // Fall back to in-memory short code (old format)
  const url = shortLinks[req.params.code];
  if (url) {
    trackClick(url.substring(0, 80));
    return res.redirect(301, url);
  }
  return res.status(404).send('Link not found.');
});

app.get('/resolve/:code', (req, res) => {
  try {
    const decoded = Buffer.from(req.params.code.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString();
    if (decoded.startsWith('http')) return res.json({ url: decoded });
  } catch(e) {}
  const url = shortLinks[req.params.code];
  if (url) return res.json({ url });
  return res.status(404).json({ error:'Not found' });
});

app.get('/test-link', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.json({ error:'Pass ?url=...' });
  try { const r = await convertExtraPe(url); res.json({ input:url, result:r }); }
  catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Price comparison ──
app.get('/compare/search', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error:'Pass ?url=' });
  if (!SERP_API_KEY) return res.status(503).json({ error:'SERP_API_KEY not configured', needsKey:true });

  try {
    console.log('[Compare] URL:', url);
    trackCompare().catch(() => {});

    // Get title
    const title = await fetchTitle(url);
    let shortQ = '';
    if (title && title.length > 5) {
      const core = title
        .replace(/\|.*/g,'').replace(/[\(\[].*?[\)\]]/g,'')
        .replace(/\b(with|for|up to|upto|comes|get|buy|online|india|featuring)\b.*/i,'')
        .replace(/,.*$/,'').replace(/[^a-zA-Z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
      shortQ = core.split(' ').filter(w=>w.length>0).slice(0,5).join(' ');
    }
    if (!shortQ) {
      try {
        const segs = new URL(url).pathname.split('/').filter(s=>s.length>3&&!/^[A-Z0-9]{6,}$/.test(s)&&!/^(dp|p|product|item|buy|s|ip|d)$/i.test(s));
        shortQ = (segs[0]||'').replace(/-/g,' ').trim().split(' ').slice(0,5).join(' ');
      } catch(e) {}
    }
    if (!shortQ||shortQ.length<3) return res.status(400).json({ error:'Could not identify product' });

    const fullTitle = title || shortQ;

    // Extract ASIN (Amazon Standard Identification Number — unique across stores)
    let asin = null;
    try {
      const m = new URL(url).pathname.match(/\/dp\/([A-Z0-9]{10})/i) ||
                new URL(url).pathname.match(/\/([A-Z0-9]{10})(?:\/|$)/i);
      if (m) asin = m[1];
    } catch(e) {}

    // Source store
    const srcHost = (() => { try { return new URL(url).hostname.replace('www.',''); } catch(e) { return ''; } })();
    const srcStore = (() => {
      if (srcHost.includes('amazon')||srcHost.includes('amzn')) return 'Amazon';
      if (srcHost.includes('flipkart')) return 'Flipkart';
      if (srcHost.includes('myntra')) return 'Myntra';
      if (srcHost.includes('ajio')) return 'Ajio';
      if (srcHost.includes('nykaa')) return 'Nykaa';
      if (srcHost.includes('tatacliq')) return 'TataCliq';
      if (srcHost.includes('croma')) return 'Croma';
      if (srcHost.includes('snapdeal')) return 'Snapdeal';
      return '';
    })();

    // Search queries
    // q1: ASIN + brand (most precise — finds exact product on all stores)
    // q2: short title (broad — catches stores that don't index by ASIN)
    // q3: brand + model only (even broader)
    const brandModel = shortQ.split(' ').slice(0,3).join(' ');
    const q1 = asin ? (asin + ' ' + brandModel) : shortQ;
    const q2 = shortQ;
    const q3 = brandModel;

    console.log('[Compare] Queries:', q1, '|', q2, '|', q3);

    const serpSearch = (q) => fetch(
      'https://serpapi.com/search.json?engine=google_shopping'
      + '&q=' + encodeURIComponent(q)
      + '&gl=in&hl=en&currency=INR&num=40&api_key=' + SERP_API_KEY,
      { signal: AbortSignal.timeout(15000) }
    ).then(r => r.json()).catch(() => null);

    const [r1, r2, r3] = await Promise.all([serpSearch(q1), serpSearch(q2), serpSearch(q3)]);

    const allResults = [
      ...(r1?.shopping_results||[]),
      ...(r2?.shopping_results||[]),
      ...(r3?.shopping_results||[]),
    ];
    const productImage = r1?.shopping_results?.[0]?.thumbnail || r2?.shopping_results?.[0]?.thumbnail || '';
    console.log('[Compare] Total results:', allResults.length);

    // Similarity: % of query keywords in result title
    const qWords = shortQ.toLowerCase().split(' ').filter(w=>w.length>2);
    function sim(t) {
      if (!t) return 0;
      const tl = t.toLowerCase();
      // ASIN match = perfect
      if (asin && tl.includes(asin.toLowerCase())) return 1.0;
      // Keyword overlap
      return qWords.filter(w=>tl.includes(w)).length / qWords.length;
    }

    const TARGET = ['Amazon','Flipkart','Myntra','Ajio','Nykaa','TataCliq','Croma','Snapdeal'];
    const storeMap = {};

    allResults.forEach(item => {
      const store = normalizeStore(item.source||'');
      if (!TARGET.includes(store)) return;
      const price = item.extracted_price || 0;
      if (price === 0) return;
      const s = sim(item.title);

      // Log every result for Render logs debugging
      console.log('[Compare]', store, '₹'+price, 'sim:'+Math.round(s*100)+'%', (item.title||'').substring(0,50));

      // Accept if ≥ 40% keyword match OR perfect ASIN match
      if (s < 0.4) { console.log('  → SKIP'); return; }

      // Direct product link preferred over Google redirect
      const link = (item.product_link && !item.product_link.includes('google.com'))
        ? item.product_link : storeSearchUrl(store, fullTitle);

      if (!storeMap[store] || price < storeMap[store].price) {
        storeMap[store] = { name:store, normalizedName:store, price, url:link };
      }
    });

    let stores = Object.values(storeMap).sort((a,b)=>a.price-b.price)
      .map((s,i)=>({ ...s, isBest:i===0, isSource:s.name===srcStore }));

    const src = stores.find(s=>s.isSource);
    const savings = src && !src.isBest ? src.price - stores[0].price : 0;

    console.log('[Compare] FINAL:', stores.map(s=>s.name+':₹'+s.price+(s.isSource?'[src]':'')+(s.isBest?'[best]':'')).join(' | '));

    return res.json({
      stores, productName:fullTitle, productImage,
      totalStores:stores.length, savings:savings>0?savings:0, searchQuery:shortQ
    });

  } catch(e) {
    console.error('[Compare] Error:', e.message);
    res.status(500).json({ error:e.message });
  }
});

// Debug endpoint
app.get('/serp/debug', async (req, res) => {
  if (!SERP_API_KEY) return res.json({ error:'No SERP_API_KEY' });
  const { url, q } = req.query;
  let query = q || '';
  if (url && !q) {
    const t = await fetchTitle(url).catch(()=>null);
    if (t) query = t.replace(/\|.*/g,'').replace(/[\(\[].*?[\)\]]/g,'').replace(/,.*$/,'').replace(/[^a-zA-Z0-9 ]/g,' ').trim().split(' ').slice(0,5).join(' ');
    // Also check ASIN
    try {
      const m = new URL(url).pathname.match(/\/dp\/([A-Z0-9]{10})/i);
      if (m) query = m[1] + ' ' + query.split(' ').slice(0,3).join(' ');
    } catch(e) {}
  }
  const r = await fetch('https://serpapi.com/search.json?engine=google_shopping&q='+encodeURIComponent(query)+'&gl=in&hl=en&currency=INR&num=40&api_key='+SERP_API_KEY);
  const d = await r.json();
  res.json({ query, count:(d.shopping_results||[]).length,
    results:(d.shopping_results||[]).slice(0,15).map(x=>({ source:x.source, price:x.price, extracted:x.extracted_price, title:(x.title||'').substring(0,70), link:(x.product_link||'').substring(0,80) })) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
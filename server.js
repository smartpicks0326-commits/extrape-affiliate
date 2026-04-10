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
  type:   { type: String, enum: ['conversion', 'click', 'compare'] },
  url:    String,
  store:  String,
  state:  String,
  dest:   String,
  ts:     { type: Date, default: Date.now },
});
eventSchema.index({ ts: -1 });  // fast recent queries

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
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    Counter = mongoose.model('Counter', counterSchema);
    Event   = mongoose.model('Event',   eventSchema);
    // Ensure the main counter document exists
    await Counter.findOneAndUpdate(
      { _id: 'main' },
      { $setOnInsert: { _id: 'main' } },
      { upsert: true, new: true }
    );
    dbConnected = true;
    console.log('[DB] MongoDB connected ✅');
  } catch(e) {
    console.error('[DB] MongoDB connection failed:', e.message, '— using in-memory fallback');
  }
}
connectDB();

// ── Track functions ──
async function trackVisit() {
  if (dbConnected) {
    await Counter.updateOne({ _id: 'main' }, { $inc: { pageVisits: 1 } }).catch(e => console.error('[DB] trackVisit:', e.message));
  } else {
    memAnalytics.pageVisits++;
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

async function trackClick(dest) {
  if (dbConnected) {
    await Counter.updateOne({ _id: 'main' }, { $inc: { clicks: 1 } }).catch(e => console.error('[DB] trackClick:', e.message));
    await new Event({ type: 'click', dest, ts: new Date() }).save().catch(() => {});
  } else {
    memAnalytics.clicks++;
    memAnalytics.recentClicks.unshift({ dest, ts: Date.now() });
    if (memAnalytics.recentClicks.length > 50) memAnalytics.recentClicks.pop();
  }
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

// Track page visits (called from frontend on load)
app.post('/track/visit', async (req, res) => {
  await trackVisit().catch(() => {});
  res.json({ ok: true });
});

// Dashboard stats endpoint — reads from MongoDB if connected
app.get('/dashboard/stats', async (req, res) => {
  try {
    if (dbConnected) {
      const counter = await Counter.findById('main').lean();
      const recentConversions = await Event.find({ type: 'conversion' })
        .sort({ ts: -1 }).limit(50).lean();
      const recentClicks = await Event.find({ type: 'click' })
        .sort({ ts: -1 }).limit(50).lean();

      // Convert Map to plain object for JSON
      const storeBreakdown = {};
      if (counter?.storeBreakdown) {
        for (const [k, v] of Object.entries(counter.storeBreakdown)) {
          storeBreakdown[k] = v;
        }
      }

      return res.json({
        pageVisits:        counter?.pageVisits   || 0,
        conversions:       counter?.conversions  || 0,
        clicks:            counter?.clicks       || 0,
        compares:          counter?.compares     || 0,
        storeBreakdown,
        recentConversions: recentConversions.map(e => ({ url: e.url, store: e.store, state: e.state, ts: e.ts?.getTime() })),
        recentClicks:      recentClicks.map(e => ({ dest: e.dest, ts: e.ts?.getTime() })),
        dbConnected:       true,
        serverUptime:      Math.round(process.uptime() / 60) + ' min',
        generatedAt:       new Date().toISOString(),
      });
    }
  } catch(e) {
    console.error('[DB] dashboard/stats error:', e.message);
  }

  // Fallback: return in-memory data
  res.json({
    pageVisits:        memAnalytics.pageVisits,
    conversions:       memAnalytics.conversions,
    clicks:            memAnalytics.clicks,
    compares:          memAnalytics.compares,
    storeBreakdown:    memAnalytics.storeBreakdown,
    recentConversions: memAnalytics.recentConversions,
    recentClicks:      memAnalytics.recentClicks,
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
      trackClick(decoded.substring(0, 80));
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
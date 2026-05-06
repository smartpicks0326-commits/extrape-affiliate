try { require('dotenv').config(); } catch(e) {} // Load .env if available (optional)
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
  // Use www. subdomain — Pages Function works on www but not apex domain
  const baseUrl = FRONTEND_URL.replace('https://smartpickdeals.live', 'https://www.smartpickdeals.live')
                               .replace('http://smartpickdeals.live', 'https://www.smartpickdeals.live');
  return baseUrl + '/go/' + b64;
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

// ── Short URL → Store mapping (populated when conversions happen) ──
// When user converts croma.com → gets bilty.co short link
// We map bilty.co/CODE → 'Croma' so click tracking knows the store
const shortUrlStoreMap = new Map(); // shortUrl → storeName

function cacheShortUrlStore(shortUrl, store) {
  if (shortUrl && store) {
    shortUrlStoreMap.set(shortUrl, store);
    // Also cache partial match (just the path code)
    try {
      const path = new URL(shortUrl).pathname.split('/')[1];
      if (path) shortUrlStoreMap.set(path, store);
    } catch(e) {}
  }
}

function lookupShortUrlStore(url) {
  if (!url) return '';
  // Exact match
  if (shortUrlStoreMap.has(url)) return shortUrlStoreMap.get(url);
  // Partial match by path code
  try {
    const path = new URL(url).pathname.split('/')[1];
    if (path && shortUrlStoreMap.has(path)) return shortUrlStoreMap.get(path);
  } catch(e) {}
  return '';
}

// ── SSE: declared here so all track functions can call pushDashboardUpdate ──
const sseClients = new Set();
function pushDashboardUpdate() {
  if (sseClients.size === 0) return;
  const payload = JSON.stringify({
    type: 'counter',
    pageVisits:  memAnalytics.pageVisits,
    conversions: memAnalytics.conversions,
    clicks:      memAnalytics.clicks,
    compares:    memAnalytics.compares,
    ts: Date.now(),
  });
  sseClients.forEach(client => {
    try { client.write('data: ' + payload + '\n\n'); }
    catch(e) { sseClients.delete(client); }
  });
}

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

// ── Auto-sync Render in-memory data on every startup ──
// Runs whenever this server starts (reboot, pm2 restart, or pm2 start)
// If Render has no MONGO_URI, it stores data in-memory → pull it here
async function syncFromRender() {
  const RENDER = 'https://extrape-affiliate.onrender.com';
  // Wait for DB to connect first
  for (let i = 0; i < 10; i++) {
    if (dbConnected) break;
    await new Promise(r => setTimeout(r, 1500));
  }
  if (!dbConnected) return console.log('[Sync] Skipped — DB not connected');

  try {
    console.log('[Sync] Pulling Render data...');
    const r = await fetch(
      RENDER + '/dashboard/stats?from=2024-01-01T00:00:00.000Z&to=' + new Date().toISOString(),
      { signal: AbortSignal.timeout(15000) }
    );
    if (!r.ok) return console.log('[Sync] Render returned', r.status);
    const d = await r.json();

    if (d.dbConnected) {
      return console.log('[Sync] Render uses same MongoDB — no sync needed ✅');
    }

    // Only merge if Render has data worth syncing
    const total = (d.pageVisits||0) + (d.conversions||0) + (d.clicks||0) + (d.compares||0);
    if (total === 0) return console.log('[Sync] Render has no in-memory data to sync');

    // Merge counters
    await Counter.updateOne({ _id: 'main' }, {
      $inc: {
        pageVisits:  d.pageVisits  || 0,
        conversions: d.conversions || 0,
        clicks:      d.clicks      || 0,
        compares:    d.compares    || 0,
      }
    });

    // Save recent events (avoid duplicates by checking ts + dest)
    const events = [
      ...(d.recentVisits      || []).map(e => ({ type:'visit',      url:e.url||'',  ts:new Date(e.ts) })),
      ...(d.recentConversions || []).map(e => ({ type:'conversion',  url:e.url||'',  store:e.store||'', state:e.state||'', ts:new Date(e.ts) })),
      ...(d.recentClicks      || []).map(e => ({ type:'click', dest:e.dest||'', store:e.store||detectStoreFromUrl(e.dest||''), ts:new Date(e.ts) })),
    ].filter(e => e.ts && !isNaN(e.ts.getTime()));

    if (events.length > 0) {
      await Event.insertMany(events, { ordered: false }).catch(() => {});
    }

    console.log('[Sync] ✅ Merged from Render — visits:' + (d.pageVisits||0) +
      ' conversions:' + (d.conversions||0) + ' clicks:' + (d.clicks||0) +
      ' events saved:' + events.length);
  } catch(e) {
    console.log('[Sync] Failed to reach Render:', e.message);
  }
}
// Run sync 5 seconds after startup (gives DB time to connect)
setTimeout(syncFromRender, 5000);

// Backfill ALL click events with store names (runs after DB connects)
async function backfillStoresOnStart() {
  // Wait until DB is connected (poll every 2s, max 30s)
  for (let i = 0; i < 15; i++) {
    if (dbConnected) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!dbConnected) return console.log('[Backfill] Skipped — DB not connected');
  try {
    // Find ALL clicks and update store if missing or wrong
    const clicks = await Event.find({ type: 'click' }).lean();
    let updated = 0;
    for (const c of clicks) {
      const store = detectStoreFromUrl(c.dest || '');
      if (store && store !== c.store) {
        await Event.updateOne({ _id: c._id }, { $set: { store } });
        updated++;
      }
    }
    console.log('[Startup] Backfilled store names: checked', clicks.length, '| updated', updated);
  } catch(e) { console.log('[Backfill] Error:', e.message); }
}
setTimeout(backfillStoresOnStart, 5000);

// ── Track functions ──
async function trackVisit(page) {
  if (dbConnected) {
    await Counter.updateOne({ _id: 'main' }, { $inc: { pageVisits: 1 } })
      .catch(e => console.error('[DB] trackVisit:', e.message));
    await new Event({ type: 'visit', url: page || '/', ts: new Date() }).save()
      .catch(e => console.error('[DB] visit event:', e.message));
  } else {
    memAnalytics.pageVisits++;
  }
  pushDashboardUpdate();
}

async function trackConversion(url, store, state, affiliateLink) {
  // Cache affiliate short URL → store mapping for click tracking
  if (affiliateLink && store && state === 'done') {
    cacheShortUrlStore(affiliateLink, store);
  }
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

function detectStoreFromUrl(url) {
  if (!url) return '';
  // Direct store domains
  if (url.includes('amazon.in') || url.includes('amzn.in') || url.includes('amzn.to') || url.includes('amazon.com')) return 'Amazon';
  if (url.includes('flipkart.com') || url.includes('fkrt.co') || url.includes('dl.flipkart.com')) return 'Flipkart';
  if (url.includes('myntra.com') || url.includes('myntr.co')) return 'Myntra';
  if (url.includes('ajio.com') || url.includes('ajiio.co')) return 'Ajio';
  if (url.includes('nykaa.com') || url.includes('nykaafashion.com')) return 'Nykaa';
  if (url.includes('tatacliq.com') || url.includes('tata.cliq') || url.includes('tatacl.iq')) return 'TataCliq';
  if (url.includes('croma.com')) return 'Croma';
  if (url.includes('snapdeal.com') || url.includes('sdl.me')) return 'Snapdeal';
  if (url.includes('meesho.com') || url.includes('meesho.in')) return 'Meesho';
  if (url.includes('jiomart.com') || url.includes('jiom.art')) return 'JioMart';
  if (url.includes('netmeds.com')) return 'Netmeds';
  if (url.includes('lenskart.com') || url.includes('lk.ms')) return 'Lenskart';
  if (url.includes('reliancedigital.in') || url.includes('rlnc.in')) return 'Reliance Digital';
  if (url.includes('vijaysales.com')) return 'Vijay Sales';
  if (url.includes('shopclues.com')) return 'ShopClues';
  if (url.includes('paytmmall.com')) return 'Paytm Mall';
  if (url.includes('bigbasket.com')) return 'BigBasket';

  // ExtraPe short link domains — store name embedded in URL path
  if (url.includes('bilty.co') || url.includes('ajiio.co') || url.includes('cliq.ly') || url.includes('myntr.co')) {
    const u = url.toLowerCase();
    if (u.includes('croma'))              return 'Croma';
    if (u.includes('ajio') || url.includes('ajiio.co')) return 'Ajio';
    if (u.includes('myntra'))             return 'Myntra';
    if (u.includes('nykaa'))              return 'Nykaa';
    if (u.includes('tatacliq') || u.includes('tata+cliq') || u.includes('tata cliq')) return 'TataCliq';
    if (u.includes('snapdeal'))           return 'Snapdeal';
    if (u.includes('meesho'))             return 'Meesho';
    if (u.includes('jiomart'))            return 'JioMart';
    if (u.includes('netmeds'))            return 'Netmeds';
    if (u.includes('lenskart'))           return 'Lenskart';
    if (u.includes('reliance'))           return 'Reliance Digital';
    if (u.includes('vijay'))              return 'Vijay Sales';
    if (u.includes('flipkart'))           return 'Flipkart';
    if (u.includes('amazon'))            return 'Amazon';
    if (url.includes('bilty.co'))         return 'Croma'; // bilty.co = primarily Croma
    if (url.includes('ajiio.co'))         return 'Ajio';  // ajiio.co = Ajio
  }
  return '';
}


async function trackClick(dest, store) {
  const d = (dest || 'unknown').substring(0, 300);
  // Try: explicit store → cached short URL map → URL detection
  const s = store || lookupShortUrlStore(d) || detectStoreFromUrl(d) || '';
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
  pushDashboardUpdate();
}

async function trackCompare() {
  if (dbConnected) {
    await Counter.updateOne({ _id: 'main' }, { $inc: { compares: 1 } }).catch(e => console.error('[DB] trackCompare:', e.message));
  } else {
    memAnalytics.compares++;
  }
}

async function trackCompareEvent(url, store) {
  await trackCompare().catch(() => {});
  if (dbConnected) {
    await new Event({ type: 'compare', url: url||'', store: store||'', ts: new Date() }).save()
      .catch(e => console.error('[DB] compare event:', e.message));
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
    trackConversion(req.url, req.store, 'done', req.affiliateLink);
  } catch(e) {
    req.state = 'error'; req.error = e.message;
    trackConversion(req.url, req.store, 'error', null);
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
  if (s.includes('amazon'))                                    return 'Amazon';
  if (s.includes('flipkart'))                                  return 'Flipkart';
  if (s.includes('myntra'))                                    return 'Myntra';
  if (s.includes('ajio'))                                      return 'Ajio';
  if (s.includes('nykaa'))                                     return 'Nykaa';
  if (s.includes('tatacliq') || s.includes('tata cliq'))      return 'TataCliq';
  if (s.includes('croma'))                                     return 'Croma';
  if (s.includes('snapdeal'))                                  return 'Snapdeal';
  if (s.includes('meesho'))                                    return 'Meesho';
  if (s.includes('jiomart') || s.includes('jio mart'))        return 'JioMart';
  if (s.includes('reliance digital') || s.includes('reliancedigital')) return 'Reliance Digital';
  if (s.includes('vijay sales') || s.includes('vijaysales'))  return 'Vijay Sales';
  if (s.includes('netmeds'))                                   return 'Netmeds';
  if (s.includes('lenskart'))                                  return 'Lenskart';
  if (s.includes('pepperfry'))                                 return 'Pepperfry';
  if (s.includes('firstcry'))                                  return 'FirstCry';
  if (s.includes('bigbasket'))                                 return 'BigBasket';
  return '';
}

function storeSearchUrl(store, q) {
  const eq = encodeURIComponent(q);
  if (store==='Amazon')           return 'https://www.amazon.in/s?k='+eq;
  if (store==='Flipkart')         return 'https://www.flipkart.com/search?q='+eq;
  if (store==='Myntra')           return 'https://www.myntra.com/'+eq;
  if (store==='Ajio')             return 'https://www.ajio.com/search/?text='+eq;
  if (store==='Nykaa')            return 'https://www.nykaa.com/search/result/?q='+eq;
  if (store==='TataCliq')         return 'https://www.tatacliq.com/search/?text='+eq;
  if (store==='Croma')            return 'https://www.croma.com/searchB?q='+eq;
  if (store==='Snapdeal')         return 'https://www.snapdeal.com/search?keyword='+eq;
  if (store==='Meesho')           return 'https://www.meesho.com/search?q='+eq;
  if (store==='JioMart')          return 'https://www.jiomart.com/search?q='+eq;
  if (store==='Reliance Digital') return 'https://www.reliancedigital.in/search?q='+eq;
  if (store==='Vijay Sales')      return 'https://www.vijaysales.com/search/'+eq;
  if (store==='Netmeds')          return 'https://www.netmeds.com/catalogsearch/result?q='+eq;
  if (store==='Lenskart')         return 'https://www.lenskart.com/search/?q='+eq;
  return 'https://www.google.com/search?q=site:'+encodeURIComponent(store.toLowerCase()+'.com')+'+'+eq;
}

// ══════════════════════════════════════════════════════════════
// BUYHATKE integration
// No API key required. Works from Indian residential IP (laptop).
// Extension API: api.buyhatke.com/mw/papi/v1/product/info
// ══════════════════════════════════════════════════════════════

// Fetch price comparison data from Buyhatke's extension API.
// Buyhatke returns prices + direct store URLs for the same product.
// ══════════════════════════════════════════════════════════════════════
// BUYHATKE — confirmed two-step API (discovered via DevTools, May 2026)
//
// Step 1 — productData: gets source product + internalPid
//   GET https://buyhatke.com/api/productData?pos={pos}&pid={pid}
//   pos = store index (Amazon India = 63, Flipkart = 1, Myntra = 4 …)
//   pid = store's own product ID (ASIN for Amazon, pid for Flipkart)
//   Returns: name, image, link, cur_price, site_name, internalPid
//
// Step 2 — getRawProdSpecs: gets cross-store price comparison by internalPid
//   GET https://buyhatke.com/api/getRawProdSpecs?pid_id={internalPid}&pos={pos}
//   Returns: array of {site_name, site_pos, pid, price, link, inStock …}
// ══════════════════════════════════════════════════════════════════════

// Buyhatke store position numbers (pos param in productData endpoint).
// pos=63 confirmed for Amazon India. Others are best-known values —
// add more as you discover them via DevTools on buyhatke.com.
// Confirmed pos values from buyhatke.com/api/posList (May 2026)
const BHK_POS = {
  amazon:    63,
  flipkart:  2,      // was 1 — confirmed from posList: "www.flipkart.com": 2
  myntra:    111,    // was 4
  ajio:      2191,   // was 14
  nykaa:     1830,   // was 11
  croma:     71,     // was 7
  snapdeal:  129,    // was 3
  tatacliq:  2190,   // was 10
  meesho:    7376,   // was 22
  jiomart:   6660,   // was 20
};

// Extract (pos, pid) from a product URL so we can call productData.
// Returns null if the URL is not from a recognised store.
// Detect short URLs that need redirect-resolution before we can extract params.
// These are links like amzn.in/d/xxx or dl.flipkart.com/s/xxx — they carry
// no ASIN/pid in the URL itself; we must follow the redirect first.
function isShortUrl(productUrl) {
  try {
    const host = new URL(productUrl).hostname.replace('www.', '');
    return (
      host === 'amzn.in'  || host === 'amzn.to' ||   // Amazon short links
      host === 'dl.flipkart.com' ||                    // Flipkart deep-link short
      host === 'fkrt.co'  ||                           // Flipkart native short
      host === 'ajiio.co' ||                           // Ajio ExtraPe short
      host === 'bilty.co' ||                           // Croma ExtraPe short
      host === 'myntr.co'                              // Myntra ExtraPe short
    );
  } catch(e) { return false; }
}

// Follow redirects and return the final destination URL.
// Uses HEAD first (fast), falls back to GET if server rejects HEAD.
async function resolveRedirect(shortUrl) {
  // Amazon (amzn.in) serves a 200 HTML page from Indian server IPs instead
  // of a 302 redirect — bot detection at the CDN edge. The final URL won't
  // differ from the input. We handle this by:
  //   1. Following redirects normally (works for Flipkart, Ajio short links)
  //   2. If the URL didn't change, parse ASIN from HTML meta/canonical tags
  const reqHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'en-IN,en;q=0.9',
  };

  const r = await fetch(shortUrl, {
    method: 'GET', headers: reqHeaders, redirect: 'follow',
    signal: AbortSignal.timeout(12000),
  });
  const finalUrl = r.url;
  console.log('[Redirect]', shortUrl.substring(0,50), '→', finalUrl.substring(0,80));

  // If redirect worked — final URL differs and contains a known long-URL pattern
  if (finalUrl !== shortUrl && !isShortUrl(finalUrl)) {
    return finalUrl;
  }

  // Redirect didn't work (Amazon bot wall). Parse ASIN from HTML response body.
  const html = await r.text();

  // Try 1: canonical link tag — most reliable
  const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
                 || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  if (canonical) {
    console.log('[Redirect] canonical:', canonical[1].substring(0,80));
    return canonical[1];
  }

  // Try 2: og:url meta tag
  const ogUrl = html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)
             || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i);
  if (ogUrl) {
    console.log('[Redirect] og:url:', ogUrl[1].substring(0,80));
    return ogUrl[1];
  }

  // Try 3: extract ASIN directly from any URL pattern in the HTML
  const asinMatch = html.match(/\/dp\/([A-Z0-9]{10})/i);
  if (asinMatch) {
    const resolved = `https://www.amazon.in/dp/${asinMatch[1]}`;
    console.log('[Redirect] ASIN from HTML:', resolved);
    return resolved;
  }

  // Try 4: data-asin attribute (Amazon product page)
  const dataAsin = html.match(/data-asin=["']([A-Z0-9]{10})["']/i);
  if (dataAsin) {
    const resolved = `https://www.amazon.in/dp/${dataAsin[1]}`;
    console.log('[Redirect] data-asin from HTML:', resolved);
    return resolved;
  }

  // Give up — return whatever URL we got
  console.log('[Redirect] Could not extract product URL from HTML, returning:', finalUrl.substring(0,80));
  return finalUrl;
}

function extractBhkParams(productUrl) {
  try {
    const u    = new URL(productUrl);
    const host = u.hostname.replace('www.', '');

    // Amazon long URL — ASIN in /dp/XXXXXXXXXX
    if (host.includes('amazon')) {
      const m = u.pathname.match(/\/dp\/([A-Z0-9]{10})/i)
             || u.pathname.match(/\/([A-Z0-9]{10})(?:\/|$)/i);
      if (m) return { pos: BHK_POS.amazon, pid: m[1] };
    }

    // Flipkart long URL — extract product item ID from path (/p/itm...) NOT ?pid=
    // ?pid= is the seller/listing ID (e.g. MOBHFN6YWTXZD8SG) — Buyhatke doesn't use it.
    // The product ID is the itm... code in the URL path (e.g. /p/itm1834df7ee2812).
    if (host.includes('flipkart') && host !== 'dl.flipkart.com') {
      const pathPid = (u.pathname.match(/\/p\/([a-zA-Z0-9]+)/i) || [])[1];
      if (pathPid) return { pos: BHK_POS.flipkart, pid: pathPid };
    }

    // Myntra — numeric product ID is the last path segment
    if (host.includes('myntra')) {
      const m = u.pathname.match(/\/(\d{6,})(?:\/|$)/);
      if (m) return { pos: BHK_POS.myntra, pid: m[1] };
    }

    // Ajio long URL — product code is last path segment
    if (host.includes('ajio') && host !== 'ajiio.co') {
      const segs = u.pathname.split('/').filter(Boolean);
      const pid  = segs[segs.length - 1];
      if (pid && pid.length > 4) return { pos: BHK_POS.ajio, pid };
    }

    // Nykaa — numeric product ID in path
    if (host.includes('nykaa')) {
      const m = u.pathname.match(/\/(\d{4,})(?:\/|$)/);
      if (m) return { pos: BHK_POS.nykaa, pid: m[1] };
    }

    return null;
  } catch(e) { return null; }
}

const BHK_HEADERS = {
  'Accept':          'application/json, */*',
  'Accept-Language': 'en-IN,en;q=0.9',
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Referer':         'https://buyhatke.com/',
  'Origin':          'https://buyhatke.com',
};

// Same-origin XHR headers — used for getRawProdSpecs which returns JSON to browser
// XHR but falls back to SSR HTML for plain fetch requests.
// The sec-fetch-* headers tell the server this is a same-origin AJAX call, not
// a browser navigation — that's why the browser gets JSON and we were getting HTML.
const BHK_XHR_HEADERS = {
  ...BHK_HEADERS,
  'Accept':            'application/json, text/plain, */*',
  'sec-fetch-dest':    'empty',
  'sec-fetch-mode':    'cors',
  'sec-fetch-site':    'same-origin',
  'sec-ch-ua':         '"Google Chrome";v="124", "Chromium";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile':  '?0',
  'sec-ch-ua-platform': '"Windows"',
  'x-requested-with':  'XMLHttpRequest',
};

// Step 1: resolve input URL → { name, image, cur_price, internalPid, site_name, link }
async function bhkGetProductData(pos, pid) {
  const url = `https://buyhatke.com/api/productData?pos=${pos}&pid=${encodeURIComponent(pid)}`;
  console.log('[BHK] productData:', url);
  const r = await fetch(url, { headers: BHK_HEADERS, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`productData HTTP ${r.status}`);
  const d = await r.json();
  if (!d.data || !d.data.internalPid) {
    // Product not in Buyhatke index — log full response for diagnosis, throw for SerpAPI fallback
    console.log('[BHK] productData missing internalPid. Full response:', JSON.stringify(d).substring(0, 400));
    const err = new Error('productData: no internalPid — product not in Buyhatke index');
    err.rawResponse = d;
    throw err;
  }
  console.log(`[BHK] Got product: "${(d.data.name||'').substring(0,50)}" internalPid=${d.data.internalPid}`);
  return d.data;
}

// Step 2: get cross-store prices by internalPid.
// Primary: getRawProdSpecs (seen in DevTools).
// Fallback candidates probed silently if primary returns no store list.
async function bhkGetMultiStorePrices(internalPid, srcPid, srcPos) {
  const rawResponses = [];

  // ── Strategy A: search-new.bitbns.com — Buyhatke's actual backend API ──
  // bitbns.com is Buyhatke's parent company. Their backend API is separate from
  // the buyhatke.com frontend and may not have the same browser restrictions.
  // We try several endpoint patterns that match what the SvelteKit app calls.
  // bitbns confirmed returning JSON freely — try price-focused endpoints first,
  // then fall back to per-store productData calls via bitbns.
  // ══════════════════════════════════════════════════════════════
  // CONFIRMED flow (DevTools, May 2026):
  //
  // thunder/priceData POST {"param": [[pos, "storePid"], ...]}
  //   Response: {"status":1,"data":{"63~**~B0FVS8V372":"{"price":799,"oos":0}"}}
  //   Key format: "{pos}~**~{storePid}" → JSON string {"price":N,"oos":0|1}
  //
  // Cross-store pids: getRawProdSpecs?pid_id={internalPid}&pos={storePos}
  //   Returns spec_json which contains the store-specific pid field
  //   e.g. Amazon pos=63 → spec_json.ASIN = "B0FVS8V372"
  //        Flipkart pos=2 → spec_json might have FSN or pid field
  // ══════════════════════════════════════════════════════════════

  const thunderUrl  = 'https://search-new.bitbns.com/buyhatke/thunder/priceData';
  const thunderHdrs = {
    ...BHK_XHR_HEADERS,
    'Content-Type': 'application/json',
    'Referer': 'https://buyhatke.com/',
    'Origin':  'https://buyhatke.com',
  };

  // ── Step 2a: Get cross-store [pos, storePid] pairs ──
  // 1. buyhatke.com/api/posList → {domain: pos} for all stores carrying this product
  // 2. getRawProdSpecs?pid_id={internalPid}&pos={storePos} → store-specific pid in spec_json
  let posMap = null;
  try {
    const r = await fetch(`https://buyhatke.com/api/posList?internalPid=${internalPid}`,
      { headers: BHK_HEADERS, signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    if (d.status === 1 && d.data) posMap = d.data;
  } catch(e) { rawResponses.push({ step: 'posList', error: e.message }); }

  if (!posMap) return { items: [], endpoint: null, rawResponses };

  // Deduplicate stores, skip source store pos (we already have it from step 1)
  const storePosMap = {};   // name → pos
  for (const [domain, pos] of Object.entries(posMap)) {
    const name = normalizeStore(domain);
    if (!name) continue;
    // Keep lowest pos number per store name (most canonical entry)
    if (!storePosMap[name] || pos < storePosMap[name]) storePosMap[name] = pos;
  }

  // Always include source store with its real pid
  const thunderPairs = [[srcPos, srcPid]];

  // For each other store, call getRawProdSpecs on bitbns to get store-specific pid
  const specsHeaders = { ...BHK_XHR_HEADERS, 'Referer': 'https://buyhatke.com/' };
  const otherStores  = Object.entries(storePosMap).filter(([, pos]) => pos !== srcPos);

  console.log('[BHK] Fetching storePids via getRawProdSpecs for', otherStores.length, 'stores');

  // Fetch store-specific pid AND log full diagnostic for debug endpoint
  const storeSpecDiag = [];
  const fetchStorePid = async ([name, storePos]) => {
    const url = `https://search-new.bitbns.com/buyhatke/getRawProdSpecs?pid_id=${internalPid}&pos=${storePos}`;
    try {
      const r = await fetch(url, { headers: specsHeaders, signal: AbortSignal.timeout(8000) });
      const diag = { name, pos: storePos, httpStatus: r.status };
      if (!r.ok) { storeSpecDiag.push(diag); return null; }
      const d = await r.json();
      diag.responseKeys = Object.keys(d);
      diag.count = d.count;

      // Resolve spec object — may be at top level (Amazon) or inside data array
      // {spec_json:...}  OR  {success, count, data:[{pid_id,pos,spec_json},...]  }
      let spec = null;
      let rawPid = null;

      if (d.spec_json) {
        // Direct spec_json at top level (Amazon pattern)
        spec = typeof d.spec_json === 'string' ? JSON.parse(d.spec_json) : d.spec_json;
      } else if (Array.isArray(d.data) && d.data.length > 0) {
        // Array pattern — first item should have the spec and store pid
        const item = d.data[0];
        diag.dataItem0Keys = Object.keys(item);
        diag.dataItem0Sample = JSON.stringify(item).substring(0, 400);
        if (item.spec_json) {
          spec = typeof item.spec_json === 'string' ? JSON.parse(item.spec_json) : item.spec_json;
        }
        // The item itself may carry the store pid directly
        rawPid = item.pid || item.product_id || item.storePid || item.store_pid || null;
      } else {
        // count=0 — product not listed on this store
        diag.note = d.count === 0 ? 'count=0: product not on this store' : 'no spec_json, empty data';
        storeSpecDiag.push(diag);
        return null;
      }

      if (spec) {
        diag.specKeys = Object.keys(spec).slice(0, 15);
        const specSample = {};
        Object.entries(spec).slice(0, 6).forEach(([k,v]) => { specSample[k] = String(v).substring(0, 50); });
        diag.specSample = specSample;
        const storePid = rawPid || extractStorePidFromSpec(spec, name, storePos);
        if (!storePid) {
          diag.note = 'no pid extracted — check specKeys/specSample';
          storeSpecDiag.push(diag);
          console.log(`[BHK] No storePid for ${name} pos=${storePos}. specKeys: ${diag.specKeys.join(',')}`);
          return null;
        }
        diag.storePid = storePid;
        storeSpecDiag.push(diag);
        console.log(`[BHK] ${name} pos=${storePos} storePid=${storePid}`);
        return [storePos, storePid];
      }

      // No spec at all — log raw item for diagnosis
      diag.note = 'no spec_json anywhere';
      storeSpecDiag.push(diag);
      return null;
    } catch(e) {
      storeSpecDiag.push({ name, pos: storePos, error: e.message.substring(0,60) });
      return null;
    }
  };

  const pairResults = await Promise.all(otherStores.map(fetchStorePid));
  pairResults.forEach(p => { if (p) thunderPairs.push(p); });

  console.log('[BHK] thunder pairs collected:', thunderPairs.length,
    '| pairs:', thunderPairs.map(p=>p[0]+'~'+p[1]).join(' '));
  rawResponses.push({
    step: 'getRawProdSpecs-mapping',
    pairsFound: thunderPairs.length,
    pairs: thunderPairs.map(p => ({ pos: p[0], pid: p[1] })),
    perStoreDiagnostics: storeSpecDiag,   // ← key: shows spec fields for each store
  });

  // ── Step 2b: Call thunder/priceData with all pairs ──
  // If only source pair available (no cross-store mapping found),
  // thunder may still return cross-store matches from its own index.
  // Also try with just [[srcPos, srcPid]] in case internalPid pairs confuse it.
  const pairsToSend = thunderPairs.length > 1
    ? thunderPairs
    : [[srcPos, srcPid]];  // bare source pair — let thunder resolve cross-store
  console.log('[BHK] thunder sending', pairsToSend.length, 'pairs');
  try {
    const r = await fetch(thunderUrl, {
      method: 'POST',
      headers: thunderHdrs,
      body: JSON.stringify({ param: pairsToSend }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await r.text();
    let d; try { d = JSON.parse(text); } catch(e) {}

    if (!d) {
      rawResponses.push({ step: 'thunder', note: 'non-JSON', preview: text.substring(0,200) });
      return { items: [], endpoint: null, rawResponses };
    }

    console.log('[BHK] thunder response:', JSON.stringify(d).substring(0, 600));
    rawResponses.push({ step: 'thunder', status: r.status,
      preview: JSON.stringify(d).substring(0, 400) });

    const items = parseThunderResponse(d, posMap);
    console.log('[BHK] thunder parsed:', items.length, 'stores →',
      items.map(s => s.name + ':₹' + s.price).join(' | '));

    if (items.length > 0) {
      return { items, endpoint: thunderUrl, rawResponses };
    }
  } catch(e) {
    rawResponses.push({ step: 'thunder', error: e.message });
  }

  return { items: [], endpoint: null, rawResponses };
}

// Extract store-specific pid from getRawProdSpecs spec_json
function extractStorePidFromSpec(spec, storeName, pos) {
  if (!spec || typeof spec !== 'object') return null;

  // Amazon
  if (storeName === 'Amazon' || pos === 63) {
    return spec['ASIN'] || spec['asin'] || null;
  }
  // Flipkart
  if (storeName === 'Flipkart' || pos === 2) {
    return spec['FSN'] || spec['Flipkart Serial Number'] || spec['pid'] || spec['fsn'] || null;
  }
  // Myntra
  if (storeName === 'Myntra' || pos === 111) {
    return spec['Myntra Product ID'] || spec['Style ID'] || spec['style_id'] || null;
  }
  // Snapdeal
  if (storeName === 'Snapdeal' || pos === 129) {
    return spec['Snapdeal Product ID'] || spec['pid'] || null;
  }

  // Generic: look for any field that looks like a short product identifier
  // (short alphanumeric, not a description/sentence)
  for (const [k, v] of Object.entries(spec)) {
    if (typeof v !== 'string') continue;
    if (v.length < 6 || v.length > 40) continue;
    if (/\s/.test(v)) continue;  // no spaces = likely an ID
    if (/^[A-Za-z0-9_\-]+$/.test(v)) {
      const kl = k.toLowerCase();
      if (kl.includes('id') || kl.includes('sku') || kl.includes('pid') ||
          kl.includes('code') || kl.includes('number') || kl.includes('asin') ||
          kl.includes('fsn')  || kl.includes('serial') || kl.includes('model')) {
        return v;
      }
    }
  }
  return null;
}

// Parse thunder/priceData response into store items.
// Response: {"status":1,"data":{"63~**~B0FVS8V372":"{"price":799,"oos":0}",...}}
function parseThunderResponse(d, posMap) {
  const items = [];
  const data  = d.data || {};

  // Build pos→storeName lookup from posMap ({domain:pos})
  const posToName = {};
  if (posMap) {
    for (const [domain, pos] of Object.entries(posMap)) {
      const name = normalizeStore(domain);
      if (name && !posToName[pos]) posToName[pos] = name;
    }
  }

  for (const [key, val] of Object.entries(data)) {
    // Key format: "63~**~B0FVS8V372"
    const parts = key.split('~**~');
    if (parts.length !== 2) continue;
    const pos = parseInt(parts[0]);
    const pid = parts[1];

    // Parse value — it's a JSON string: "{"price":799,"oos":0}"
    let priceData;
    try {
      priceData = typeof val === 'string' ? JSON.parse(val) : val;
    } catch(e) { continue; }

    if (!priceData || priceData.oos === 1) continue;  // out of stock
    const price = parseFloat(priceData.price || priceData.cur_price || 0);
    if (price <= 0) continue;

    const name = posToName[pos] || normalizeStore(String(pos));
    if (!name) {
      console.log('[BHK] thunder: unknown pos', pos, '— add to posToName');
      continue;
    }

    // Build product URL: thunder doesn't return URLs, use productData for the link
    // We'll enrich with URLs in a follow-up step; for now use store search URL
    const url = priceData.link || priceData.url || storeSearchUrl(name, pid);
    items.push({ name, normalizedName: name, price, url, _pid: pid, _pos: pos });
  }

  return items.sort((a, b) => a.price - b.price);
}

// Post-enrich thunder items with real product URLs via productData calls
async function enrichThunderItems(items, internalPid, srcPid) {
  return Promise.all(items.map(async item => {
    if (item.url && !item.url.includes('google.com') &&
        !item.url.includes('amazon.in/s?') &&
        !item.url.includes('flipkart.com/search')) {
      return item;  // already has a real URL
    }
    try {
      const pid = item._pid || internalPid;
      const url = `https://buyhatke.com/api/productData?pos=${item._pos}&pid=${encodeURIComponent(pid)}`;
      const r   = await fetch(url, { headers: BHK_HEADERS, signal: AbortSignal.timeout(6000) });
      if (!r.ok) return item;
      const d = await r.json();
      if (d.data && d.data.link && d.data.link.startsWith('http')) {
        return { ...item, url: d.data.link };
      }
    } catch(e) {}
    return item;
  }));
}



// Parse thunder/priceData response into store items.
// Response shape TBD — we'll see from the first successful call.
// Common shapes: { data: [{pos, pid, price, link, site_name}, ...] }
//                { data: { [pos]: {price, link, ...} } }
//                [ {pos, pid, cur_price, link}, ... ]
function parseThunderResponse(d, paramPairs) {
  const items = [];
  const root  = d.data || d;

  // Shape 1: array of objects
  if (Array.isArray(root)) {
    root.forEach(item => {
      const name = normalizeStore(item.site_name || item.store_name || item.storeName || '');
      const price = parseFloat(item.cur_price || item.price || item.offerPrice || 0);
      const url   = item.link || item.url || item.productURL || '';
      if (name && price > 0 && url.startsWith('http')) {
        items.push({ name, normalizedName: name, price, url });
      }
    });
    if (items.length > 0) return items;
  }

  // Shape 2: object keyed by pos or pid
  if (typeof root === 'object' && !Array.isArray(root)) {
    for (const [key, val] of Object.entries(root)) {
      if (typeof val !== 'object') continue;
      const price = parseFloat(val.cur_price || val.price || val.offerPrice || 0);
      const url   = val.link || val.url || val.productURL || '';
      const rawName = val.site_name || val.store_name || val.storeName || '';
      const name  = normalizeStore(rawName) || normalizeStore(String(key));
      if (name && price > 0 && url.startsWith('http')) {
        items.push({ name, normalizedName: name, price, url });
      }
    }
    if (items.length > 0) return items;
  }

  // Log unparsed shape so we can add support
  console.log('[BHK] parseThunderResponse: unrecognised shape. Keys:', Object.keys(d).join(','),
    '| root type:', typeof root, Array.isArray(root) ? '(array len='+root.length+')' : '',
    '| sample:', JSON.stringify(root).substring(0, 300));
  return [];
}

// Stub (replaces the old bhkGetMultiStorePrices dummy below)


// Detect store item array from any response shape.
// Items must have a numeric price field — spec objects (with spec_json) are excluded.
function isStoreItem(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.spec_json) return false;  // this is a product spec, not a price entry
  const price = item.cur_price || item.price || item.storePrice || item.offerPrice
    || item.selling_price || item.mrp;
  return price && parseFloat(String(price).replace(/[^0-9.]/g,'')) > 0;
}

function extractStoreItems(d) {
  const root = d.data || d.result || d;
  // Named array fields
  for (const key of ['storeData', 'stores', 'priceList', 'storeList', 'prices',
                      'pricelist', 'offer_stores', 'offerList', 'items', 'results']) {
    if (Array.isArray(root[key]) && root[key].length > 0 && root[key].some(isStoreItem)) return root[key].filter(isStoreItem);
  }
  // Root-level array
  if (Array.isArray(root) && root.length > 0 && root.some(isStoreItem)) return root.filter(isStoreItem);
  // Array inside data.data
  if (root.data && Array.isArray(root.data) && root.data.length > 0 && root.data.some(isStoreItem)) return root.data.filter(isStoreItem);
  return null;
}

// Parse one store item from getRawProdSpecs (or any similar shape)
// into { name, price, url }. Returns null if unusable.
function parseStoreItem(item) {
  // Store name — confirmed fields from getRawProdSpecs + defensive alternatives
  const rawName = item.site_name || item.storeName || item.store_name
    || item.name  || item.store   || item.merchant  || '';
  const name = normalizeStore(rawName);
  if (!name) return null;

  // Price — confirmed: cur_price. Also try alternatives.
  const rawPrice = item.cur_price  || item.price      || item.storePrice
    || item.offerPrice || item.selling_price || item.mrp || 0;
  const price = parseFloat(String(rawPrice).replace(/[^0-9.]/g, '')) || 0;
  if (price <= 0) return null;

  // Stock — skip out-of-stock items
  if (item.inStock === 0 || item.inStock === false) return null;

  // URL — confirmed: link. Also try alternatives.
  const url = item.link || item.url || item.productURL || item.product_url
    || item.buyUrl  || item.buy_url  || '';
  if (!url || !url.startsWith('http')) return null;

  return { name, normalizedName: name, price, url };
}

// Main Buyhatke fetch — two-step, returns same shape as before
async function fetchBuyhatke(productUrl) {
  // Resolve short URLs (amzn.in/d/xxx, dl.flipkart.com/s/xxx, fkrt.co/xxx etc.)
  // before trying to extract ASIN/pid — short URLs carry no product ID in the path.
  if (isShortUrl(productUrl)) {
    console.log('[BHK] Short URL detected, resolving:', productUrl);
    try {
      productUrl = await resolveRedirect(productUrl);
      console.log('[BHK] Resolved to:', productUrl);
    } catch(e) {
      throw new Error('Could not resolve short URL: ' + e.message);
    }
  }

  const params = extractBhkParams(productUrl);
  if (!params) throw new Error(
    'URL not recognised as a supported store (Amazon/Flipkart/Myntra/Ajio/Nykaa). ' +
    'Got: ' + productUrl.substring(0, 80)
  );

  const { pos, pid } = params;

  // Step 1 — source product
  const srcProduct = await bhkGetProductData(pos, pid);
  const { internalPid, name: productName, image: productImage,
          cur_price: srcPrice, link: srcLink, site_name: srcSiteName } = srcProduct;

  // Step 2 — cross-store prices
  let { items } = await bhkGetMultiStorePrices(internalPid, pid, pos);
  if (items.length > 0) items = await enrichThunderItems(items, internalPid, pid);

  // Build store list — include source store always (it's confirmed from step 1)
  const storeMap = {};

  // Add source store from step-1 data (always present, accurate).
  // Use the original productUrl (what the user pasted) as the source link —
  // Buyhatke's returned link is sometimes wrong (wrong product in their DB).
  // Fall back to Buyhatke's link only if original URL looks like a short URL still.
  const srcStoreName = normalizeStore(srcSiteName || '');
  const bestSrcLink  = (!isShortUrl(productUrl) && productUrl.startsWith('http'))
    ? productUrl : (srcLink || productUrl);
  if (srcStoreName && srcPrice > 0) {
    storeMap[srcStoreName] = { name: srcStoreName, normalizedName: srcStoreName,
                               price: srcPrice, url: bestSrcLink };
  }

  // Add cross-store results from step 2
  items.forEach(item => {
    const parsed = parseStoreItem(item);
    if (!parsed) return;
    // Keep lowest price per store
    if (!storeMap[parsed.name] || parsed.price < storeMap[parsed.name].price) {
      storeMap[parsed.name] = parsed;
    }
  });

  console.log(`[BHK] Total stores collected: ${Object.keys(storeMap).length} —`,
    Object.values(storeMap).map(s => s.name + ':₹' + s.price).join(' | '));

  return {
    _bhkParsed: true,   // flag so parseBuyhatkeResponse knows we pre-parsed
    stores:       Object.values(storeMap),
    productName:  productName || '',
    productImage: productImage || '',
  };
}

// parseBuyhatkeResponse — called by /compare/search and /buyhatke/debug
// fetchBuyhatke now returns pre-parsed data, so this just applies
// isBest/isSource flags and sorts. Kept for backwards compat.
function parseBuyhatkeResponse(data, inputUrl, srcStore) {
  // New pre-parsed path
  if (data._bhkParsed) {
    const stores = data.stores
      .sort((a, b) => a.price - b.price)
      .map((s, i) => ({ ...s, isBest: i === 0, isSource: s.name === srcStore }));
    return { stores, productName: data.productName, productImage: data.productImage };
  }

  // Legacy path — raw API response (kept in case /buyhatke/debug is called
  // with data from an older version or a manual test)
  const d = data.data || data.result || data;
  const productName  = d.name  || d.productName  || '';
  const productImage = d.image || d.productImage || '';
  const rawItems     = extractStoreItems(d) || [];
  const storeMap     = {};
  rawItems.forEach(item => {
    const parsed = parseStoreItem(item);
    if (!parsed) return;
    if (!storeMap[parsed.name] || parsed.price < storeMap[parsed.name].price) {
      storeMap[parsed.name] = parsed;
    }
  });
  const stores = Object.values(storeMap)
    .sort((a, b) => a.price - b.price)
    .map((s, i) => ({ ...s, isBest: i === 0, isSource: s.name === srcStore }));
  return { stores, productName, productImage };
}

// ── SerpAPI comparison (fallback when Buyhatke returns < 2 stores) ──
async function searchViaSerpAPI(url, srcStore) {
  if (!SERP_API_KEY) throw new Error('SERP_API_KEY not configured');

  const title = await fetchTitle(url);
  let shortQ = '';
  if (title && title.length > 5) {
    const core = title
      .replace(/|.*/g,'').replace(/[([].*?[)]]/g,'')
      .replace(/(with|for|up to|upto|comes|get|buy|online|india|featuring).*/i,'')
      .replace(/,.*$/,'').replace(/[^a-zA-Z0-9 ]/g,' ').replace(/s+/g,' ').trim();
    shortQ = core.split(' ').filter(w=>w.length>0).slice(0,5).join(' ');
  }
  if (!shortQ) {
    try {
      const segs = new URL(url).pathname.split('/')
        .filter(s=>s.length>3&&!/^[A-Z0-9]{6,}$/.test(s)&&!/^(dp|p|product|item|buy|s|ip|d)$/i.test(s));
      shortQ = (segs[0]||'').replace(/-/g,' ').trim().split(' ').slice(0,5).join(' ');
    } catch(e) {}
  }
  if (!shortQ || shortQ.length < 3) throw new Error('Could not identify product from URL');

  const fullTitle = title || shortQ;
  let asin = null;
  try {
    const m = new URL(url).pathname.match(/\/dp\/([A-Z0-9]{10})/i) ||
              new URL(url).pathname.match(/\/([A-Z0-9]{10})(?:\/|$)/i);
    if (m) asin = m[1];
  } catch(e) {}

  const brandModel = shortQ.split(' ').slice(0,3).join(' ');
  const q1 = asin ? (asin + ' ' + brandModel) : shortQ;
  const q2 = shortQ;
  const q3 = brandModel;
  console.log('[SerpAPI] Queries:', q1, '|', q2, '|', q3);

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
  console.log('[SerpAPI] Total results:', allResults.length);

  const qWords = shortQ.toLowerCase().split(' ').filter(w=>w.length>2);
  function sim(t) {
    if (!t) return 0;
    const tl = t.toLowerCase();
    if (asin && tl.includes(asin.toLowerCase())) return 1.0;
    return qWords.filter(w=>tl.includes(w)).length / qWords.length;
  }

  const TARGET = ['Amazon','Flipkart','Myntra','Ajio','Nykaa','TataCliq','Croma','Snapdeal'];
  const storeMap = {};
  allResults.forEach(item => {
    const store = normalizeStore(item.source||'');
    if (!TARGET.includes(store)) return;
    const price = item.extracted_price || 0;
    if (!price) return;
    const s = sim(item.title);
    console.log('[SerpAPI]', store, '₹'+price, 'sim:'+Math.round(s*100)+'%', (item.title||'').substring(0,50));
    if (s < 0.4) { console.log('  → SKIP'); return; }
    const link = (item.product_link && !item.product_link.includes('google.com'))
      ? item.product_link : storeSearchUrl(store, fullTitle);
    if (!storeMap[store] || price < storeMap[store].price) {
      storeMap[store] = { name:store, normalizedName:store, price, url:link };
    }
  });

  const stores = Object.values(storeMap)
    .sort((a,b)=>a.price-b.price)
    .map((s,i)=>({ ...s, isBest:i===0, isSource:s.name===srcStore }));

  console.log('[SerpAPI] FINAL:', stores.map(s=>s.name+':₹'+s.price).join(' | '));
  return { stores, productName: fullTitle, productImage };
}

// ── Routes ──
app.get('/', (req, res) => res.send('Smart Pick Deals ✅'));
app.get('/ping', (req, res) => res.json({ status:'ok', time:new Date().toISOString() }));

// Battery status endpoint — reads from Linux battery sys files
app.get('/battery', async (req, res) => {
  try {
    const fs = require('fs');
    const path = '/sys/class/power_supply';
    if (!fs.existsSync(path)) {
      return res.json({ available: false, reason: 'No power supply info' });
    }
    const supplies = fs.readdirSync(path);
    const bat = supplies.find(s => s.startsWith('BAT'));
    if (!bat) {
      return res.json({ available: false, reason: 'No battery found (desktop or server)' });
    }
    const batPath = `${path}/${bat}`;
    const readFile = f => { try { return fs.readFileSync(`${batPath}/${f}`, 'utf8').trim(); } catch(e) { return null; } };
    const capacity = parseInt(readFile('capacity') || '0');
    const status   = readFile('status') || 'Unknown'; // Charging / Discharging / Full
    return res.json({ available: true, battery: capacity, status, battery_name: bat });
  } catch(e) {
    return res.json({ available: false, reason: e.message });
  }
});

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

    // Step 2: Extract threadId and messageId from stream — this is the real key
    // Flash stores results by threadId, not referenceId
    let threadId = null;
    let messageId = null;
    for (const line of streamText.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const d = JSON.parse(line.slice(5).trim());
        if (d.threadId) threadId = d.threadId;
        if (d.messageId) messageId = d.messageId;
      } catch(e) {}
    }
    console.log('[Flash Test] threadId:', threadId, 'messageId:', messageId);

    const delay = ms => new Promise(r => setTimeout(r, ms));
    let pollData = null;
    let pollScope = null;
    let pollAttempts = 0;

    // Try threadId-based endpoints first (most likely to work)
    const threadEndpoints = threadId ? [
      `https://apiv3.flash.tech/api/v1/agents/chat/thread/${threadId}/messages`,
      `https://apiv3.flash.tech/api/v2/agents/chat/thread/${threadId}/messages`,
      `https://apiv3.flash.tech/api/v1/chat/thread/${threadId}/messages`,
      `https://apiv3.flash.tech/api/v1/threads/${threadId}/messages`,
      `https://apiv3.flash.tech/api/v1/threads/${threadId}`,
    ] : [];

    // Also try messageId endpoints
    const messageEndpoints = messageId ? [
      `https://apiv3.flash.tech/api/v1/agents/chat/message/${messageId}`,
      `https://apiv3.flash.tech/api/v1/messages/${messageId}/products`,
      `https://apiv3.flash.tech/api/v1/messages/${messageId}/price-compare`,
    ] : [];

    // Feedback endpoints with referenceId
    const feedbackEndpoints = [
      `https://apiv3.flash.tech/api/v1/customer/feedback/fetch?scope=PRICE_COMPARE&referenceId=${pageHash}`,
      `https://apiv3.flash.tech/api/v1/customer/feedback/fetch?scope=PRODUCT_DETAILS&referenceId=${pageHash}`,
      `https://apiv3.flash.tech/api/v1/customer/feedback/fetch?scope=PRODUCT_SEARCH&referenceId=${pageHash}`,
    ];

    const allEndpoints = [...threadEndpoints, ...messageEndpoints, ...feedbackEndpoints];
    const probeResults = [];

    // Probe all endpoints immediately
    for (const ep of allEndpoints) {
      try {
        const r = await fetch(ep, { headers: priceHeaders, signal: AbortSignal.timeout(5000) });
        const txt = await r.text();
        probeResults.push({ ep: ep.replace('https://apiv3.flash.tech',''), status: r.status, body: txt.substring(0, 200) });
        if (r.ok && r.status === 200) {
          try {
            const d = JSON.parse(txt);
            const str = JSON.stringify(d);
            // Check for product data in various shapes
            const hasProducts = d?.messages?.length > 0 || d?.data?.length > 0 ||
              (d?.response?.feedbacks?.length > 0) || d?.products?.length > 0 ||
              str.includes('"price"') || str.includes('"storeName"') || str.includes('"stores"');
            if (hasProducts) {
              pollData = d; pollScope = ep; pollAttempts = 1;
              console.log('[Flash Test] ✅ Found data at:', ep);
              break;
            }
          } catch(e) {}
        }
      } catch(e) {
        probeResults.push({ ep: ep.replace('https://apiv3.flash.tech',''), error: e.message });
      }
    }

    // If nothing found yet, poll feedback endpoints with delay
    if (!pollData) {
      for (let attempt = 0; attempt < 8; attempt++) {
        await delay(3000);
        pollAttempts = attempt + 2;
        for (const ep of feedbackEndpoints) {
          try {
            const r = await fetch(ep, { headers: priceHeaders, signal: AbortSignal.timeout(6000) });
            if (!r.ok) continue;
            const d = await r.json();
            const feedbacks = d?.response?.feedbacks || d?.feedbacks || [];
            if (feedbacks.length > 0) {
              pollData = d; pollScope = ep;
              console.log('[Flash Test] ✅ Got feedbacks at attempt:', attempt + 1);
              break;
            }
          } catch(e) {}
        }
        if (pollData) break;
      }
    }

    const pr = { ok: !!pollData, status: pollData ? 200 : 504 };
    const priceData = pollData;
    const priceStatus = pr.status;
    return res.json({
      success: pr.ok,
      searchHash: pageHash,
      pollAttempts,
      pollScope: pollScope || null,
      streamStatus,
      priceStatus: pr.status,
      feedbackCount: (pollData?.response?.feedbacks || pollData?.feedbacks || []).length,
      priceKeys: pollData ? Object.keys(pollData) : [],
      priceSample: JSON.stringify(pollData).substring(0, 1500),
      probeResults: probeResults || [],
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
        const feedbacks = data?.response?.feedbacks || data?.feedbacks || [];
        if (feedbacks.length > 0) {
          console.log('[Flash Proxy] ✅ Got', feedbacks.length, 'feedbacks immediately');
          return res.json({ ok: true, data });
        }
        // Empty — will poll below
      }
    } catch(e) {}
  }

  // Poll with delay — flash processes async
  for (let attempt = 0; attempt < 12; attempt++) {
    await new Promise(r => setTimeout(r, 2500));
    for (const ep of endpoints) {
      try {
        const r2 = await fetch(ep, { headers, signal: AbortSignal.timeout(8000) });
        if (!r2.ok) continue;
        const data = await r2.json();
        const feedbacks = data?.response?.feedbacks || data?.feedbacks || [];
        if (feedbacks.length > 0) {
          console.log('[Flash Proxy] ✅ Got', feedbacks.length, 'feedbacks at poll attempt:', attempt + 1);
          return res.json({ ok: true, data, attempt: attempt + 1 });
        }
      } catch(e) {}
    }
    console.log('[Flash Proxy] Poll attempt', attempt + 1, '— still empty');
  }
  return res.status(504).json({ error: 'Flash timed out after 30s', pageHash: req.params.pageHash });
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

// Backfill store names for existing clicks missing store field
app.post('/admin/backfill-stores', async (req, res) => {
  if (!dbConnected) return res.json({ ok: false, reason: 'DB not connected' });
  const force = req.query.force === 'true';
  try {
    const clicks = await Event.find({ type: 'click' }).lean();
    let updated = 0;
    const details = [];
    for (const c of clicks) {
      const store = detectStoreFromUrl(c.dest || '');
      // Update if: force mode, OR store is empty/blank, OR store improved
      if (store && (force || !c.store || c.store !== store)) {
        await Event.updateOne({ _id: c._id }, { $set: { store } });
        if (store !== c.store) {
          details.push({ dest: (c.dest||'').substring(0,50), old: c.store||'', new: store });
          updated++;
        }
      }
    }
    res.json({ ok: true, total: clicks.length, updated, details: details.slice(0,20), message: updated + ' records updated' });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Sync endpoint: merge another server's in-memory analytics into MongoDB ──
// Called by laptop startup script to pull Render's data after being offline
app.post('/admin/sync-from', async (req, res) => {
  if (!dbConnected) return res.json({ ok: false, reason: 'DB not connected' });
  const { sourceUrl } = req.body;
  if (!sourceUrl) return res.status(400).json({ ok: false, reason: 'Pass sourceUrl in body' });

  try {
    // Fetch stats from the other server (all-time)
    const r = await fetch(sourceUrl + '/dashboard/stats?from=2024-01-01T00:00:00.000Z&to=' + new Date().toISOString(),
      { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('Source returned ' + r.status);
    const d = await r.json();

    // If source uses DB too, skip sync (same data)
    if (d.dbConnected) return res.json({ ok: true, skipped: true, reason: 'Source already uses MongoDB' });

    // Merge in-memory counters into MongoDB
    const inc = {
      pageVisits:  d.pageVisits  || 0,
      conversions: d.conversions || 0,
      clicks:      d.clicks      || 0,
      compares:    d.compares    || 0,
    };
    await Counter.updateOne({ _id: 'main' }, { $inc: inc });
    console.log('[Sync] Merged from', sourceUrl, ':', inc);

    // Save recent events to MongoDB
    const events = [
      ...(d.recentVisits       || []).map(e => ({ type:'visit',      url:e.url,   ts:new Date(e.ts) })),
      ...(d.recentConversions  || []).map(e => ({ type:'conversion', url:e.url,   store:e.store, state:e.state, ts:new Date(e.ts) })),
      ...(d.recentClicks       || []).map(e => ({ type:'click',      dest:e.dest, store:e.store || detectStoreFromUrl(e.dest||''), ts:new Date(e.ts) })),
    ].filter(e => e.ts && !isNaN(e.ts));

    if (events.length > 0) {
      await Event.insertMany(events, { ordered: false }).catch(() => {});
    }

    res.json({ ok: true, merged: inc, events: events.length });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Track page visits
app.post('/track/visit', async (req, res) => {
  const page = req.body?.page || req.headers?.referer || '/';
  await trackVisit(page).catch(() => {});
  res.json({ ok: true });
});

// Track compare searches
app.post('/track/compare', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const url   = req.body?.url   || '';
  const store = req.body?.store || detectStoreFromUrl(url) || '';
  await trackCompareEvent(url, store).catch(() => {});
  res.json({ ok: true });
});
app.options('/track/compare', (req, res) => { res.set('Access-Control-Allow-Origin','*').set('Access-Control-Allow-Methods','POST,OPTIONS').set('Access-Control-Allow-Headers','Content-Type').sendStatus(204); });

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
  const dest  = (req.body?.dest || req.body?.url || req.query?.dest || 'unknown').substring(0, 300);
  const store = req.body?.store || req.query?.store || detectStoreFromUrl(dest) || '';
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

// ── Real-time dashboard via Server-Sent Events (SSE) ──
// Browser connects once → server pushes updates instantly when data changes
app.get('/dashboard/live', (req, res) => {
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.flushHeaders();

  // Send initial ping
  res.write("data: {\"type\":\"connected\"}\n\n");

  sseClients.add(res);
  console.log('[SSE] Client connected. Total:', sseClients.size);

  // Send full stats every 5s (for date-range accuracy)
  const interval = setInterval(async () => {
    try {
      const now = new Date();
      const IST_OFFSET = 5.5 * 60 * 60 * 1000;
      const nowUTC = Date.now();
      const midnightIST = new Date(nowUTC + IST_OFFSET);
      midnightIST.setUTCHours(0,0,0,0);
      const from = new Date(midnightIST.getTime() - IST_OFFSET);

      if (dbConnected) {
        const dateFilter = { ts: { $gte: from, $lte: now } };
        const [v,c,k,q] = await Promise.all([
          Event.countDocuments({ type: 'visit',      ...dateFilter }),
          Event.countDocuments({ type: 'conversion', state:'done', ...dateFilter }),
          Event.countDocuments({ type: 'click',      ...dateFilter }),
          Event.countDocuments({ type: 'compare',    ...dateFilter }),
        ]);
        const payload = JSON.stringify({ type:'stats', pageVisits:v, conversions:c, clicks:k, compares:q, ts:Date.now() });
        res.write(`data: ${payload}

`);
      }
    } catch(e) {}
  }, 5000);

  req.on('close', () => {
    sseClients.delete(res);
    clearInterval(interval);
    console.log('[SSE] Client disconnected. Total:', sseClients.size);
  });
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
        recentClicks:      recentClicks.map(e => ({ dest: e.dest, store: e.store || detectStoreFromUrl(e.dest||'') || '', ts: e.ts?.getTime() })),
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
    recentClicks:      memAnalytics.recentClicks.map(c => ({
      dest: c.dest, ts: c.ts,
      store: c.store || detectStoreFromUrl(c.dest||'') || ''
    })),
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

// ── Price comparison — Buyhatke (primary) + SerpAPI (fallback when <2 stores) ──
app.get('/compare/search', async (req, res) => {
  const { url: rawUrl } = req.query;
  if (!rawUrl) return res.status(400).json({ error: 'Pass ?url=' });

  try {
    // Resolve short URLs before any further processing
    let url = rawUrl;
    if (isShortUrl(rawUrl)) {
      try {
        url = await resolveRedirect(rawUrl);
        console.log('[Compare] Resolved', rawUrl.substring(0,50), '→', url.substring(0,70));
      } catch(e) {
        console.log('[Compare] Short URL resolution failed:', e.message);
        // Keep original — fetchBuyhatke will also attempt resolution
      }
    }
    console.log('[Compare] URL:', url);

    // ── Source store detection ──
    const srcHost = (() => { try { return new URL(url).hostname.replace('www.',''); } catch(e) { return ''; } })();
    const srcStore = (() => {
      if (srcHost.includes('amazon') || srcHost.includes('amzn')) return 'Amazon';
      if (srcHost.includes('flipkart'))        return 'Flipkart';
      if (srcHost.includes('myntra'))          return 'Myntra';
      if (srcHost.includes('ajio'))            return 'Ajio';
      if (srcHost.includes('nykaa'))           return 'Nykaa';
      if (srcHost.includes('tatacliq'))        return 'TataCliq';
      if (srcHost.includes('croma'))           return 'Croma';
      if (srcHost.includes('snapdeal'))        return 'Snapdeal';
      if (srcHost.includes('meesho'))          return 'Meesho';
      if (srcHost.includes('jiomart'))         return 'JioMart';
      if (srcHost.includes('reliancedigital')) return 'Reliance Digital';
      if (srcHost.includes('vijaysales'))      return 'Vijay Sales';
      return '';
    })();

    let stores       = [];
    let productName  = '';
    let productImage = '';
    let dataSource   = 'buyhatke';
    const errors     = [];

    // ── Strategy 1: Buyhatke (primary) ──
    try {
      const bhRaw    = await fetchBuyhatke(url);
      const bhParsed = parseBuyhatkeResponse(bhRaw, url, srcStore);
      stores       = bhParsed.stores;
      productName  = bhParsed.productName;
      productImage = bhParsed.productImage;
      console.log('[Compare] Buyhatke returned', stores.length, 'stores');
    } catch(e) {
      errors.push('Buyhatke: ' + e.message);
      console.log('[Compare] Buyhatke failed:', e.message);
    }

    // ── Strategy 2: SerpAPI fallback (when Buyhatke returns <2 stores) ──
    // Buyhatke's cross-store data is inconsistent — many products only return
    // the source store. SerpAPI reliably returns 4–8 stores for any product.
    if (stores.length < 2 && SERP_API_KEY) {
      console.log('[Compare] Buyhatke insufficient (' + stores.length + ' stores) — falling back to SerpAPI');
      try {
        const serp    = await searchViaSerpAPI(url, srcStore);
        stores        = serp.stores;
        if (!productName)  productName  = serp.productName;
        if (!productImage) productImage = serp.productImage;
        dataSource    = 'serpapi';
        console.log('[Compare] SerpAPI returned', stores.length, 'stores');
      } catch(e) {
        errors.push('SerpAPI: ' + e.message);
        console.log('[Compare] SerpAPI also failed:', e.message);
      }
    }

    if (stores.length === 0) {
      return res.status(404).json({
        error: 'No price comparison results found. ' + errors.join(' | '),
        tried: errors,
      });
    }

    const srcEntry = stores.find(s => s.isSource);
    const savings  = srcEntry && !srcEntry.isBest ? srcEntry.price - stores[0].price : 0;

    console.log('[Compare] FINAL via', dataSource + ':',
      stores.map(s => s.name + ':₹' + s.price + (s.isSource?'[src]':'') + (s.isBest?'[best]':'')).join(' | '));

    return res.json({
      stores,
      productName:  productName || url,
      productImage,
      totalStores:  stores.length,
      savings:      savings > 0 ? savings : 0,
      dataSource,
    });

  } catch(e) {
    console.error('[Compare] Unhandled error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});
// Buyhatke debug — shows full two-step diagnostic for any product URL
// Usage: https://api.smartpickdeals.live/buyhatke/debug?url=https://www.amazon.in/dp/B0FVS8V372
app.get('/buyhatke/debug', async (req, res) => {
  const { url: rawUrl } = req.query;
  if (!rawUrl) return res.json({
    usage:   'Add ?url=YOUR_PRODUCT_URL',
    example: '/buyhatke/debug?url=https://www.amazon.in/dp/B0FVS8V372',
    supportedStores: 'Amazon, Flipkart, Myntra, Ajio, Nykaa',
  });

  // Resolve short URLs first
  let url = rawUrl;
  if (isShortUrl(rawUrl)) {
    try {
      url = await resolveRedirect(rawUrl);
      console.log('[BHK debug] Resolved:', rawUrl, '→', url);
    } catch(e) {
      return res.json({ error: 'Could not resolve short URL: ' + e.message, url: rawUrl });
    }
  }

  // Step 1: param extraction
  const params = extractBhkParams(url);
  if (!params) return res.json({
    error: 'URL not from a supported store (Amazon/Flipkart/Myntra/Ajio/Nykaa)',
    originalUrl: rawUrl,
    resolvedUrl: url,
  });
  const { pos, pid } = params;

  // Step 2: productData call
  let srcProduct = null;
  try {
    srcProduct = await bhkGetProductData(pos, pid);
  } catch(e) {
    return res.json({
      step:            'productData',
      error:           e.message,
      pos, pid,
      rawResponse:     e.rawResponse || null,
      diagnosis:       'Product not in Buyhatke index — compare will fall back to SerpAPI for this URL',
    });
  }

  // Step 3: multi-store call — collect raw responses for diagnosis
  const { items, endpoint: multiEndpoint, rawResponses } =
    await bhkGetMultiStorePrices(srcProduct.internalPid, pid, pos);

  // Step 4: parse what we have (source store always present from step 1)
  const srcStoreName = normalizeStore(srcProduct.site_name || '');
  const storeMap = {};
  // Use input URL as source link — Buyhatke's link field is sometimes wrong
  const bestDebugLink = (!isShortUrl(url) && url.startsWith('http')) ? url : srcProduct.link;
  if (srcStoreName && srcProduct.cur_price > 0) {
    storeMap[srcStoreName] = { name: srcStoreName, normalizedName: srcStoreName,
                               price: srcProduct.cur_price, url: bestDebugLink,
                               isBest: true, isSource: true };
  }
  items.forEach(item => {
    const p = parseStoreItem(item);
    if (!p) return;
    if (!storeMap[p.name] || p.price < storeMap[p.name].price) {
      storeMap[p.name] = { ...p, isBest: false, isSource: p.name === srcStoreName };
    }
  });
  const parsedStores = Object.values(storeMap).sort((a,b) => a.price - b.price)
    .map((s,i) => ({ ...s, isBest: i === 0 }));

  return res.json({
    step1_params:     { pos, pid },
    step1_productData: {
      name:        srcProduct.name,
      site_name:   srcProduct.site_name,
      cur_price:   srcProduct.cur_price,
      internalPid: srcProduct.internalPid,
      inStock:     srcProduct.inStock,
      link:        srcProduct.link,
    },
    step2_workingEndpoint: multiEndpoint || null,
    step2_rawItemCount:    items.length,
    step2_sampleItems:     items.slice(0, 2),
    // Raw response from EACH candidate — key for diagnosing step 2 failures:
    step2_allAttempts:     rawResponses,
    parsedStores,
    parsedCount:           parsedStores.length,
    productName:           srcProduct.name,
    productImage:          srcProduct.image,
    status: items.length > 0 ? '✅ Full multi-store data' :
            parsedStores.length > 0 ? '⚠️ Source store only — step 2 failed, check step2_allAttempts' :
            '❌ No data',
  });
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
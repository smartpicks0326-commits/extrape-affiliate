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

// ── Price Comparison via SerpAPI Google Shopping ──
// Free: 100 searches/month at serpapi.com — no IP restrictions
const SERP_API_KEY = process.env.SERP_API_KEY || '';

// Fetch real product title from the product page — follows redirects automatically
async function fetchProductTitle(productUrl) {
  try {
    const r = await fetch(productUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-IN,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    const html = await r.text();
    console.log('[Title] Fetched', r.url, 'status:', r.status, 'length:', html.length);

    // Try Open Graph title first (most accurate)
    let m = html.match(/<meta[^>]+property=.og:title.[^>]+content=.([^"'<]+)/i);
    if (m && m[1].trim().length > 5) return m[1].trim();

    // Standard title tag
    m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (m) {
      return m[1].trim()
        .replace(/\s*[|\-–]\s*(Amazon|Flipkart|Myntra|Ajio|Nykaa|Croma|TataCliq|Online Shopping|Buy|India).*/i, '')
        .trim();
    }
    return null;
  } catch(e) {
    console.log('[SerpAPI] Title fetch error:', e.message);
    return null;
  }
}

app.get('/compare/search', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Pass ?url=' });
  if (!SERP_API_KEY) return res.status(503).json({ error: 'SERP_API_KEY not configured', needsKey: true });

  try {
    console.log('[Compare] Searching:', url);

    // Step 1: Get real product title
    const title = await fetchProductTitle(url);
    let shortQuery = '';
    if (title && title.length > 5) {
      const core = title
        .replace(/\|.*/g, '').replace(/[\(\[].*?[\)\]]/g, '')
        .replace(/\b(with|for|up to|upto|comes|get|buy|online|india|featuring)\b.*/i, '')
        .replace(/,.*/, '').replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      shortQuery = core.split(' ').filter(w => w.length > 0).slice(0, 5).join(' ');
    } else {
      try {
        const segs = new URL(url).pathname.split('/')
          .filter(s => s.length > 3 && !/^[A-Z0-9]{6,}$/.test(s) && !/^(dp|p|product|item|buy|s|ip|d)$/i.test(s));
        shortQuery = (segs[0]||'').replace(/-/g,' ').trim().split(' ').slice(0,5).join(' ');
      } catch(e) {}
    }
    if (!shortQuery || shortQuery.length < 3) return res.status(400).json({ error: 'Could not determine product name' });

    const fullTitle = title || shortQuery;
    console.log('[Compare] Short query:', shortQuery);

    // Only ExtraPe-supported stores + Meesho
    // ExtraPe affiliate links work for all these stores
    const TARGET_STORES = [
      { name: 'Amazon',    site: 'amazon.in',          extrape: true  },
      { name: 'Flipkart',  site: 'flipkart.com',        extrape: true  },
      { name: 'Myntra',    site: 'myntra.com',          extrape: true  },
      { name: 'Ajio',      site: 'ajio.com',            extrape: true  },
      { name: 'Nykaa',     site: 'nykaa.com',           extrape: true  },
      { name: 'TataCliq',  site: 'tatacliq.com',        extrape: true  },
      { name: 'Croma',     site: 'croma.com',           extrape: true  },
      { name: 'Snapdeal',  site: 'snapdeal.com',        extrape: true  },
      { name: 'Netmeds',   site: 'netmeds.com',         extrape: true  },
      { name: 'Lenskart',  site: 'lenskart.com',        extrape: true  },
      { name: 'Meesho',    site: 'meesho.com',          extrape: false }, // no affiliate but include prices
    ];

    // Detect source store to skip re-searching it (we already have affiliate link)
    const srcHost = (() => { try { return new URL(url).hostname.replace('www.',''); } catch(e) { return ''; } })();
    const srcStoreName = normalizeStoreName(srcHost.split('.')[0]) || '';

    // Search each store in parallel using Google site: search
    const storePromises = TARGET_STORES.map(async store => {
      try {
        const q = shortQuery + ' site:' + store.site;
        const serpUrl = 'https://serpapi.com/search.json'
          + '?engine=google'
          + '&q=' + encodeURIComponent(q)
          + '&gl=in&hl=en&num=3'
          + '&api_key=' + SERP_API_KEY;

        const r = await fetch(serpUrl, { signal: AbortSignal.timeout(12000) });
        if (!r.ok) return null;
        const data = await r.json();
        const organic = data.organic_results || [];
        if (organic.length === 0) return null;

        const top = organic[0];
        const productPageUrl = top.link || '';
        if (!productPageUrl || !productPageUrl.includes(store.site)) return null;

        // Extract price from snippet — Google often shows price in snippet
        const snippet = (top.snippet || top.rich_snippet?.top?.detected_extensions?.price || '');
        const priceMatch = snippet.match(/[₹Rs\.\s]([0-9][0-9,]+)/);
        let price = priceMatch ? parseInt(priceMatch[1].replace(/,/g,'')) : 0;

        // If no price in snippet, try the rich snippet extensions
        if (!price && top.rich_snippet?.top?.detected_extensions?.price) {
          price = parseInt(top.rich_snippet.top.detected_extensions.price.toString().replace(/[^0-9]/g,'')) || 0;
        }

        console.log('[Compare]', store.name, price ? '₹'+price : 'no price', productPageUrl.substring(0,70));
        return { name: store.name, normalizedName: store.name, price, url: productPageUrl, extrape: store.extrape, image: '', title: top.title || fullTitle };
      } catch(e) {
        console.log('[Compare]', store.name, 'error:', e.message);
        return null;
      }
    });

    // Also run Google Shopping for prices + product image (single API call)
    const shoppingPromise = (async () => {
      try {
        const serpUrl = 'https://serpapi.com/search.json'
          + '?engine=google_shopping'
          + '&q=' + encodeURIComponent(shortQuery)
          + '&gl=in&hl=en&currency=INR&num=20'
          + '&api_key=' + SERP_API_KEY;
        const r = await fetch(serpUrl, { signal: AbortSignal.timeout(12000) });
        if (!r.ok) return null;
        return await r.json();
      } catch(e) { return null; }
    })();

    const [storeResults, shoppingData] = await Promise.all([Promise.all(storePromises), shoppingPromise]);

    // Build shopping price map — use as ground-truth prices
    // Google Shopping prices are accurate (taken from structured data on store pages)
    const shoppingPrices = {};
    const shoppingImage = shoppingData?.shopping_results?.[0]?.thumbnail || '';
    (shoppingData?.shopping_results || []).forEach(item => {
      const n = normalizeStoreName(item.source || '');
      if (n && item.extracted_price > 0) {
        // Keep lowest price found per store (some stores have multiple listings)
        if (!shoppingPrices[n] || item.extracted_price < shoppingPrices[n]) {
          shoppingPrices[n] = item.extracted_price;
        }
      }
    });
    console.log('[Compare] Shopping prices:', JSON.stringify(shoppingPrices));

    // Merge results — shopping price is more reliable than snippet price
    let stores = storeResults
      .filter(s => s !== null)
      .map(s => {
        // Shopping price overrides snippet price — it's scraped directly from store
        const verifiedPrice = shoppingPrices[s.name] || s.price;
        return { ...s, price: verifiedPrice };
      })
      .filter(s => s.price > 0);

    // If a store had no direct URL but we have shopping price, add with search URL
    TARGET_STORES.forEach(store => {
      const already = stores.find(s => s.name === store.name);
      if (!already && shoppingPrices[store.name]) {
        stores.push({
          name: store.name, normalizedName: store.name,
          price: shoppingPrices[store.name],
          url: buildStoreUrl(store.name, fullTitle),
          extrape: store.extrape, image: shoppingImage,
          title: fullTitle, isFallback: true
        });
      }
    });

    stores.sort((a, b) => a.price - b.price);
    if (stores.length > 0) stores[0].isBest = true;

    console.log('[Compare] Final:', stores.map(s => s.name + ':₹' + s.price + (s.isFallback?'(search)':'(direct)')).join(' | '));

    return res.json({
      stores,
      productName: fullTitle,
      productImage: shoppingImage,
      totalStores: stores.length,
      searchQuery: shortQuery,
      sourceUrl: url,
    });

  } catch(e) {
    console.error('[Compare] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// Normalize store names to match our known stores
function buildStoreUrl(storeName, productQuery) {
  const q = encodeURIComponent(productQuery);
  const s = storeName.toLowerCase();
  if (s.includes('amazon'))         return 'https://www.amazon.in/s?k=' + q;
  if (s.includes('flipkart'))       return 'https://www.flipkart.com/search?q=' + q;
  if (s.includes('myntra'))         return 'https://www.myntra.com/' + q;
  if (s.includes('ajio'))           return 'https://www.ajio.com/search/?text=' + q;
  if (s.includes('nykaa'))          return 'https://www.nykaa.com/search/result/?q=' + q;
  if (s.includes('tatacliq'))       return 'https://www.tatacliq.com/search/?text=' + q;
  if (s.includes('croma'))          return 'https://www.croma.com/searchB?q=' + q;
  if (s.includes('snapdeal'))       return 'https://www.snapdeal.com/search?keyword=' + q;
  if (s.includes('meesho'))         return 'https://www.meesho.com/search?q=' + q;
  if (s.includes('jiomart'))        return 'https://www.jiomart.com/catalogsearch/result/?q=' + q;
  if (s.includes('reliance'))       return 'https://www.reliancedigital.in/search?q=' + q;
  if (s.includes('vijay'))          return 'https://www.vijaysales.com/search/' + q;
  if (s.includes('shopsy'))         return 'https://shopsy.in/search?q=' + q;
  if (s.includes('blinkit'))        return 'https://blinkit.com/s/?q=' + q;
  if (s.includes('swiggy'))         return 'https://www.swiggy.com/search?query=' + q;
  if (s.includes('bigbasket'))      return 'https://www.bigbasket.com/ps/?q=' + q;
  if (s.includes('netmeds'))        return 'https://www.netmeds.com/catalogsearch/result/' + q;
  if (s.includes('lenskart'))       return 'https://www.lenskart.com/search/?q=' + q;
  if (s.includes('poorvika'))       return 'https://www.poorvika.com/search?search=' + q;
  if (s.includes('93mobiles'))      return 'https://www.93mobiles.com/search?q=' + q;
  return 'https://www.google.com/search?tbm=shop&q=' + q + '+site:' + encodeURIComponent(storeName.toLowerCase().replace(/\s/g,'') + '.com');
}

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

// ── Debug: see raw SerpAPI response ──
app.get('/serp/debug', async (req, res) => {
  const { url, q } = req.query;
  if (!SERP_API_KEY) return res.json({ error: 'SERP_API_KEY not set' });

  let searchQuery = q || '';
  if (url && !q) {
    const title = await fetchProductTitle(url).catch(() => null);
    if (title && title.length > 5) {
      const core = title
        .replace(/\|.*/g, '').replace(/[\(\[].*?[\)\]]/g, '')
        .replace(/\b(with|for|up to|upto|comes|get|buy|online|india|featuring)\b.*/i, '')
        .replace(/,.*/, '').replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      searchQuery = core.split(' ').filter(w => w.length > 0).slice(0, 5).join(' ');
    } else {
      try {
        const segs = new URL(url).pathname.split('/').filter(s => s.length > 3 && !/^[A-Z0-9]{6,}$/.test(s));
        searchQuery = (segs[0]||'').replace(/-/g,' ').trim().split(' ').slice(0,5).join(' ');
      } catch(e) {}
    }
  }

  const serpUrl = 'https://serpapi.com/search.json'
    + '?engine=google_shopping'
    + '&q=' + encodeURIComponent(searchQuery)
    + '&gl=in&hl=en&currency=INR&num=40'
    + '&api_key=' + SERP_API_KEY;
  console.log('[Debug] Query sent to SerpAPI:', searchQuery);

  try {
    const r = await fetch(serpUrl);
    const data = await r.json();
    const shopResults = data.shopping_results || [];
    const results = shopResults.slice(0, 10).map(item => ({
      source: item.source,
      price: item.price,
      extracted_price: item.extracted_price,
      product_id: item.product_id || null,
      title: (item.title||'').substring(0,60),
      product_link: (item.product_link||'').substring(0,80),
    }));

    // If first result has product_id, also fetch sellers
    const topId = shopResults.find(r => r.product_id)?.product_id;
    let sellers = [];
    if (topId) {
      const pr2 = await fetch('https://serpapi.com/search.json?engine=google_product&product_id=' + topId + '&gl=in&hl=en&currency=INR&api_key=' + SERP_API_KEY);
      if (pr2.ok) {
        const pd = await pr2.json();
        sellers = (pd.sellers_results?.online_sellers || []).map(s => ({
          name: s.name, price: s.base_price || s.total_price, link: (s.link||'').substring(0,100)
        }));
      }
    }

    res.json({ searchQuery, totalResults: shopResults.length, topProductId: topId, sellers, results });
  } catch(e) {
    res.json({ error: e.message });
  }
});

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
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
  requests[id] = { id, url, store, state:'pending', position:0, affiliateLink:null, error:null, createdAt:Date.now() };
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
    estimatedSeconds:pos * AVG_SECONDS_PER_REQUEST, affiliateLink:r.affiliateLink, error:r.error };
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

    // Amazon: keep only dp path + tag param → produces clean amazon.in/dp/XXXXX?tag=yyy
    if (host.includes('amazon')) {
      const dpMatch = parsed.pathname.match(/\/dp\/([A-Z0-9]{10})/i);
      if (dpMatch) {
        const tag = parsed.searchParams.get('tag');
        const clean = 'https://www.amazon.in/dp/' + dpMatch[1] + (tag ? '?tag=' + tag : '');
        // Wrap in /s/ to hide tag
        const code = makeShortCode();
        shortLinks[code] = clean;
        return BACKEND_URL + '/s/' + code;
      }
    }

    // Flipkart: already short (fkrt.co) — return as-is
    if (host.includes('fkrt.co')) return url;

    // Other native short links — return as-is
    if (url.length < 55) return url;

    // Everything else — wrap in /s/ short code
    const code = makeShortCode();
    shortLinks[code] = url;
    return BACKEND_URL + '/s/' + code;

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

  const final = cleanAffiliateUrl(decoded, productUrl);
  console.log('Final link: ' + final);
  return final;
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
    req.affiliateLink = await convertUrl(req.url);
    req.state = 'done';
  } catch(err) {
    req.state = 'error'; req.error = err.message;
    console.error('Failed:', err.message);
  } finally {
    isProcessing = false; processQueue();
  }
}

// ── Flash.co proxy ──
const FLASH_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
  'Referer': 'https://flash.co/',
  'Origin': 'https://flash.co',
  'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
};

async function flashFetch(url) {
  const r = await fetch(url, { headers: FLASH_HEADERS });
  const text = await r.text();
  console.log('Flash [' + url.substring(0,80) + '] status:' + r.status + ' body:' + text.substring(0,200));
  if (!r.ok) throw new Error('Flash ' + r.status + ': ' + text.substring(0,100));
  return JSON.parse(text);
}

app.get('/flash/search', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'No URL' });
  const endpoints = [
    'https://flash.co/api/product-search?url=' + encodeURIComponent(url),
    'https://flash.co/api/search?url=' + encodeURIComponent(url),
    'https://flash.co/api/v1/product-search?url=' + encodeURIComponent(url),
    'https://flash.co/api/v2/product-search?url=' + encodeURIComponent(url),
  ];
  for (const ep of endpoints) {
    try { return res.json(await flashFetch(ep)); } catch(e) { console.log('Tried:', ep, e.message); }
  }
  res.status(500).json({ error: 'Flash search unavailable' });
});

app.get('/flash/compare/:id', async (req, res) => {
  const id = req.params.id;
  const endpoints = [
    'https://flash.co/api/product-compare/' + id,
    'https://flash.co/api/product/' + id + '/compare',
    'https://flash.co/api/product-details/' + id,
    'https://flash.co/api/v1/product-compare/' + id,
  ];
  for (const ep of endpoints) {
    try { return res.json(await flashFetch(ep)); } catch(e) { console.log('Tried:', ep, e.message); }
  }
  res.status(500).json({ error: 'Flash compare unavailable' });
});

app.get('/flash/debug', async (req, res) => {
  const url = req.query.url || 'https://dl.flipkart.com/s/7PRWD6NNNN';
  const results = {};
  const eps = [
    'https://flash.co/api/product-search?url=' + encodeURIComponent(url),
    'https://flash.co/api/search?url=' + encodeURIComponent(url),
    'https://flash.co/api/v1/product-search?url=' + encodeURIComponent(url),
  ];
  for (const ep of eps) {
    try {
      const r = await fetch(ep, { headers: FLASH_HEADERS });
      results[ep] = { status: r.status, body: (await r.text()).substring(0, 600) };
    } catch(e) { results[ep] = { error: e.message }; }
  }
  res.json(results);
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

app.get('/', (req, res) => res.send('Smart Pick Deals backend ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server on port ' + PORT));
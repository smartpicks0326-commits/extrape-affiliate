const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());
app.use(cors());

const EXTRAPE_ACCESS_TOKEN   = process.env.EXTRAPE_ACCESS_TOKEN;
const EXTRAPE_REMEMBER_TOKEN = process.env.EXTRAPE_REMEMBER_TOKEN;
const AVG_SECONDS_PER_REQUEST = 2;

const SUPPORTED_DOMAINS = [
  'amazon.in', 'amazon.com', 'amzn.in', 'amzn.to',
  'flipkart.com', 'dl.flipkart.com',
  'myntra.com', 'ajio.com',
  'nykaa.com', 'nykaafashion.com', 'nykaabeauty.com',
  'tatacliq.com', 'tatacliq.luxury',
  'croma.com', 'snapdeal.com', 'boat-lifestyle.com',
  'makemytrip.com', 'cleartrip.com',
  'netflix.com', 'sonyliv.com', 'hotstar.com',
  'netmeds.com', '1mg.com', 'pharmeasy.in',
  'mamaearth.in', 'wowskinscience.com',
  'meesho.com', 'jiomart.com',
  'bigbasket.com', 'firstcry.com',
  'lenskart.com', 'pepperfry.com',
];

function isSupported(url) {
  try {
    const hostname = new URL(url).hostname.replace('www.', '');
    return SUPPORTED_DOMAINS.some(d => hostname.includes(d));
  } catch { return false; }
}

// ── Short URL store ──
const shortLinks = {}; // code -> full affiliate URL

function generateShortCode() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createShortLink(fullUrl, baseUrl) {
  let code = generateShortCode();
  while (shortLinks[code]) code = generateShortCode(); // ensure unique
  shortLinks[code] = fullUrl;
  return baseUrl + '/s/' + code;
}

// ── Queue ──
const queue = [];
const requests = {};
let isProcessing = false;

function createRequest(url, store) {
  const id = uuidv4();
  requests[id] = {
    id, url, store,
    state: 'pending',
    position: 0,
    affiliateLink: null,
    error: null,
    createdAt: Date.now()
  };
  queue.push(id);
  updatePositions();
  return id;
}

function updatePositions() {
  queue.forEach((id, index) => {
    if (requests[id]) requests[id].position = index + 1;
  });
}

function getStatus(id) {
  const r = requests[id];
  if (!r) return null;
  const position = r.state === 'pending' ? r.position : 0;
  return {
    id: r.id,
    state: r.state,
    position,
    queueLength: queue.length,
    estimatedSeconds: position * AVG_SECONDS_PER_REQUEST,
    affiliateLink: r.affiliateLink,
    error: r.error,
  };
}

// Cleanup old requests after 10 mins
setInterval(() => {
  const tenMins = 10 * 60 * 1000;
  Object.keys(requests).forEach(id => {
    if (Date.now() - requests[id].createdAt > tenMins) delete requests[id];
  });
}, 60000);

// ── Core: Call ExtraPe API directly ──
async function convertUrl(productUrl) {
  console.log('Converting: ' + productUrl);

  const encodedUrl = encodeURIComponent(productUrl);

  const response = await fetch('https://www.extrape.com/handler/convertText', {
    method: 'POST',
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
      'Accesstoken': EXTRAPE_ACCESS_TOKEN,
      'Content-Type': 'application/json',
      'Origin': 'https://www.extrape.com',
      'Referer': 'https://www.extrape.com/link-converter',
      'Remembermetoken': EXTRAPE_REMEMBER_TOKEN,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({
      inputText: encodedUrl,
      bitlyConvert: false,
      advanceMode: false
    })
  });

  if (!response.ok) {
    const text = await response.text();
    console.error('API error:', response.status, text);
    throw new Error('ExtraPe API returned error: ' + response.status);
  }

  const data = await response.json();
  console.log('API response:', JSON.stringify(data));

  // Extract the affiliate link from response
  const affiliateLink =
    data.convertedText ||
    data.outputText ||
    data.result ||
    data.link ||
    data.url ||
    (typeof data === 'string' ? data : null);

  if (!affiliateLink) {
    throw new Error('No affiliate link in response: ' + JSON.stringify(data));
  }

  const decoded = decodeURIComponent(affiliateLink.trim());
  console.log('ExtraPe returned: ' + decoded);

  // If ExtraPe returned a native short link (fkrt.co etc.) — return as-is
  const nativeShortDomains = ['fkrt.co', 'clnk.in'];
  if (nativeShortDomains.some(d => decoded.includes(d)) || decoded.length < 50) {
    console.log('Native short link — returning directly: ' + decoded);
    return decoded;
  }

  // For Amazon and other long URLs with tags — shorten via TinyURL (free, no auth)
  try {
    const tinyRes = await fetch('https://tinyurl.com/api-create.php?url=' + encodeURIComponent(decoded));
    if (tinyRes.ok) {
      const tinyUrl = await tinyRes.text();
      if (tinyUrl.startsWith('https://tinyurl.com')) {
        console.log('TinyURL created: ' + tinyUrl);
        return tinyUrl.trim();
      }
    }
  } catch(e) {
    console.log('TinyURL failed, using /s/ fallback:', e.message);
  }

  // Final fallback: our own /s/ short code
  const baseUrl = process.env.BACKEND_URL || '';
  if (baseUrl) {
    const code = generateShortCode() + generateShortCode();
    shortLinks[code] = decoded;
    const short = baseUrl + '/s/' + code;
    console.log('Fallback short link: ' + short);
    return short;
  }
  return decoded;
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
  console.log('Processing: ' + id + ' [' + req.store + ']');

  try {
    const link = await convertUrl(req.url);
    req.state = 'done';
    req.affiliateLink = link;
  } catch(err) {
    req.state = 'error';
    req.error = err.message;
    console.error('Failed:', err.message);
  } finally {
    isProcessing = false;
    processQueue();
  }
}

// ── Routes ──
app.post('/generate', async (req, res) => {
  const { url, store } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided.' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL.' }); }
  if (!isSupported(url)) return res.status(400).json({ error: 'Store not supported.' });
  if (!EXTRAPE_ACCESS_TOKEN) return res.status(500).json({ error: 'EXTRAPE_ACCESS_TOKEN not configured.' });

  const id = createRequest(url, store || 'Unknown');
  processQueue();
  return res.json({ requestId: id, ...getStatus(id) });
});

app.get('/status/:id', (req, res) => {
  const status = getStatus(req.params.id);
  if (!status) return res.status(404).json({ error: 'Request not found.' });
  return res.json(status);
});

// ── Short link redirect — /s/:code ──
app.get('/s/:code', (req, res) => {
  const url = shortLinks[req.params.code];
  if (url) {
    res.redirect(301, url);
  } else {
    res.status(404).send('Link not found or expired.');
  }
});

// ── Flash.co proxy — server-side to bypass CORS ──
const FLASH_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
  'Referer': 'https://flash.co/',
  'Origin': 'https://flash.co',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
};

app.get('/flash/search', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'No URL' });
  try {
    // Try multiple flash.co endpoint patterns
    const endpoints = [
      'https://flash.co/api/product-search?url=' + encodeURIComponent(url),
      'https://flash.co/api/search?url=' + encodeURIComponent(url),
      'https://flash.co/api/v1/product-search?url=' + encodeURIComponent(url),
    ];
    let lastError = null;
    for (const endpoint of endpoints) {
      try {
        const r = await fetch(endpoint, { headers: FLASH_HEADERS });
        const text = await r.text();
        console.log('Flash search [' + endpoint + '] status:', r.status, 'body:', text.substring(0, 200));
        if (r.ok) {
          res.json(JSON.parse(text));
          return;
        }
        lastError = 'Status ' + r.status + ': ' + text.substring(0, 100);
      } catch(e) { lastError = e.message; }
    }
    res.status(500).json({ error: 'All flash endpoints failed: ' + lastError });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/flash/compare/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const endpoints = [
      'https://flash.co/api/product-compare/' + id,
      'https://flash.co/api/product-details/' + id,
      'https://flash.co/api/v1/product-compare/' + id,
    ];
    let lastError = null;
    for (const endpoint of endpoints) {
      try {
        const r = await fetch(endpoint, { headers: FLASH_HEADERS });
        const text = await r.text();
        console.log('Flash compare [' + endpoint + '] status:', r.status, 'body:', text.substring(0, 200));
        if (r.ok) {
          res.json(JSON.parse(text));
          return;
        }
        lastError = 'Status ' + r.status + ': ' + text.substring(0, 100);
      } catch(e) { lastError = e.message; }
    }
    res.status(500).json({ error: 'All flash compare endpoints failed: ' + lastError });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Flash debug endpoint — call this to see raw flash.co response ──
app.get('/flash/debug', async (req, res) => {
  const testUrl = req.query.url || 'https://www.flipkart.com/apple-iphone-15/p/itm6ac6485515ae4';
  const results = {};
  const endpoints = [
    'https://flash.co/api/product-search?url=' + encodeURIComponent(testUrl),
    'https://flash.co/api/search?url=' + encodeURIComponent(testUrl),
  ];
  for (const ep of endpoints) {
    try {
      const r = await fetch(ep, { headers: FLASH_HEADERS });
      results[ep] = { status: r.status, body: (await r.text()).substring(0, 500) };
    } catch(e) {
      results[ep] = { error: e.message };
    }
  }
  res.json(results);
});

app.get('/', (req, res) => res.send('Smart Pick Deals backend running ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server on port ' + PORT + ' — ready instantly!'));
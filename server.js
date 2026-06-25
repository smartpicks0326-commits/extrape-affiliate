try { require('dotenv').config(); } catch(e) {} // Load .env if available (optional)
const express  = require('express');
const cors     = require('cors');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());
app.use(cors());

// ── Env vars ──
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://smartpickdeals.live';
const SERP_API_KEY = process.env.SERP_API_KEY || '';
const FLASH_DEVICE_ID = process.env.FLASH_DEVICE_ID || 'web-spd-backend';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'spd-admin-2024';

// ── ExtraPe token — in-memory cache, loaded from .env at startup ──
// Updated via the bookmarklet: visit https://api.smartpickdeals.live/extrape/token-page
const extrapeTokenCache = {
  accessToken:   process.env.EXTRAPE_ACCESS_TOKEN   || '',
  rememberToken: process.env.EXTRAPE_REMEMBER_TOKEN || '',
  updatedAt:     process.env.EXTRAPE_TOKEN_UPDATED_AT ? Number(process.env.EXTRAPE_TOKEN_UPDATED_AT) : null,
};

// Convenience getters used by existing code
function getExtrapeAccessToken()   { return extrapeTokenCache.accessToken; }
function getExtrapeRememberToken() { return extrapeTokenCache.rememberToken; }

// How many days remain on a token (14-day lifetime)
function tokenDaysRemaining(updatedAt) {
  if (!updatedAt) return null;
  const elapsed = (Date.now() - updatedAt) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.round((14 - elapsed) * 10) / 10);
}

// ── Flash token — in-memory cache, loaded from .env at startup ──
// Update via the bookmarklet: visit https://api.smartpickdeals.live/flash/token-page
// No server restart or .env editing needed when refreshing the token.
const flashTokenCache = {
  token:    process.env.FLASH_AUTH_TOKEN  || '',
  deviceId: process.env.FLASH_DEVICE_ID   || '',
  userId:   process.env.FLASH_USER_ID     || '',
  updatedAt: process.env.FLASH_TOKEN_UPDATED_AT ? Number(process.env.FLASH_TOKEN_UPDATED_AT) : null,
};

function getFlashToken() {
  if (!flashTokenCache.token) throw new Error('Flash token not set. Visit https://api.smartpickdeals.live/flash/token-page for setup.');
  return flashTokenCache.token;
}

// ── Shared .env writer helper ──
function writeEnvVars(updates) {
  const fs   = require('fs');
  const path = require('path').join(process.env.HOME || '/home/smartpick', 'extrape-affiliate', '.env');
  try {
    let envContent = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '';
    const upsert = (key, val) => {
      if (val === null || val === undefined) return;
      const v = String(val);
      if (envContent.includes(key + '='))
        envContent = envContent.replace(new RegExp(key + '=.*'), key + '=' + v);
      else
        envContent += '\n' + key + '=' + v + '\n';
    };
    Object.entries(updates).forEach(([k, v]) => upsert(k, v));
    fs.writeFileSync(path, envContent);
    return true;
  } catch(e) {
    console.log('[ENV] Could not write .env:', e.message);
    return false;
  }
}

// ── POST /flash/update-token ── (called by the bookmarklet from the owner's browser)
app.post('/flash/update-token', async (req, res) => {
  const { token, secret } = req.body;
  if (!token) return res.status(400).json({ error: 'Missing token' });
  if (secret !== ADMIN_SECRET) return res.status(401).json({ error: 'Wrong secret' });
  const { deviceId, userId } = req.body;
  const now = Date.now();
  flashTokenCache.token     = token;
  flashTokenCache.updatedAt = now;
  if (deviceId) flashTokenCache.deviceId = deviceId;
  if (userId)   flashTokenCache.userId   = userId;
  console.log('[Flash] ✅ Token updated via bookmarklet. deviceId:', deviceId, 'userId:', userId ? userId.substring(0,8)+'...' : 'n/a');
  writeEnvVars({
    FLASH_AUTH_TOKEN:       token,
    FLASH_TOKEN_UPDATED_AT: now,
    ...(deviceId ? { FLASH_DEVICE_ID: deviceId } : {}),
    ...(userId   ? { FLASH_USER_ID:   userId   } : {}),
  });
  return res.json({ ok: true, message: 'Token updated! Good for ~14 days.', updatedAt: now });
});

// ── GET /flash/token-status ──
app.get('/flash/token-status', (req, res) => {
  const days = tokenDaysRemaining(flashTokenCache.updatedAt);
  res.json({
    set:       !!flashTokenCache.token,
    preview:   flashTokenCache.token ? flashTokenCache.token.substring(0,16)+'...' : null,
    updatedAt: flashTokenCache.updatedAt,
    daysRemaining: days,
    status: !flashTokenCache.token ? 'not_set' : days === null ? 'set_no_timestamp' : days <= 0 ? 'expired' : days <= 3 ? 'expiring_soon' : 'ok',
  });
});

// ── GET /flash/token-page ── bookmarklet instructions page
app.get('/flash/token-page', (req, res) => {
  const secret = ADMIN_SECRET;
  const backend = 'https://api.smartpickdeals.live';
  const bm = `(function(){var t=null;try{t=localStorage.getItem('authToken')||localStorage.getItem('flash_auth_token')||localStorage.getItem('token')||localStorage.getItem('accessToken');}catch(e){}if(!t){var m=document.cookie.match(/(?:^|;\\s*)(?:authToken|flash_auth_token|token)=([^;]+)/);if(m)t=decodeURIComponent(m[1]);}if(!t){var ss=document.querySelectorAll('script');for(var i=0;i<ss.length;i++){var m2=ss[i].textContent.match(/"(?:authToken|token)":\\s*"(eyJ[^"]{20,})"/);if(m2){t=m2[1];break;}}}if(!t){alert('Token not found. Make sure you are logged into flash.co.');return;}fetch('${backend}/flash/update-token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t,secret:'${secret}'})}).then(function(r){return r.json();}).then(function(d){alert(d.ok?'✅ Smart Pick Deals token updated! Good for ~14 days.':'❌ '+d.error);}).catch(function(e){alert('❌ '+e.message);});})()`;
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Flash Token Updater</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0f;color:#f0ede8;max-width:600px;margin:60px auto;padding:0 24px;}
h1{font-size:22px;margin-bottom:6px;}.sub{color:#6b6878;font-size:14px;margin-bottom:32px;}
.card{background:#13131a;border:1px solid #1e1e2e;border-radius:16px;padding:28px;margin-bottom:20px;}
h2{font-size:14px;font-weight:700;margin-bottom:18px;color:#ff9a5c;text-transform:uppercase;letter-spacing:.06em;}
.step{display:flex;gap:14px;margin-bottom:16px;}.num{background:rgba(255,107,43,.12);border:1px solid rgba(255,107,43,.25);color:#ff6b2b;font-weight:800;font-size:12px;width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
p{font-size:14px;color:#b0ada8;line-height:1.6;margin:0;}
.bm{display:inline-block;background:#ff6b2b;color:#fff;font-weight:700;font-size:15px;padding:13px 28px;border-radius:12px;text-decoration:none;margin:10px 0;box-shadow:0 4px 20px rgba(255,107,43,.35);}
.bm:hover{background:#ff9a5c;}.hint{font-size:12px;color:#6b6878;margin-top:8px;}
.status{background:#0a0a0f;border:1px solid #1e1e2e;border-radius:10px;padding:14px 18px;font-family:monospace;font-size:13px;}
.ok{color:#29d87a;}.badge{display:inline-block;background:rgba(41,216,122,.1);border:1px solid rgba(41,216,122,.2);color:#29d87a;font-size:11px;font-weight:700;padding:2px 10px;border-radius:999px;margin-left:8px;}</style></head>
<body><h1>⚡ Flash Token Updater</h1><p class="sub">Refresh your Smart Pick Deals token in 5 seconds</p>
<div class="card"><h2>Step 1 — One-time setup</h2>
<div class="step"><div class="num">1</div><p>Drag the button below to your browser bookmarks bar</p></div>
<a class="bm" href="javascript:${encodeURIComponent(bm)}">⚡ Update SPD Flash Token</a>
<p class="hint">Can't drag? Right-click → Bookmark this link</p></div>
<div class="card"><h2>Step 2 — Every ~14 days (takes 5 seconds)</h2>
<div class="step"><div class="num">1</div><p>Go to <a href="https://flash.co" target="_blank" style="color:#ff9a5c">flash.co</a> and make sure you're logged in</p></div>
<div class="step"><div class="num">2</div><p>Click the <strong>⚡ Update SPD Flash Token</strong> bookmark</p></div>
<div class="step"><div class="num">3</div><p>See <strong>"✅ Token updated!"</strong> popup — done</p></div></div>
<div class="card"><h2>Current status</h2><div class="status" id="st">Checking...</div></div>
<script>fetch('/flash/token-status').then(r=>r.json()).then(d=>{document.getElementById('st').innerHTML=d.set?'<span class="ok">✅ Token active</span><span class="badge">Set</span><br/><small style="color:#6b6878">Preview: '+d.preview+'</small>':'⚠️ No token yet. Follow steps above.';}).catch(()=>{document.getElementById('st').textContent='Could not reach backend.';});</script>
</body></html>`);
});


// ── POST /extrape/update-token ── (called by the ExtraPe bookmarklet)
app.post('/extrape/update-token', async (req, res) => {
  const { accessToken, rememberToken, rememberMeToken, secret } = req.body;
  if (!accessToken) return res.status(400).json({ error: 'Missing accessToken' });
  if (secret !== ADMIN_SECRET) return res.status(401).json({ error: 'Wrong secret' });
  const rt = rememberToken || rememberMeToken || extrapeTokenCache.rememberToken;
  const now = Date.now();
  extrapeTokenCache.accessToken   = accessToken;
  extrapeTokenCache.rememberToken = rt;
  extrapeTokenCache.updatedAt     = now;
  console.log('[ExtraPe] ✅ Token updated via bookmarklet. accessToken preview:', accessToken.substring(0,16)+'...');
  writeEnvVars({
    EXTRAPE_ACCESS_TOKEN:       accessToken,
    EXTRAPE_TOKEN_UPDATED_AT:   now,
    ...(rt ? { EXTRAPE_REMEMBER_TOKEN: rt } : {}),
  });
  return res.json({ ok: true, message: 'ExtraPe token updated! Good for ~14 days.', updatedAt: now });
});

// ── GET /extrape/token-status ──
app.get('/extrape/token-status', (req, res) => {
  const days = tokenDaysRemaining(extrapeTokenCache.updatedAt);
  res.json({
    set:       !!extrapeTokenCache.accessToken,
    preview:   extrapeTokenCache.accessToken ? extrapeTokenCache.accessToken.substring(0,16)+'...' : null,
    updatedAt: extrapeTokenCache.updatedAt,
    daysRemaining: days,
    status: !extrapeTokenCache.accessToken ? 'not_set' : days === null ? 'set_no_timestamp' : days <= 0 ? 'expired' : days <= 3 ? 'expiring_soon' : 'ok',
  });
});

// ── GET /extrape/token-page ── bookmarklet instructions page
app.get('/extrape/token-page', (req, res) => {
  const secret  = ADMIN_SECRET;
  const backend = 'https://api.smartpickdeals.live';

  // CONFIRMED from DevTools (2026-06-04):
  // - Input[2]: type=text, placeholder="Paste link here"   ← URL input
  // - Input[3]: TEXTAREA, placeholder="Input Links..."     ← alternate input
  // - Convert button: exact text "Convert"
  // - ExtraPe uses XHR (not fetch) — FETCH CAUGHT never fired
  // - Must intercept XHR.send() to know when the call fires, not just setRequestHeader
  const bm = `(function(){
    if(!location.hostname.includes('extrape.com')){
      alert('Run this on extrape.com/link-converter while logged in.');return;
    }
    var captured={at:null,rt:null};
    var done=false;

    function sendToBackend(){
      if(done)return;
      if(!captured.at){alert('\\u274C Token not captured. Make sure you are logged in.');return;}
      done=true;
      fetch('${backend}/extrape/update-token',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({accessToken:captured.at,rememberMeToken:captured.rt||'',secret:'${secret}'})
      }).then(function(r){return r.json();})
        .then(function(d){alert(d.ok?'\\u2705 ExtraPe token updated! Good for ~14 days.':'\\u274C '+d.error);})
        .catch(function(e){alert('\\u274C '+e.message);});
    }

    // ── Patch XHR — intercept both setRequestHeader AND send ──
    var origOpen=XMLHttpRequest.prototype.open;
    var origSetHdr=XMLHttpRequest.prototype.setRequestHeader;
    var origSend=XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open=function(m,u){
      this._epUrl=String(u||'');
      return origOpen.apply(this,arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader=function(k,v){
      if(this._epUrl&&this._epUrl.includes('convertText')){
        if(k==='accessToken')captured.at=v;
        if(k==='rememberMeToken')captured.rt=v;
      }
      return origSetHdr.apply(this,arguments);
    };
    XMLHttpRequest.prototype.send=function(body){
      var self=this;
      if(this._epUrl&&this._epUrl.includes('convertText')){
        this.addEventListener('loadend',function(){setTimeout(sendToBackend,300);},{once:true});
      }
      return origSend.apply(this,arguments);
    };

    // ── Fill input[placeholder="Paste link here"] ──
    // Confirmed index 2 in DOM, but select by placeholder to be safe
    var urlInput=document.querySelector('input[placeholder="Paste link here"]');
    if(!urlInput){
      // Fallback: textarea with "Input Links" placeholder
      urlInput=document.querySelector('textarea[placeholder*="Input Links"],textarea[placeholder*="http"]');
    }
    if(!urlInput){
      alert('\\u26A0\\uFE0F Could not find URL input. Make sure you are on extrape.com/link-converter.');return;
    }

    // React-safe setter
    var nativeSetter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')||
                     Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value');
    if(nativeSetter&&nativeSetter.set){nativeSetter.set.call(urlInput,'https://www.amazon.in/dp/B08N5WRWNW');}
    else{urlInput.value='https://www.amazon.in/dp/B08N5WRWNW';}
    urlInput.dispatchEvent(new Event('input',{bubbles:true}));
    urlInput.dispatchEvent(new Event('change',{bubbles:true}));

    // ── Click Convert (confirmed exact text "Convert") ──
    setTimeout(function(){
      var btn=null;
      var all=Array.prototype.slice.call(document.querySelectorAll('button'));
      for(var i=0;i<all.length;i++){
        if(all[i].textContent.trim()==='Convert'){btn=all[i];break;}
      }
      if(btn){btn.click();}
      else{alert('\\u26A0\\uFE0F Convert button not found. Paste a URL manually, click Convert, then click bookmark again.');}
      // Safety net: if XHR already fired before patch, send whatever we have
      setTimeout(function(){if(!done)sendToBackend();},8000);
    },300);
  })()`.replace(/\n\s+/g,' ');

  // The loader bookmarklet is tiny — just injects a <script> tag from our server.
  // This bypasses extrape.com's CSP which blocks inline javascript: URLs.
  // The actual logic lives at /extrape/bookmarklet.js served from our own domain.
  const loader = `(function(){var s=document.createElement('script');s.src='https://api.smartpickdeals.live/extrape/bookmarklet.js?t='+Date.now();document.head.appendChild(s);})()`;

  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>ExtraPe Token Updater</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0f;color:#f0ede8;max-width:600px;margin:60px auto;padding:0 24px;}
h1{font-size:22px;margin-bottom:6px;}.sub{color:#6b6878;font-size:14px;margin-bottom:32px;}
.card{background:#13131a;border:1px solid #1e1e2e;border-radius:16px;padding:28px;margin-bottom:20px;}
h2{font-size:14px;font-weight:700;margin-bottom:18px;color:#a78bfa;text-transform:uppercase;letter-spacing:.06em;}
.step{display:flex;gap:14px;margin-bottom:16px;}.num{background:rgba(167,139,250,.12);border:1px solid rgba(167,139,250,.25);color:#a78bfa;font-weight:800;font-size:12px;width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
p{font-size:14px;color:#b0ada8;line-height:1.6;margin:0;}a{color:#a78bfa;}
.bm{display:inline-block;background:#7c3aed;color:#fff;font-weight:700;font-size:15px;padding:13px 28px;border-radius:12px;text-decoration:none;margin:10px 0;box-shadow:0 4px 20px rgba(124,58,237,.35);}
.bm:hover{background:#a78bfa;}.hint{font-size:12px;color:#6b6878;margin-top:8px;}
.callout{background:rgba(245,158,11,.07);border:1px solid rgba(245,158,11,.2);border-radius:10px;padding:12px 16px;font-size:13px;color:#b0ada8;margin-top:12px;line-height:1.6;}
.status{background:#0a0a0f;border:1px solid #1e1e2e;border-radius:10px;padding:14px 18px;font-family:monospace;font-size:13px;}
.ok{color:#29d87a;}.warn{color:#f59e0b;}.badge{display:inline-block;background:rgba(41,216,122,.1);border:1px solid rgba(41,216,122,.2);color:#29d87a;font-size:11px;font-weight:700;padding:2px 10px;border-radius:999px;margin-left:8px;}</style></head>
<body>
<h1>🔗 ExtraPe Token Updater</h1>
<p class="sub">Auto-fills the converter and captures your token — one click</p>
<div class="card">
  <h2>Step 1 — One-time setup</h2>
  <div class="step"><div class="num">1</div><p>Drag the button below to your browser bookmarks bar</p></div>
  <a class="bm" href="javascript:${encodeURIComponent(loader)}">🔗 Update SPD ExtraPe Token</a>
  <p class="hint">Can't drag? Right-click → "Bookmark this link"</p>
  <div class="callout">⚡ This bookmark loads the updater script from our server — bypasses extrape.com's security policy that blocked the old version.</div>
</div>
<div class="card">
  <h2>Step 2 — Every ~14 days</h2>
  <div class="step"><div class="num">1</div><p>Go to <a href="https://www.extrape.com/link-converter" target="_blank">extrape.com/link-converter</a> — make sure you're logged in</p></div>
  <div class="step"><div class="num">2</div><p>Click the <strong>🔗 Update SPD ExtraPe Token</strong> bookmark</p></div>
  <div class="step"><div class="num">3</div><p>The page auto-fills a URL, converts it, and shows <strong>"✅ Token updated!"</strong></p></div>
</div>
<div class="card"><h2>Current status</h2><div class="status" id="st">Checking...</div></div>
<script>fetch('/extrape/token-status').then(r=>r.json()).then(d=>{
  var days=d.daysRemaining;
  var cls=d.status==='ok'?'ok':d.status==='expiring_soon'?'warn':'';
  var msg=!d.set?'⚠️ No token yet. Follow steps above.':d.status==='expired'?'<span style="color:#ff4b6e">🔴 Token expired — refresh now</span>':days!==null?'<span class="'+cls+'">✅ Token active — '+Math.floor(days)+' days remaining</span><span class="badge">Set</span><br/><small style="color:#6b6878;margin-top:6px;display:block">Preview: '+d.preview+'</small>':'<span class="ok">✅ Token set</span><span class="badge">Active</span><br/><small style="color:#6b6878;margin-top:6px;display:block">Preview: '+d.preview+'</small>';
  document.getElementById('st').innerHTML=msg;
}).catch(()=>{document.getElementById('st').textContent='Could not reach backend.';});
</script></body></html>`);
});

// ── GET /extrape/bookmarklet.js ── the actual logic, served as a JS file
// Loaded dynamically by the loader bookmarklet — bypasses CSP on extrape.com
app.get('/extrape/bookmarklet.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const secret  = ADMIN_SECRET;
  const backend = 'https://api.smartpickdeals.live';
  res.send(`(function(){
    if(!location.hostname.includes('extrape.com')){
      alert('Run this on extrape.com/link-converter while logged in.');return;
    }
    var captured={at:null,rt:null};
    var done=false;
    function sendToBackend(){
      if(done)return;
      if(!captured.at){alert('\\u274C Token not captured. Make sure you are logged in.');return;}
      done=true;
      fetch('${backend}/extrape/update-token',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({accessToken:captured.at,rememberMeToken:captured.rt||'',secret:'${secret}'})
      }).then(function(r){return r.json();})
        .then(function(d){alert(d.ok?'\\u2705 ExtraPe token updated! Good for ~14 days.':'\\u274C '+d.error);})
        .catch(function(e){alert('\\u274C '+e.message);});
    }
    var origOpen=XMLHttpRequest.prototype.open;
    var origSetHdr=XMLHttpRequest.prototype.setRequestHeader;
    var origSend=XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open=function(m,u){
      this._epUrl=String(u||'');return origOpen.apply(this,arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader=function(k,v){
      if(this._epUrl&&this._epUrl.includes('convertText')){
        if(k==='accessToken')captured.at=v;
        if(k==='rememberMeToken')captured.rt=v;
      }
      return origSetHdr.apply(this,arguments);
    };
    XMLHttpRequest.prototype.send=function(b){
      if(this._epUrl&&this._epUrl.includes('convertText')){
        this.addEventListener('loadend',function(){setTimeout(sendToBackend,300);},{once:true});
      }
      return origSend.apply(this,arguments);
    };
    // Converter tab uses a TEXTAREA (placeholder "Input Links...")
    // Make Links tab uses input[placeholder="Paste link here"]
    // Try textarea first since that's the active Converter tab
    var inp=document.querySelector('textarea[placeholder*="Input Links"]')
         ||document.querySelector('textarea[placeholder*="http"]')
         ||document.querySelector('input[placeholder="Paste link here"]');
    if(!inp){alert('\\u26A0\\uFE0F Could not find URL input. Make sure you are on the Converter tab at extrape.com/link-converter.');return;}
    var nsSetter=inp.tagName==='TEXTAREA'
      ?Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')
      :Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');
    if(nsSetter&&nsSetter.set)nsSetter.set.call(inp,'https://www.amazon.in/dp/B08N5WRWNW');
    else inp.value='https://www.amazon.in/dp/B08N5WRWNW';
    inp.dispatchEvent(new Event('input',{bubbles:true}));
    inp.dispatchEvent(new Event('change',{bubbles:true}));
    setTimeout(function(){
      var btn=Array.prototype.find.call(document.querySelectorAll('button'),function(b){return b.textContent.trim()==='Convert';});
      if(btn)btn.click();
      else alert('\\u26A0\\uFE0F Convert button not found.');
      setTimeout(function(){if(!done)sendToBackend();},8000);
    },300);
  })();`);
});

// ── GET /admin/token-status ── returns both Flash + ExtraPe token health
app.get('/admin/token-status', (req, res) => {
  const flashDays  = tokenDaysRemaining(flashTokenCache.updatedAt);
  const extrapeDays = tokenDaysRemaining(extrapeTokenCache.updatedAt);
  res.json({
    flash: {
      set:           !!flashTokenCache.token,
      preview:       flashTokenCache.token ? flashTokenCache.token.substring(0,16)+'...' : null,
      updatedAt:     flashTokenCache.updatedAt,
      daysRemaining: flashDays,
      status:        !flashTokenCache.token ? 'not_set' : flashDays === null ? 'set_no_timestamp' : flashDays <= 0 ? 'expired' : flashDays <= 3 ? 'expiring_soon' : 'ok',
    },
    extrape: {
      set:           !!extrapeTokenCache.accessToken,
      preview:       extrapeTokenCache.accessToken ? extrapeTokenCache.accessToken.substring(0,16)+'...' : null,
      updatedAt:     extrapeTokenCache.updatedAt,
      daysRemaining: extrapeDays,
      status:        !extrapeTokenCache.accessToken ? 'not_set' : extrapeDays === null ? 'set_no_timestamp' : extrapeDays <= 0 ? 'expired' : extrapeDays <= 3 ? 'expiring_soon' : 'ok',
    },
  });
});

// ── Puppeteer Flash.co scraper ──
// Runs all Flash API calls from WITHIN a real headless Chrome browser.
// Chrome's TLS fingerprint passes Flash.co WAF — server IP doesn't matter.

let flashBrowser     = null;
let flashBrowserBusy = false;
const flashWaitQueue = [];

async function getFlashBrowser() {
  if (flashBrowser && flashBrowser.isConnected()) return flashBrowser;
  console.log('[Flash/Puppeteer] Launching Chrome...');
  flashBrowser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--single-process','--no-zygote','--disable-extensions','--mute-audio'],
  });
  flashBrowser.on('disconnected', () => {
    console.log('[Flash/Puppeteer] Browser disconnected');
    flashBrowser = null; flashBrowserBusy = false;
    while (flashWaitQueue.length) flashWaitQueue.shift()();
  });
  try {
    const warm = await flashBrowser.newPage();
    await warm.goto('https://flash.co', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await warm.close();
    console.log('[Flash/Puppeteer] ✅ Chrome ready');
  } catch(e) { console.log('[Flash/Puppeteer] Warm-up skipped:', e.message); }
  return flashBrowser;
}

function withFlashBrowser(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      flashBrowserBusy = true;
      try { resolve(await fn()); } catch(e) { reject(e); }
      finally { flashBrowserBusy = false; if (flashWaitQueue.length) flashWaitQueue.shift()(); }
    };
    if (!flashBrowserBusy) run(); else flashWaitQueue.push(run);
  });
}

async function flashSearchPuppeteer(productUrl) {
  return withFlashBrowser(async () => {
    const browser = await getFlashBrowser();
    const page    = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    // Capture console logs from the page for debugging
    const pageLogs = [];
    page.on('console', m => pageLogs.push(m.text().substring(0, 200)));

    try {
      // ── Step 1: Go to flash.co and inject auth token ──
      await page.goto('https://flash.co', { waitUntil: 'networkidle2', timeout: 25000 });
      console.log('[Flash/Puppeteer] flash.co loaded, URL:', page.url());

      if (flashTokenCache.token) {
        await page.evaluate((tok) => {
          try { localStorage.setItem('authToken',   tok); } catch(e) {}
          try { localStorage.setItem('accessToken', tok); } catch(e) {}
          try { localStorage.setItem('flash_token', tok); } catch(e) {}
          // Also try setting as cookie via document.cookie
          document.cookie = `authToken=${tok}; path=/; domain=flash.co`;
        }, flashTokenCache.token);
        console.log('[Flash/Puppeteer] Auth token injected');
      }

      // ── Step 2: Submit URL via search input ──
      const inputSelectors = [
        'input[placeholder*="paste"]',
        'input[placeholder*="link"]',
        'input[placeholder*="url"]',
        'input[placeholder*="URL"]',
        'input[type="text"]',
        'input[type="url"]',
        'input[type="search"]',
        'textarea',
      ];
      let inputFound = false;
      for (const sel of inputSelectors) {
        try {
          const el = await page.$(sel);
          if (!el) continue;
          await el.click({ clickCount: 3 });
          await el.type(productUrl, { delay: 15 });
          await page.keyboard.press('Enter');
          inputFound = true;
          console.log('[Flash/Puppeteer] Typed URL into selector:', sel);
          break;
        } catch(e) { /* try next */ }
      }
      if (!inputFound) console.log('[Flash/Puppeteer] WARNING: No input found — relying on stream API only');

      // ── Step 3: Fire stream API in parallel ──
      const snap = {
        url:      productUrl,
        token:    flashTokenCache.token,
        deviceId: flashTokenCache.deviceId || 'web-spd-' + Date.now(),
        userId:   flashTokenCache.userId   || '',
      };

      const streamPromise = page.evaluate(async ({ url, token, deviceId, userId }) => {
        const idKey = btoa(unescape(encodeURIComponent(userId + '_' + url + '_WEB'))).substring(0, 64);
        const headers = {
          'Authorization':   'Bearer ' + token,
          'Channel-Type':    'web',
          'Content-Type':    'application/json',
          'Accept':          'text/event-stream',
          'Origin':          'https://flash.co',
          'X-Country-Code':  'IN',
          'X-Device-Id':     deviceId,
          'X-Timezone':      'Asia/Calcutta',
          'X-Idempotency-Key': idKey,
        };
        const params = new URLSearchParams({
          source: 'APPEND', context: 'HOME_URL_PASTE',
          user_agent: navigator.userAgent, device_type: 'DESKTOP', country_code: 'IN',
        });
        try {
          const r = await fetch('https://api.flash.co/agents/chat/stream?' + params, {
            method: 'POST', headers,
            body: JSON.stringify({ query: url, context: 'HOME_URL_PASTE' }),
          });
          if (!r.ok) return { hash: null, status: r.status };
          const text = await r.text();
          const patterns = [
            /product-details\/([A-Za-z0-9_-]{4,})/,
            /product-search\/([A-Za-z0-9_-]{4,})/,
            /"pageHash"\s*:\s*"([A-Za-z0-9_-]{4,})"/,
            /\/h\/([A-Za-z0-9_-]{6,})/,
          ];
          for (const pat of patterns) {
            const m = text.match(pat); if (m) return { hash: m[1], status: r.status, sample: text.substring(0, 300) };
          }
          return { hash: null, status: r.status, sample: text.substring(0, 300) };
        } catch(e) { return { hash: null, error: e.message }; }
      }, snap);

      // ── Step 4: Get pageHash — stream API first (fast), browser nav as fallback ──
      let pageHash = null;

      // Wait for stream API result (already fired in Step 3)
      // This usually resolves in 5-15 seconds
      const streamResult = await streamPromise.catch(() => null);
      console.log('[Flash/Puppeteer] Stream result:', JSON.stringify(streamResult || {}).substring(0, 200));

      if (streamResult && streamResult.hash) {
        // Fast path: got hash from stream, navigate directly
        pageHash = streamResult.hash;
        console.log('[Flash/Puppeteer] ✅ Hash from stream:', pageHash);
        try {
          await page.goto('https://flash.co/price-compare/' + pageHash, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch(e) {
          // Try alternate URL formats
          try { await page.goto('https://flash.co/product-details/' + pageHash, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch(e2) {}
        }
        console.log('[Flash/Puppeteer] Navigated to:', page.url());
      } else {
        // Slow path: wait for browser to navigate itself (from input submission)
        console.log('[Flash/Puppeteer] No stream hash — waiting for browser navigation...');
        try {
          await page.waitForFunction(
            () => /price-compare|product-details|\/h\//.test(window.location.href),
            { timeout: 45000 }
          );
          const curUrl = page.url();
          const m = curUrl.match(/price-compare\/\d+\/h\/([A-Za-z0-9_-]{4,})/)
                 || curUrl.match(/product-details\/([A-Za-z0-9_-]{4,})/)
                 || curUrl.match(/\/h\/([A-Za-z0-9_-]{4,})/);
          if (m) pageHash = m[1];
          console.log('[Flash/Puppeteer] Browser navigated:', curUrl);
        } catch(navErr) {
          // One retry via stream API
          console.log('[Flash/Puppeteer] Nav timed out — one stream retry...');
          await new Promise(r => setTimeout(r, 8000));
          const retryHash = await page.evaluate(async ({ url, token, deviceId, userId }) => {
            const idKey = btoa(unescape(encodeURIComponent(userId + '_' + url + '_RETRY'))).substring(0, 64);
            const headers = {
              'Authorization': 'Bearer ' + token, 'Channel-Type': 'web',
              'Content-Type': 'application/json', 'Origin': 'https://flash.co',
              'X-Country-Code': 'IN', 'X-Device-Id': deviceId, 'X-Timezone': 'Asia/Calcutta',
              'X-Idempotency-Key': idKey,
            };
            try {
              const r = await fetch('https://api.flash.co/agents/chat/stream?' + new URLSearchParams({ source:'APPEND', context:'HOME_URL_PASTE', device_type:'DESKTOP', country_code:'IN' }), {
                method: 'POST', headers, body: JSON.stringify({ query: url, context: 'HOME_URL_PASTE' }),
              });
              if (!r.ok) return null;
              const text = await r.text();
              for (const pat of [/price-compare\/\d+\/h\/([A-Za-z0-9_-]{4,})/, /product-details\/([A-Za-z0-9_-]{4,})/, /\/h\/([A-Za-z0-9_-]{6,})/]) {
                const m = text.match(pat); if (m) return m[1];
              }
              return null;
            } catch(e) { return null; }
          }, snap).catch(() => null);

          if (retryHash) {
            pageHash = retryHash;
            try { await page.goto('https://flash.co/price-compare/' + pageHash, { waitUntil: 'domcontentloaded', timeout: 25000 }); } catch(e) {}
            console.log('[Flash/Puppeteer] Retry hash:', pageHash);
          } else {
            const html = await page.content();
            return { error: 'FLASH_NO_DATA', htmlSample: html.substring(0, 3000), pageLogs };
          }
        }
      }

      // Extract hash from current URL if not yet set
      if (!pageHash) {
        const cur = page.url();
        const m = cur.match(/price-compare\/\d+\/h\/([A-Za-z0-9_-]{4,})/)
               || cur.match(/product-details\/([A-Za-z0-9_-]{4,})/)
               || cur.match(/\/h\/([A-Za-z0-9_-]{4,})/);
        pageHash = m ? m[1] : 'unknown';
      }
      console.log('[Flash/Puppeteer] pageHash:', pageHash, '| URL:', page.url());

      // ── Step 5: Wait for prices AND product content to fully load ──
      try {
        await page.waitForFunction(() => {
          const prices = document.body.innerText.match(/₹[\d,]{2,}/g) || [];
          return prices.length >= 2;
        }, { timeout: 30000 });
        console.log('[Flash/Puppeteer] Prices detected in DOM');
      } catch(e) {
        console.log('[Flash/Puppeteer] Price wait timed out — extracting anyway');
      }

      // Wait for real product name (not Flash placeholder)
      const genericNames = [
        'flash ai assistant', 'flash ai', 'compare prices', 'best price',
        'product details', 'product information', 'loading', 'please wait',
      ];
      try {
        await page.waitForFunction((generic) => {
          const candidates = document.querySelectorAll('h1, h2, [class*="product-name"], [class*="productName"], [class*="title"]');
          for (const el of candidates) {
            const t = el.textContent.trim().toLowerCase();
            if (t.length > 5 && !generic.some(g => t.includes(g))) return true;
          }
          return false;
        }, { timeout: 12000 }, genericNames);
      } catch(e) {
        console.log('[Flash/Puppeteer] Product name wait timed out');
      }

      // Wait for a real product image (not /merchants/ store logos)
      try {
        await page.waitForFunction(() => {
          for (const img of document.querySelectorAll('img')) {
            const src = img.src || '';
            if (!src || src.includes('/merchants/') || src.includes('/favicon')) continue;
            if (img.naturalWidth > 80 && img.naturalHeight > 80) return true;
          }
          return false;
        }, { timeout: 8000 });
      } catch(e) {
        console.log('[Flash/Puppeteer] Product image wait timed out');
      }

      // Scroll to load lazy content + expand all stores
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise(r => setTimeout(r, 2500));

      // Click "View all" / "Show more" buttons
      try {
        const clicked = await page.evaluate(() => {
          let count = 0;
          for (const el of document.querySelectorAll('button, a, [role="button"], span, div, p')) {
            const t = (el.textContent || '').toLowerCase().trim();
            if (/view all|show all|all stores|more stores|view \d+ store|show \d+/.test(t)) {
              el.click(); count++;
            }
          }
          return count;
        });
        if (clicked > 0) {
          await new Promise(r => setTimeout(r, 3000));
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await new Promise(r => setTimeout(r, 2000));
        }
      } catch(e) {}

      await page.evaluate(() => window.scrollTo(0, 0));
      await new Promise(r => setTimeout(r, 800));

      // ── Step 6: Extract prices + metadata from DOM ──
      const extracted = await page.evaluate((genericNamesInner) => {

        function normalizeName(raw) {
          const l = (raw || '').toLowerCase().trim();
          if (l.includes('amazon'))          return 'Amazon';
          if (l.includes('flipkart'))        return 'Flipkart';
          if (l.includes('myntra'))          return 'Myntra';
          if (l.includes('ajio'))            return 'Ajio';
          if (l.includes('nykaa'))           return 'Nykaa';
          if (l.includes('tatacliq') || l === 'tata cliq') return 'TataCliq';
          if (l.includes('croma'))           return 'Croma';
          if (l.includes('snapdeal'))        return 'Snapdeal';
          if (l.includes('meesho'))          return 'Meesho';
          if (l.includes('jiomart') || l === 'jio mart') return 'JioMart';
          if (l.includes('bigbasket') || l === 'big basket') return 'BigBasket';
          if (l.includes('zepto'))           return 'Zepto';
          if (l.includes('blinkit'))         return 'Blinkit';
          if (l.includes('swiggy'))          return 'Swiggy';
          if (l.includes('zomato'))          return 'Zomato';
          if (l.includes('firstcry'))        return 'FirstCry';
          if (l.includes('netmeds'))         return 'Netmeds';
          if (l.includes('lenskart'))        return 'Lenskart';
          if (l.includes('boat'))            return 'Boat';
          if (l.includes('zebrs'))           return 'Zebrs';
          if (l.includes('decathlon'))       return 'Decathlon';
          if (l.includes('pepperfry'))       return 'Pepperfry';
          if (l.includes('vijay'))           return 'Vijay Sales';
          if (l.includes('reliance'))        return 'Reliance Digital';
          if (l.includes('sangeetha'))       return 'Sangeetha';
          if (l.includes('mamaearth'))       return 'Mamaearth';
          if (l.includes('purplle'))         return 'Purplle';
          if (l.includes('fire-boltt') || l.includes('fireboltt')) return 'Fire-Boltt';
          return raw.trim();
        }

        function parseStandalonePrice(text) {
          const m = (text || '').trim().match(/^₹\s*([\d,]+)$/);
          if (!m) return 0;
          const p = parseInt(m[1].replace(/,/g, ''));
          return p >= 50 && p <= 5000000 ? p : 0;
        }

        const KNOWN_STORES = [
          'amazon','flipkart','myntra','ajio','nykaa','tatacliq','tata cliq','croma','snapdeal',
          'meesho','jiomart','jio mart','bigbasket','big basket','zepto','blinkit','swiggy',
          'instamart','zomato','firstcry','netmeds','lenskart','boat','mamaearth','purplle',
          'bewakoof','decathlon','pepperfry','vijay sales','reliance digital','sangeetha',
          'poorvika','pai international','apple','nubo','getuscart','zebrs','shopclues',
          'fire-boltt','fireboltt',
        ];

        // ── Detect source store from "You came from here" label ──
        let sourceStore = '';
        {
          const allText = document.body.innerText || '';
          const m = allText.match(/you came from here/i);
          if (m) {
            // Find the element containing that text and get the store name near it
            for (const el of document.querySelectorAll('*')) {
              if ((el.textContent || '').toLowerCase().includes('you came from here') &&
                  !el.children.length && el.textContent.trim().length < 100) {
                // Store name is likely in a sibling or parent
                const parent = el.closest('[class]') || el.parentElement;
                if (parent) {
                  for (const child of parent.querySelectorAll('*')) {
                    const t = (child.textContent || '').trim();
                    const l = t.toLowerCase();
                    if (t.length > 1 && t.length < 50 &&
                        KNOWN_STORES.some(s => l === s || (s.length > 4 && l.includes(s)))) {
                      sourceStore = normalizeName(t);
                      break;
                    }
                  }
                }
                if (sourceStore) break;
              }
            }
          }
        }

        // ── Extract each store card ──
        // Flash.co renders a list of cards. Each card contains:
        //   • Optional savings badge: "Save ₹200 over Flipkart!" / "LOWEST PRICE"
        //   • Store logo (img with alt = store name)
        //   • Store name text
        //   • Price: ₹XXX
        //   • Optional "Out of stock" text
        //   • "Visit" button (a[href] pointing to store)
        // Strategy: find the repeated container that holds store+price+visit

        const seen = new Set();
        const results = [];

        function extractCard(card) {
          // ── Price ──
          let price = 0;
          for (const el of card.querySelectorAll('*')) {
            if (el.children.length > 0) continue;
            const t = (el.textContent || '').trim();
            const p = parseStandalonePrice(t);
            if (p > 0) {
              // Make sure this isn't inside a savings badge ("Save ₹200 over...")
              const ancestor3 = [el.parentElement, el.parentElement?.parentElement, el.parentElement?.parentElement?.parentElement].filter(Boolean);
              const inBadge = ancestor3.some(a => /save\s*₹|₹\d+\s*off|cashback/i.test(a.textContent || '') && (a.textContent || '').length < 60);
              if (!inBadge) { price = p; break; }
            }
          }
          if (!price) return null;

          // ── Store name ── prefer img[alt], then text
          let storeName = '';
          for (const img of card.querySelectorAll('img')) {
            const alt = (img.alt || '').trim();
            if (alt.length > 1 && alt.length < 60 && !/logo|product|image/i.test(alt) && !/^\d/.test(alt)) {
              // Verify it looks like a store name (contains a known store or is short enough)
              if (KNOWN_STORES.some(s => alt.toLowerCase().includes(s)) || alt.length < 25) {
                storeName = alt; break;
              }
            }
          }
          if (!storeName) {
            for (const el of card.querySelectorAll('*')) {
              if (el.children.length > 0) continue;
              const t = (el.textContent || '').trim();
              const l = t.toLowerCase();
              if (t.length < 2 || t.length > 60 || /^₹/.test(t) || /^\d/.test(t)) continue;
              if (KNOWN_STORES.some(s => l === s || (s.length > 4 && l.includes(s)))) {
                storeName = t; break;
              }
            }
          }
          if (!storeName) return null;

          const normalized = normalizeName(storeName);
          const key = normalized.toLowerCase();
          if (seen.has(key)) return null;

          // ── Out of stock ──
          const cardText = (card.textContent || '').toLowerCase();
          const outOfStock = /out of stock|not available|unavailable|sold out/.test(cardText);

          // ── Savings badge ──
          let savingsBadge = '';
          let lowestPrice = false;
          for (const el of card.querySelectorAll('*')) {
            const t = (el.textContent || '').trim();
            if (/save\s*₹[\d,]+/i.test(t) && t.length < 60) { savingsBadge = t; }
            if (/lowest\s*price/i.test(t) && t.length < 30) { lowestPrice = true; }
          }

          // ── Store URL ── first outbound link that isn't flash.co
          let storeUrl = '';
          for (const a of card.querySelectorAll('a[href]')) {
            const href = a.href || '';
            if (href && !href.includes('flash.co') && href.startsWith('http')) {
              storeUrl = href; break;
            }
          }

          seen.add(key);
          return { name: normalized, price, url: storeUrl, outOfStock, savingsBadge, lowestPrice };
        }

        // Try card selectors from most specific to least
        const cardSelectors = [
          '[class*="store-card"]','[class*="storeCard"]','[class*="StoreCard"]',
          '[class*="price-card"]','[class*="priceCard"]','[class*="PriceCard"]',
          '[class*="store-item"]','[class*="storeItem"]','[class*="StoreItem"]',
          '[class*="store-row"]','[class*="storeRow"]','[class*="StoreRow"]',
          '[class*="retailer"]','[class*="merchant-row"]','[class*="offer-row"]',
          '[class*="compare-item"]','[class*="compareItem"]',
          // Generic: look for repeated li or div siblings that all contain ₹
          'li','[class*="item"]',
        ];

        for (const sel of cardSelectors) {
          const cards = document.querySelectorAll(sel);
          if (cards.length < 2) continue;
          const batch = [];
          seen.clear(); // reset for each selector attempt
          for (const card of cards) {
            const r = extractCard(card);
            if (r) batch.push(r);
          }
          if (batch.length >= 2) { results.push(...batch); break; }
        }

        // ── Fallback: link-anchored ──
        if (results.length < 2) {
          seen.clear();
          document.querySelectorAll('a[href]').forEach(a => {
            const href = a.href || '';
            if (!href || href.includes('flash.co') || !href.startsWith('http')) return;
            const hrefL = href.toLowerCase();
            const match = KNOWN_STORES.find(s => s.length > 3 && hrefL.includes(s.replace(/\s/g,'')));
            if (!match) return;
            const normalized = normalizeName(match);
            const key = normalized.toLowerCase();
            if (seen.has(key)) return;

            let price = 0;
            let container = a.parentElement;
            for (let d = 0; d < 8 && container && !price; d++) {
              for (const el of container.querySelectorAll('*')) {
                if (el.children.length > 0) continue;
                const p = parseStandalonePrice(el.textContent);
                if (p > 0) { price = p; break; }
              }
              container = container.parentElement;
            }
            if (!price) return;

            const outOfStock = /out of stock|unavailable/i.test((a.closest('[class]') || a.parentElement || document.body).textContent || '');
            seen.add(key);
            results.push({ name: normalized, price, url: href, outOfStock, savingsBadge: '', lowestPrice: false });
          });
        }

        // ── Product name ──
        // Never show Flash branding — if we can't find the real name, return empty
        const FLASH_JUNK = [
          'flash ai assistant', 'flash ai', 'flash assistant', 'compare prices',
          'best price', 'product details', 'product information', 'loading',
          'please wait', 'price compare',
        ];
        const productName = (() => {
          for (const sel of [
            'h1[class*="product"]','h1[class*="title"]',
            '[class*="product-name"]','[class*="productName"]','[class*="product_name"]',
            'h1','h2',
          ]) {
            for (const el of document.querySelectorAll(sel)) {
              const t = el.textContent.trim();
              const l = t.toLowerCase();
              if (t.length > 8 && t.length < 400 && !FLASH_JUNK.some(j => l.includes(j))) return t;
            }
          }
          // Page title fallback — strip Flash suffix
          const title = document.title.replace(/\s*[-|—]\s*(Flash.*|Compare.*|Best Price.*|Price Compare.*)$/i,'').trim();
          if (title.length > 5 && !FLASH_JUNK.some(j => title.toLowerCase().includes(j))) return title;
          return ''; // return empty — frontend will use "Product from <store>"
        })();

        // ── Product image ──
        // Priority: Flash CDN proxy → Amazon/Flipkart CDN → largest square non-logo img
        // NEVER return /merchants/ images (store logos) or /favicon images
        const productImage = (() => {
          function isLogoOrIcon(src, alt) {
            if (!src) return true;
            if (src.includes('/merchants/')) return true;
            if (src.includes('/favicon'))    return true;
            if (src.includes('faviconV2'))   return true;  // Google favicon service
            if (src.includes('/icons/'))     return true;
            if (/logo|icon/i.test(alt || '')) return true;
            if (src.includes('logo'))        return true;
            return false;
          }

          // 1. Flash CDN proxy — always a real product image
          for (const img of document.querySelectorAll('img')) {
            const src = img.src || '';
            if (/img\.flash\.co.*\/plain\//.test(src)) {
              try {
                const part = src.split('/plain/')[1];
                const decoded = decodeURIComponent(part.split('?')[0]);
                if (decoded.startsWith('http') && !isLogoOrIcon(decoded, img.alt)) return decoded;
                if (!isLogoOrIcon(src, img.alt)) return src;
              } catch { if (!isLogoOrIcon(src, img.alt)) return src; }
            }
          }

          // 2. Known product CDN patterns (Amazon / Flipkart / Myntra)
          for (const img of document.querySelectorAll('img')) {
            const src = img.src || '';
            if (isLogoOrIcon(src, img.alt)) continue;
            if (/media-amazon\.com|images-amazon\.com|_SL\d+_|_AC_SL|rukmini\d+\.flixcart|img\.flipkart|assets\.myntassets/.test(src)) {
              // Extra check: must be reasonably large
              const w = img.naturalWidth || img.width || 0;
              const h = img.naturalHeight || img.height || 0;
              if (w >= 60 && h >= 60) return src;
            }
          }

          // 3. Largest square-ish image that isn't a logo
          let best = '', bestScore = 0;
          for (const img of document.querySelectorAll('img')) {
            const src = img.src || '';
            if (src.length < 20 || isLogoOrIcon(src, img.alt)) continue;
            const w = img.naturalWidth  || img.width  || 0;
            const h = img.naturalHeight || img.height || 0;
            if (w < 80 || h < 80) continue;           // skip tiny images
            const ratio = Math.max(w, h) / Math.min(w, h);
            if (ratio > 4) continue;                   // skip banners/strips
            const score = w * h * (ratio < 1.3 ? 4 : ratio < 2 ? 2 : 1);
            if (score > bestScore) { bestScore = score; best = src; }
          }
          return best;
        })();

        // Deduplicate — keep lowest price per store
        const finalMap = {};
        for (const s of results) {
          const key = s.name.toLowerCase();
          if (!finalMap[key] || s.price < finalMap[key].price) finalMap[key] = s;
        }

        return {
          productName,
          productImage,
          sourceStore,
          stores: Object.values(finalMap),
          debug: {
            resultsCount: results.length,
            priceTagsOnPage: (document.body.innerText.match(/₹[\d,]+/g) || []).length,
          },
        };
      }, genericNames);

      console.log('[Flash/Puppeteer] Extraction debug:', JSON.stringify(extracted.debug));
      console.log('[Flash/Puppeteer] productName:', extracted.productName);
      console.log('[Flash/Puppeteer] productImage:', extracted.productImage ? extracted.productImage.substring(0, 120) : 'NONE');
      console.log('[Flash/Puppeteer] Stores found:', extracted.stores.length,
        extracted.stores.map(s => s.name + ':₹' + s.price + (s.outOfStock ? '[OOS]' : '')).join(' | '));

      if (extracted.stores.length === 0) {
        const html = await page.content();
        console.log('[Flash/Puppeteer] ❌ No stores. HTML sample:', html.substring(500, 2000));
        return {
          error:      'No prices found in DOM',
          pageHash,
          htmlSample: html.substring(0, 5000),
          pageLogs,
        };
      }

      return {
        ok: true,
        pageHash,
        data: {
          productName:  extracted.productName,
          productImage: extracted.productImage,
          sourceStore:  extracted.sourceStore,
          stores:       extracted.stores,   // direct array — compare/search reads rawData.stores
        },
        debug: extracted.debug,
      };

    } finally {
      await page.close().catch(() => {});
    }
  });
}

getFlashBrowser().catch(e => console.log('[Flash/Puppeteer] Startup launch failed (will retry):', e.message));

// ── Encode affiliate URL ──
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
      if (asin) {
        const cleanDisplay   = 'https://www.amazon.in/dp/' + asin;
        // Always use our tag — never use flashai or any other tag
        const affiliateClick = cleanDisplay + '?tag=smartpickd0be-21';
        return {
          displayUrl: cleanDisplay,
          clickUrl:   makeGoLink(affiliateClick),
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

// ── Store logo system ──
// Known official logos for major stores
const STORE_LOGOS = {
  'Amazon':          'https://logo.clearbit.com/amazon.in',
  'Flipkart':        'https://logo.clearbit.com/flipkart.com',
  'Myntra':          'https://logo.clearbit.com/myntra.com',
  'Ajio':            'https://logo.clearbit.com/ajio.com',
  'Nykaa':           'https://logo.clearbit.com/nykaa.com',
  'TataCliq':        'https://logo.clearbit.com/tatacliq.com',
  'Croma':           'https://logo.clearbit.com/croma.com',
  'Snapdeal':        'https://logo.clearbit.com/snapdeal.com',
  'Meesho':          'https://logo.clearbit.com/meesho.com',
  'JioMart':         'https://logo.clearbit.com/jiomart.com',
  'BigBasket':       'https://logo.clearbit.com/bigbasket.com',
  'Zepto':           'https://logo.clearbit.com/zeptonow.com',
  'Blinkit':         'https://logo.clearbit.com/blinkit.com',
  'Swiggy':          'https://logo.clearbit.com/swiggy.com',
  'FirstCry':        'https://logo.clearbit.com/firstcry.com',
  'Netmeds':         'https://logo.clearbit.com/netmeds.com',
  'Lenskart':        'https://logo.clearbit.com/lenskart.com',
  'Reliance Digital':'https://logo.clearbit.com/reliancedigital.in',
  'Vijay Sales':     'https://logo.clearbit.com/vijaysales.com',
  'Bajaj Markets':   'https://logo.clearbit.com/bajajfinservmarkets.in',
  'Zebrs':           'https://logo.clearbit.com/zebrs.com',
  'Poorvika':        'https://logo.clearbit.com/poorvika.com',
  'Sangeetha':       'https://logo.clearbit.com/sangeetha.com',
  'Fire-Boltt':      'https://logo.clearbit.com/fireboltt.com',
  'Boat':            'https://logo.clearbit.com/boat-lifestyle.com',
  'GadgetsNow':      'https://logo.clearbit.com/gadgetsnow.com',
  'Shopsy':          'https://logo.clearbit.com/shopsy.in',
  'Pepperfry':       'https://logo.clearbit.com/pepperfry.com',
  'Decathlon':       'https://logo.clearbit.com/decathlon.co.in',
  'Noise':           'https://logo.clearbit.com/gonoise.com',
  'VleBazaar':       'https://logo.clearbit.com/vlebazaar.in',
  'Bajaj Markets':   'https://logo.clearbit.com/bajajfinservmarkets.in',
};

// In-memory logo cache for unknown stores (domain → logo url)
const _logoCache = new Map();

async function getStoreLogo(storeName, storeUrl) {
  // 1. Check hardcoded map first
  if (STORE_LOGOS[storeName]) return STORE_LOGOS[storeName];

  // 2. Check in-memory cache
  let domain = '';
  try { domain = new URL(storeUrl || '').hostname.replace('www.', ''); } catch(e) {}
  if (!domain) return '';

  if (_logoCache.has(domain)) return _logoCache.get(domain);

  // 3. Fetch via Google Favicon API (reliable, no auth needed)
  try {
    const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
    // Verify it's not the default Google favicon (16x16 grey globe)
    const r = await fetch(faviconUrl, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const logo = faviconUrl;
      _logoCache.set(domain, logo);
      console.log('[Logo] Cached favicon for:', domain);
      return logo;
    }
  } catch(e) {}

  // 4. Fallback: Clearbit logo API
  try {
    const clearbitUrl = `https://logo.clearbit.com/${domain}`;
    const r = await fetch(clearbitUrl, { signal: AbortSignal.timeout(3000) });
    if (r.ok && r.headers.get('content-type')?.includes('image')) {
      _logoCache.set(domain, clearbitUrl);
      return clearbitUrl;
    }
  } catch(e) {}

  return '';
}

// ── GET /store-logo?store=Amazon&url=https://... ──
app.get('/store-logo', async (req, res) => {
  const { store, url } = req.query;
  if (!store) return res.status(400).json({ error: 'Pass ?store=' });
  const logo = await getStoreLogo(store, url || '');
  return res.json({ store, logo });
});


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
// Render sync removed — VPS is the only backend now

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
      'accessToken': extrapeTokenCache.accessToken,
      'Content-Type': 'application/json',
      'Origin': 'https://www.extrape.com',
      'Referer': 'https://www.extrape.com/link-converter',
      'rememberMeToken': extrapeTokenCache.rememberToken,
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
    // Ensure store is detected — use URL detection if store is still Unknown
    const finalStore = (req.store && req.store !== 'Unknown')
      ? req.store
      : (detectStoreFromUrl(req.url) || detectStoreFromUrl(req.affiliateLink || '') || 'Unknown');
    req.store = finalStore;
    // Only track the affiliate link if it's meaningfully different from the input URL
    // amzn.in short links return themselves — skip to avoid duplicate dashboard entries
    const trackUrl = req.displayLink || req.affiliateLink || req.url;
    const isDifferent = trackUrl !== req.url &&
      !(req.url.includes('amzn.in') && trackUrl.includes('amzn.in')) &&
      !(req.url.includes('fkrt.co') && trackUrl.includes('fkrt.co'));
    if (isDifferent) {
      trackConversion(trackUrl, finalStore, 'done', req.affiliateLink);
    } else {
      // Still track but with the affiliate link as the stored URL
      trackConversion(req.affiliateLink || trackUrl, finalStore, 'done', req.affiliateLink);
    }
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
  if (s.includes('amazon'))                                       return 'Amazon';
  if (s.includes('flipkart'))                                     return 'Flipkart';
  if (s.includes('myntra'))                                       return 'Myntra';
  if (s.includes('ajio'))                                         return 'Ajio';
  if (s.includes('nykaa'))                                        return 'Nykaa';
  if (s.includes('tatacliq') || s.includes('tata cliq'))         return 'TataCliq';
  if (s.includes('croma'))                                        return 'Croma';
  if (s.includes('snapdeal'))                                     return 'Snapdeal';
  if (s.includes('meesho'))                                       return 'Meesho';
  if (s.includes('jiomart') || s.includes('jio mart'))           return 'JioMart';
  if (s.includes('reliance digital') || s.includes('reliancedigital')) return 'Reliance Digital';
  if (s.includes('vijay sales') || s.includes('vijaysales'))     return 'Vijay Sales';
  if (s.includes('netmeds'))                                      return 'Netmeds';
  if (s.includes('lenskart'))                                     return 'Lenskart';
  if (s.includes('pepperfry'))                                    return 'Pepperfry';
  if (s.includes('firstcry'))                                     return 'FirstCry';
  if (s.includes('bigbasket') || s.includes('big basket'))       return 'BigBasket';
  if (s.includes('zepto'))                                        return 'Zepto';
  if (s.includes('blinkit') || s.includes('grofers'))            return 'Blinkit';
  if (s.includes('swiggy instamart') || s.includes('instamart')) return 'Swiggy Instamart';
  if (s.includes('pai international') || s.includes('paiinternational')) return 'PAI International';
  if (s.includes('poorvika'))                                     return 'Poorvika';
  if (s === 'apple' || s.includes('apple.com') || s.includes('apple store')) return 'Apple Store';
  if (s.includes('sangeetha'))                                    return 'Sangeetha';
  if (s.includes('chroma') || s.includes('croma'))               return 'Croma';
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
    if (host === 'amzn.in'  || host === 'amzn.to') return true;   // Amazon short links
    if (host === 'fkrt.co')  return true;                           // Flipkart native short
    if (host === 'ajiio.co') return true;                           // Ajio ExtraPe short
    if (host === 'bilty.co') return true;                           // Croma ExtraPe short
    if (host === 'myntr.co') return true;                           // Myntra ExtraPe short
    // dl.flipkart.com: only treat as a short link if there's no /p/itm product path embedded
    // URLs like /dl/slug/p/itmbff478... already contain the full product info — just rewrite domain
    if (host === 'dl.flipkart.com') {
      const pathname = new URL(productUrl).pathname;
      const hasProductPath = /\/p\/itm[a-z0-9]+/i.test(pathname);
      return !hasProductPath; // if it has the itm path, we can rewrite directly — not a "short" URL
    }
    return false;
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
async function bhkGetMultiStorePrices(internalPid, srcPid, srcPos, productName) {
  // Strategy: fetch the Buyhatke product page HTML and parse the SvelteKit
  // deduplication pool embedded in the <script> tag. SvelteKit SSR bakes
  // all page data — including cross-store prices — into the HTML as:
  //   <script>__sveltekit_data = [...]</script>  or
  //   preloadData([...]) / window.__data = [...]
  // This works from our server even when /__data.json returns 403.

  const rawResponses = [];

  // Build Buyhatke product page URL
  const srcStoreSlug = {
    63:'amazon', 2:'flipkart', 111:'myntra', 2191:'ajio', 1830:'nykaa',
    71:'croma', 129:'snapdeal', 2190:'tatacliq', 7376:'meesho',
    6660:'jiomart', 6607:'reliance-digital', 6645:'vijay-sales',
  }[srcPos] || 'amazon';

  const slug = (productName || srcPid)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .split('-').slice(0, 12).join('-');

  const bhkPageUrl = `https://buyhatke.com/${srcStoreSlug}-${slug}-price-in-india-${srcPos}-${internalPid}`;
  console.log('[BHK] Fetching page HTML:', bhkPageUrl.substring(0, 100));

  try {
    const r = await fetch(bhkPageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'en-IN,en;q=0.9',
        'Referer': 'https://buyhatke.com/',
      },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });

    const html = await r.text();
    console.log('[BHK] HTML length:', html.length, '| status:', r.status, '| final URL:', r.url.substring(0,80));
    rawResponses.push({ step: 'html-fetch', status: r.status, htmlLength: html.length });

    // SvelteKit bakes page data into HTML in several patterns — try all of them
    const pools = extractAllSvelteKitPools(html);
    console.log('[BHK] Found', pools.length, 'candidate data pools in HTML');

    for (const pool of pools) {
      const items = parsePricePool(pool);
      if (items && items.length > 0) {
        console.log('[BHK] ✅ HTML page data → ' + items.length + ' stores:', items.map(s=>s.name+':₹'+s.price).join(' | '));
        rawResponses.push({ step: 'html-parse', storesFound: items.length, poolSize: pool.length });
        return { items, endpoint: bhkPageUrl, rawResponses };
      }
    }

    // Log first 2KB of HTML for diagnosis if no data found
    rawResponses.push({ step: 'html-parse', note: 'no price data found in any pool', htmlPreview: html.substring(0, 300) });
    console.log('[BHK] HTML sample:', html.substring(0, 500));

  } catch(e) {
    console.log('[BHK] HTML fetch failed:', e.message);
    rawResponses.push({ step: 'html-fetch', error: e.message });
  }

  // Fallback: thunder with source pair
  try {
    const plR = await fetch(`https://buyhatke.com/api/posList?internalPid=${internalPid}`,
      { headers: BHK_HEADERS, signal: AbortSignal.timeout(8000) });
    const plD = await plR.json();
    if (plD.status === 1 && plD.data) {
      const tR = await fetch('https://search-new.bitbns.com/buyhatke/thunder/priceData', {
        method: 'POST',
        headers: { ...BHK_XHR_HEADERS, 'Content-Type': 'application/json', 'Referer': 'https://buyhatke.com/' },
        body: JSON.stringify({ param: [[srcPos, srcPid]] }),
        signal: AbortSignal.timeout(10000),
      });
      const tD = await tR.json();
      if (tD.status === 1 && tD.data) {
        const items = parseThunderResponse(tD, plD.data);
        if (items.length > 1) {
          rawResponses.push({ step: 'thunder-fallback', storesFound: items.length });
          return { items, endpoint: 'thunder', rawResponses };
        }
      }
    }
  } catch(e) { rawResponses.push({ step: 'thunder-fallback', error: e.message }); }

  return { items: [], endpoint: null, rawResponses };
}

// Parse Buyhatke HTML — finds the kit.start() SvelteKit call and extracts embedded page data.
// Confirmed structure (May 2026): kit.start(app, element, { node_ids:[0,3,25], data:[...] })
// The product data is in the third node (index 2) of the data array.
function extractAllSvelteKitPools(html) {
  const pools = [];

  // Find kit.start directly in the full HTML string — no regex needed for location
  const kitIdx = html.indexOf('kit.start(');
  if (kitIdx === -1) {
    console.log('[BHK] kit.start not found in HTML');
    return pools;
  }

  // Find the data: [ array after kit.start
  const dataKey = html.indexOf('data:', kitIdx);
  if (dataKey === -1) { console.log('[BHK] data: key not found'); return pools; }

  const arrOpen = html.indexOf('[', dataKey);
  if (arrOpen === -1) { console.log('[BHK] [ not found after data:'); return pools; }

  // Walk forward counting brackets to find the matching ]
  let depth = 0, inStr = false, strChar = '';
  let i = arrOpen;
  for (; i < Math.min(html.length, arrOpen + 200000); i++) {
    const c = html[i];
    if (inStr) {
      if (c === strChar && html[i-1] !== '\\') inStr = false;
    } else if (c === '"' || c === "'") {
      inStr = true; strChar = c;
    } else if (c === '[' || c === '{') {
      depth++;
    } else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) break;
    }
  }

  const rawArr = html.slice(arrOpen, i + 1);
  console.log('[BHK] kit.start data array extracted, length:', rawArr.length);

  // Convert JS object literal (unquoted keys) to valid JSON
  // Only quote keys that are bare identifiers (not already quoted)
  try {
    const jsonStr = rawArr
      // Quote unquoted object keys: handles {key: and ,key: and { key:
      .replace(/([{,\[]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, (m, pre, key) => pre + '"' + key + '":')
      .replace(/:\s*undefined/g, ':null')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed)) {
      console.log('[BHK] Parsed data array, length:', parsed.length);
      parsed.forEach((node, idx) => {
        if (node && node.data && typeof node.data === 'object') {
          console.log('[BHK] Node', idx, 'data keys:', Object.keys(node.data).slice(0, 8).join(','));
          pools.push(node.data);
        }
      });
    }
  } catch(e) {
    console.log('[BHK] JSON parse failed:', e.message.substring(0, 100));
    // JSON parse failed — try a targeted regex extraction of price objects instead
    // Look for objects with cur_price field directly in the raw array string
    const priceRe = /\{[^{}]{0,500}cur_price["']?\s*:\s*(\d+)[^{}]{0,500}\}/g;
    let pm;
    while ((pm = priceRe.exec(rawArr)) !== null) {
      try {
        const o = JSON.parse(pm[0].replace(/([{,])\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":'));
        if (o.cur_price) pools.push(o);
      } catch(e2) {}
    }
    console.log('[BHK] Regex fallback found', pools.length, 'price objects');
  }

  console.log('[BHK] Total pools found:', pools.length);
  return pools;
}


// Recursively scan any object/array for store price entries
function parsePricePool(pool) {
  const storeMap = {};
  const scan = (obj, depth) => {
    if (!obj || typeof obj !== 'object' || depth > 8) return;
    if (Array.isArray(obj)) { obj.forEach(v => scan(v, depth+1)); return; }
    // Special: _raw string — scan for cur_price patterns inline
    if (obj._raw) {
      const re = /cur_price["']?:\s*(\d+)/g;
      let mm; while ((mm = re.exec(obj._raw)) !== null) {
        console.log('[BHK] raw cur_price hit:', mm[1]);
      }
      return;
    }
    const rawPrice = obj.cur_price || obj.price || obj.offerPrice || obj.storePrice || 0;
    const price = parseFloat(String(rawPrice).replace(/[^0-9.]/g, '')) || 0;
    const rawName = obj.site_name || obj.siteName || obj.storeName || obj.store_name || obj.name || '';
    const name = normalizeStore(rawName);
    const link = obj.link || obj.url || obj.productURL || obj.product_url || '';
    if (price > 0 && name && link && link.startsWith('http')) {
      if (obj.inStock === 0 || obj.oos === 1) return;
      // Validate the URL domain matches the store — Buyhatke sometimes has wrong cached URLs
      // e.g. a Flipkart entry pointing to a microwave oven URL
      try {
        const linkHost = new URL(link).hostname.replace('www.','');
        const expectedDomains = {
          'Amazon':           ['amazon.in','amazon.com'],
          'Flipkart':         ['flipkart.com'],
          'Myntra':           ['myntra.com'],
          'Ajio':             ['ajio.com','luxe.ajio.com'],
          'Nykaa':            ['nykaa.com','nykaafashion.com','nykaaman.com'],
          'TataCliq':         ['tatacliq.com','luxury.tatacliq.com'],
          'Croma':            ['croma.com'],
          'Snapdeal':         ['snapdeal.com'],
          'Meesho':           ['meesho.com'],
          'JioMart':          ['jiomart.com'],
          'Reliance Digital': ['reliancedigital.in'],
          'Vijay Sales':      ['vijaysales.com'],
          'BigBasket':        ['bigbasket.com','bb.com'],
          'Pepperfry':        ['pepperfry.com'],
          'FirstCry':         ['firstcry.com'],
          'Netmeds':          ['netmeds.com'],
          'Zepto':            ['zeptonow.com','zepto.com'],
          'Blinkit':          ['blinkit.com','grofers.com'],
          'Swiggy Instamart': ['swiggy.com','instamart'],
          'PAI International':['paiinternational.com','maplestore.in'],
          'Poorvika':         ['poorvika.com'],
          'Apple Store':      ['apple.com'],
          'Sangeetha':        ['sangeetha.com'],
        };
        const allowed = expectedDomains[name] || [];
        if (allowed.length > 0 && !allowed.some(d => linkHost.includes(d))) {
          console.log('[BHK] Skipping wrong-domain URL for', name, ':', linkHost);
          return;  // skip this entry — URL domain doesn't match store
        }
      } catch(e) {}
      if (!storeMap[name] || price < storeMap[name].price) {
        storeMap[name] = { name, normalizedName: name, price, url: link };
        console.log('[BHK] Found store in pool:', name, '₹'+price);
      }
    }
    Object.values(obj).forEach(v => { if (v && typeof v === 'object') scan(v, depth+1); });
  };
  scan(pool, 0);
  return Object.values(storeMap);
}

// Parse SvelteKit __data.json deduplication pool to extract store prices.
// SvelteKit serialises page data as a flat array of values + index references.
// We search all objects in the pool for ones that look like store price entries.
function extractSvelteKitPrices(d) {
  const items = [];
  const storeMap = {};

  // Unwrap SvelteKit envelope: { type:'data', nodes: [{...}, { type:'data', data:[...] }] }
  let pool = null;
  if (d && d.nodes && Array.isArray(d.nodes)) {
    for (const node of d.nodes) {
      if (node && node.type === 'data' && Array.isArray(node.data)) {
        pool = node.data; break;
      }
    }
  }
  // Also try root-level array (some SvelteKit versions)
  if (!pool && Array.isArray(d)) pool = d;
  // Also try d.data
  if (!pool && d && Array.isArray(d.data)) pool = d.data;

  if (!pool) {
    console.log('[BHK] SvelteKit: no data pool found. Keys:', Object.keys(d || {}).join(','));
    return null;
  }

  console.log('[BHK] SvelteKit pool length:', pool.length, '| sample:', JSON.stringify(pool.slice(0,5)));

  // Scan all objects in pool for price/store data
  pool.forEach(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;

    // Look for store price objects — must have price and some store identifier
    const rawPrice = item.cur_price || item.price || item.offerPrice || item.storePrice || 0;
    const price    = parseFloat(String(rawPrice).replace(/[^0-9.]/g, '')) || 0;
    if (price <= 0) return;

    const rawName = item.site_name || item.storeName || item.store_name || item.name || '';
    const name    = normalizeStore(rawName);
    if (!name) return;

    const link = item.link || item.url || item.productURL || item.product_url || '';
    if (!link || !link.startsWith('http')) return;

    if (item.inStock === 0 || item.inStock === false || item.oos === 1) return;

    if (!storeMap[name] || price < storeMap[name].price) {
      storeMap[name] = { name, normalizedName: name, price, url: link };
    }
  });

  return Object.values(storeMap);
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
  let { items } = await bhkGetMultiStorePrices(internalPid, pid, pos, productName);
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
async function searchViaSerpAPI(url, srcStore, knownProductName = '') {
  if (!SERP_API_KEY) throw new Error('SERP_API_KEY not configured');

  // Use pre-known product name from Buyhatke if available — avoids fetching
  // Flipkart/store page titles which contain SEO noise like "Buy online at best price"
  const title = knownProductName || await fetchTitle(url);
  let shortQ = '';
  if (title && title.length > 5) {
    const core = title
      // Remove parenthetical content: (Mist Blue, 256 GB), [features] etc.
      .replace(/s*([^)]*)/g, '').replace(/s*[[^]]*]/g, '')
      // Stop at noise words
      .replace(/(with|for|up to|upto|comes|buy|online|india|featuring|at best).*/i, '')
      .replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/s+/g, ' ').trim();
    shortQ = core.split(' ').filter(w => w.length > 0).slice(0, 6).join(' ');
  }
  if (!shortQ) {
    try {
      const segs = new URL(url).pathname.split('/')
        .filter(s=>s.length>3&&!/^[A-Z0-9]{6,}$/.test(s)&&!/^(dp|p|product|item|buy|s|ip|d)$/i.test(s));
      shortQ = (segs[0]||'').replace(/-/g,' ').trim().split(' ').slice(0,6).join(' ');
    } catch(e) {}
  }
  // If shortQ still empty but we have an ASIN — search by ASIN directly (always works)
  if (!shortQ || shortQ.length < 3) {
    const asinM = url.match(/[/=]([A-Z0-9]{10})(?:[/?&]|$)/i);
    if (asinM) shortQ = asinM[1];
  }
  if (!shortQ || shortQ.length < 3) throw new Error('Could not identify product from URL');

  const fullTitle = title || shortQ;
  let asin = null;
  try {
    const m = new URL(url).pathname.match(/\/dp\/([A-Z0-9]{10})/i) ||
              new URL(url).pathname.match(/\/([A-Z0-9]{10})(?:\/|$)/i);
    if (m) asin = m[1];
  } catch(e) {}

  const brandModel = shortQ.split(' ').slice(0,4).join(' ');
  const q1 = asin ? (asin + ' ' + brandModel) : shortQ;
  const q2 = shortQ + ' price India';
  const q3 = brandModel;
  console.log('[SerpAPI] shortQ:', shortQ, '| Queries:', q1, '|', q2, '|', q3);

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

  // Include 2-char words (model numbers: "17", "5G", "M2" etc.) — critical for matching
  // e.g. "Apple iPhone 17" without "17" means ANY Apple iPhone matches at 100%
  const qWords = shortQ.toLowerCase().split(' ').filter(w=>w.length>1);
  function sim(t) {
    if (!t) return 0;
    const tl = t.toLowerCase();
    if (asin && tl.includes(asin.toLowerCase())) return 1.0;
    if (!qWords.length) return 0;
    return qWords.filter(w=>tl.includes(w)).length / qWords.length;
  }

  const TARGET = ['Amazon','Flipkart','Myntra','Ajio','Nykaa','TataCliq','Croma','Snapdeal',
                  'Meesho','Reliance Digital','Vijay Sales'];
  const storeMap = {};
  allResults.forEach(item => {
    const store = normalizeStore(item.source||'');
    if (!TARGET.includes(store)) return;
    const price = item.extracted_price || 0;
    if (!price) return;
    const s = sim(item.title);
    console.log('[SerpAPI]', store, '₹'+price, 'sim:'+Math.round(s*100)+'%', (item.title||'').substring(0,50));

    // 0.6 threshold — needs to match 60% of query words (model number included now)
    if (s < 0.6) { console.log('  → SKIP (sim ' + Math.round(s*100) + '%)'); return; }

    // Prefer direct store URL; accept Google Shopping page as fallback
    const storeDomains = ['amazon.in','flipkart.com','myntra.com','ajio.com','nykaa.com',
      'tatacliq.com','croma.com','snapdeal.com','meesho.com','reliancedigital.in','vijaysales.com'];
    let link = null;
    if (item.product_link) {
      try {
        const h = new URL(item.product_link).hostname.replace('www.','');
        if (storeDomains.some(d => h.includes(d))) link = item.product_link;
      } catch(e) {}
    }
    if (!link && item.link) {
      // Google Shopping product page (not a /search? page) is an acceptable fallback
      if (!item.link.includes('/search?') && item.link.includes('google.com')) {
        link = item.link;
      }
    }
    if (!link) { console.log('  → SKIP (no store link)'); return; }

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
// Routes flash.co API calls through the server using the token from env vars
// FLASH_AUTH_TOKEN and FLASH_DEVICE_ID are declared at the top of this file
const PROXY_URL = process.env.PROXY_URL || ''; // optional: residential proxy

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
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';
  // Resolve IP → location (country - region - city)
  let location = ip;
  try {
    if (ip && ip !== 'unknown' && !ip.startsWith('127.') && !ip.startsWith('::1')) {
      const geo = await fetch(`http://ip-api.com/json/${ip}?fields=countryCode,regionName,city`, {
        signal: AbortSignal.timeout(2000)
      }).then(r => r.json()).catch(() => null);
      if (geo && geo.countryCode) {
        location = [geo.city, geo.regionName, geo.countryCode].filter(Boolean).join(' - ');
      }
    }
  } catch(e) {}
  await trackVisit(location).catch(() => {});
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
      const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // last 30 days

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
  // Default: last 30 days (today-only filter hides most data)
  const nowUTC = Date.now();
  const defaultTo   = new Date(nowUTC);
  const defaultFrom = new Date(nowUTC - 30 * 24 * 60 * 60 * 1000);

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
  if (!extrapeTokenCache.accessToken) return res.status(500).json({ error:'EXTRAPE_ACCESS_TOKEN not set. Visit https://api.smartpickdeals.live/extrape/token-page' });
  // Detect store from URL if not provided or unknown
  const detectedStore = (store && store !== 'Unknown') ? store : (detectStoreFromUrl(url) || 'Unknown');
  const id = enqueue(url, detectedStore);
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

// ── Price comparison — Flash.co (replaces Buyhatke) ──
// Token managed server-side in env var — frontend needs no auth at all.
// Response shape is identical to the old Buyhatke version so the frontend needs no changes.
app.get('/compare/search', async (req, res) => {
  const { url: rawUrl } = req.query;
  if (!rawUrl) return res.status(400).json({ error: 'Pass ?url=' });

  const token    = flashTokenCache.token || '';
  const deviceId = flashTokenCache.deviceId || process.env.FLASH_DEVICE_ID || 'web-spd';
  if (!token) return res.status(503).json({ error: 'Flash token not set. Visit https://api.smartpickdeals.live/flash/token-page' });

  try {
    // ── URL normalisation ──
    let url = rawUrl;
    try {
      const pu = new URL(url);
      if (pu.hostname === 'dl.flipkart.com') {
        pu.hostname = 'www.flipkart.com';
        pu.pathname = pu.pathname.replace(/^\/dl\//, '/');
        url = pu.toString();
      }
    } catch(e) {}

    if (isShortUrl(url)) {
      try { url = await resolveRedirect(url); }
      catch(e) { return res.status(400).json({ error: 'Could not resolve short link. Open it in your browser, copy the full URL, and paste that instead.' }); }
    }

    // Strip tracking params that confuse Flash — always run after redirect resolution
    const STRIP_PARAMS = ['ref', 'ref_', 'social_share', 'iid', 'fm', 'hl_lid', 'lid',
      'srno', 'otracker', 'ssid', 'ov_redirect', '_refId', '_appId', 'ppt', 'ppn',
      'source', 'smid', 'psc', 'th', 'linkCode', 'tag', 'linkId', 'camp', 'creative',
      'ctx', 'BU', 'marketplace', '_encoding'];
    try {
      const pu2 = new URL(url);
      STRIP_PARAMS.forEach(p => pu2.searchParams.delete(p));
      url = pu2.toString();
    } catch(e) {}

    console.log('[Compare] URL:', url.substring(0, 100));

    const srcHost  = (() => { try { return new URL(url).hostname.replace('www.',''); } catch { return ''; } })();
    const srcStore = normalizeStore(srcHost.split('.')[0]) || '';

    // ── Step 1: Stream API → itemId + pageHash ──
    const flashHeaders = {
      'Authorization':  'Bearer ' + token,
      'Channel-Type':   'web',
      'Content-Type':   'application/json',
      'Origin':         'https://flash.co',
      'Referer':        'https://flash.co/',
      'User-Agent':     'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      'X-Country-Code': 'IN',
      'X-Device-Id':    deviceId,
      'X-Timezone':     'Asia/Calcutta',
      'Accept':         'application/json, text/event-stream, */*',
    };

    const streamParams = new URLSearchParams({
      source: 'APPEND', context: 'HOME_URL_PASTE',
      user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      device_type: 'DESKTOP', country_code: 'IN',
    });

    console.log('[Compare] Calling Flash stream API...');
    const sr = await fetch('https://apiv3.flash.tech/agents/chat/stream?' + streamParams, {
      method: 'POST', headers: flashHeaders,
      body: JSON.stringify({ query: url, context: 'HOME_URL_PASTE' }),
      signal: AbortSignal.timeout(40000),
    });

    if (!sr.ok) {
      if (sr.status === 401) { flashTokenCache.token = ''; return res.status(503).json({ error: 'Flash token expired. Renew at https://api.smartpickdeals.live/flash/token-page' }); }
      return res.status(502).json({ error: 'Flash stream returned ' + sr.status });
    }

    const streamText = await sr.text();
    console.log('[Compare] Stream sample:', streamText.substring(0, 300));

    // Extract webapp URL from INT_NAVIGATION event — Flash uses multiple formats:
    // Format A: webapp.flash.co/item/273023/h/ce9vnppi
    // Format B: webapp.flash.co/product-search/MewW_YRY
    // Format C: flash.co/product-details/FZBL5L7N
    // Format D: flash.co/item/123/slug/h/hash
    let itemId    = null;
    let pageHash  = null;
    let webappUrl = null;

    // Format A: item/{id}/h/{hash}
    const navMatchA = streamText.match(/webapp\.flash\.co\/item\/(\d+)\/h\/([A-Za-z0-9_-]+)/);
    if (navMatchA) {
      itemId = navMatchA[1]; pageHash = navMatchA[2];
      webappUrl = `https://webapp.flash.co/item/${itemId}/h/${pageHash}`;
    }

    // Format B: product-search/{hash}
    if (!webappUrl) {
      const navMatchB = streamText.match(/webapp\.flash\.co\/product-search\/([A-Za-z0-9_-]{4,})/);
      if (navMatchB) { pageHash = navMatchB[1]; webappUrl = `https://webapp.flash.co/product-search/${pageHash}`; }
    }

    // Format C: flash.co/product-details/{hash} — navigate directly, itemId resolved from page
    if (!webappUrl) {
      const navMatchC = streamText.match(/flash\.co\/product-details\/([A-Za-z0-9_-]{4,})/);
      if (navMatchC) { pageHash = navMatchC[1]; webappUrl = `https://flash.co/product-details/${pageHash}`; }
    }

    // Format D: flash.co/item/{id}/...
    if (!webappUrl) {
      const navMatchD = streamText.match(/flash\.co\/item\/(\d+)\/[^/]+\/h\/([A-Za-z0-9_-]+)/);
      if (navMatchD) { itemId = navMatchD[1]; pageHash = navMatchD[2]; webappUrl = `https://webapp.flash.co/item/${itemId}/h/${pageHash}`; }
    }

    // Fallback: any /h/{hash} pattern
    if (!webappUrl) {
      for (const pat of [/price-compare\/(\d+)\/h\/([A-Za-z0-9_-]{4,})/, /\/h\/([A-Za-z0-9_-]{6,})/]) {
        const m = streamText.match(pat);
        if (m) {
          pageHash = m[2] || m[1];
          if (m[2]) itemId = m[1];
          webappUrl = `https://webapp.flash.co/product-search/${pageHash}`;
          break;
        }
      }
    }

    console.log('[Compare] itemId:', itemId, '| pageHash:', pageHash, '| webappUrl:', webappUrl);
    if (!webappUrl) {
      return res.status(404).json({ error: 'Flash.co has no comparison data for this product.', streamSample: streamText.substring(0, 300) });
    }
    console.log('[Compare] Opening in Puppeteer:', webappUrl);

    let quickStores = [];
    let itemPageMeta = { img: '', name: '' };
    const extracted = await withFlashBrowser(async () => {
      const browser = await getFlashBrowser();
      const page    = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

      // Intercept Flash's client-side API responses to capture store prices directly
      const interceptedData = [];
      await page.setRequestInterception(true);
      page.on('request', req => req.continue());
      page.on('response', async resp => {
        const url = resp.url();
        // Capture any Flash API response that might contain store prices
        if ((url.includes('apiv3.flash.tech') || url.includes('api.flash.co') || url.includes('webapp.flash.co')) &&
            !url.includes('/stream')) {
          try {
            const ct = resp.headers()['content-type'] || '';
            if (ct.includes('json')) {
              const json = await resp.json().catch(() => null);
              if (json) interceptedData.push({ url: url.substring(0, 100), data: json });
            }
          } catch(e) {}
        }
      });

      try {
        // ── Token injection — only visit flash.co homepage if not yet authenticated ──
        let needsAuth = true;
        try {
          const existing = await page.evaluate(() => {
            try { return !!localStorage.getItem('authToken'); } catch(e) { return false; }
          }).catch(() => false);
          if (existing) needsAuth = false;
        } catch(e) {}

        if (needsAuth) {
          await page.goto('https://flash.co', { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
          await page.evaluate((tok) => {
            try { localStorage.setItem('authToken', tok); } catch(e) {}
            try { localStorage.setItem('accessToken', tok); } catch(e) {}
          }, token);
        } else {
          await page.evaluate((tok) => {
            try { localStorage.setItem('authToken', tok); } catch(e) {}
            try { localStorage.setItem('accessToken', tok); } catch(e) {}
          }, token);
        }

        // ── FAST PATH: Go directly to price-compare (has ALL stores, no expand needed) ──
        const priceCompareUrl = itemId
          ? `https://flash.co/price-compare/${itemId}/h/${pageHash}`
          : null;

        if (priceCompareUrl) {
          // Fast path: go directly to price-compare — skips item page entirely
          console.log('[Compare/Puppeteer] Fast path → price-compare:', priceCompareUrl);
          await page.goto(priceCompareUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        } else if (webappUrl && webappUrl.includes('product-details')) {
          // Format C: flash.co/product-details/{hash} — click "Compare prices" to get to price-compare
          console.log('[Compare/Puppeteer] Product-details path:', webappUrl);
          await page.goto(webappUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await new Promise(r => setTimeout(r, 2000));
          // Extract itemId from page URL or API calls
          const pdUrl = page.url();
          const pdM = pdUrl.match(/\/item\/(\d+)\//) || pdUrl.match(/product-details\/\d+\/h\//) ;
          // Click "Compare prices" button
          const clicked = await page.evaluate(() => {
            for (const el of document.querySelectorAll('a, button, [role="button"]')) {
              const t = (el.textContent || '').toLowerCase().trim();
              if (/compare prices|view all stores|price compare|all \d+ stores/.test(t) && t.length < 60) {
                if (el.tagName === 'A' && el.href) return el.href;
                el.click(); return 'clicked';
              }
            }
            return null;
          }).catch(() => null);
          if (clicked && clicked.startsWith('http')) {
            await page.goto(clicked, { waitUntil: 'domcontentloaded', timeout: 20000 });
          } else if (clicked === 'clicked') {
            await new Promise(r => setTimeout(r, 2000));
          }
          // Try to extract itemId from current URL
          const afterUrl = page.url();
          const afterM = afterUrl.match(/\/item\/(\d+)\//) || afterUrl.match(/\/price-compare\/(\d+)\//);
          if (afterM && !itemId) { itemId = afterM[1]; }
          const afterH = afterUrl.match(/\/h\/([A-Za-z0-9_-]+)/);
          if (afterH) { pageHash = afterH[1]; }
          // If we now have itemId, navigate to price-compare
          if (itemId && pageHash) {
            const pc2 = `https://flash.co/price-compare/${itemId}/h/${pageHash}`;
            console.log('[Compare/Puppeteer] Product-details → price-compare:', pc2);
            await page.goto(pc2, { waitUntil: 'domcontentloaded', timeout: 20000 });
          }
        } else {
          // No itemId — navigate to product-search and wait for redirect to item page
          console.log('[Compare/Puppeteer] No itemId — navigating to:', webappUrl);
          await page.goto(webappUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          try {
            await page.waitForFunction(
              () => /\/item\/\d+\//.test(window.location.href) || /price-compare/.test(window.location.href),
              { timeout: 15000 }
            );
          } catch(e) {}
        }

        let loadedUrl = page.url();
        console.log('[Compare/Puppeteer] Loaded:', loadedUrl);

        // Extract itemId/pageHash from URL if not already set
        if (!itemId) {
          const m = loadedUrl.match(/\/item\/(\d+)\//) || loadedUrl.match(/\/price-compare\/(\d+)\//);
          if (m) { itemId = m[1]; console.log('[Compare/Puppeteer] itemId from URL:', itemId); }
        }
        if (loadedUrl.includes('/h/')) {
          const m = loadedUrl.match(/\/h\/([A-Za-z0-9_-]+)/);
          if (m && m[1] !== pageHash) { pageHash = m[1]; console.log('[Compare/Puppeteer] pageHash updated:', pageHash); }
        }

        // Handle product-details page — extract itemId from intercepted API calls
        if (loadedUrl.includes('product-details') && !itemId) {
          // Wait briefly for API calls to fire
          await new Promise(r => setTimeout(r, 2000));
          for (const { url: apiUrl } of interceptedData) {
            const m = apiUrl.match(/\/item\/(\d+)/) || apiUrl.match(/itemId[=:](\d+)/);
            if (m) { itemId = m[1]; console.log('[Compare/Puppeteer] itemId from API:', itemId); break; }
          }
          // Also try clicking "View all stores" / "Compare prices"
          const clicked = await page.evaluate(() => {
            for (const el of document.querySelectorAll('a, button, [role="button"]')) {
              const t = (el.textContent || '').toLowerCase().trim();
              if (/compare prices|view all|all stores|price compare/.test(t) && t.length < 50) {
                el.click(); return t;
              }
            }
            return null;
          }).catch(() => null);
          if (clicked) {
            console.log('[Compare/Puppeteer] Clicked on product-details:', clicked);
            await new Promise(r => setTimeout(r, 3000));
            loadedUrl = page.url();
            const m2 = loadedUrl.match(/\/item\/(\d+)\//) || loadedUrl.match(/\/price-compare\/(\d+)\//);
            if (m2 && !itemId) { itemId = m2[1]; }
            if (loadedUrl.includes('/h/')) { const m3 = loadedUrl.match(/\/h\/([A-Za-z0-9_-]+)/); if (m3) pageHash = m3[1]; }
          }
        }

        const isOnItemPage = /\/item\/\d+\//.test(loadedUrl) && !loadedUrl.includes('price-compare');

        if (isOnItemPage) {
          // Extract meta from item page then navigate to price-compare
          itemPageMeta = await page.evaluate(() => {
            const JUNK = ['flash ai','compare prices','best price','loading','price compare'];
            let img = '';
            const ogImg = document.querySelector('meta[property="og:image"]');
            if (ogImg) { const s = (ogImg.getAttribute('content')||'').trim(); if (s.startsWith('http') && !s.includes('/merchants/') && !s.includes('logo')) img = s; }
            if (!img) {
              for (const el of document.querySelectorAll('img')) {
                const s = el.src || '';
                if (!s || s.includes('/merchants/') || s.includes('/favicon') || s.includes('logo')) continue;
                if (/img\.flash\.co.*\/plain\//.test(s)) { try { const d = decodeURIComponent(s.split('/plain/')[1].split('?')[0]); img = d.startsWith('http') ? d : s; break; } catch { img = s; break; } }
                if (/media-amazon\.com|rukmini\d+\.flixcart|img\.flipkart|fireboltt\.com/.test(s)) { img = s; break; }
              }
            }
            let name = '';
            const ogTitle = document.querySelector('meta[property="og:title"]');
            if (ogTitle) { const t = (ogTitle.getAttribute('content')||'').trim(); if (t.length > 8 && !JUNK.some(j => t.toLowerCase().includes(j))) name = t; }
            if (!name) { for (const el of document.querySelectorAll('h1,h2')) { const t = el.textContent.trim(); if (t.length > 8 && t.length < 400 && !JUNK.some(j => t.toLowerCase().includes(j))) { name = t; break; } } }
            return { img, name };
          }).catch(() => ({ img: '', name: '' }));
          console.log('[Compare/Puppeteer] Item meta:', itemPageMeta.name.substring(0,40));

          // Navigate to price-compare
          if (itemId && pageHash) {
            const pc = `https://flash.co/price-compare/${itemId}/h/${pageHash}`;
            await page.goto(pc, { waitUntil: 'domcontentloaded', timeout: 20000 });
            console.log('[Compare/Puppeteer] Navigated to price-compare:', page.url());
            loadedUrl = page.url();
          }
        } else {
          // On price-compare or product-details — try og:image then product CDN images
          itemPageMeta = await page.evaluate(() => {
            const JUNK = ['flash ai','compare prices','best price','loading','price compare'];
            let img = '';
            // 1. og:image
            const ogImg = document.querySelector('meta[property="og:image"]');
            if (ogImg) { const s = (ogImg.getAttribute('content')||'').trim(); if (s.startsWith('http') && !s.includes('/merchants/') && !s.includes('logo')) img = s; }
            // 2. Flash CDN proxy images
            if (!img) {
              for (const el of document.querySelectorAll('img')) {
                const s = el.src || '';
                if (!s || s.includes('/merchants/') || s.includes('/favicon') || s.includes('logo')) continue;
                if (/img\.flash\.co.*\/plain\//.test(s)) { try { const d = decodeURIComponent(s.split('/plain/')[1].split('?')[0]); img = d.startsWith('http') ? d : s; break; } catch { img = s; break; } }
              }
            }
            // 3. Known product CDN patterns
            if (!img) {
              for (const el of document.querySelectorAll('img')) {
                const s = el.src || '';
                if (!s || s.includes('/merchants/') || s.includes('/favicon') || s.includes('logo')) continue;
                if (/media-amazon\.com|images-amazon\.com|rukmini\d+\.flixcart|img\.flipkart|encrypted-tbn/.test(s)) { img = s; break; }
              }
            }
            // 4. Largest non-logo image
            if (!img) {
              let best = '', bestScore = 0;
              for (const el of document.querySelectorAll('img')) {
                const s = el.src || '';
                if (!s || s.includes('/merchants/') || s.includes('/favicon') || s.includes('logo') || s.length < 30) continue;
                const w = el.naturalWidth || el.width || 0, h = el.naturalHeight || el.height || 0;
                if (w < 60 || h < 60) continue;
                const ratio = Math.max(w,h)/Math.min(w,h);
                const score = w * h * (ratio < 1.5 ? 3 : ratio < 3 ? 1 : 0.1);
                if (score > bestScore) { bestScore = score; best = s; }
              }
              img = best;
            }
            let name = '';
            const ogTitle = document.querySelector('meta[property="og:title"]');
            if (ogTitle) { const t = (ogTitle.getAttribute('content')||'').trim(); if (t.length > 8 && !JUNK.some(j => t.toLowerCase().includes(j))) name = t; }
            if (!name) { for (const el of document.querySelectorAll('h1,h2,[class*="product"],[class*="title"]')) { const t = el.textContent.trim(); if (t.length > 8 && t.length < 400 && !JUNK.some(j => t.toLowerCase().includes(j))) { name = t; break; } } }
            return { img, name };
          }).catch(() => ({ img: '', name: '' }));

          // If no image from price-compare page, visit the item page briefly to get it
          if (!itemPageMeta.img && itemId && pageHash) {
            try {
              const itemUrl = `https://flash.co/item/${itemId}/h/${pageHash}`;
              await page.goto(itemUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
              // Wait for og:image meta tag to be set (React renders it async)
              try {
                await page.waitForFunction(
                  () => !!document.querySelector('meta[property="og:image"]')?.getAttribute('content'),
                  { timeout: 5000 }
                );
              } catch(e) {}
              await new Promise(r => setTimeout(r, 1000));
              const metaFromItem = await page.evaluate(() => {
                const JUNK = ['flash ai','compare prices','best price','loading','price compare'];
                let img = '';
                const ogImg = document.querySelector('meta[property="og:image"]');
                if (ogImg) { const s = (ogImg.getAttribute('content')||'').trim(); if (s.startsWith('http') && !s.includes('/merchants/') && !s.includes('logo')) img = s; }
                if (!img) {
                  for (const el of document.querySelectorAll('img')) {
                    const s = el.src || '';
                    if (!s || s.includes('/merchants/') || s.includes('/favicon') || s.includes('logo')) continue;
                    if (/img\.flash\.co.*\/plain\//.test(s)) { try { const d = decodeURIComponent(s.split('/plain/')[1].split('?')[0]); img = d.startsWith('http') ? d : s; break; } catch { img = s; break; } }
                    if (/media-amazon\.com|rukmini\d+\.flixcart|img\.flipkart|fireboltt\.com|encrypted-tbn/.test(s)) { img = s; break; }
                  }
                }
                let name = '';
                const ogTitle = document.querySelector('meta[property="og:title"]');
                if (ogTitle) { const t = (ogTitle.getAttribute('content')||'').trim(); if (t.length > 8 && !JUNK.some(j => t.toLowerCase().includes(j))) name = t; }
                if (!name) { for (const el of document.querySelectorAll('h1,h2')) { const t = el.textContent.trim(); if (t.length > 8 && t.length < 400 && !JUNK.some(j => t.toLowerCase().includes(j))) { name = t; break; } } }
                return { img, name };
              }).catch(() => ({ img: '', name: '' }));
              if (metaFromItem.img) itemPageMeta.img = metaFromItem.img;
              if (metaFromItem.name && !itemPageMeta.name) itemPageMeta.name = metaFromItem.name;
              console.log('[Compare/Puppeteer] Image from item page:', itemPageMeta.img.substring(0,60));
              // Navigate back to price-compare
              const pcBack = `https://flash.co/price-compare/${itemId}/h/${pageHash}`;
              await page.goto(pcBack, { waitUntil: 'domcontentloaded', timeout: 15000 });
            } catch(e) { console.log('[Compare/Puppeteer] Item page image fetch failed:', e.message); }
          }

          console.log('[Compare/Puppeteer] Page meta — image:', itemPageMeta.img.substring(0,60), '| name:', itemPageMeta.name.substring(0,40));
        }

        // Wait for stores to appear — race between 3+ outbound links or 10s timeout
        try {
          await page.waitForFunction(() =>
            [...document.querySelectorAll('a[href]')]
              .filter(a => a.href && !a.href.includes('flash.co') && a.href.startsWith('http')).length >= 3,
            { timeout: 10000 }
          );
        } catch(e) { console.log('[Compare/Puppeteer] Store links wait timed out'); }

        // Click "view X more" / "view all" if present — some price-compare pages paginate
        const clicked3 = await page.evaluate(() => {
          for (const el of document.querySelectorAll('button, a, [role="button"], span, div, p')) {
            const t = (el.textContent || '').replace(/\s+/g, ' ').toLowerCase().trim();
            if (/view all|view \d+ more|show all|all stores|more stores/.test(t) && t.length < 60) {
              el.click(); return t;
            }
          }
          return null;
        }).catch(() => null);

        if (clicked3) {
          console.log('[Compare/Puppeteer] Clicked expand:', clicked3);
          await new Promise(r => setTimeout(r, 2000));
        }

        await new Promise(r => setTimeout(r, 600));
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await new Promise(r => setTimeout(r, 500));

        const pageTitle2 = await page.title().catch(() => '');
        const pageUrl2 = page.url();
        console.log('[Compare/Puppeteer] Title:', pageTitle2, '| URL:', pageUrl2.substring(0, 80));

        const linkCount2 = await page.evaluate(() =>
          [...document.querySelectorAll('a[href]')].filter(a => a.href && !a.href.includes('flash.co')).length
        ).catch(() => 0);
        console.log('[Compare/Puppeteer] Outbound links visible:', linkCount2);

        // Intercepted stores from API calls
        const interceptedStores = [];
        for (const { data } of interceptedData) {
          function digIntercepted(o, d, acc) {
            if (!o || d > 10 || typeof o !== 'object') return;
            if (Array.isArray(o)) {
              const items = o.filter(x => x && typeof x === 'object' &&
                (x.storeName || x.store_name || x.name || x.merchant || x.retailer) &&
                (x.price !== undefined || x.salePrice !== undefined || x.amount !== undefined));
              if (items.length >= 2) { acc.push(...items); return; }
              o.forEach(x => digIntercepted(x, d+1, acc));
            } else { Object.values(o).forEach(v => digIntercepted(v, d+1, acc)); }
          }
          digIntercepted(data, 0, interceptedStores);
        }
        console.log('[Compare/Puppeteer] Intercepted stores:', interceptedStores.length);


        // ── Quick per-link card extraction (price-compare page) ──
        quickStores = await page.evaluate(() => {
          const STORE_MAP = {
            'amazon': 'Amazon', 'flipkart': 'Flipkart', 'myntra': 'Myntra',
            'ajio': 'Ajio', 'nykaa': 'Nykaa', 'tatacliq': 'TataCliq',
            'croma': 'Croma', 'snapdeal': 'Snapdeal', 'meesho': 'Meesho',
            'jiomart': 'JioMart', 'bigbasket': 'BigBasket', 'zepto': 'Zepto',
            'blinkit': 'Blinkit', 'swiggy': 'Swiggy', 'firstcry': 'FirstCry',
            'netmeds': 'Netmeds', 'lenskart': 'Lenskart',
            'reliancedigital': 'Reliance Digital', 'vijaysales': 'Vijay Sales',
            'zebrs': 'Zebrs', 'poorvika': 'Poorvika', 'sangeetha': 'Sangeetha',
            'fireboltt': 'Fire-Boltt', 'fire-boltt': 'Fire-Boltt',
            'boat-lifestyle': 'Boat', 'vlebazaar': 'VleBazaar',
            'gadgetsnow': 'GadgetsNow', 'bajajfinserv': 'Bajaj Markets',
            'dailydeals365': 'DailyDeals365', 'shopclues': 'ShopClues',
            'pepperfry': 'Pepperfry', 'decathlon': 'Decathlon',
            'mamaearth': 'Mamaearth', 'purplle': 'Purplle',
            'nykaafashion': 'Nykaa Fashion', 'bewakoof': 'Bewakoof',
            'paytmmall': 'Paytm Mall', 'tatadigital': 'Tata Digital',
            'infibeam': 'Infibeam', 'shopsy': 'Shopsy',
            'samsungshop': 'Samsung Shop', 'oneplusstore': 'OnePlus Store',
            'realme': 'Realme Store', 'mi.com': 'Mi Store', 'mi store': 'Mi Store',
            'apple': 'Apple Store', 'gonoise': 'Noise',
          };

          // Unwrap redirect URLs to find the real store
          function unwrapUrl(href) {
            try {
              const u = new URL(href);
              const ulp = u.searchParams.get('ulp') || u.searchParams.get('url') ||
                          u.searchParams.get('dest') || u.searchParams.get('target');
              return ulp ? decodeURIComponent(ulp) : href;
            } catch(e) { return href; }
          }
          const seen = new Set();
          const result = [];
          document.querySelectorAll('a[href]').forEach(a => {
            if (!a.href || a.href.includes('flash.co') || !a.href.startsWith('http')) return;
            // Unwrap redirect wrappers (linksredirect.com, tjzuh.com etc.)
            const checkUrl = unwrapUrl(a.href);
            const hl = checkUrl.toLowerCase();
            const storeKey = Object.keys(STORE_MAP).find(k => hl.includes(k));
            if (!storeKey) return;
            const name = STORE_MAP[storeKey];
            if (seen.has(name)) return;

            // Individual store card on Flash price-compare is ~50-150 chars
            let card = a.closest('.block.cursor-pointer') || a.closest('[class*="cursor-pointer"]');
            if (!card || (card.textContent || '').length > 300) {
              card = a.parentElement;
              let best = null;
              for (let d = 0; d < 8 && card; d++) {
                const txt = card.textContent || '';
                if (txt.length > 300) break;
                if (/₹[\d,]+/.test(txt)) best = card;
                card = card.parentElement;
              }
              card = best || a.parentElement;
            }

            const cardText = card ? (card.textContent || '') : '';
            const amounts = [...(cardText.match(/₹[\d,]+/g) || [])]
              .map(s => parseInt(s.replace(/[^0-9]/g, '')))
              .filter(p => p >= 200 && p <= 5000000);
            if (!amounts.length) return;

            // Price picking: if amounts span a huge ratio (e.g. ₹3910 vs ₹134900),
            // the card is bleeding — take the MAX (actual price, not instalment/badge).
            // Otherwise take LAST (Flash renders savings badge first, store price last).
            const minAmt = Math.min(...amounts);
            const maxAmt = Math.max(...amounts);
            const price = (maxAmt / minAmt > 5) ? maxAmt : amounts[amounts.length - 1];

            seen.add(name);
            result.push({
              name, price, url: a.href,
              outOfStock:  /out of stock|unavailable|sold out/i.test(cardText),
              isSource:    /you came from here/i.test(cardText),
              lowestPrice: /lowest price|best price/i.test(cardText),
              savingsBadge: (cardText.match(/save\s*₹[\d,]+[^.\n]*/i) || [''])[0].trim().substring(0, 50),
            });
          });
          return result;
        }).catch(() => []);
        console.log('[Compare/Puppeteer] Quick stores:', quickStores.map(s => s.name + ':₹' + s.price).join(' | '));

        // ── DOM Extraction Strategy A/B (fallback) ──
        const strategyABStores = await page.evaluate((intercepted) => {
          function normName(raw) {
            const l = (raw||'').toLowerCase().trim();
            if (l.includes('amazon'))    return 'Amazon';
            if (l.includes('flipkart'))  return 'Flipkart';
            if (l.includes('myntra'))    return 'Myntra';
            if (l.includes('ajio'))      return 'Ajio';
            if (l.includes('nykaa'))     return 'Nykaa';
            if (l.includes('tatacliq') || l === 'tata cliq') return 'TataCliq';
            if (l.includes('croma'))     return 'Croma';
            if (l.includes('snapdeal'))  return 'Snapdeal';
            if (l.includes('meesho'))    return 'Meesho';
            if (l.includes('jiomart'))   return 'JioMart';
            if (l.includes('bigbasket')) return 'BigBasket';
            if (l.includes('zepto'))     return 'Zepto';
            if (l.includes('blinkit'))   return 'Blinkit';
            if (l.includes('swiggy'))    return 'Swiggy';
            if (l.includes('firstcry'))  return 'FirstCry';
            if (l.includes('netmeds'))   return 'Netmeds';
            if (l.includes('lenskart'))  return 'Lenskart';
            if (l.includes('boat'))      return 'Boat';
            if (l.includes('zebrs'))     return 'Zebrs';
            if (l.includes('reliance'))  return 'Reliance Digital';
            if (l.includes('vijay'))     return 'Vijay Sales';
            if (l.includes('fire-boltt') || l.includes('fireboltt')) return 'Fire-Boltt';
            if (l.includes('poorvika'))  return 'Poorvika';
            if (l.includes('sangeetha')) return 'Sangeetha';
            return '';
          }

          function parsePrice(text) {
            const m = (text||'').trim().match(/^₹\s*([\d,]+)$/);
            if (!m) return 0;
            const p = parseInt(m[1].replace(/,/g,''));
            return (p >= 100 && p <= 10000000) ? p : 0;
          }

          function isDiscountContext(el) {
            for (let p = el.parentElement, i = 0; p && i < 4; p = p.parentElement, i++) {
              const t = (p.textContent||'').toLowerCase();
              if (t.length < 80 && /\b(off|save|saved|cashback|extra)\b/.test(t)) return true;
            }
            return false;
          }

          const STORE_DOMAINS = {
            'amazon': 'Amazon', 'flipkart': 'Flipkart', 'myntra': 'Myntra',
            'ajio': 'Ajio', 'nykaa': 'Nykaa', 'tatacliq': 'TataCliq',
            'croma': 'Croma', 'snapdeal': 'Snapdeal', 'meesho': 'Meesho',
            'jiomart': 'JioMart', 'bigbasket': 'BigBasket', 'zepto': 'Zepto',
            'blinkit': 'Blinkit', 'swiggy': 'Swiggy', 'firstcry': 'FirstCry',
            'netmeds': 'Netmeds', 'lenskart': 'Lenskart',
            'boat-lifestyle': 'Boat', 'gonoise': 'Noise', 'zebrs': 'Zebrs',
            'reliancedigital': 'Reliance Digital', 'vijaysales': 'Vijay Sales',
            'linksredirect.com': null, // redirect wrapper — check ulp param
            'tjzuh.com': null,         // redirect wrapper — check ulp param
          };

          function storeFromUrl(href) {
            try {
              const u = new URL(href);
              // Unwrap redirect params
              const ulp = u.searchParams.get('ulp') || u.searchParams.get('url') || u.searchParams.get('dest');
              const checkUrl = ulp || href;
              const hl = checkUrl.toLowerCase();
              for (const [domain, name] of Object.entries(STORE_DOMAINS)) {
                if (name && hl.includes(domain)) return { name, url: href };
              }
              // Generic hostname match
              const host = new URL(checkUrl).hostname.replace('www.','');
              const n = normName(host.split('.')[0]);
              return n ? { name: n, url: href } : null;
            } catch(e) { return null; }
          }

          function findPriceInCard(container) {
            // Only search within containers that aren't too large (avoid getting page-level prices)
            // If the container has too much text, it's too broad
            if ((container.textContent || '').length > 1000) return 0;
            let best = 0;
            const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
            let node;
            while ((node = walker.nextNode())) {
              const p = parsePrice(node.textContent);
              if (p > 0 && !isDiscountContext(node.parentElement)) {
                if (p > best) best = p;
              }
            }
            return best;
          }

          const seen = new Set();
          const stores = [];

          // ── Strategy A: Link-first extraction ──
          // Find every outbound link, identify its store, then find the price
          // in the same card by walking up the DOM tree
          document.querySelectorAll('a[href]').forEach(a => {
            const href = a.href || '';
            if (!href || href.includes('flash.co') || href.includes('webapp.flash') || href === '#') return;
            if (!href.startsWith('http')) return;

            const storeInfo = storeFromUrl(href);
            if (!storeInfo) return;
            const { name } = storeInfo;
            if (seen.has(name.toLowerCase())) return;

            // Walk up from the link to find a container with a price
            let price = 0;
            let container = a.parentElement;
            for (let depth = 0; depth < 10 && container && !price; depth++) {
              price = findPriceInCard(container);
              container = container.parentElement;
            }
            if (!price) return;

            // Get card context for metadata
            const cardEl = a.closest('[class]') || a.parentElement;
            const cardText = (cardEl ? cardEl.textContent : '').toLowerCase();
            const isSource   = /you came from here/i.test(cardText);
            const outOfStock = /out of stock|unavailable|sold out/i.test(cardText);
            const lowestPrc  = /lowest price|best price/i.test(cardText);
            const saveM      = cardText.match(/save\s*₹[\d,]+/i);

            seen.add(name.toLowerCase());
            stores.push({
              name, price, url: href,
              outOfStock, isSource, lowestPrice: lowestPrc,
              savingsBadge: saveM ? saveM[0].trim() : '',
            });
          });

          // ── Strategy B: Image alt + price proximity ──
          // For store logos with alt text, find the nearest price node
          if (stores.length < 2) {
            document.querySelectorAll('img[alt]').forEach(img => {
              const alt = (img.alt || '').trim();
              const name = normName(alt);
              if (!name || seen.has(name.toLowerCase())) return;

              let price = 0;
              let container = img.parentElement;
              for (let depth = 0; depth < 10 && container && !price; depth++) {
                price = findPriceInCard(container);
                container = container.parentElement;
              }
              if (!price) return;

              // Find the store link from nearby anchors
              let url = '';
              const cardEl = img.closest('[class]') || img.parentElement;
              if (cardEl) {
                for (const a of cardEl.querySelectorAll('a[href]')) {
                  if (a.href && !a.href.includes('flash.co') && a.href.startsWith('http')) {
                    url = a.href; break;
                  }
                }
              }

              seen.add(name.toLowerCase());
              stores.push({ name, price, url, outOfStock: false, isSource: false, lowestPrice: false, savingsBadge: '' });
            });
          }

          return stores;
        }, interceptedStores);

        // Merge for second evaluate
        const mergedIntercepted = [...interceptedStores, ...strategyABStores];

        // ── Main extraction (Strategy 0/1/2) ──
        return await page.evaluate((intercepted2) => {
          function normName(raw) {
            const l = (raw||'').toLowerCase().trim();
            if (l.includes('amazon'))    return 'Amazon';
            if (l.includes('flipkart'))  return 'Flipkart';
            if (l.includes('myntra'))    return 'Myntra';
            if (l.includes('ajio'))      return 'Ajio';
            if (l.includes('nykaa'))     return 'Nykaa';
            if (l.includes('tatacliq') || l === 'tata cliq') return 'TataCliq';
            if (l.includes('croma'))     return 'Croma';
            if (l.includes('snapdeal'))  return 'Snapdeal';
            if (l.includes('meesho'))    return 'Meesho';
            if (l.includes('jiomart'))   return 'JioMart';
            if (l.includes('bigbasket')) return 'BigBasket';
            if (l.includes('zepto'))     return 'Zepto';
            if (l.includes('blinkit'))   return 'Blinkit';
            if (l.includes('swiggy'))    return 'Swiggy';
            if (l.includes('zomato'))    return 'Zomato';
            if (l.includes('firstcry'))  return 'FirstCry';
            if (l.includes('netmeds'))   return 'Netmeds';
            if (l.includes('lenskart'))  return 'Lenskart';
            if (l.includes('boat'))      return 'Boat';
            if (l.includes('zebrs'))     return 'Zebrs';
            if (l.includes('reliance'))  return 'Reliance Digital';
            if (l.includes('vijay'))     return 'Vijay Sales';
            if (l.includes('fire-boltt') || l.includes('fireboltt')) return 'Fire-Boltt';
            if (l.includes('poorvika'))  return 'Poorvika';
            if (l.includes('sangeetha')) return 'Sangeetha';
            return raw.trim();
          }

          // Parse a standalone price string like "₹10,999"
          // Strictly: must be ONLY ₹ + digits + commas — no surrounding text
          function parsePrice(text) {
            const m = (text || '').trim().match(/^₹\s*([\d,]+)$/);
            if (!m) return 0;
            const p = parseInt(m[1].replace(/,/g,''));
            return (p >= 100 && p <= 10000000) ? p : 0;
          }

          // Is this price node inside a discount/savings badge?
          function isDiscountNode(el) {
            let p = el.parentElement;
            for (let i = 0; i < 5 && p; i++) {
              const t = (p.textContent || '').toLowerCase();
              // Short containers containing "off" or "save" = discount badge
              if (t.length < 80 && /\b(off|save|saved|extra|cashback)\b/.test(t)) return true;
              p = p.parentElement;
            }
            return false;
          }

          const KNOWN_STORES = ['amazon','flipkart','myntra','ajio','nykaa','tatacliq','croma',
            'snapdeal','meesho','jiomart','bigbasket','zepto','blinkit','swiggy','zomato',
            'firstcry','netmeds','lenskart','boat','mamaearth','purplle','bewakoof',
            'decathlon','pepperfry','vijay','reliance','zebrs','shopclues','poorvika','sangeetha'];

          // ── Strategy 1: Card-based extraction ──
          // webapp.flash.co renders each store as a card/row.
          // Try common card selectors and extract store+price+link as a unit.
          const cardSelectors = [
            '[class*="store-card"]','[class*="storeCard"]','[class*="StoreCard"]',
            '[class*="price-card"]','[class*="priceCard"]',
            '[class*="store-item"]','[class*="storeItem"]','[class*="StoreItem"]',
            '[class*="store-row"]','[class*="storeRow"]',
            '[class*="retailer"]','[class*="merchant"]',
            '[class*="offer-row"]','[class*="compare-row"]',
            '[class*="PriceItem"]','[class*="price-item"]',
          ];

          const seen = new Set();
          const stores = [];

          // ═══════════════════════════════════════════════════
          // STRATEGY 0: __NEXT_DATA__ — most reliable source
          // webapp.flash.co is Next.js — all data is in the
          // <script id="__NEXT_DATA__"> tag as serialised JSON.
          // Prices here are exact and per-store.
          // ═══════════════════════════════════════════════════
          (() => {
            const el = document.getElementById('__NEXT_DATA__');
            if (!el) return;
            try {
              const nd = JSON.parse(el.textContent);

              // Collect ALL price arrays — keep recursing even after finding one
              // so we don't miss the main store list which may be deeper in the tree
              function dig(o, d, acc) {
                if (!o || d > 15 || typeof o !== 'object') return;
                if (Array.isArray(o)) {
                  const items = o.filter(x => x && typeof x === 'object' &&
                    (x.storeName || x.store_name || x.name || x.merchant || x.retailer) &&
                    (x.price !== undefined || x.salePrice !== undefined || x.sellingPrice !== undefined || x.amount !== undefined));
                  if (items.length >= 1) acc.push(items); // collect it BUT keep recursing
                  o.forEach(x => dig(x, d+1, acc));       // always continue
                } else { Object.values(o).forEach(v => dig(v, d+1, acc)); }
              }

              const lists = []; dig(nd, 0, lists);
              // Pick the array with the MOST stores (most complete price list)
              lists.sort((a,b) => b.length - a.length);
              console.log('[__NEXT_DATA__] Found', lists.length, 'price arrays, sizes:', lists.slice(0,6).map(l=>l.length).join(','));
              const best = lists[0] || [];

              for (const item of best) {
                const rawName = item.storeName || item.store_name || item.name || item.merchant || item.retailer || '';
                const name = normName(rawName);
                if (!name || seen.has(name.toLowerCase())) continue;
                const rawPrice = item.price ?? item.salePrice ?? item.sellingPrice ?? item.amount ?? 0;
                const price = parseInt(String(rawPrice).replace(/[^0-9]/g,'')) || 0;
                if (price <= 0) continue;
                let url = item.url || item.link || item.deepLink || item.productUrl || '';
                try { const u = new URL(url); const ulp = u.searchParams.get('ulp')||u.searchParams.get('url')||u.searchParams.get('dest'); if(ulp) url=ulp; } catch(e) {}
                const outOfStock = !!(item.outOfStock || item.oos || item.out_of_stock);
                seen.add(name.toLowerCase());
                stores.push({ name, price, url, outOfStock, isSource: false, lowestPrice: false, savingsBadge: '', _src: 'next' });
              }
              console.log('[__NEXT_DATA__] Extracted', stores.length, 'stores from best list of', best.length);
            } catch(e) { console.log('[__NEXT_DATA__] parse error:', e.message); }
          })();

          function extractCard(card) {
            // ── 1. Find the main price (the actual selling price, not discount) ──
            // Collect ALL price text nodes in this card, pick the LARGEST valid one
            // (the selling price is always the main price shown prominently)
            let mainPrice = 0;
            const candidatePrices = [];
            card.querySelectorAll('*').forEach(el => {
              if (el.children.length > 0) return;
              const p = parsePrice(el.textContent);
              if (p > 0 && !isDiscountNode(el)) candidatePrices.push(p);
            });
            // The main price is the LOWEST valid price — MRP is higher, badges caught by isDiscountNode
            if (candidatePrices.length > 0) mainPrice = Math.min(...candidatePrices);
            if (!mainPrice) return null;

            // ── 2. Find store name — prefer img[alt], then text ──
            let storeName = '';
            for (const img of card.querySelectorAll('img')) {
              const alt = (img.alt || '').trim();
              if (alt.length > 1 && alt.length < 60 &&
                  !/logo|product|image|icon/i.test(alt) &&
                  KNOWN_STORES.some(s => alt.toLowerCase().includes(s))) {
                storeName = alt; break;
              }
            }
            if (!storeName) {
              for (const el of card.querySelectorAll('*')) {
                if (el.children.length > 0) continue;
                const t = (el.textContent || '').trim();
                const l = t.toLowerCase();
                if (t.length < 2 || t.length > 60 || /^₹/.test(t) || /^\d/.test(t)) continue;
                if (KNOWN_STORES.some(s => s.length > 3 && l.includes(s))) { storeName = t; break; }
              }
            }
            if (!storeName) return null;

            const normalized = normName(storeName);
            const key = normalized.toLowerCase();
            if (seen.has(key)) return null;

            // ── 3. Find the store-specific outbound link ──
            const storeKey = normalized.toLowerCase().replace(/\s/g,'');
            // Known domains for each store
            const storeDomains = {
              'amazon': ['amazon.in','amazon.com','amzn.in'],
              'flipkart': ['flipkart.com','fkrt.co'],
              'myntra': ['myntra.com'],
              'ajio': ['ajio.com'],
              'nykaa': ['nykaa.com','nykaafashion.com'],
              'tatacliq': ['tatacliq.com'],
              'croma': ['croma.com'],
              'snapdeal': ['snapdeal.com'],
              'meesho': ['meesho.com'],
              'jiomart': ['jiomart.com'],
              'bigbasket': ['bigbasket.com'],
              'zepto': ['zeptonow.com','zepto.com'],
              'blinkit': ['blinkit.com','grofers.com'],
              'swiggy': ['swiggy.com'],
              'firstcry': ['firstcry.com'],
              'netmeds': ['netmeds.com'],
              'lenskart': ['lenskart.com'],
              'boat': ['boat-lifestyle.com'],
              'reliancedigital': ['reliancedigital.in'],
              'vijaysales': ['vijaysales.com'],
              'zebrs': ['zebrs.com'],
              'poorvika': ['poorvika.com'],
              'sangeetha': ['sangeetha.com'],
            };
            const expectedDomains = storeDomains[storeKey] || [storeKey + '.com'];

            let storeUrl = '';
            // Pass 1: find link whose href (or embedded ulp param) matches store domain
            for (const a of card.querySelectorAll('a[href]')) {
              const href = a.href || '';
              if (!href || href.includes('webapp.flash.co') || href === '#') continue;
              // Unwrap redirect URLs that contain store URL as a param
              let checkUrl = href;
              try {
                const u = new URL(href);
                const ulp = u.searchParams.get('ulp') || u.searchParams.get('url') || u.searchParams.get('dest');
                if (ulp) checkUrl = ulp;
              } catch(e) {}
              const checkL = checkUrl.toLowerCase();
              if (expectedDomains.some(d => checkL.includes(d))) { storeUrl = href; break; }
            }
            // Pass 2: any outbound link in this card that isn't flash
            if (!storeUrl) {
              for (const a of card.querySelectorAll('a[href]')) {
                const href = a.href || '';
                if (href && !href.includes('flash.co') && !href.includes('webapp.flash') && href !== '#' && href.startsWith('http')) {
                  storeUrl = href; break;
                }
              }
            }

            // ── 4. Extract badges ──
            const cardText = card.textContent || '';
            const cardTextL = cardText.toLowerCase();
            const outOfStock = /out of stock|not available|unavailable|sold out/i.test(cardText);
            const isSource   = /you came from here/i.test(cardText);
            const isLowest   = /lowest price|best price/i.test(cardText);

            // Savings badge: "Save ₹200 over Flipkart" pattern
            let savingsBadge = '';
            const saveMatch = cardText.match(/save\s*₹[\d,]+[^.!\n]*/i);
            if (saveMatch) savingsBadge = saveMatch[0].trim().substring(0, 50);

            seen.add(key);
            return { name: normalized, price: mainPrice, url: storeUrl,
                     outOfStock, isSource, lowestPrice: isLowest, savingsBadge };
          }

          // Try each card selector — only if Strategy 0 didn't find stores
          if (stores.length < 2) {
          for (const sel of cardSelectors) {
            const cards = document.querySelectorAll(sel);
            if (cards.length < 2) continue;
            seen.clear();
            const batch = [];
            for (const card of cards) {
              const r = extractCard(card);
              if (r) batch.push(r);
            }
            if (batch.length >= 2) { stores.push(...batch); break; }
          }
          } // end Strategy 1 guard

          // ── Strategy 2: Fallback — link-anchored per-store extraction ──
          if (stores.length < 2) {
            seen.clear();
            document.querySelectorAll('a[href]').forEach(a => {
              const href = a.href || '';
              if (!href || href.includes('webapp.flash.co') || !href.startsWith('http')) return;

              // Unwrap redirect URLs
              let checkUrl = href;
              try {
                const u = new URL(href);
                const ulp = u.searchParams.get('ulp') || u.searchParams.get('url') || u.searchParams.get('dest');
                if (ulp) checkUrl = ulp;
              } catch(e) {}
              const hl = checkUrl.toLowerCase();

              const matchedStore = KNOWN_STORES.find(s => s.length > 3 && hl.includes(s));
              if (!matchedStore) return;
              const normalized = normName(matchedStore);
              if (seen.has(normalized.toLowerCase())) return;

              // Walk up from link to find price
              let price = 0;
              let container = a.parentElement;
              for (let d = 0; d < 8 && container && !price; d++) {
                container.querySelectorAll('*').forEach(el => {
                  if (el.children.length > 0 || price) return;
                  const p = parsePrice(el.textContent);
                  if (p > 0 && !isDiscountNode(el)) price = (price === 0 || p < price) ? p : price;
                });
                container = container.parentElement;
              }
              if (!price) return;

              const cardEl = a.closest('[class]') || a.parentElement;
              const cardText = (cardEl || document.body).textContent || '';
              seen.add(normalized.toLowerCase());
              stores.push({
                name: normalized, price, url: href,
                outOfStock:  /out of stock/i.test(cardText),
                isSource:    /you came from here/i.test(cardText),
                lowestPrice: /lowest price/i.test(cardText),
                savingsBadge: '',
              });
            });
          }

          // For stores from Strategy 0 (__NEXT_DATA__), enrich with DOM badges
          // "You came from here" / savings badge / out of stock come from the rendered page
          if (stores.length > 0 && stores[0]._src === 'next') {
            stores.forEach(s => {
              // Find the store's card in the DOM by name
              for (const el of document.querySelectorAll('*')) {
                const t = (el.textContent || '');
                if (!t.includes(s.name)) continue;
                const tl = t.toLowerCase();
                if (/you came from here/i.test(t) && t.length < 500) { s.isSource = true; }
                if (/out of stock|unavailable/i.test(t) && t.length < 500) { s.outOfStock = true; }
                if (/lowest price|best price/i.test(t) && t.length < 200) { s.lowestPrice = true; }
                const saveM = t.match(/save\s*₹[\d,]+[^.!\n]{0,40}/i);
                if (saveM && !s.savingsBadge) s.savingsBadge = saveM[0].trim().substring(0, 50);
                break;
              }
            });
          }
          const JUNK = ['flash ai','compare prices','best price','product details','loading','please wait','price compare'];
          let productName = '';

          // 1. og:title meta tag (most reliable on webapp.flash.co)
          const ogTitle = document.querySelector('meta[property="og:title"]');
          if (ogTitle) {
            const t = (ogTitle.getAttribute('content') || '').trim();
            if (t.length > 8 && !JUNK.some(j => t.toLowerCase().includes(j))) productName = t;
          }

          // 2. Headings and product-name elements
          if (!productName) {
            for (const sel of ['h1','h2','[class*="product-name"]','[class*="productName"]','[class*="product_name"]','[class*="ProductName"]','[class*="item-name"]','[class*="itemName"]']) {
              for (const el of document.querySelectorAll(sel)) {
                const t = el.textContent.trim();
                if (t.length > 8 && t.length < 400 && !JUNK.some(j => t.toLowerCase().includes(j))) {
                  productName = t; break;
                }
              }
              if (productName) break;
            }
          }

          // 3. Page title (strip Flash branding)
          if (!productName) {
            const title = document.title.replace(/\s*[-|—]\s*(Flash.*|Compare.*|Best Price.*|Price Compare.*)$/i,'').trim();
            if (title.length > 8 && !JUNK.some(j => title.toLowerCase().includes(j))) productName = title;
          }

          // Product image — try multiple sources
          let productImage = '';

          // 1. og:image (most reliable)
          const ogImg = document.querySelector('meta[property="og:image"]');
          if (ogImg) {
            const src = (ogImg.getAttribute('content') || '').trim();
            if (src && src.startsWith('http') && !src.includes('/merchants/') && !src.includes('logo')) productImage = src;
          }

          // 2. Flash CDN proxy — img.flash.co/plain/<encoded-url>
          if (!productImage) {
            for (const img of document.querySelectorAll('img')) {
              const src = img.src || '';
              if (!src || src.includes('/merchants/') || src.includes('/favicon') || src.includes('logo')) continue;
              if (/img\.flash\.co.*\/plain\//.test(src)) {
                try { const d = decodeURIComponent(src.split('/plain/')[1].split('?')[0]); if (d.startsWith('http')) { productImage = d; break; } } catch { productImage = src; break; }
              }
            }
          }

          // 3. Amazon / Flipkart CDN patterns
          if (!productImage) {
            for (const img of document.querySelectorAll('img')) {
              const src = img.src || '';
              if (!src || src.includes('/merchants/') || src.includes('/favicon') || src.includes('logo')) continue;
              if (/media-amazon\.com|images-amazon\.com|_SL\d+_|_AC_|rukmini\d+\.flixcart|img\.flipkart/.test(src)) { productImage = src; break; }
            }
          }

          // 4. Largest square-ish non-logo image
          if (!productImage) {
            let best = '', bestScore = 0;
            for (const img of document.querySelectorAll('img')) {
              const src = img.src || '';
              if (!src || src.includes('/merchants/') || src.includes('/favicon') || src.includes('logo') || src.length < 30) continue;
              const w = img.naturalWidth || img.width || 0, h = img.naturalHeight || img.height || 0;
              if (w < 60 || h < 60) continue;
              const ratio = Math.max(w,h)/Math.min(w,h);
              const score = w * h * (ratio < 1.5 ? 3 : ratio < 3 ? 1 : 0.1);
              if (score > bestScore) { bestScore = score; best = src; }
            }
            productImage = best;
          }

          return { stores, productName, productImage,
            debug: { cardCount: stores.filter(s=>s._src==='card').length, linkCount: stores.filter(s=>s._src==='link').length, nextCount: 0 }
          };
        }, mergedIntercepted);

      } finally {
        await page.close().catch(() => {});
      }
    });

    console.log('[Compare] Extracted', extracted.stores.length, 'stores:',
      extracted.stores.map(s => s.name + ':₹' + s.price).join(' | '));

    // Use quickStores if available (correct prices from price-compare page)
    if (quickStores.length > 0) {
      console.log('[Compare] Using quickStores:', quickStores.map(s => s.name + ':₹' + s.price).join(' | '));
      extracted.stores = quickStores;
    }
    // Use image/name from item page (price-compare page has no og:image)
    if (itemPageMeta.img) extracted.productImage = itemPageMeta.img;
    if (itemPageMeta.name && !extracted.productName) extracted.productName = itemPageMeta.name;

    if (extracted.stores.length === 0) {
      return res.status(404).json({
        error: 'Flash.co loaded the product page but no store prices were found. Try again.',
        webappUrl,
        hint: 'Visit /compare/debug?url=' + encodeURIComponent(url) + ' for diagnostics',
      });
    }

    // Sort + mark best/source using Flash's own DOM-detected flags
    let stores = extracted.stores
      .sort((a, b) => a.price - b.price)
      .map((s, i) => {
        const urlSrc = srcStore && s.name.toLowerCase().includes(srcStore.toLowerCase());
        const isSrc  = s.isSource || urlSrc;
        const inStockStores = extracted.stores.filter(x => !x.outOfStock);
        const bestPrice = inStockStores.length > 0 ? Math.min(...inStockStores.map(x => x.price)) : 0;
        const isBest = !s.outOfStock && s.price === bestPrice;
        return {
          ...s,
          normalizedName: s.name,
          isSource:    isSrc,
          isBest,
          lowestPrice: s.lowestPrice || isBest,
          // Only show savingsBadge on the best price store
          savingsBadge: isBest ? (s.savingsBadge || '') : '',
        };
      });

    const srcEntry = stores.find(s => s.isSource);
    const bestEntry = stores.find(s => s.isBest);
    const savings  = (srcEntry && bestEntry && !srcEntry.isBest)
      ? srcEntry.price - bestEntry.price : 0;

    const JUNK_NAMES = ['flash ai assistant','flash ai','flash assistant','compare prices','price compare'];
    const productName = JUNK_NAMES.some(j => (extracted.productName||'').toLowerCase().includes(j))
      ? ('Product from ' + srcStore) : (extracted.productName || ('Product from ' + srcStore));

    console.log('[Compare] ✅ FINAL:', stores.map(s => s.name + ':₹' + s.price + (s.isSource?'[src]':'') + (s.isBest?'[best]':'')).join(' | '));

    // Affiliate links via ExtraPe
    if (extrapeTokenCache.accessToken) {
      stores = await Promise.all(stores.map(async (s) => {
        if (!s.url || !s.url.startsWith('http')) return s;
        // Clean store URL before sending to ExtraPe
        let cleanUrl = s.url;
        try {
          const u = new URL(s.url);
          ['ref', 'ref_', 'social_share', 'source', 'smid', 'psc', 'th', '_encoding',
           'tag', 'linkCode', 'linkId', 'camp', 'creative', 'iid', 'fm', 'srno',
           'otracker', 'ssid', 'ctx', 'BU', 'ov_redirect'].forEach(p => u.searchParams.delete(p));
          cleanUrl = u.toString();
        } catch(e) {}
        try {
          const result = await convertExtraPe(cleanUrl);
          const affiliateLink = result.clickUrl || result;
          // Track each affiliated store as a conversion
          trackConversion(cleanUrl, s.name, 'done', affiliateLink).catch(() => {});
          return { ...s, affiliateLink, displayLink: result.displayUrl || result.clickUrl || s.url };
        } catch(e) { return { ...s, affiliateLink: s.url, displayLink: s.url }; }
      }));
      console.log('[Compare] Affiliated:', stores.map(s => s.name + ':' + (s.affiliateLink||'').substring(0,40)).join(' | '));
    }

    return res.json({
      stores, productName,
      productImage: extracted.productImage || '',
      totalStores:  stores.length,
      savings:      savings > 0 ? savings : 0,
      dataSource:   'flash',
      resolvedUrl:  url,
      webappUrl,
    });

  } catch(e) {
    console.error('[Compare] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});


// ── /compare/debug — step-by-step Flash API diagnostic ──
// Run: curl "https://api.smartpickdeals.live/compare/debug?url=https://amzn.in/d/01tGuO9p"
// ── /compare/rawdata — dumps raw __NEXT_DATA__ from webapp.flash.co ──
// Use this to inspect what Next.js embeds in the page for any product
app.get('/compare/rawdata', async (req, res) => {
  const { url: rawUrl } = req.query;
  if (!rawUrl) return res.json({ usage: 'GET /compare/rawdata?url=PRODUCT_URL' });
  const token = flashTokenCache.token || '';
  if (!token) return res.status(503).json({ error: 'No Flash token' });

  try {
    let url = rawUrl;
    try { const pu = new URL(url); if (pu.hostname === 'dl.flipkart.com') { pu.hostname = 'www.flipkart.com'; url = pu.toString(); } } catch(e) {}
    if (isShortUrl(url)) { try { url = await resolveRedirect(url); } catch(e) {} }

    // Get stream to find itemId + pageHash
    const flashHeaders = {
      'Authorization': 'Bearer ' + token, 'Channel-Type': 'web',
      'Content-Type': 'application/json', 'Origin': 'https://flash.co',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'X-Country-Code': 'IN', 'X-Device-Id': flashTokenCache.deviceId || 'web-spd', 'X-Timezone': 'Asia/Calcutta',
    };
    const streamParams = new URLSearchParams({ source:'APPEND', context:'HOME_URL_PASTE', device_type:'DESKTOP', country_code:'IN' });
    const sr = await fetch('https://apiv3.flash.tech/agents/chat/stream?' + streamParams, {
      method: 'POST', headers: flashHeaders, body: JSON.stringify({ query: url, context: 'HOME_URL_PASTE' }),
      signal: AbortSignal.timeout(35000),
    });
    const streamText = await sr.text();
    const navMatch = streamText.match(/webapp\.flash\.co\/item\/(\d+)\/h\/([A-Za-z0-9_-]+)/);
    if (!navMatch) return res.json({ error: 'No itemId/pageHash in stream', streamSample: streamText.substring(0, 300) });
    const itemId = navMatch[1], pageHash = navMatch[2];
    const webappUrl = `https://webapp.flash.co/item/${itemId}/h/${pageHash}`;

    // Open in Puppeteer and dump __NEXT_DATA__
    const rawData = await withFlashBrowser(async () => {
      const browser = await getFlashBrowser();
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');
      try {
        await page.goto('https://webapp.flash.co', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await page.evaluate((tok) => { try { localStorage.setItem('authToken', tok); } catch(e) {} }, token);
        await page.goto(webappUrl, { waitUntil: 'networkidle2', timeout: 40000 });

        // Wait for prices
        try { await page.waitForFunction(() => (document.body.innerText.match(/₹[\d,]+/g)||[]).length >= 2, { timeout: 25000 }); } catch(e) {}
        await new Promise(r => setTimeout(r, 3000));

        return await page.evaluate(() => {
          const el = document.getElementById('__NEXT_DATA__');
          const nd = el ? JSON.parse(el.textContent) : null;

          // Find all arrays with price-like objects
          const found = [];
          function dig(o, path, d) {
            if (!o || d > 15 || typeof o !== 'object') return;
            if (Array.isArray(o)) {
              const priceItems = o.filter(x => x && typeof x === 'object' &&
                (x.storeName || x.store_name || x.name || x.merchant) &&
                (x.price !== undefined || x.salePrice !== undefined || x.amount !== undefined));
              if (priceItems.length > 0) {
                found.push({ path, count: priceItems.length, sample: priceItems.slice(0,3).map(x => ({ name: x.storeName||x.store_name||x.name||x.merchant, price: x.price||x.salePrice||x.amount, url: (x.url||x.link||'').substring(0,60) })) });
              }
              o.forEach((x, i) => dig(x, path + '[' + i + ']', d+1));
            } else {
              Object.entries(o).forEach(([k, v]) => dig(v, path + '.' + k, d+1));
            }
          }
          if (nd) dig(nd, 'root', 0);
          return {
            hasNextData: !!el,
            nextDataSize: el ? el.textContent.length : 0,
            priceArraysFound: found,
            pageTitle: document.title,
            priceCount: (document.body.innerText.match(/₹[\d,]+/g)||[]).length,
            rawSample: nd ? JSON.stringify(nd).substring(0, 1500) : null,
          };
        });
      } finally { await page.close().catch(() => {}); }
    });

    return res.json({ resolvedUrl: url, webappUrl, ...rawData });
  } catch(e) { return res.status(500).json({ error: e.message }); }
});

// ── /compare/dump — extract raw __NEXT_DATA__ from webapp.flash.co to diagnose price structure ──
app.get('/compare/dump', async (req, res) => {
  const { url: rawUrl } = req.query;
  if (!rawUrl) return res.json({ usage: 'GET /compare/dump?url=PRODUCT_URL' });
  const token = flashTokenCache.token || '';
  if (!token) return res.status(503).json({ error: 'No Flash token' });

  try {
    let url = rawUrl;
    try { const pu = new URL(url); if (pu.hostname === 'dl.flipkart.com') { pu.hostname = 'www.flipkart.com'; url = pu.toString(); } } catch(e) {}
    if (isShortUrl(url)) { try { url = await resolveRedirect(url); } catch(e) {} }

    // Step 1: Get itemId + pageHash from stream
    const headers = {
      'Authorization': 'Bearer ' + token, 'Channel-Type': 'web', 'Content-Type': 'application/json',
      'Origin': 'https://flash.co', 'Referer': 'https://flash.co/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36',
      'X-Country-Code': 'IN', 'X-Device-Id': flashTokenCache.deviceId || 'web-spd', 'X-Timezone': 'Asia/Calcutta',
    };
    const streamParams = new URLSearchParams({ source:'APPEND', context:'HOME_URL_PASTE', device_type:'DESKTOP', country_code:'IN' });
    const sr = await fetch('https://apiv3.flash.tech/agents/chat/stream?' + streamParams, {
      method:'POST', headers, body: JSON.stringify({ query: url, context:'HOME_URL_PASTE' }), signal: AbortSignal.timeout(35000),
    });
    const streamText = await sr.text();
    const navMatch = streamText.match(/webapp\.flash\.co\/item\/(\d+)\/h\/([A-Za-z0-9_-]+)/);
    if (!navMatch) return res.json({ error: 'No item URL in stream', streamSample: streamText.substring(0, 300) });

    const itemId = navMatch[1], pageHash = navMatch[2];
    const webappUrl = `https://webapp.flash.co/item/${itemId}/h/${pageHash}`;

    // Step 2: Open in Puppeteer and dump __NEXT_DATA__ + all price text
    const dump = await withFlashBrowser(async () => {
      const browser = await getFlashBrowser();
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');
      try {
        await page.goto('https://webapp.flash.co', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
        await page.evaluate((tok) => { try { localStorage.setItem('authToken', tok); } catch(e) {} }, token);
        await page.goto(webappUrl, { waitUntil: 'networkidle2', timeout: 40000 });

        // Wait for prices
        await page.waitForFunction(() => (document.body.innerText.match(/₹[\d,]+/g)||[]).length >= 2, { timeout: 30000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 3000));

        return await page.evaluate(() => {
          // 1. Raw __NEXT_DATA__
          const el = document.getElementById('__NEXT_DATA__');
          const nextDataRaw = el ? el.textContent : 'NOT FOUND';

          // 2. All price text nodes on the page
          const priceTexts = [];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
          let node;
          while ((node = walker.nextNode())) {
            const t = node.textContent.trim();
            if (/^₹[\d,]+$/.test(t)) {
              const container = node.parentElement?.parentElement?.textContent?.trim().substring(0, 80) || '';
              priceTexts.push({ price: t, context: container });
            }
          }

          // 3. All outbound links
          const links = [];
          document.querySelectorAll('a[href]').forEach(a => {
            if (a.href && !a.href.includes('flash.co') && a.href.startsWith('http'))
              links.push(a.href.substring(0, 120));
          });

          // 4. Count store names visible on page
          const bodyText = document.body.innerText;
          const storeMatches = bodyText.match(/(Amazon|Flipkart|Myntra|Ajio|Nykaa|TataCliq|Croma|Zepto|Blinkit|JioMart|Meesho|Reliance)/g) || [];
          const uniqueStores = [...new Set(storeMatches)];

          return {
            pageTitle: document.title,
            nextDataLength: nextDataRaw.length,
            nextDataSample: nextDataRaw.substring(0, 3000),
            priceTexts: priceTexts.slice(0, 20),
            outboundLinks: [...new Set(links)].slice(0, 15),
            storesVisibleOnPage: uniqueStores,
          };
        });
      } finally { await page.close().catch(() => {}); }
    });

    return res.json({ resolvedUrl: url, webappUrl, ...dump });
  } catch(e) { return res.status(500).json({ error: e.message }); }
});

app.get('/compare/debug', async (req, res) => {
  const { url: rawUrl } = req.query;
  if (!rawUrl) return res.json({
    usage: 'GET /compare/debug?url=PRODUCT_URL',
    example: 'curl "https://api.smartpickdeals.live/compare/debug?url=https://amzn.in/d/01tGuO9p"',
  });

  const report = {
    input:        rawUrl,
    resolvedUrl:  null,
    token:        { set: false, preview: null, daysOld: null },
    deviceId:     null,
    step1_stream: { ok: false, status: null, length: null, pageHash: null, sample: null, error: null },
    step2_prices: { ok: false, status: null, feedbackCount: null, sample: null, error: null, endpoint: null },
    step3_parse:  { storeCount: 0, stores: [], productName: null, productImage: null },
    conclusion:   null,
  };

  // ── Token check ──
  const token    = flashTokenCache.token || process.env.FLASH_AUTH_TOKEN || '';
  const deviceId = flashTokenCache.deviceId || process.env.FLASH_DEVICE_ID || 'web-spd';
  report.token.set     = !!token;
  report.token.preview = token ? token.substring(0, 20) + '...' : 'NOT SET';
  report.token.daysOld = flashTokenCache.updatedAt ? Math.floor((Date.now() - new Date(flashTokenCache.updatedAt).getTime()) / 86400000) : null;
  report.deviceId      = deviceId;

  if (!token) {
    report.conclusion = '❌ FAIL: No Flash token. Visit https://api.smartpickdeals.live/flash/token-page';
    return res.json(report);
  }

  // ── URL normalisation ──
  let url = rawUrl;
  try { const pu = new URL(url); if (pu.hostname === 'dl.flipkart.com') { pu.hostname = 'www.flipkart.com'; url = pu.toString(); } } catch(e) {}
  if (isShortUrl(url)) {
    try { url = await resolveRedirect(url); } catch(e) { url = rawUrl; }
  }
  report.resolvedUrl = url;

  const headers = {
    'Authorization':  'Bearer ' + token,
    'Channel-Type':   'web',
    'Content-Type':   'application/json',
    'Origin':         'https://flash.co',
    'Referer':        'https://flash.co/',
    'User-Agent':     'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'X-Country-Code': 'IN',
    'X-Device-Id':    deviceId,
    'X-Timezone':     'Asia/Calcutta',
    'Accept':         'application/json, text/event-stream, */*',
  };

    // ── Step 1: Stream API → pageHash + threadId + messageId ──
    // Use apiv3.flash.tech (confirmed working from original flash/test route)
    let pageHash  = null;
    let threadId  = null;
    let messageId = null;
    let fullStreamText = '';
    try {
      const streamParams = new URLSearchParams({
        source: 'APPEND', context: 'HOME_URL_PASTE',
        user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
        device_type: 'DESKTOP', country_code: 'IN',
      });
      const sr = await fetch('https://apiv3.flash.tech/agents/chat/stream?' + streamParams, {
        method: 'POST', headers,
        body: JSON.stringify({ query: url, context: 'HOME_URL_PASTE' }),
        signal: AbortSignal.timeout(35000),
      });
      fullStreamText = await sr.text();
      report.step1_stream.status = sr.status;
      report.step1_stream.length = fullStreamText.length;
      report.step1_stream.sample = fullStreamText.substring(0, 600);

      if (!sr.ok) {
        report.step1_stream.error = 'HTTP ' + sr.status + (sr.status === 401 ? ' — Token expired. Run bookmarklet on flash.co.' : '');
        report.conclusion = '❌ FAIL at Step 1: Flash stream returned ' + sr.status;
        return res.json(report);
      }

      // Extract pageHash from URL patterns in INT_NAVIGATION
      const hashPats = [
        /price-compare\/\d+\/h\/([A-Za-z0-9_-]{4,})/,
        /item\/(\d+)\/h\/([A-Za-z0-9_-]{4,})/,
        /product-search\/([A-Za-z0-9_-]{4,})/,
        /product-details\/([A-Za-z0-9_-]{4,})/,
        /\/h\/([A-Za-z0-9_-]{6,})/,
      ];
      for (const pat of hashPats) {
        const m = fullStreamText.match(pat);
        if (m) { pageHash = m[2] || m[1]; break; }
      }

      // Parse every SSE data line
      for (const line of fullStreamText.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        const navM = raw.match(/item\/(\d+)\/h\/([A-Za-z0-9_-]{4,})/);
        if (navM) { pageHash = pageHash || navM[2]; }
        try {
          const d = JSON.parse(raw);
          if (d.data?.threadId)  threadId  = String(d.data.threadId);
          if (d.data?.messageId) messageId = String(d.data.messageId);
          if (d.threadId)        threadId  = String(d.threadId);
          if (d.messageId)       messageId = String(d.messageId);
          if (!pageHash) pageHash = d.pageHash || d.referenceId || d.hash || (d.data && (d.data.pageHash || d.data.referenceId)) || null;
        } catch(e) {}
      }

      report.step1_stream.ok       = true;
      report.step1_stream.pageHash = pageHash;
      report.step1_stream.threadId = threadId;
      report.step1_stream.messageId = messageId;

      if (!pageHash && !threadId) {
        report.conclusion = '❌ FAIL at Step 1: Stream 200 OK but no pageHash/threadId found. Product may not be indexed by Flash.co.';
        return res.json(report);
      }
    } catch(e) {
      report.step1_stream.error = e.message;
      report.conclusion = '❌ FAIL at Step 1: ' + e.message;
      return res.json(report);
    }

  // ── Step 2: Fetch prices using all known Flash API endpoints (apiv3.flash.tech) ──
  const getHeaders = { ...headers };
  delete getHeaders['Content-Type'];

  const threadEndpoints = threadId ? [
    `https://apiv3.flash.tech/api/v1/agents/chat/thread/${threadId}/messages`,
    `https://apiv3.flash.tech/api/v2/agents/chat/thread/${threadId}/messages`,
    `https://apiv3.flash.tech/api/v1/chat/thread/${threadId}/messages`,
    `https://apiv3.flash.tech/api/v1/threads/${threadId}/messages`,
    `https://apiv3.flash.tech/api/v1/threads/${threadId}`,
  ] : [];

  const msgEndpoints = messageId ? [
    `https://apiv3.flash.tech/api/v1/agents/chat/message/${messageId}`,
    `https://apiv3.flash.tech/api/v1/messages/${messageId}/products`,
    `https://apiv3.flash.tech/api/v1/messages/${messageId}/price-compare`,
  ] : [];

  const feedbackEndpoints = pageHash ? [
    `https://apiv3.flash.tech/api/v1/customer/feedback/fetch?scope=PRICE_COMPARE&referenceId=${pageHash}`,
    `https://apiv3.flash.tech/api/v1/customer/feedback/fetch?scope=PRODUCT_DETAILS&referenceId=${pageHash}`,
    `https://apiv3.flash.tech/api/v1/customer/feedback/fetch?scope=PRODUCT_SEARCH&referenceId=${pageHash}`,
  ] : [];

  const allEps = [...threadEndpoints, ...msgEndpoints, ...feedbackEndpoints];

  function debugHasData(d) {
    const str = JSON.stringify(d);
    const feedbacks = d?.response?.feedbacks || d?.feedbacks || [];
    return feedbacks.length > 0 || d?.messages?.length > 0 ||
      str.includes('"storeName"') || str.includes('"storeList"');
  }

  let rawPriceData = null;
  const probeResults = [];

  // Probe all immediately
  for (const ep of allEps) {
    try {
      const r = await fetch(ep, { headers: getHeaders, signal: AbortSignal.timeout(6000) });
      const txt = await r.text();
      probeResults.push({ ep, status: r.status, body: txt.substring(0, 300) });
      if (r.ok) {
        try {
          const d = JSON.parse(txt);
          if (debugHasData(d)) {
            rawPriceData = d;
            report.step2_prices.endpoint = ep;
            report.step2_prices.ok = true;
            break;
          }
        } catch(e) {}
      }
    } catch(e) { probeResults.push({ ep, error: e.message }); }
  }

  // Poll feedback endpoints 8×3s
  for (let i = 0; !rawPriceData && i < 8; i++) {
    await new Promise(r => setTimeout(r, 3000));
    for (const ep of feedbackEndpoints) {
      try {
        const r = await fetch(ep, { headers: getHeaders, signal: AbortSignal.timeout(6000) });
        if (!r.ok) continue;
        const d = await r.json();
        if (debugHasData(d)) {
          rawPriceData = d;
          report.step2_prices.ok = true;
          report.step2_prices.endpoint = ep + ` (poll ${i+1})`;
          break;
        }
      } catch(e) {}
    }
  }

  report.step2_prices.feedbackCount = rawPriceData
    ? (rawPriceData?.response?.feedbacks || rawPriceData?.feedbacks || []).length : 0;
  report.step2_prices.sample = rawPriceData ? JSON.stringify(rawPriceData).substring(0, 1000) : null;
  report.step2_prices.probeResults = probeResults;

  if (!rawPriceData) {
    report.conclusion = `❌ FAIL at Step 2: No price data after 24s. pageHash=${pageHash} threadId=${threadId} messageId=${messageId}. Check probeResults.`;
    return res.json(report);
  }


  // ── Step 3: Parse ──
  function dig(o, d, best) {
    if (!o || d > 7 || typeof o !== 'object') return;
    if (Array.isArray(o)) {
      if (o.length > 0) { const f = o[0]; if (f && (f.price !== undefined || f.amount !== undefined || f.storeName || f.retailer)) best.push(o); }
      o.forEach(x => dig(x, d+1, best));
    } else { Object.values(o).forEach(v => dig(v, d+1, best)); }
  }
  const best = [];
  dig(rawPriceData, 0, best);
  best.sort((a, b) => b.length - a.length);
  const priceList = best[0] || [];

  const stores = priceList.map(s => ({
    name:  s.storeName || s.name || s.store || s.retailer || '?',
    price: parseInt(String(s.price || s.amount || s.salePrice || 0).replace(/[^0-9]/g,'')) || 0,
    url:   (s.url || s.link || '').substring(0, 80),
  })).filter(s => s.price > 0);

  const meta = rawPriceData?.response?.productDetails || rawPriceData?.productDetails || {};
  report.step3_parse.storeCount   = stores.length;
  report.step3_parse.stores       = stores;
  report.step3_parse.productName  = meta.name || meta.productName || rawPriceData?.productName || null;
  report.step3_parse.productImage = meta.imageUrl || meta.image || rawPriceData?.productImage || null;

  report.conclusion = stores.length > 0
    ? '✅ SUCCESS: ' + stores.length + ' stores found → ' + stores.map(s => s.name + ':₹' + s.price).join(' | ')
    : '⚠️ Step 2 returned data but Step 3 could not parse any store prices. Check step2_prices.sample for structure.';

  return res.json(report);
});
// Buyhatke debug — shows full two-step diagnostic for any product URL
// ── Buyhatke product info — step 1 only, for browser-side fetching ──
// Returns internalPid + pos so the browser can construct the Buyhatke page URL
// and fetch /__data.json directly (bypassing the 403 we get server-side).
app.get('/buyhatke/productinfo', async (req, res) => {
  const { url: rawUrl } = req.query;
  if (!rawUrl) return res.status(400).json({ error: 'Pass ?url=' });
  try {
    let url = rawUrl;
    if (isShortUrl(rawUrl)) {
      try { url = await resolveRedirect(rawUrl); } catch(e) {}
    }
    const params = extractBhkParams(url);
    if (!params) return res.status(400).json({ error: 'URL not from a supported store', url });
    const { pos, pid } = params;
    const product = await bhkGetProductData(pos, pid);
    return res.json({
      internalPid: product.internalPid,
      pos,
      pid,
      name:      product.name,
      site_name: product.site_name,
      image:     product.image,
      cur_price: product.cur_price,
      inStock:   product.inStock,
    });
  } catch(e) {
    return res.status(404).json({ error: e.message });
  }
});

// ── Compare affiliate — browser POSTs raw Buyhatke store data, we return affiliate links ──
// The browser fetches prices from Buyhatke directly, then sends the store list here.
// We convert each store URL to an affiliate link using ExtraPe and return the enriched list.
app.post('/compare/affiliate', async (req, res) => {
  const { stores, productName, productImage } = req.body;
  if (!stores || !Array.isArray(stores) || stores.length === 0) {
    return res.status(400).json({ error: 'Pass { stores: [{name, price, url}] }' });
  }

  // Convert each store URL to affiliate link via ExtraPe (same as existing compare flow)
  const enriched = await Promise.all(stores.map(async (store) => {
    if (!store.url || !store.url.startsWith('http')) return store;
    try {
      const affResult = await getAffiliateLink(store.url);
      const displayLink = getDisplayLink(store.url, affResult);
      return {
        ...store,
        affiliateLink: affResult || store.url,
        displayLink:   displayLink || store.url,
      };
    } catch(e) {
      return { ...store, affiliateLink: store.url, displayLink: store.url };
    }
  }));

  const sorted = enriched.sort((a, b) => a.price - b.price)
    .map((s, i) => ({ ...s, isBest: i === 0 }));

  return res.json({
    stores:      sorted,
    productName:  productName || '',
    productImage: productImage || '',
    totalStores:  sorted.length,
    savings:      0,
    dataSource:  'buyhatke',
  });
});

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
    await bhkGetMultiStorePrices(srcProduct.internalPid, pid, pos, srcProduct.name);

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
// Cloudflare Pages Function — handles smartpickdeals.live/go/:code
// Fetches real URL from Render backend, redirects user to affiliate link

const BACKEND = 'https://extrape-affiliate.onrender.com';

export async function onRequest(context) {
  const code = context.params.code;
  if (!code) return new Response('Missing code', { status: 400 });

  try {
    // Fetch the real affiliate URL from Render
    // Uses a 25s timeout — handles Render cold starts (free tier sleeps)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);

    const r = await fetch(`${BACKEND}/resolve/${code}`, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    });
    clearTimeout(timer);

    if (r.ok) {
      const data = await r.json();
      if (data.url) {
        return Response.redirect(data.url, 302);
      }
    }

    // If Render returned an error, try /go/ directly as fallback
    return Response.redirect(`${BACKEND}/go/${code}`, 302);

  } catch(e) {
    // Render is waking up (cold start) — show friendly loading page
    // that auto-retries every 3 seconds
    return new Response(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Smart Pick Deals — Loading...</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #0a0a0f; color: #f0ede8;
           display: flex; flex-direction: column; align-items: center; justify-content: center;
           min-height: 100vh; margin: 0; text-align: center; padding: 20px; }
    .spinner { width: 40px; height: 40px; border: 3px solid #1e1e2e;
               border-top-color: #ff6b2b; border-radius: 50%;
               animation: spin 0.8s linear infinite; margin: 0 auto 20px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    h2 { font-size: 1.2rem; margin: 0 0 8px; }
    p { color: #6b6878; font-size: 0.9rem; }
  </style>
  <script>
    // Auto-retry — Render wakes up in 20-40 seconds
    var attempts = 0;
    function retry() {
      attempts++;
      if (attempts > 15) {
        document.getElementById('msg').textContent = 'Taking too long. Please try again.';
        return;
      }
      fetch('/go/${code}').then(r => {
        if (r.redirected) window.location.href = r.url;
        else if (r.ok) window.location.reload();
        else setTimeout(retry, 3000);
      }).catch(() => setTimeout(retry, 3000));
    }
    setTimeout(retry, 4000);
  </script>
</head>
<body>
  <div class="spinner"></div>
  <h2>Redirecting to your product...</h2>
  <p id="msg">Starting up — this takes about 20 seconds on first visit</p>
</body>
</html>`, {
      status: 200,
      headers: { 'Content-Type': 'text/html' }
    });
  }
}
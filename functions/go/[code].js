// Cloudflare Pages Function: smartpickdeals.live/go/:code
// Decodes base64url → instant 302 redirect
// Tracking is fire-and-forget (never delays redirect)

const BACKEND_PRIMARY  = 'https://api.smartpickdeals.live';
const BACKEND_FALLBACK = 'https://extrape-affiliate.onrender.com';

export async function onRequest(context) {
  const code = context.params.code;
  if (!code) return new Response('Missing code', { status: 400 });

  let dest = null;

  // Decode base64url → affiliate URL
  try {
    const decoded = atob(code.replace(/-/g, '+').replace(/_/g, '/'));
    if (decoded.startsWith('http')) dest = decoded;
  } catch(e) {}

  if (!dest) {
    // Code not base64 — try backend directly
    return Response.redirect(`${BACKEND_PRIMARY}/go/${code}`, 302);
  }

  // Fire tracking in background — try laptop first, fallback to Render
  // Never awaited — redirect is always instant
  context.waitUntil(
    fetch(`${BACKEND_PRIMARY}/track/click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dest }),
      signal: AbortSignal.timeout(3000),
    }).catch(() =>
      fetch(`${BACKEND_FALLBACK}/track/click`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dest }),
      }).catch(() => {})
    )
  );

  // Instant redirect — no waiting for backend
  return Response.redirect(dest, 302);
}
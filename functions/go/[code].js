// Cloudflare Pages Function: smartpickdeals.live/go/:code
// 1. Decodes base64url affiliate URL
// 2. Fires click tracking to Render (async, doesn't delay redirect)
// 3. Immediately 302 redirects user to affiliate URL

const BACKEND = 'https://extrape-affiliate.onrender.com';

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
    // Fallback: send to Render directly
    return Response.redirect(`${BACKEND}/go/${code}`, 302);
  }

  // Fire tracking in background (don't await — instant redirect)
  context.waitUntil(
    fetch(`${BACKEND}/track/click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dest }),
    }).catch(() => {}) // silently ignore if Render is sleeping
  );

  // Instant redirect — no waiting for Render
  return Response.redirect(dest, 302);
}
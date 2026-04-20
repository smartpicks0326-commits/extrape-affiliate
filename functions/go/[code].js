// Cloudflare Pages Function: smartpickdeals.live/go/:code
// Tracking goes to Render — Cloudflare Workers cannot call Cloudflare Tunnels
// (api.smartpickdeals.live is a Tunnel — calling it from a Worker causes a loop)

const TRACKING_BACKEND = 'https://extrape-affiliate.onrender.com';

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
    return Response.redirect('https://smartpickdeals.live', 302);
  }

  // Fire tracking in background — Render only (not Tunnel)
  context.waitUntil(
    fetch(`${TRACKING_BACKEND}/track/click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dest }),
    }).catch(() => {})
  );

  // Instant redirect
  return Response.redirect(dest, 302);
}
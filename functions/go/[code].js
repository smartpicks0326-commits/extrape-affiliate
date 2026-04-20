// Cloudflare Pages Function: /go/:code
// Pure redirect — no external calls, never fails
// Tracking is completely optional and non-blocking

export async function onRequest(context) {
  const code = context.params.code;
  if (!code) return new Response('Missing code', { status: 400 });

  // Decode base64url → destination URL
  let dest = null;
  try {
    const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64 + '=='.slice(0, (4 - b64.length % 4) % 4);
    dest = atob(pad);
    if (!dest.startsWith('http')) dest = null;
  } catch(e) { dest = null; }

  // If decode fails — redirect to homepage
  if (!dest) return Response.redirect('https://smartpickdeals.live', 302);

  // Fire tracking async — completely isolated, never affects redirect
  const BACKEND = 'https://api.smartpickdeals.live';
  try {
    context.waitUntil(
      fetch(BACKEND + '/track/click', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dest }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => {}) // silently ignore ALL errors
    );
  } catch(e) {} // even waitUntil itself is wrapped

  // Always redirect immediately — tracking never blocks this
  return Response.redirect(dest, 302);
}
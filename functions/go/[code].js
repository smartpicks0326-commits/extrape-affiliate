// Cloudflare Pages Function: smartpickdeals.live/go/:code
// Simple 302 redirect to Render — NO fetch, so no 522 timeout.
// Browser handles the redirect chain directly.
const BACKEND = 'https://extrape-affiliate.onrender.com';
export async function onRequest(context) {
  const code = context.params.code;
  if (!code) return new Response('Missing code', { status: 400 });
  // Direct redirect — Cloudflare is not involved after this
  // Browser → Render /go/:code → affiliate URL
  return Response.redirect(`${BACKEND}/go/${code}`, 302);
}
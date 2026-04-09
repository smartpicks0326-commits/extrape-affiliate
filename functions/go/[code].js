// Cloudflare Pages Function: smartpickdeals.live/go/:code
// The :code is base64url-encoded affiliate URL — decoded and redirected directly.
// NO Render fetch = NO 522 timeout = always works even if Render is sleeping.
export async function onRequest(context) {
  const code = context.params.code;
  if (!code) return new Response('Missing code', { status: 400 });
  try {
    // Decode base64url → actual affiliate URL
    const decoded = atob(code.replace(/-/g, '+').replace(/_/g, '/'));
    if (!decoded.startsWith('http')) throw new Error('Invalid');
    return Response.redirect(decoded, 302);
  } catch(e) {
    // Fallback: try Render directly (for old-style short codes)
    return Response.redirect('https://extrape-affiliate.onrender.com/go/' + code, 302);
  }
}
// Cloudflare Pages Function — handles /go/:code redirects
// When user visits smartpickdeals.pages.dev/go/B0GL2MJBT2
// it fetches the full affiliate URL from our backend and redirects

const BACKEND = 'https://extrape-affiliate.onrender.com';

export async function onRequest(context) {
  const { params } = context;
  const code = params.code;

  if (!code) {
    return new Response('Missing code', { status: 400 });
  }

  try {
    // Fetch the real URL from our backend
    const res = await fetch(`${BACKEND}/resolve/${code}`, {
      headers: { 'Accept': 'application/json' }
    });

    if (!res.ok) {
      return new Response('Link not found or expired.', { status: 404 });
    }

    const data = await res.json();
    const targetUrl = data.url;

    if (!targetUrl) {
      return new Response('Invalid link.', { status: 404 });
    }

    // Redirect to the full affiliate URL (with tag)
    return Response.redirect(targetUrl, 301);

  } catch (err) {
    // Fallback: try the backend /go/ directly
    return Response.redirect(`${BACKEND}/go/${code}`, 302);
  }
}

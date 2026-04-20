export async function onRequest(context) {
  const code = context.params.code;
  if (!code) return Response.redirect('https://smartpickdeals.live', 302);

  try {
    const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
    const dest = atob(b64);
    if (dest.startsWith('http')) {
      // Fire-and-forget tracking
      fetch('https://api.smartpickdeals.live/track/click', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dest }),
      }).catch(() => {});
      return Response.redirect(dest, 302);
    }
  } catch(e) {}

  return Response.redirect('https://smartpickdeals.live', 302);
}
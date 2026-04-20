export async function onRequest(context) {
  const code = context.params.code;
  if (!code) return Response.redirect('https://smartpickdeals.live', 302);

  try {
    const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
    const dest = atob(b64);
    if (dest.startsWith('http')) {

      // MUST use context.waitUntil so tracking runs AFTER redirect is sent
      // Without this, Workers waits for fetch before sending redirect → 522
      context.waitUntil(
        fetch('https://api.smartpickdeals.live/track/click', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dest }),
        }).catch(() => {})
      );

      // This sends immediately — tracking runs in background
      return Response.redirect(dest, 302);
    }
  } catch(e) {}

  return Response.redirect('https://smartpickdeals.live', 302);
}
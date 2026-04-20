export async function onRequest(context) {
  try {
    const code = context.params.code;
    if (!code) return Response.redirect('https://smartpickdeals.live', 302);

    // Base64url decode
    const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
    const dest = atob(b64);

    if (dest && dest.startsWith('http')) {
      return Response.redirect(dest, 302);
    }
  } catch(e) {
    console.log('Error:', e.message);
  }

  return Response.redirect('https://smartpickdeals.live', 302);
}
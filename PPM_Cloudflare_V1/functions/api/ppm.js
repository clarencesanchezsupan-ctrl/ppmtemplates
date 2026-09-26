export async function onRequestPost(context) {
  const appScriptUrl = context.env.PPM_APPS_SCRIPT_URL;
  const proxySecret = context.env.PPM_PROXY_SECRET;

  if (!appScriptUrl || !proxySecret) {
    return json(500, {
      ok: false,
      error: 'PPM backend environment variables are missing in Cloudflare.'
    });
  }

  let incoming;
  try {
    incoming = await context.request.json();
  } catch (_) {
    return json(400, { ok: false, error: 'Invalid request.' });
  }

  try {
    const response = await fetch(appScriptUrl, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ ...incoming, secret: proxySecret })
    });

    const text = await response.text();
    let backend;
    try {
      backend = JSON.parse(text);
    } catch (_) {
      console.error('Non-JSON Apps Script response:', text.slice(0, 500));
      return json(502, {
        ok: false,
        error: 'The Google backend is not reachable. Recheck the Apps Script deployment: Execute as Me, access Anyone, and use the /exec URL.'
      });
    }

    if (!backend.ok) {
      return json(400, backend);
    }

    return json(200, backend);
  } catch (err) {
    console.error('PPM proxy error:', err);
    return json(502, {
      ok: false,
      error: 'Could not reach the PPM backend. Please try again.'
    });
  }
}

export function onRequestGet() {
  return json(405, { ok: false, error: 'Method not allowed.' });
}

function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

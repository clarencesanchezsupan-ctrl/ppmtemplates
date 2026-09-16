export default async (request) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };

  if (request.method === "OPTIONS") {
    return new Response("", { status: 204, headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "Method not allowed." }),
      { status: 405, headers: corsHeaders }
    );
  }

  const appsScriptUrl = process.env.PPM_APPS_SCRIPT_URL;
  const proxySecret = process.env.PPM_PROXY_SECRET;

  if (!appsScriptUrl || !proxySecret) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Server configuration is incomplete."
      }),
      { status: 500, headers: corsHeaders }
    );
  }

  try {
    const incoming = await request.json();

    const allowedActions = new Set([
      "config",
      "preview",
      "booking",
      "health"
    ]);

    const action = String(incoming?.action || "").trim();

    if (!allowedActions.has(action)) {
      return new Response(
        JSON.stringify({ ok: false, error: "Unknown API action." }),
        { status: 400, headers: corsHeaders }
      );
    }

    const payload = {
      ...incoming,
      action,
      secret: proxySecret
    };

    const upstream = await fetch(appsScriptUrl, {
      method: "POST",
      redirect: "follow",
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },
      body: JSON.stringify(payload)
    });

    const raw = await upstream.text();

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "The Apps Script backend returned an invalid response."
        }),
        { status: 502, headers: corsHeaders }
      );
    }

    return new Response(
      JSON.stringify(data),
      {
        status: upstream.ok ? 200 : 502,
        headers: corsHeaders
      }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: error?.message || "Server error."
      }),
      { status: 500, headers: corsHeaders }
    );
  }
};

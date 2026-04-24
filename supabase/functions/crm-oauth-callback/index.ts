import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GHL_CLIENT_ID = Deno.env.get("GHL_CLIENT_ID")!;
const GHL_CLIENT_SECRET = Deno.env.get("GHL_CLIENT_SECRET")!;

const TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";
const LOCATION_URL = "https://services.leadconnectorhq.com/locations/";

function htmlResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
  });
}

function pageShell(title: string, body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#0a0a0a;color:#fafafa;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
  .card{max-width:520px;background:#161616;border:1px solid #2a2a2a;border-radius:12px;padding:32px;text-align:center}
  h1{margin:0 0 12px;font-size:22px}
  p{color:#a1a1aa;line-height:1.5;margin:8px 0}
  a{display:inline-block;margin-top:20px;background:#fafafa;color:#0a0a0a;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600}
  .err{color:#f87171}
</style></head><body><div class="card">${body}</div></body></html>`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  if (errorParam) {
    return htmlResponse(pageShell("Connection failed", `<h1 class="err">Connection cancelled</h1><p>${errorParam}</p><a href="/admin/tenants">Back to tenants</a>`));
  }
  if (!code || !state) {
    return htmlResponse(pageShell("Invalid request", `<h1 class="err">Invalid request</h1><p>Missing code or state.</p><a href="/admin/tenants">Back</a>`), 400);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Validate state (CSRF)
  const { data: stateRow } = await supabase
    .from("oauth_states")
    .select("id, user_id, expires_at")
    .eq("state", state)
    .maybeSingle();

  if (!stateRow || new Date(stateRow.expires_at).getTime() < Date.now()) {
    return htmlResponse(pageShell("Expired", `<h1 class="err">Session expired</h1><p>Please try connecting again.</p><a href="/admin/tenants">Back</a>`), 400);
  }
  await supabase.from("oauth_states").delete().eq("id", stateRow.id);

  // Exchange code for sub-account (Location) token
  const redirectUri = `${url.origin}${url.pathname}`;
  const tokenForm = new URLSearchParams({
    client_id: GHL_CLIENT_ID,
    client_secret: GHL_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    user_type: "Location",
  });

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: tokenForm.toString(),
  });
  const tokenJson: any = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenJson.access_token) {
    console.error("[crm-oauth-callback] token exchange failed", tokenRes.status, tokenJson);
    return htmlResponse(pageShell("Connection failed", `<h1 class="err">Token exchange failed</h1><p>${JSON.stringify(tokenJson).slice(0, 300)}</p><a href="/admin/tenants">Back</a>`), 500);
  }

  const accessToken: string = tokenJson.access_token;
  const refreshToken: string | null = tokenJson.refresh_token || null;
  const locationId: string | undefined = tokenJson.locationId;
  const companyId: string | null = tokenJson.companyId || null;
  const expiresAt = new Date(Date.now() + (Number(tokenJson.expires_in || 86400)) * 1000).toISOString();

  if (!locationId) {
    return htmlResponse(pageShell("Connection failed", `<h1 class="err">No locationId returned</h1><p>This token did not include a location. Reinstall on a single sub-account.</p><a href="/admin/tenants">Back</a>`), 400);
  }

  // Fetch the location details for name + timezone
  let locName = `Location ${locationId}`;
  let locTimezone = "America/Los_Angeles";
  try {
    const locRes = await fetch(`${LOCATION_URL}${locationId}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Version: "2021-07-28",
        Accept: "application/json",
      },
    });
    const locJson: any = await locRes.json().catch(() => ({}));
    if (locRes.ok) {
      const loc = locJson.location || locJson;
      if (loc?.name) locName = loc.name;
      if (loc?.timezone) locTimezone = loc.timezone;
    } else {
      console.warn("[crm-oauth-callback] location fetch non-ok", locRes.status, locJson);
    }
  } catch (err) {
    console.warn("[crm-oauth-callback] location fetch failed", err);
  }

  // Upsert tenant by ghl_location_id
  const { data: existing } = await supabase
    .from("tenants")
    .select("id")
    .eq("ghl_location_id", locationId)
    .maybeSingle();

  const payload: any = {
    name: locName,
    ghl_location_id: locationId,
    ghl_api_token: accessToken,
    ghl_refresh_token: refreshToken,
    ghl_token_expires_at: expiresAt,
    ghl_company_id: companyId,
    oauth_imported: true,
    timezone: locTimezone,
    active: true,
  };

  let upsertError: string | null = null;
  let action: "created" | "updated" = "created";
  if (existing) {
    action = "updated";
    const { error } = await supabase.from("tenants").update(payload).eq("id", existing.id);
    if (error) upsertError = error.message;
  } else {
    const { error } = await supabase.from("tenants").insert(payload);
    if (error) upsertError = error.message;
  }

  if (upsertError) {
    return htmlResponse(pageShell("Connection failed", `<h1 class="err">Could not save tenant</h1><p>${upsertError}</p><a href="/admin/tenants">Back</a>`), 500);
  }

  return htmlResponse(pageShell("Connected", `
    <h1>✓ Sub-account connected</h1>
    <p><strong>${locName}</strong> was ${action} as a tenant.</p>
    <p style="color:#a1a1aa;font-size:13px;margin-top:16px">Next: pick a calendar for this tenant on the Tenants page. To add another sub-account, click Connect again from a different sub-account login.</p>
    <a href="/admin/tenants">Back to tenants</a>
  `));
});

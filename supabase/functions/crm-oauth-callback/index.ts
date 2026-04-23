import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GHL_CLIENT_ID = Deno.env.get("GHL_CLIENT_ID")!;
const GHL_CLIENT_SECRET = Deno.env.get("GHL_CLIENT_SECRET")!;

const TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";
const LOCATIONS_URL = "https://services.leadconnectorhq.com/locations/search";
const LOCATION_TOKEN_URL = "https://services.leadconnectorhq.com/oauth/locationToken";

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

  // Exchange code for agency token
  const redirectUri = `${url.origin}${url.pathname}`;
  const tokenForm = new URLSearchParams({
    client_id: GHL_CLIENT_ID,
    client_secret: GHL_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    user_type: "Company",
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

  const agencyToken: string = tokenJson.access_token;
  const companyId: string | undefined = tokenJson.companyId;

  if (!companyId) {
    return htmlResponse(pageShell("Connection failed", `<h1 class="err">No companyId returned</h1><p>This token belongs to a single location, not an agency. Reconnect using your agency login.</p><a href="/admin/tenants">Back</a>`), 400);
  }

  // List all locations under this agency
  const locRes = await fetch(`${LOCATIONS_URL}?companyId=${encodeURIComponent(companyId)}&limit=500`, {
    headers: {
      Authorization: `Bearer ${agencyToken}`,
      Version: "2021-07-28",
      Accept: "application/json",
    },
  });
  const locJson: any = await locRes.json().catch(() => ({}));
  if (!locRes.ok) {
    console.error("[crm-oauth-callback] locations list failed", locRes.status, locJson);
    return htmlResponse(pageShell("Connection failed", `<h1 class="err">Could not list locations</h1><p>${JSON.stringify(locJson).slice(0, 300)}</p><a href="/admin/tenants">Back</a>`), 500);
  }

  const locations: any[] = locJson.locations || [];
  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  // For each location, mint a per-location token and upsert the tenant.
  for (const loc of locations) {
    const locId = loc.id;
    const locName = loc.name || `Location ${locId}`;
    if (!locId) continue;

    try {
      const locTokenForm = new URLSearchParams({
        companyId,
        locationId: locId,
      });
      const ltRes = await fetch(LOCATION_TOKEN_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${agencyToken}`,
          Version: "2021-07-28",
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: locTokenForm.toString(),
      });
      const ltJson: any = await ltRes.json().catch(() => ({}));
      if (!ltRes.ok || !ltJson.access_token) {
        skipped++;
        errors.push(`${locName}: ${JSON.stringify(ltJson).slice(0, 120)}`);
        continue;
      }

      const expiresAt = new Date(Date.now() + (Number(ltJson.expires_in || 86400)) * 1000).toISOString();

      // Upsert by ghl_location_id
      const { data: existing } = await supabase
        .from("tenants")
        .select("id")
        .eq("ghl_location_id", locId)
        .maybeSingle();

      const payload: any = {
        name: locName,
        ghl_location_id: locId,
        ghl_api_token: ltJson.access_token,
        ghl_refresh_token: ltJson.refresh_token || null,
        ghl_token_expires_at: expiresAt,
        ghl_company_id: companyId,
        oauth_imported: true,
        timezone: loc.timezone || "America/Los_Angeles",
        active: true,
      };

      if (existing) {
        await supabase.from("tenants").update(payload).eq("id", existing.id);
      } else {
        await supabase.from("tenants").insert(payload);
      }
      imported++;
    } catch (err: any) {
      skipped++;
      errors.push(`${locName}: ${err.message}`);
    }
  }

  const errorList = errors.length
    ? `<details style="text-align:left;margin-top:16px"><summary style="cursor:pointer;color:#a1a1aa">${errors.length} skipped</summary><pre style="white-space:pre-wrap;font-size:12px;color:#71717a">${errors.join("\n")}</pre></details>`
    : "";

  return htmlResponse(pageShell("Connected", `
    <h1>✓ CRM agency connected</h1>
    <p><strong>${imported}</strong> sub-account${imported === 1 ? "" : "s"} imported as tenants.</p>
    ${skipped ? `<p style="color:#a1a1aa">${skipped} skipped.</p>` : ""}
    ${errorList}
    <p style="color:#a1a1aa;font-size:13px;margin-top:16px">Next: pick a calendar for each tenant in the Tenants page.</p>
    <a href="/admin/tenants">Back to tenants</a>
  `));
});

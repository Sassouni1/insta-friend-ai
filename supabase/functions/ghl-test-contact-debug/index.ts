// Debug: delete any existing contacts in a tenant's GHL location matching a phone,
// then create a fresh test contact. Lets us verify the ContactCreate webhook fires.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { getFreshGhlToken } from "../_shared/ghl.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const GHL = "https://services.leadconnectorhq.com";
const V = "2021-07-28";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  const tenantId = url.searchParams.get("tenant_id");
  const email = url.searchParams.get("email") || "test@gmail.com";
  const phone = url.searchParams.get("phone") || "+17276374672";
  const firstName = url.searchParams.get("first_name") || "Test";
  const lastName = url.searchParams.get("last_name") || "Lead";
  if (!tenantId) return jsonResponse({ error: "tenant_id required" }, 400);

  const sb: any = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  let token: string, locationId: string;
  try {
    const t = await getFreshGhlToken(sb, tenantId);
    token = t.token; locationId = t.locationId;
  } catch (err: any) {
    return jsonResponse({ error: "token fetch failed", detail: err.message }, 500);
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Version: V,
    Accept: "application/json",
  };

  // 1. Search existing contacts with this phone
  const searchRes = await fetch(`${GHL}/contacts/search`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      locationId,
      pageLimit: 50,
      filters: [{ field: "phone", operator: "eq", value: phone }],
    }),
  });
  const searchJson: any = await searchRes.json().catch(() => ({}));
  const existing = (searchJson?.contacts || []) as any[];
  const deleted: any[] = [];
  for (const c of existing) {
    const delRes = await fetch(`${GHL}/contacts/${c.id}`, { method: "DELETE", headers });
    deleted.push({ id: c.id, name: [c.firstName, c.lastName].filter(Boolean).join(" "), ok: delRes.ok, status: delRes.status });
  }

  // Also wipe any local scheduled_calls for this phone in this tenant so the new one isn't deduped
  await sb.from("scheduled_calls").delete().eq("tenant_id", tenantId).eq("lead_phone", phone);

  // 2. Create the test contact
  const createRes = await fetch(`${GHL}/contacts/`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      locationId,
      firstName,
      lastName,
      email,
      phone,
      source: "Webhook Test",
    }),
  });
  const createText = await createRes.text();
  let createJson: any;
  try { createJson = JSON.parse(createText); } catch { createJson = createText; }

  if (!createRes.ok) {
    return jsonResponse({
      ok: false,
      step: "create",
      status: createRes.status,
      detail: createJson,
      deleted,
    }, 500);
  }

  const contactId = createJson?.contact?.id || createJson?.id;
  return jsonResponse({
    ok: true,
    locationId,
    deleted_count: deleted.length,
    deleted,
    created: { id: contactId, email, phone, name: `${firstName} ${lastName}` },
  });
});

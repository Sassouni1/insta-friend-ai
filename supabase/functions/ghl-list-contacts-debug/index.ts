// Debug: list contacts for a tenant created this month via GHL API.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { getFreshGhlToken } from "../_shared/ghl.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  const tenantId = url.searchParams.get("tenant_id");
  if (!tenantId) return jsonResponse({ error: "tenant_id required" }, 400);

  const supabase: any = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  let token: string, locationId: string;
  try {
    const t = await getFreshGhlToken(supabase, tenantId);
    token = t.token;
    locationId = t.locationId;
  } catch (err: any) {
    return jsonResponse({ error: "token fetch failed", detail: err.message }, 500);
  }

  // Start of current month UTC
  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCFullYear() && now.getUTCMonth(), 1));
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);

  const body = {
    locationId,
    pageLimit: 100,
    page: 1,
    filters: [
      {
        field: "dateAdded",
        operator: "range",
        value: { gte: startOfMonth.toISOString(), lte: now.toISOString() },
      },
    ],
    sort: [{ field: "dateAdded", direction: "desc" }],
  };

  const res = await fetch("https://services.leadconnectorhq.com/contacts/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Version: "2021-07-28",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }

  if (!res.ok) {
    return jsonResponse({ error: "ghl search failed", status: res.status, data }, 500);
  }

  const contacts = (data?.contacts || []).map((c: any) => ({
    id: c.id,
    name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.contactName,
    phone: c.phone,
    email: c.email,
    dateAdded: c.dateAdded,
    source: c.source,
    tags: c.tags,
  }));

  return jsonResponse({
    locationId,
    total: data?.total ?? contacts.length,
    returned: contacts.length,
    since: startOfMonth.toISOString(),
    contacts,
  });
});

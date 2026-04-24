import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace("Bearer ", "");
  if (!jwt) return jsonResponse({ error: "unauthorized" }, 401);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: userData } = await supabase.auth.getUser(jwt);
  const user = userData?.user;
  if (!user) return jsonResponse({ error: "unauthorized" }, 401);

  const { data: roleRow } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .eq("role", "admin")
    .maybeSingle();
  if (!roleRow) return jsonResponse({ error: "forbidden" }, 403);

  const body = await req.json().catch(() => ({}));
  const tenantId: string = body.tenant_id;
  if (!tenantId) return jsonResponse({ error: "tenant_id required" }, 400);

  const { data: tenant } = await supabase
    .from("tenants")
    .select("ghl_api_token, ghl_location_id")
    .eq("id", tenantId)
    .maybeSingle();

  if (!tenant?.ghl_api_token || !tenant?.ghl_location_id) {
    return jsonResponse({ error: "tenant missing CRM token or location id" }, 400);
  }

  const url = `https://services.leadconnectorhq.com/calendars/?locationId=${encodeURIComponent(tenant.ghl_location_id)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${tenant.ghl_api_token}`,
      Version: "2021-04-15",
      Accept: "application/json",
    },
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("[ghl-list-calendars] failed", res.status, json);
    return jsonResponse({ error: "list failed", details: json }, res.status);
  }

  const calendars = (json.calendars || []).map((c: any) => ({
    id: c.id,
    name: c.name,
    isActive: c.isActive ?? true,
  }));

  return jsonResponse({ calendars });
});

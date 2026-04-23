import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { GhlClient, flattenSlots } from "../_shared/ghl.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const BodySchema = z.object({
  tenant_id: z.string().uuid(),
  days_ahead: z.number().int().min(1).max(30).default(7),
});

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return jsonResponse({ error: parsed.error.flatten().fieldErrors }, 400);
  }
  const { tenant_id, days_ahead } = parsed.data;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: tenant, error } = await supabase
    .from("tenants")
    .select("ghl_api_token, ghl_calendar_id, ghl_location_id, timezone")
    .eq("id", tenant_id)
    .maybeSingle();

  if (error || !tenant?.ghl_api_token || !tenant.ghl_calendar_id || !tenant.ghl_location_id) {
    return jsonResponse({ error: "tenant ghl config incomplete" }, 400);
  }

  try {
    const client = new GhlClient(tenant.ghl_api_token, tenant.ghl_location_id);
    const startMs = Date.now();
    const endMs = startMs + days_ahead * 24 * 60 * 60 * 1000;
    const raw = await client.getCalendarSlots(tenant.ghl_calendar_id, startMs, endMs, tenant.timezone);
    const all = flattenSlots(raw);
    const next3 = all.slice(0, 3);
    return jsonResponse({
      slots: next3,
      timezone: tenant.timezone,
      total_available: all.length,
    });
  } catch (err: any) {
    console.error("[ghl-get-availability]", err);
    return jsonResponse({ error: err.message || "failed" }, 500);
  }
});

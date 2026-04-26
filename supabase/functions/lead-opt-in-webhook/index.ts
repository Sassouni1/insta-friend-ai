import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { fireCall, scheduleBackground } from "../_shared/dialer.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const DEFAULT_DELAY_SECONDS = 120;

function pickPhone(body: any): string | null {
  const candidates = [body?.phone, body?.lead_phone, body?.contact?.phone, body?.full_phone];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return null;
}

function pickName(body: any): string | null {
  if (body?.name) return String(body.name);
  const first = body?.first_name || body?.contact?.firstName || "";
  const last = body?.last_name || body?.contact?.lastName || "";
  const full = `${first} ${last}`.trim();
  return full || null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  if (!secret) return jsonResponse({ error: "missing secret" }, 401);

  const body: any = await req.json().catch(() => ({}));
  const locationId: string | undefined =
    body?.locationId || body?.location_id || body?.contact?.locationId;
  if (!locationId) return jsonResponse({ error: "locationId required" }, 400);

  const phone = pickPhone(body);
  if (!phone) return jsonResponse({ error: "phone required" }, 400);

  const supabase: any = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: tenant } = await supabase
    .from("tenants")
    .select("id, webhook_secret, active")
    .eq("ghl_location_id", locationId)
    .maybeSingle();

  if (!tenant) return jsonResponse({ error: "tenant not found" }, 404);
  if (tenant.webhook_secret !== secret) return jsonResponse({ error: "invalid secret" }, 401);
  if (!tenant.active) return jsonResponse({ error: "tenant inactive" }, 403);

  const delaySeconds = Number(body?.delay_seconds ?? DEFAULT_DELAY_SECONDS);
  const fireAt = new Date(Date.now() + delaySeconds * 1000).toISOString();

  const { data: row, error: insErr } = await supabase
    .from("scheduled_calls")
    .insert({
      tenant_id: tenant.id,
      lead_phone: phone,
      lead_name: pickName(body),
      lead_email: body?.email || body?.contact?.email || null,
      ghl_contact_id: body?.contact_id || body?.contact?.id || null,
      fire_at: fireAt,
    })
    .select("id, fire_at")
    .single();

  if (insErr || !row) {
    console.error("[opt-in] insert failed", insErr);
    return jsonResponse({ error: "scheduling failed" }, 500);
  }

  console.log(`[opt-in] scheduled ${row.id} for ${phone}, firing in ${delaySeconds}s`);

  scheduleBackground(async () => {
    await new Promise((r) => setTimeout(r, delaySeconds * 1000));
    await fireCall(row.id, "opt-in");
  });

  return jsonResponse({ ok: true, scheduled_id: row.id, fire_at: row.fire_at });
});

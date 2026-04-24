import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { telnyxDial } from "../_shared/telnyx.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BRIDGE_WS_URL = `wss://${new URL(SUPABASE_URL).host.replace(".supabase.co", ".functions.supabase.co")}/telnyx-bridge`;

const DEFAULT_DELAY_SECONDS = 120; // 2 minute delay after opt-in

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

const RING_TIMEOUT_SECS = 25;
const RETRY_WAIT_MS = 35_000; // wait a bit longer than ring timeout before checking

async function placeDial(opts: {
  supabase: ReturnType<typeof createClient>;
  tenantId: string;
  leadPhone: string;
  leadName: string | null;
  leadEmail: string | null;
}): Promise<{ conversationId: string; callControlId: string | null }> {
  const { supabase, tenantId, leadPhone, leadName, leadEmail } = opts;

  const [{ data: phoneRow }, { data: tenantRow }] = await Promise.all([
    supabase
      .from("phone_numbers")
      .select("e164_number, telnyx_connection_id")
      .eq("tenant_id", tenantId)
      .eq("active", true)
      .limit(1)
      .maybeSingle(),
    supabase
      .from("tenants")
      .select("name, timezone")
      .eq("id", tenantId)
      .maybeSingle(),
  ]);

  if (!phoneRow?.e164_number || !phoneRow?.telnyx_connection_id) {
    throw new Error("no active phone number for tenant");
  }

  const { data: convRow, error: convErr } = await supabase
    .from("conversations")
    .insert({
      tenant_id: tenantId,
      caller_phone: leadPhone,
      direction: "outbound",
    })
    .select("id")
    .single();

  if (convErr || !convRow) throw new Error(`conversation insert failed: ${convErr?.message}`);

  const params = new URLSearchParams({
    conv: convRow.id,
    tenant: tenantId,
    caller: leadPhone,
  });
  if (leadName) params.set("name", leadName);
  if (leadEmail) params.set("email", leadEmail);
  if (tenantRow?.name) params.set("company", tenantRow.name);
  if (tenantRow?.timezone) params.set("tz", tenantRow.timezone);

  const streamUrl = `${BRIDGE_WS_URL}?${params.toString()}`;

  const dialRes = await telnyxDial({
    to: leadPhone,
    from: phoneRow.e164_number,
    connection_id: phoneRow.telnyx_connection_id,
    stream_url: streamUrl,
    stream_track: "both_tracks",
    stream_bidirectional_mode: "rtp",
    stream_bidirectional_codec: "PCMU",
    stream_codec: "PCMU",
    timeout_secs: RING_TIMEOUT_SECS,
  });

  if (!dialRes.ok) {
    const txt = await dialRes.text();
    throw new Error(`telnyx dial ${dialRes.status}: ${txt.slice(0, 200)}`);
  }

  const dialData = await dialRes.json();
  const callControlId = dialData?.data?.call_control_id ?? null;
  if (callControlId) {
    await supabase
      .from("conversations")
      .update({ telnyx_call_control_id: callControlId })
      .eq("id", convRow.id);
  }
  return { conversationId: convRow.id, callControlId };
}

async function wasAnswered(supabase: ReturnType<typeof createClient>, conversationId: string): Promise<boolean> {
  // If any transcript entries exist, the bridge connected → call was answered.
  const { count } = await supabase
    .from("transcript_entries")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId);
  return (count ?? 0) > 0;
}

async function fireCall(scheduledId: string) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Atomically claim the row to avoid double-fire
  const { data: claimed } = await supabase
    .from("scheduled_calls")
    .update({ status: "processing", attempts: 1 })
    .eq("id", scheduledId)
    .eq("status", "pending")
    .select("id, tenant_id, lead_phone, lead_name, lead_email")
    .maybeSingle();

  if (!claimed) {
    console.log(`[opt-in] call ${scheduledId} already processed or cancelled`);
    return;
  }

  try {
    const first = await placeDial({
      supabase,
      tenantId: claimed.tenant_id,
      leadPhone: claimed.lead_phone,
      leadName: claimed.lead_name,
      leadEmail: claimed.lead_email,
    });

    await supabase
      .from("scheduled_calls")
      .update({ status: "dialed", conversation_id: first.conversationId, last_error: null })
      .eq("id", scheduledId);

    console.log(`[opt-in] dialed ${claimed.lead_phone} for scheduled ${scheduledId} (attempt 1)`);

    // Wait for ring window, then check if they answered. If not, dial once more.
    await new Promise((r) => setTimeout(r, RETRY_WAIT_MS));

    const answered = await wasAnswered(supabase, first.conversationId);
    if (answered) {
      console.log(`[opt-in] ${claimed.lead_phone} answered on attempt 1`);
      return;
    }

    console.log(`[opt-in] ${claimed.lead_phone} no-answer on attempt 1, retrying...`);

    const second = await placeDial({
      supabase,
      tenantId: claimed.tenant_id,
      leadPhone: claimed.lead_phone,
      leadName: claimed.lead_name,
      leadEmail: claimed.lead_email,
    });

    await supabase
      .from("scheduled_calls")
      .update({
        status: "dialed",
        conversation_id: second.conversationId,
        attempts: 2,
        last_error: null,
      })
      .eq("id", scheduledId);

    console.log(`[opt-in] dialed ${claimed.lead_phone} for scheduled ${scheduledId} (attempt 2)`);
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error(`[opt-in] fire failed for ${scheduledId}:`, msg);
    await supabase
      .from("scheduled_calls")
      .update({ status: "failed", last_error: msg.slice(0, 500) })
      .eq("id", scheduledId);
  }
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

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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

  // Background task: wait, then dial. EdgeRuntime.waitUntil keeps the runtime alive.
  const task = new Promise<void>((resolve) => {
    setTimeout(async () => {
      await fireCall(row.id);
      resolve();
    }, delaySeconds * 1000);
  });

  // @ts-ignore EdgeRuntime is a Deno deploy global
  if (typeof EdgeRuntime !== "undefined" && (EdgeRuntime as any).waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(task);
  } else {
    // Fallback: don't await — function will return but may be cut short locally
    task.catch((e) => console.error("[opt-in] background error", e));
  }

  return jsonResponse({ ok: true, scheduled_id: row.id, fire_at: row.fire_at });
});

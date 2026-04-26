// Shared outbound dialer used by lead opt-in + GHL contact webhooks.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { telnyxDial } from "./telnyx.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BRIDGE_WS_URL = `wss://${new URL(SUPABASE_URL).host.replace(".supabase.co", ".functions.supabase.co")}/telnyx-bridge`;

const RING_TIMEOUT_SECS = 25;
const RETRY_WAIT_MS = 35_000;

export async function placeDial(opts: {
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
  const { count } = await supabase
    .from("transcript_entries")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId);
  return (count ?? 0) > 0;
}

export async function fireCall(scheduledId: string, logTag = "dial") {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: claimed } = await supabase
    .from("scheduled_calls")
    .update({ status: "processing", attempts: 1 })
    .eq("id", scheduledId)
    .eq("status", "pending")
    .select("id, tenant_id, lead_phone, lead_name, lead_email")
    .maybeSingle();

  if (!claimed) {
    console.log(`[${logTag}] call ${scheduledId} already processed or cancelled`);
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

    console.log(`[${logTag}] dialed ${claimed.lead_phone} for ${scheduledId} (attempt 1)`);

    await new Promise((r) => setTimeout(r, RETRY_WAIT_MS));

    if (await wasAnswered(supabase, first.conversationId)) {
      console.log(`[${logTag}] ${claimed.lead_phone} answered on attempt 1`);
      return;
    }

    console.log(`[${logTag}] ${claimed.lead_phone} no-answer on attempt 1, retrying...`);

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

    console.log(`[${logTag}] dialed ${claimed.lead_phone} for ${scheduledId} (attempt 2)`);
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error(`[${logTag}] fire failed for ${scheduledId}:`, msg);
    await supabase
      .from("scheduled_calls")
      .update({ status: "failed", last_error: msg.slice(0, 500) })
      .eq("id", scheduledId);
  }
}

export function scheduleBackground(task: () => Promise<void>) {
  const p = task();
  // @ts-ignore EdgeRuntime is a Deno deploy global
  if (typeof EdgeRuntime !== "undefined" && (EdgeRuntime as any).waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(p);
  } else {
    p.catch((e) => console.error("[dialer] background error", e));
  }
}

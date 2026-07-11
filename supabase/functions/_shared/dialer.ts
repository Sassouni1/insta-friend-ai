// Shared outbound dialer used by lead opt-in + GHL contact webhooks.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  ELEVENLABS_OUTBOUND_AGENT_ID,
  ELEVENLABS_SIP_FROM_NUMBER,
  ELEVENLABS_SIP_PHONE_NUMBER_ID,
  elevenLabsSipDial,
} from "./elevenlabs-sip.ts";
import {
  assertPhoneNotSuppressed,
  isPhoneSuppressed,
} from "./opt-out.ts";

// Loose alias — Deno's strict typing on createClient<unknown> infers `never` for
// schema, which breaks .from() chaining across modules. We treat the client as
// any inside dialer code; runtime behavior is unaffected.
type SupabaseAny = any;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export async function placeDial(opts: {
  supabase: SupabaseAny;
  tenantId: string;
  leadPhone: string;
  leadName: string | null;
  leadEmail: string | null;
}): Promise<{ conversationId: string; elevenLabsConversationId: string }> {
  const { supabase, tenantId, leadPhone, leadName, leadEmail } = opts as {
    supabase: SupabaseAny;
    tenantId: string;
    leadPhone: string;
    leadName: string | null;
    leadEmail: string | null;
  };

  await assertPhoneNotSuppressed(supabase, tenantId, leadPhone);

  const [{ data: phoneRow }, { data: tenantRow }] = await Promise.all([
    supabase
      .from("phone_numbers")
      .select("e164_number")
      .eq("tenant_id", tenantId)
      .eq("active", true)
      .eq("e164_number", ELEVENLABS_SIP_FROM_NUMBER)
      .limit(1)
      .maybeSingle(),
    supabase
      .from("tenants")
      .select("name, timezone")
      .eq("id", tenantId)
      .maybeSingle(),
  ]);

  if (!phoneRow?.e164_number) {
    throw new Error("no active ElevenLabs SIP phone number for tenant");
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

  if (convErr || !convRow) {
    throw new Error(`conversation insert failed: ${convErr?.message}`);
  }

  const dialData = await elevenLabsSipDial({
    toNumber: leadPhone,
    tenantId,
    conversationId: convRow.id,
    leadName,
    leadEmail,
    companyName: tenantRow?.name,
    tenantTimezone: tenantRow?.timezone,
  });

  await supabase
    .from("conversations")
    .update({
      elevenlabs_agent_id: ELEVENLABS_OUTBOUND_AGENT_ID,
      elevenlabs_conversation_id: dialData.conversation_id,
      telnyx_call_status: "elevenlabs_sip_dial_accepted",
      telnyx_event_payload: {
        provider: "elevenlabs_sip",
        sip_phone_number_id: ELEVENLABS_SIP_PHONE_NUMBER_ID,
        sip_call_id: dialData.sip_call_id,
        from_number: phoneRow.e164_number,
      },
    })
    .eq("id", convRow.id);

  return {
    conversationId: convRow.id,
    elevenLabsConversationId: dialData.conversation_id!,
  };
}

export async function fireCall(scheduledId: string, logTag = "dial"): Promise<{
  status: "dialed" | "failed" | "skipped";
  conversationId?: string;
  error?: string;
}> {
  const supabase: SupabaseAny = createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
  );

  const { data: claimed } = await supabase
    .from("scheduled_calls")
    .update({ status: "dialing", attempts: 1, last_error: null })
    .eq("id", scheduledId)
    .eq("status", "pending")
    .select("id, tenant_id, lead_phone, lead_name, lead_email")
    .maybeSingle();

  if (!claimed) {
    console.log(
      `[${logTag}] call ${scheduledId} already processed or cancelled`,
    );
    return { status: "skipped" };
  }

  if (
    await isPhoneSuppressed(
      supabase,
      claimed.tenant_id,
      claimed.lead_phone,
    )
  ) {
    await supabase
      .from("scheduled_calls")
      .update({
        status: "cancelled",
        last_error: "phone number opted out",
      })
      .eq("id", scheduledId);
    console.log(`[${logTag}] suppressed opted-out number for ${scheduledId}`);
    return { status: "skipped" };
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
      .update({
        status: "dialed",
        conversation_id: first.conversationId,
        last_error: null,
      })
      .eq("id", scheduledId);

    console.log(
      `[${logTag}] dialed ${claimed.lead_phone} for ${scheduledId} (attempt 1)`,
    );

    // Direct SIP no longer exposes the bridge-only speech counters that the old
    // retry heuristic depended on. Never redial blindly; a future retry policy
    // must be driven by verified ElevenLabs post-call outcomes.
    return { status: "dialed", conversationId: first.conversationId };
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error(`[${logTag}] fire failed for ${scheduledId}:`, msg);
    await supabase
      .from("scheduled_calls")
      .update({ status: "failed", last_error: msg.slice(0, 500) })
      .eq("id", scheduledId);
    return { status: "failed", error: msg.slice(0, 500) };
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

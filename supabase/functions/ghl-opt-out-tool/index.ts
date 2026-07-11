import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { GhlClient, getFreshGhlToken } from "../_shared/ghl.ts";
import { normalizePhoneForSuppression } from "../_shared/opt-out.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const BodySchema = z.object({
  tenant_id: z.string().uuid(),
  conversation_id: z.string().uuid(),
  elevenlabs_conversation_id: z.string().optional(),
  caller_phone: z.string().min(8),
  reason: z.string().max(500).optional(),
});

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return jsonResponse({ error: parsed.error.flatten().fieldErrors }, 400);
  }

  const input = parsed.data;
  const normalizedPhone = normalizePhoneForSuppression(input.caller_phone);
  if (!normalizedPhone) {
    return jsonResponse({ error: "invalid caller_phone" }, 400);
  }

  const supabase: any = createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
  );
  const { data: conversation, error: conversationError } = await supabase
    .from("conversations")
    .select("id, tenant_id, caller_phone")
    .eq("id", input.conversation_id)
    .eq("tenant_id", input.tenant_id)
    .maybeSingle();
  if (
    conversationError || !conversation ||
    normalizePhoneForSuppression(conversation.caller_phone || "") !==
      normalizedPhone
  ) {
    return jsonResponse({
      ok: false,
      opted_out: false,
      error: "conversation does not match this tenant and phone number",
    }, 403);
  }

  const now = new Date().toISOString();
  const { error: suppressionError } = await supabase
    .from("call_opt_outs")
    .upsert({
      tenant_id: input.tenant_id,
      phone_normalized: normalizedPhone,
      caller_phone: input.caller_phone,
      conversation_id: input.conversation_id,
      elevenlabs_conversation_id: input.elevenlabs_conversation_id || null,
      reason: input.reason || "caller requested no further calls",
      source: "voice_agent",
      updated_at: now,
    }, { onConflict: "tenant_id,phone_normalized" });
  if (suppressionError) {
    return jsonResponse({
      ok: false,
      opted_out: false,
      error: `suppression failed: ${suppressionError.message}`,
    }, 500);
  }

  const candidatePhones = Array.from(
    new Set([input.caller_phone, normalizedPhone]),
  );
  await supabase
    .from("scheduled_calls")
    .update({ status: "cancelled", last_error: "caller opted out" })
    .eq("tenant_id", input.tenant_id)
    .in("lead_phone", candidatePhones)
    .eq("status", "pending");

  let ghlDndUpdated = false;
  let ghlWarning: string | null = null;
  try {
    const { token, locationId } = await getFreshGhlToken(
      supabase,
      input.tenant_id,
    );
    const ghl = new GhlClient(token, locationId);
    const contact = await ghl.upsertContact({
      phone: normalizedPhone,
      dnd: true,
    });
    ghlDndUpdated = Boolean(contact.id);
  } catch (error: any) {
    ghlWarning = String(error?.message || error).slice(0, 500);
    console.error("[ghl-opt-out-tool] GHL DND update failed", ghlWarning);
  }

  return jsonResponse({
    ok: true,
    opted_out: true,
    phone: normalizedPhone,
    ghl_dnd_updated: ghlDndUpdated,
    warning: ghlWarning,
    instruction:
      "The caller is suppressed from future dialer calls. End the call now.",
  });
});

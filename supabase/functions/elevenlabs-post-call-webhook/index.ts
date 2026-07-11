import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET =
  Deno.env.get("ELEVENLABS_POST_CALL_WEBHOOK_SECRET")?.trim() || "";
const MAX_SIGNATURE_AGE_SECONDS = 30 * 60;

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function hmacSha256(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(message),
  );
  const digest = Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `v0=${digest}`;
}

async function verifySignature(
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!WEBHOOK_SECRET || !signatureHeader) return false;
  const parts = signatureHeader.split(",").map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2) || "";
  const signature = parts.find((part) => part.startsWith("v0=")) || "";
  const timestampSeconds = Number(timestamp);
  if (!timestamp || !signature || !Number.isFinite(timestampSeconds)) {
    return false;
  }

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds);
  if (ageSeconds > MAX_SIGNATURE_AGE_SECONDS) return false;
  const expected = await hmacSha256(WEBHOOK_SECRET, `${timestamp}.${rawBody}`);
  return constantTimeEqual(signature, expected);
}

function looksLikeUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value);
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function hasRepeatedAgentOutput(text: string): boolean {
  const clean = normalized(text);
  if (clean.length < 24) return false;
  const midpoint = Math.floor(clean.length / 2);
  const firstHalf = clean.slice(0, midpoint).trim();
  const secondHalf = clean.slice(midpoint).trim();
  if (
    firstHalf.length >= 12 &&
    (secondHalf === firstHalf || secondHalf.startsWith(firstHalf))
  ) return true;

  const sentences = clean.split(/(?<=[.!?])\s+/).filter((part) =>
    part.length >= 12
  );
  return sentences.some((sentence, index) =>
    sentences.indexOf(sentence) !== index
  );
}

function hasInternalNarration(text: string): boolean {
  return /\b(internal reasoning|analysis:|thinking:|i should (ask|respond|say)|the user (said|wants)|next i will)\b/i
    .test(text);
}

function transcriptAlerts(transcript: any[]): number {
  return transcript.reduce((count, turn) => {
    if (turn?.role !== "agent" || typeof turn?.message !== "string") {
      return count;
    }
    return count +
      (hasRepeatedAgentOutput(turn.message) ||
          hasInternalNarration(turn.message)
        ? 1
        : 0);
  }, 0);
}

async function resolveLocalConversationId(
  supabase: any,
  data: any,
): Promise<string | null> {
  const dynamicVariables =
    data?.conversation_initiation_client_data?.dynamic_variables || {};
  if (looksLikeUuid(dynamicVariables.conversation_id)) {
    return dynamicVariables.conversation_id;
  }
  if (!data?.conversation_id) return null;

  const { data: row } = await supabase
    .from("conversations")
    .select("id")
    .eq("elevenlabs_conversation_id", data.conversation_id)
    .limit(1)
    .maybeSingle();
  return row?.id || null;
}

function compactEventPayload(eventType: string, data: any) {
  const metadata = data?.metadata || {};
  return {
    provider: "elevenlabs_sip",
    webhook_type: eventType,
    status: data?.status || null,
    failure_reason: data?.failure_reason || null,
    termination_reason: metadata?.termination_reason || null,
    call_duration_secs: metadata?.call_duration_secs ?? null,
    sip_metadata: data?.metadata?.type === "sip" ? data.metadata.body : null,
    analysis: data?.analysis || null,
  };
}

serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const rawBody = await req.text();
  if (
    !await verifySignature(rawBody, req.headers.get("ElevenLabs-Signature"))
  ) {
    return jsonResponse({ error: "invalid signature" }, 401);
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "invalid json" }, 400);
  }

  const eventType = String(event?.type || "");
  if (
    eventType !== "post_call_transcription" &&
    eventType !== "call_initiation_failure"
  ) {
    return jsonResponse({ ok: true, ignored: eventType || "unknown" });
  }

  const data = event?.data || {};
  const supabase: any = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const localConversationId = await resolveLocalConversationId(supabase, data);
  if (!localConversationId) {
    console.warn(
      `[elevenlabs-post-call] no local conversation for ${
        data?.conversation_id || "unknown"
      }`,
    );
    return jsonResponse({ ok: true, ignored: "unknown conversation" });
  }

  if (eventType === "call_initiation_failure") {
    const sipBody = data?.metadata?.type === "sip"
      ? data.metadata.body || {}
      : {};
    await supabase
      .from("conversations")
      .update({
        elevenlabs_conversation_id: data?.conversation_id || null,
        elevenlabs_agent_id: data?.agent_id || null,
        telnyx_call_status: "elevenlabs_sip_initiation_failed",
        telnyx_hangup_cause: data?.failure_reason || sipBody?.error_reason ||
          "unknown",
        telnyx_sip_code: Number(sipBody?.sip_status_code) || null,
        ended_at: new Date().toISOString(),
        telnyx_event_payload: compactEventPayload(eventType, data),
      })
      .eq("id", localConversationId);
    await supabase
      .from("scheduled_calls")
      .update({
        status: "failed",
        last_error: String(
          data?.failure_reason || sipBody?.error_reason ||
            "SIP initiation failed",
        ).slice(0, 500),
      })
      .eq("conversation_id", localConversationId);
    return jsonResponse({ ok: true, event: eventType });
  }

  const transcript = Array.isArray(data?.transcript) ? data.transcript : [];
  const startSeconds = Number(data?.metadata?.start_time_unix_secs) ||
    Math.floor(Date.now() / 1000);
  const durationSeconds = Number(data?.metadata?.call_duration_secs) || 0;
  const startedAt = new Date(startSeconds * 1000).toISOString();
  const endedAt = new Date((startSeconds + durationSeconds) * 1000)
    .toISOString();
  const entries = transcript
    .filter((turn: any) =>
      (turn?.role === "agent" || turn?.role === "user") &&
      typeof turn?.message === "string"
    )
    .map((turn: any) => ({
      conversation_id: localConversationId,
      role: turn.role,
      text: turn.message,
      spoken_at: new Date(
        (startSeconds + Math.max(0, Number(turn?.time_in_call_secs) || 0)) *
          1000,
      ).toISOString(),
    }));

  const { error: deleteError } = await supabase
    .from("transcript_entries")
    .delete()
    .eq("conversation_id", localConversationId);
  if (deleteError) {
    throw new Error(`transcript reset failed: ${deleteError.message}`);
  }
  if (entries.length) {
    const { error: insertError } = await supabase.from("transcript_entries")
      .insert(entries);
    if (insertError) {
      throw new Error(`transcript insert failed: ${insertError.message}`);
    }
  }

  const { error: updateError } = await supabase
    .from("conversations")
    .update({
      elevenlabs_conversation_id: data?.conversation_id || null,
      elevenlabs_agent_id: data?.agent_id || null,
      agent_config_version: data?.version_id || null,
      telnyx_call_status: "elevenlabs_sip_completed",
      telnyx_hangup_cause: data?.metadata?.termination_reason || null,
      started_at: startedAt,
      ended_at: endedAt,
      agent_output_alert_count: transcriptAlerts(transcript),
      telnyx_event_payload: compactEventPayload(eventType, data),
    })
    .eq("id", localConversationId);
  if (updateError) {
    throw new Error(`conversation update failed: ${updateError.message}`);
  }

  return jsonResponse({
    ok: true,
    event: eventType,
    transcript_entries: entries.length,
  });
});

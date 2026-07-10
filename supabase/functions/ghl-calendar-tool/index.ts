import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { GhlClient, flattenSlots, getFreshGhlToken } from "../_shared/ghl.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const TENANT_ID = "8ad5b297-2581-4953-91bb-7cef9a8f2080";
const CALENDAR_TOOL_NAME = "ghl_calendar_tool";

const AvailabilitySchema = z.object({
  action: z.literal("availability"),
  tenant_id: z.string().uuid().optional(),
  conversation_id: z.string().uuid().optional(),
  elevenlabs_conversation_id: z.string().optional(),
  caller_phone: z.string().min(8).optional(),
  days_ahead: z.number().int().min(1).max(30).default(7),
  preference: z.string().optional(),
  timezone: z.string().optional(),
});

const BookSchema = z.object({
  action: z.literal("book"),
  tenant_id: z.string().uuid().optional(),
  conversation_id: z.string().uuid().optional(),
  elevenlabs_conversation_id: z.string().optional(),
  caller_name: z.string().min(1).default("Chris"),
  caller_phone: z.string().min(8),
  caller_email: z.preprocess((value) => value === "" ? undefined : value, z.string().email().optional()),
  slot_iso: z.string().datetime({ offset: true }),
});

const BodySchema = z.discriminatedUnion("action", [AvailabilitySchema, BookSchema]);

type AuditParams = {
  tenantId: string;
  conversationId?: string;
  callerPhone?: string;
};

async function resolveConversationId(supabase: any, params: AuditParams): Promise<string | null> {
  if (params.conversationId) return params.conversationId;
  if (!params.callerPhone) return null;

  const { data } = await supabase
    .from("conversations")
    .select("id")
    .eq("tenant_id", params.tenantId)
    .eq("caller_phone", params.callerPhone)
    .eq("direction", "outbound")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.id || null;
}

async function recordToolStart(supabase: any, conversationId: string | null, parameters: Record<string, unknown>) {
  if (!conversationId) return;
  try {
    const { data: row } = await supabase
      .from("conversations")
      .select("bridge_calendar_tool_call_count")
      .eq("id", conversationId)
      .maybeSingle();
    await supabase
      .from("conversations")
      .update({
        bridge_calendar_tool_call_count: Number(row?.bridge_calendar_tool_call_count || 0) + 1,
        bridge_last_calendar_tool_name: CALENDAR_TOOL_NAME,
        bridge_last_calendar_tool_params: parameters,
        bridge_last_calendar_tool_result: null,
        bridge_last_calendar_tool_error: null,
        bridge_last_calendar_tool_at: new Date().toISOString(),
      })
      .eq("id", conversationId);
  } catch (error) {
    console.error("[ghl-calendar-tool] audit start failed", error);
  }
}

async function recordToolResult(supabase: any, conversationId: string | null, result: Record<string, unknown>) {
  if (!conversationId) return;
  try {
    await supabase
      .from("conversations")
      .update({ bridge_last_calendar_tool_result: result, bridge_last_calendar_tool_error: null })
      .eq("id", conversationId);
  } catch (error) {
    console.error("[ghl-calendar-tool] audit result failed", error);
  }
}

async function recordToolError(supabase: any, conversationId: string | null, errorMessage: string) {
  if (!conversationId) return;
  try {
    const { data: row } = await supabase
      .from("conversations")
      .select("bridge_calendar_tool_error_count")
      .eq("id", conversationId)
      .maybeSingle();
    await supabase
      .from("conversations")
      .update({
        bridge_calendar_tool_error_count: Number(row?.bridge_calendar_tool_error_count || 0) + 1,
        bridge_last_calendar_tool_error: errorMessage.slice(0, 1000),
      })
      .eq("id", conversationId);
  } catch (error) {
    console.error("[ghl-calendar-tool] audit error failed", error);
  }
}

function formatSlotForSpeech(slotIso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
    timeZoneName: "short",
  }).format(new Date(slotIso));
}

function slotParts(slotIso: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: timezone,
  }).formatToParts(new Date(slotIso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
  const hourText = get("hour");
  const dayPeriod = get("dayPeriod");
  const hour24 = Number(new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: false,
    timeZone: timezone,
  }).format(new Date(slotIso)));
  return {
    weekday: get("weekday"),
    month: get("month"),
    day: get("day"),
    time: `${hourText}:${get("minute")} ${dayPeriod}`.trim(),
    hour24,
  };
}

function normalizePreference(input?: string): string {
  return (input || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function filterSlots(slots: string[], timezone: string, preference?: string): string[] {
  const pref = normalizePreference(preference);
  if (!pref) return slots;

  const dayMatch = pref.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  const afterMatch = pref.match(/\b(after|later than)\s+(\d{1,2})(?::\d{2})?\s*(am|pm|a m|p m)?\b/);
  const beforeMatch = pref.match(/\b(before|earlier than)\s+(\d{1,2})(?::\d{2})?\s*(am|pm|a m|p m)?\b/);
  const toHour24 = (hourText: string, marker?: string) => {
    let hour = Number(hourText);
    const m = (marker || "").replace(/\s/g, "");
    if (m === "pm" && hour < 12) hour += 12;
    if (m === "am" && hour === 12) hour = 0;
    if (!m && hour >= 1 && hour <= 7) hour += 12;
    return hour;
  };

  let scopedSlots = slots;
  if (/\b(next week|following week)\b/.test(pref)) {
    const now = new Date();
    const daysUntilNextMonday = ((8 - now.getDay()) % 7) || 7;
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysUntilNextMonday).getTime();
    const end = start + 7 * 24 * 60 * 60 * 1000;
    scopedSlots = slots.filter((slot) => {
      const t = new Date(slot).getTime();
      return t >= start && t < end;
    });
  }

  return scopedSlots.filter((slot) => {
    const { hour24, weekday } = slotParts(slot, timezone);
    if (dayMatch && weekday.toLowerCase() !== dayMatch[1]) return false;
    if (afterMatch && hour24 <= toHour24(afterMatch[2], afterMatch[3])) return false;
    if (beforeMatch && hour24 >= toHour24(beforeMatch[2], beforeMatch[3])) return false;
    if (/\b(mornings?|am|a m|early)\b/.test(pref)) return hour24 < 12;
    if (/\b(afternoons?|pm|p m|later)\b/.test(pref)) return hour24 >= 12 && hour24 < 17;
    if (/\b(evening|after work|night)\b/.test(pref)) return hour24 >= 17;
    return true;
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return jsonResponse({ error: parsed.error.flatten().fieldErrors }, 400);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const tenantId = parsed.data.tenant_id || TENANT_ID;
  const auditConversationId = await resolveConversationId(supabase, {
    tenantId,
    conversationId: parsed.data.conversation_id,
    callerPhone: parsed.data.caller_phone,
  });
  await recordToolStart(supabase, auditConversationId, parsed.data as Record<string, unknown>);
  const { data: tenant, error } = await supabase
    .from("tenants")
    .select("ghl_calendar_id, timezone")
    .eq("id", tenantId)
    .maybeSingle();

  if (error || !tenant?.ghl_calendar_id) {
    await recordToolError(supabase, auditConversationId, "tenant ghl config incomplete");
    return jsonResponse({ error: "tenant ghl config incomplete" }, 400);
  }

  try {
    const { token, locationId } = await getFreshGhlToken(supabase, tenantId);
    const client = new GhlClient(token, locationId);

    if (parsed.data.action === "availability") {
      const startMs = Date.now();
      const endMs = startMs + parsed.data.days_ahead * 24 * 60 * 60 * 1000;
      const timezone = parsed.data.timezone || tenant.timezone;
      const raw = await client.getCalendarSlots(tenant.ghl_calendar_id, startMs, endMs, timezone);
      const all = flattenSlots(raw);
      const filtered = filterSlots(all, timezone, parsed.data.preference);
      const options = filtered.slice(0, 4).map((slotIso, index) => {
        const parts = slotParts(slotIso, timezone);
        return {
          option: index + 1,
          slot_iso: slotIso,
          spoken: formatSlotForSpeech(slotIso, timezone),
          weekday: parts.weekday,
          date: `${parts.month} ${parts.day}`,
          time: parts.time,
          timezone,
        };
      });

      const result = {
        ok: true,
        booking_confirmed: false,
        elevenlabs_conversation_id: parsed.data.elevenlabs_conversation_id || null,
        timezone,
        total_available: all.length,
        total_matching_preference: filtered.length,
        preference: parsed.data.preference || null,
        options,
        instruction: options.length
          ? "Offer two options to the caller. Remember each option number and exact slot_iso. If they choose one, call this tool again with action=book and that exact slot_iso."
          : "No matching slots were found for that preference. Ask for a different time window, then call availability again.",
      };
      await recordToolResult(supabase, auditConversationId, result);
      return jsonResponse(result);
    }

    if (!parsed.data.caller_email) {
      const result = {
        ok: false,
        booking_confirmed: false,
        needs_email: true,
        error: "caller_email required before booking",
        instruction: "Ask: Real quick, what's the best email to put on file? Then call this tool again with the same slot_iso and caller_email.",
      };
      await recordToolError(supabase, auditConversationId, result.error);
      return jsonResponse(result, 400);
    }

    const [firstName, ...rest] = parsed.data.caller_name.trim().split(/\s+/);
    const contact = await client.upsertContact({
      firstName,
      lastName: rest.join(" ") || undefined,
      email: parsed.data.caller_email,
      phone: parsed.data.caller_phone,
    });
    const appt = await client.createAppointment({
      calendarId: tenant.ghl_calendar_id,
      contactId: contact.id,
      startTime: parsed.data.slot_iso,
    });

    await supabase.from("bookings").insert({
      tenant_id: tenantId,
      conversation_id: auditConversationId,
      caller_name: parsed.data.caller_name,
      caller_phone: parsed.data.caller_phone,
      caller_email: parsed.data.caller_email || null,
      slot_iso: parsed.data.slot_iso,
      ghl_appointment_id: appt.id,
      status: "confirmed",
    });

    const result = {
      ok: true,
      booking_confirmed: true,
      appointment_id: appt.id,
      contact_id: contact.id,
      elevenlabs_conversation_id: parsed.data.elevenlabs_conversation_id || null,
      confirmation: `Booked ${parsed.data.caller_name} for ${formatSlotForSpeech(parsed.data.slot_iso, tenant.timezone)}.`,
    };
    await recordToolResult(supabase, auditConversationId, result);
    return jsonResponse(result);
  } catch (err: any) {
    console.error("[ghl-calendar-tool]", err);
    const errorMessage = err.message || "failed";
    await recordToolError(supabase, auditConversationId, errorMessage);
    return jsonResponse({ ok: false, booking_confirmed: false, error: errorMessage }, 500);
  }
});

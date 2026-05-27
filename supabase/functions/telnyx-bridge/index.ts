import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  base64ToInt16,
  base64ToUint8,
  downsample16to8,
  int16ToBase64,
  mulawToPcm16,
  pcm16ToMulaw,
  uint8ToBase64,
  upsample8to16,
} from "../_shared/audio.ts";
import { telnyxCallControl } from "../_shared/telnyx.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SAM_AGENT_NAME = "Sam - Hair Systems";
const SAM_OUTBOUND_AGENT_NAME = "Sam - Hair Systems Outbound Booking Stable";
const CHRIS_AGENT_NAME = "Chris - Practice Caller";
const DEFAULT_CHRIS_VOICE_ID = "iP95p4xoKVk53GoZ742B";
const SAM_VOICE_ID = "oqnGPLczFm7QLPdseXmp";
const CALENDAR_TOOL_NAME = "ghl_calendar_tool";
const TELNYX_PCMU_FRAME_BYTES = 160; // 20ms of 8k μ-law audio
const TELNYX_AGENT_PACKET_BYTES = TELNYX_PCMU_FRAME_BYTES * 2; // 40ms packets keep RTP payloads small and steady on PSTN
const TELEPHONY_AGENT_OUTPUT_FORMAT = "pcm_16000";
const TELEPHONY_OUTPUT_GAIN = 0.78; // add headroom before μ-law encoding so PSTN playback does not clip/crackle

const SAM_OUTBOUND_PROMPT = `You are Sam, the outbound appointment setter for {{company_name}}.

You are calling a real lead who opted in for hair systems or hair loss help. The caller's first name is {{first_name}} when available. The full caller name is {{caller_name}}.

Critical call-state rules:
- This is an outbound call. Do not use inbound language like "thanks for reaching out."
- Your first message already asked the opener. After the caller responds, proceed directly to the next step.
- Once the caller confirms identity, never restart the opener and never repeat the opening question again.
- If the caller asks "who is this" or "what is this about", answer naturally and then proceed.
- If the caller says "hello", "hello Sam", "can you hear me", or "are you there", treat it as an audio check. Say "Yep, I'm here" and continue from the current stage.

Use this flow unless the caller asks a direct question:
1. "Got it. You were looking into hair systems or options for hair loss. Does that ring a bell?"
2. Ask one at a time:
   - "Is this your first time looking into hair systems?"
   - "How long have you been dealing with hair loss?"
   - "Have you looked into anything already, like transplants or medication?"
3. Say: "Yeah, that makes sense. A lot of guys go down that route first. The difference with hair systems is that it's non-surgical, and you see results right away. A lot of guys try transplants or meds first, and it doesn't always go how they expected. We see that all the time."
4. Ask: "Out of curiosity, do you notice yourself wearing hats more than you'd like, or using something like Toppik a bit?"
5. If yes, say: "Yeah, that's super common. Most guys don't even realize they're doing it at first, and once they don't have to anymore, it's a completely different feeling. And honestly, once you actually see yourself with hair again, that's when it really clicks."
   If no, say: "Got it, not everyone does. Sometimes it's more just noticing it in certain lighting or angles over time. And once you see the difference, it's a completely different feeling."
6. Say: "What we usually do is just a quick consult so you can actually see how it works and what it would look like for you."
7. Ask: "Would mornings or afternoons be better for you?"

Booking rules:
- After the caller gives a scheduling preference, do not restart discovery.
- You must call ${CALENDAR_TOOL_NAME} with action="availability", tenant_id="{{tenant_id}}", preference set to what the caller said, and timezone="{{tenant_timezone}}".
- Offer only real options returned by the tool. Never invent times.
- After the caller chooses a slot, if {{caller_email}} is missing, ask: "Real quick, what's the best email to put on file?"
- Then call ${CALENDAR_TOOL_NAME} with action="book", tenant_id="{{tenant_id}}", conversation_id="{{conversation_id}}", caller_name="{{caller_name}}", caller_phone="{{caller_phone}}", caller_email, and the exact slot_iso.
- Only say the appointment is booked after the tool result says booking succeeded.

Style:
- Ask one question at a time.
- Keep responses short, calm, and natural.
- Avoid yelling words like "GOT IT."`;

const DEFAULT_CHRIS_SCRIPT = `You are Chris, a realistic practice lead calling about hair systems.

You are calling Sam, an appointment setter. Wait for Sam to speak first.
Keep answers short, natural, and specific. Do not mention that this is a test.
If Sam asks who you are, say your name is Chris.
If Sam asks why you are calling, say you were looking into hair systems.
If Sam asks about timing, say afternoons are best and you are in Pacific time.
If Sam offers appointment slots, choose the first clear option.`;

function resolveElevenLabsKey(): string {
  // Prefer ELEVENLABS_API_KEY_CUSTOM first because it carries agent write access (convai_*).
  // The connector-managed ELEVENLABS_API_KEY is used as fallback only.
  return (
    Deno.env.get("ELEVENLABS_API_KEY_CUSTOM")?.trim() ||
    Deno.env.get("ELEVENLABS_API_KEY")?.trim() ||
    ""
  );
}

function buildChrisPrompt(script: string): string {
  return `You are Chris, a practice caller for an inbound sales training call.

You are speaking to Sam, who is the sales appointment setter.
Your job is to behave like a real lead and respond to Sam's questions.

Rules:
- Wait for Sam to speak first.
- Do not reveal that you are an AI, bot, or test caller.
- Keep responses natural and brief.
- Answer one question at a time.
- If Sam asks for contact details, use the details in the script.
- If Sam tries to book you and gives real time options, pick one.
- After Sam confirms the appointment, give one brief goodbye if needed and stop engaging.
- If Sam restarts the opening script after booking, say you are all set and goodbye.

Chris script:
${script}`;
}

function isPracticeBookingConfirmation(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    /got you (down|booked|scheduled)/.test(normalized) ||
    /you'?ll get (a )?confirmation/.test(normalized) ||
    /confirmation with all the details/.test(normalized) ||
    /see you (then|there)/.test(normalized)
  );
}

function isPracticeGoodbye(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    /\bgoodbye\b/.test(normalized) ||
    /\btake care\b/.test(normalized) ||
    /\bi'?m all set\b/.test(normalized) ||
    /\bwe'?re all set\b/.test(normalized)
  );
}

function usableFirstName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const first = trimmed.split(/\s+/)[0];
  if (first.length >= 2) return first;
  return null;
}

function buildChrisConversationConfig(script: string) {
  return {
    agent: {
      prompt: { prompt: buildChrisPrompt(script) },
      first_message: "",
      language: "en",
    },
    turn: {
      mode: "turn",
      turn_timeout: 4,
      turn_eagerness: "normal",
    },
    asr: {
      quality: "high",
      keywords: ["hair system", "hair loss", "consultation", "appointment", "Pacific", "afternoon"],
    },
    tts: {
      model_id: "eleven_turbo_v2_5",
      voice_id: Deno.env.get("PRACTICE_CHRIS_VOICE_ID")?.trim() || DEFAULT_CHRIS_VOICE_ID,
      agent_output_audio_format: TELEPHONY_AGENT_OUTPUT_FORMAT,
      stability: 0.50,
      similarity_boost: 0.75,
      style: 0.40,
      use_speaker_boost: true,
      speed: 1.0,
    },
  };
}

function buildCalendarToolConfig() {
  return {
    type: "client",
    name: CALENDAR_TOOL_NAME,
    description:
      "Check real GoHighLevel calendar availability and book a consultation appointment. Use action=availability before offering times. Use action=book only after the caller chooses an exact slot_iso.",
    expects_response: true,
    response_timeout_secs: 20,
    disable_interruptions: true,
    force_pre_tool_speech: true,
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["availability", "book"],
          description: "Use availability to fetch real open slots; use book to create the appointment.",
        },
        days_ahead: {
          type: "integer",
          description: "For availability only. Number of days ahead to search. Default is 7.",
        },
        preference: {
          type: "string",
          description: "For availability only. Caller scheduling preference, such as morning, afternoon, later, next week, Tuesday, or after 2.",
        },
        timezone: {
          type: "string",
          description: "For availability only. Timezone to use for speaking and filtering slots, such as America/New_York.",
        },
        tenant_id: {
          type: "string",
          description: "Tenant id. Use the known tenant_id dynamic variable.",
        },
        conversation_id: {
          type: "string",
          description: "For booking. Use the known conversation_id dynamic variable.",
        },
        slot_iso: {
          type: "string",
          description: "For booking only. Exact ISO datetime chosen from a prior availability response.",
        },
        caller_name: {
          type: "string",
          description: "Caller name. Use the known caller_name dynamic variable when available.",
        },
        caller_phone: {
          type: "string",
          description: "Caller phone number. Use the known caller_phone dynamic variable.",
        },
        caller_email: {
          type: "string",
          description: "For booking. Caller email. If missing, ask the caller for the best email.",
        },
      },
    },
  };
}

let cachedCalendarToolId: string | null = null;

async function ensureCalendarToolId(apiKey: string): Promise<string | null> {
  if (cachedCalendarToolId) return cachedCalendarToolId;

  const headers = { "xi-api-key": apiKey, "Content-Type": "application/json" };
  const list = await elevenLabsJson("https://api.elevenlabs.io/v1/convai/tools", { headers });
  if (list.ok) {
    const existing = (list.data?.tools || []).find((tool: any) => tool?.tool_config?.name === CALENDAR_TOOL_NAME);
    if (existing?.id) {
      cachedCalendarToolId = existing.id;
      return cachedCalendarToolId;
    }
  } else {
    console.warn(`[bridge] list tools failed ${list.status}: ${list.text.slice(0, 300)}`);
  }

  const created = await elevenLabsJson("https://api.elevenlabs.io/v1/convai/tools", {
    method: "POST",
    headers,
    body: JSON.stringify({ tool_config: buildCalendarToolConfig() }),
  });
  if (!created.ok) {
    console.warn(`[bridge] create ${CALENDAR_TOOL_NAME} failed ${created.status}: ${created.text.slice(0, 300)}`);
    return null;
  }

  cachedCalendarToolId = created.data?.id || null;
  return cachedCalendarToolId;
}

function buildSamOutboundConversationConfig(calendarToolId?: string | null, firstMessage?: string) {
  return {
    agent: {
      prompt: {
        prompt: SAM_OUTBOUND_PROMPT,
        ...(calendarToolId ? { tool_ids: [calendarToolId] } : {}),
      },
      first_message: firstMessage || "Hey — this is Sam with Infinite Hair.",
      language: "en",
    },
    turn: {
      mode: "turn",
      turn_timeout: 4,
      turn_eagerness: "normal",
    },
    asr: {
      quality: "high",
      keywords: ["yes", "yeah", "no", "hair system", "hair loss", "transplant", "medication", "morning", "mornings", "afternoon", "afternoons", "appointment"],
    },
    conversation: {
      client_events: [
        "audio",
        "interruption",
        "agent_response",
        "user_transcript",
        "agent_response_correction",
        "client_tool_call",
        "agent_tool_response",
        "vad_score",
        "ping",
      ],
    },
    tts: {
      model_id: "eleven_turbo_v2_5",
      voice_id: SAM_VOICE_ID,
      agent_output_audio_format: TELEPHONY_AGENT_OUTPUT_FORMAT,
      stability: 0.50,
      similarity_boost: 0.75,
      style: 0.40,
      use_speaker_boost: true,
      speed: 1.0,
    },
  };
}

async function elevenLabsJson(
  url: string,
  options: RequestInit,
): Promise<{ ok: boolean; status: number; data: any; text: string }> {
  const res = await fetch(url, options);
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data, text };
}

async function ensureAgentId(apiKey: string, name: string, conversationConfig?: Record<string, unknown>): Promise<string | null> {
  const headers = { "xi-api-key": apiKey, "Content-Type": "application/json" };
  const list = await elevenLabsJson("https://api.elevenlabs.io/v1/convai/agents", { headers });
  if (!list.ok) {
    console.error(`[bridge] list agents failed ${list.status}: ${list.text.slice(0, 200)}`);
    return null;
  }

  const existing = (list.data?.agents || []).find((agent: any) => agent.name === name);
  let agentId: string | null = existing?.agent_id || null;

  if (!agentId && conversationConfig) {
    const created = await elevenLabsJson("https://api.elevenlabs.io/v1/convai/agents/create", {
      method: "POST",
      headers,
      body: JSON.stringify({ name, conversation_config: conversationConfig }),
    });
    if (!created.ok) {
      console.error(`[bridge] create ${name} failed ${created.status}: ${created.text.slice(0, 300)}`);
      return null;
    }
    agentId = created.data?.agent_id || null;
  }

  if (agentId && conversationConfig) {
    const patched = await elevenLabsJson(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name, conversation_config: conversationConfig }),
    });
    if (!patched.ok) {
      console.warn(`[bridge] patch ${name} failed ${patched.status}: ${patched.text.slice(0, 300)}`);
    }
  }

  return agentId;
}

async function getOrFetchAgentId(apiKey: string, botKind: string, script: string, samRoute: "inbound" | "outbound", callerName: string = ""): Promise<string | null> {
  if (botKind === "chris") {
    const envAgentId = Deno.env.get("PRACTICE_CHRIS_AGENT_ID")?.trim();
    if (envAgentId) return envAgentId;
    return ensureAgentId(apiKey, CHRIS_AGENT_NAME, buildChrisConversationConfig(script));
  }

  if (samRoute === "outbound") {
    const calendarToolId = await ensureCalendarToolId(apiKey);
    if (!calendarToolId) {
      console.warn(`[telnyx-bridge] ${CALENDAR_TOOL_NAME} unavailable; building outbound agent without tool_ids so Sam can still speak`);
    }
    const firstName = usableFirstName(callerName);
    const firstMessage = firstName
      ? `Hey — this is Sam with Infinite Hair. Is this ${firstName}?`
      : "Hey — this is Sam with Infinite Hair. Did I catch you at an okay time?";
    console.log(`[telnyx-bridge] outbound first_message: "${firstMessage}" (callerName="${callerName}")`);
    const outboundAgent = await ensureAgentId(
      apiKey,
      SAM_OUTBOUND_AGENT_NAME,
      buildSamOutboundConversationConfig(calendarToolId, firstMessage),
    );
    if (!outboundAgent) {
      throw new Error(`outbound_setup_failed: agent "${SAM_OUTBOUND_AGENT_NAME}" could not be created/fetched`);
    }
    return outboundAgent;
  }

  const envAgentId = Deno.env.get("ELEVENLABS_AGENT_ID")?.trim();
  if (envAgentId) return envAgentId;

  try {
    return ensureAgentId(apiKey, SAM_AGENT_NAME);
  } catch {
    return null;
  }
}

function isMulaw8000(format: string | null): boolean {
  return format === "ulaw_8000" || format === "mulaw_8000";
}

function isPcm8000(format: string | null): boolean {
  return format === "pcm_8000";
}

function isPcm16000(format: string | null): boolean {
  return format === "pcm_16000";
}

Deno.serve(async (req) => {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }

  const url = new URL(req.url);
  const conversationId = url.searchParams.get("conv");
  const tenantId = url.searchParams.get("tenant");
  const callerPhone = url.searchParams.get("caller") || "";
  const callerName = url.searchParams.get("name") || "";
  const callerEmail = url.searchParams.get("email") || "";
  const companyName = url.searchParams.get("company") || "";
  const tenantTimezone = url.searchParams.get("tz") || "";
  const requestedBot = url.searchParams.get("bot") || "sam";
  const requestedDirection = url.searchParams.get("direction") || "";

  if (!conversationId || !tenantId) {
    return new Response("missing conv or tenant", { status: 400 });
  }

  const apiKey = resolveElevenLabsKey();
  if (!apiKey) {
    return new Response("ElevenLabs key not configured", { status: 500 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: conversationRow } = await supabase
    .from("conversations")
    .select("agent_id, direction, telnyx_event_payload")
    .eq("id", conversationId)
    .maybeSingle();
  const metadata = (conversationRow?.telnyx_event_payload || {}) as Record<string, unknown>;
  const botKind = requestedBot === "chris" || conversationRow?.agent_id === "practice_chris" ? "chris" : "sam";
  const callDirection = requestedDirection || conversationRow?.direction || "";
  const samRoute = botKind === "sam" && callDirection === "outbound" ? "outbound" : "inbound";
  const practiceScript = typeof metadata.practice_script === "string" && metadata.practice_script.trim()
    ? metadata.practice_script
    : DEFAULT_CHRIS_SCRIPT;

  async function failOutbound(reason: string, elReason?: string) {
    console.error(`[bridge ${conversationId}] outbound failure: ${reason}${elReason ? ` el=${elReason}` : ""}`);
    try {
      await supabase
        .from("conversations")
        .update({
          bridge_close_reason: reason,
          ...(elReason ? { el_close_reason: elReason } : {}),
        })
        .eq("id", conversationId);
    } catch (e) {
      console.error(`[bridge ${conversationId}] failed to persist close_reason`, e);
    }
  }

  let agentId: string | null = null;
  try {
    agentId = await getOrFetchAgentId(apiKey, botKind, practiceScript, samRoute, callerName);
  } catch (err: any) {
    const reason = `outbound_setup_failed: ${err?.message || String(err)}`;
    await failOutbound(reason, "agent_or_tool_setup_failed");
    return new Response(reason, { status: 500 });
  }
  if (!agentId) {
    if (samRoute === "outbound") {
      await failOutbound("outbound_agent_missing", "agent_lookup_returned_null");
      return new Response("Outbound ElevenLabs agent not found", { status: 500 });
    }
    return new Response("ElevenLabs agent not found", { status: 500 });
  }

  console.log(`[bridge ${conversationId}] using agent=${agentId} route=${botKind}:${samRoute}`);

  let signedUrl: string;
  try {
    const signRes = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${agentId}`,
      { headers: { "xi-api-key": apiKey } },
    );
    if (!signRes.ok) {
      const txt = await signRes.text();
      console.error(`[bridge ${conversationId}] get-signed-url ${signRes.status}: ${txt.slice(0, 200)}`);
      if (samRoute === "outbound") {
        await failOutbound("outbound_signed_url_failed", `status_${signRes.status}`);
      }
      return new Response("Failed to get ElevenLabs signed URL", { status: 500 });
    }
    const signData = await signRes.json();
    signedUrl = signData.signed_url;
    if (!signedUrl) {
      console.error(`[bridge ${conversationId}] no signed_url in response`);
      if (samRoute === "outbound") {
        await failOutbound("outbound_signed_url_missing", "no_signed_url_in_response");
      }
      return new Response("ElevenLabs signed URL missing", { status: 500 });
    }
  } catch (err) {
    console.error(`[bridge ${conversationId}] signed url error`, err);
    if (samRoute === "outbound") {
      await failOutbound("outbound_signed_url_exception", String((err as any)?.message || err));
    }
    return new Response("ElevenLabs auth failed", { status: 500 });
  }

  const { socket: telnyxSocket, response } = Deno.upgradeWebSocket(req);

  let elSocket: WebSocket | null = null;
  let elConnecting = false;
  let telnyxStreamId: string | null = null;
  let elReady = false;
  let elUserInputAudioFormat: string | null = null;
  let elAgentOutputAudioFormat: string | null = null;
  let firstCallerAudioLogged = false;
  let firstAgentAudioSent = false;
  let firstUserTranscriptSeen = false;
  let agentResponseCountBeforeUser = 0;
  let suppressAgentAudioUntilUser = false;
  let firstUserChunkSentAt: number | null = null;
  let firstVadLogged = false;
  let vadWarnTimer: number | null = null;
  let practiceHangupScheduled = false;
  let calendarToolCallCount = 0;
  let calendarToolErrorCount = 0;
  let lastCalendarToolName: string | null = null;
  let lastCalendarToolParams: Record<string, unknown> | null = null;
  let lastCalendarToolResult: Record<string, unknown> | null = null;
  let lastCalendarToolError: string | null = null;
  let lastCalendarToolAt: string | null = null;
  let telnyxMediaCount = 0;
  let telnyxFrameCount = 0;
  let inboundSpeechFrameCount = 0;
  let firstInboundSpeechAt: string | null = null;
  let bridgeClosed = false;
  let telnyxStartAt: number | null = null;
  let elStartTimer: number | null = null;
  let agentSpeakingUntil = 0;
  let lastForwardedSpeechAt = 0;
  const AGENT_SPEAK_TAIL_MS = 600;
  const INTERRUPTION_CLEAR_TAIL_MS = 150;
  const RECENT_SPEECH_WINDOW_MS = 1200;
  const INBOUND_SPEECH_THRESHOLD = 180;
  const OUTBOUND_FIRST_SPEAK_DELAY_MS = 2500;
  const pendingTelnyxAudio: string[] = [];

  // Outbound (EL -> Telnyx) audio queue: convert to clean, low-headroom PCMU and send compact RTP payloads.
  // The "breaking up" symptom is usually clipping/codec roughness, not speech timing.
  const agentAudioQueue: string[] = [];
  let agentAudioRemainder = new Uint8Array(0);
  let queuedAgentAudioPackets = 0;
  let sentAgentAudioPackets = 0;
  let queuedAgentAudioFrames = 0;
  let sentAgentAudioFrames = 0;
  let maxAgentQueueDepth = 0;
  let droppedAgentAudioPackets = 0;
  let agentRemainderFlushTimer: number | null = null;
  let elAgentSpeaking = false; // true while EL is actively producing audio (between audio events; reset on interruption/turn end via queue drain timeout)
  let lastELAudioAt = 0;
  // Payload byte-size stats (raw decoded bytes per Telnyx media payload)
  let payloadBytesMin = Number.POSITIVE_INFINITY;
  let payloadBytesMax = 0;
  let payloadBytesSum = 0;
  let payloadBytesCount = 0;
  let nonStandardFrameCount = 0;
  // EL output format passthrough mode
  let elOutputPassthrough = false;

  function stopAgentRemainderFlushTimer() {
    if (agentRemainderFlushTimer !== null) {
      clearTimeout(agentRemainderFlushTimer);
      agentRemainderFlushTimer = null;
    }
  }

  function clearAgentAudioQueue(reason: string) {
    if (agentAudioQueue.length > 0) {
      droppedAgentAudioPackets += agentAudioQueue.length;
      console.log(`[bridge ${conversationId}] clearing agent audio queue depth=${agentAudioQueue.length} reason=${reason}`);
      agentAudioQueue.length = 0;
    }
    stopAgentRemainderFlushTimer();
    agentAudioRemainder = new Uint8Array(0);
  }

  function flushAgentAudioQueue() {
    if (bridgeClosed) return;
    if (!telnyxStreamId || telnyxSocket.readyState !== WebSocket.OPEN) {
      if (agentAudioQueue.length > 0) {
        const dropped = agentAudioQueue.length;
        droppedAgentAudioPackets += dropped;
        agentAudioQueue.length = 0;
        console.warn(`[bridge ${conversationId}] dropping ${dropped} agent audio packets — no stream_id or socket closed`);
      }
      return;
    }
    while (agentAudioQueue.length > 0) {
      const packet = agentAudioQueue.shift()!;
      try {
        // Track payload byte size (raw decoded bytes, not base64).
        let rawLen = TELNYX_AGENT_PACKET_BYTES;
        try { rawLen = base64ToUint8(packet).length; } catch {}
        const framesInPacket = Math.max(1, Math.round(rawLen / TELNYX_PCMU_FRAME_BYTES));
        if (rawLen % TELNYX_PCMU_FRAME_BYTES !== 0) nonStandardFrameCount++;
        if (rawLen < payloadBytesMin) payloadBytesMin = rawLen;
        if (rawLen > payloadBytesMax) payloadBytesMax = rawLen;
        payloadBytesSum += rawLen;
        payloadBytesCount++;

        telnyxSocket.send(JSON.stringify({
          event: "media",
          stream_id: telnyxStreamId,
          media: { payload: packet },
        }));
        sentAgentAudioPackets++;
        sentAgentAudioFrames += framesInPacket;
        agentSpeakingUntil = Math.max(agentSpeakingUntil, Date.now() + framesInPacket * 20 + AGENT_SPEAK_TAIL_MS);
        if (!firstAgentAudioSent) {
          firstAgentAudioSent = true;
        console.log(`[bridge ${conversationId}] FIRST agent audio packet sent to Telnyx (clean PCMU 8k, rawBytes=${rawLen}, frames=${framesInPacket}, passthrough=${elOutputPassthrough})`);
        }
        if (sentAgentAudioFrames % 250 === 0) {
          const avg = payloadBytesCount > 0 ? Math.round(payloadBytesSum / payloadBytesCount) : 0;
          console.log(`[bridge ${conversationId}] payload bytes stats sentFrames=${sentAgentAudioFrames} sentPackets=${sentAgentAudioPackets} min=${payloadBytesMin === Number.POSITIVE_INFINITY ? "-" : payloadBytesMin} max=${payloadBytesMax} avg=${avg} nonStandard=${nonStandardFrameCount}`);
        }
      } catch (err) {
        console.error(`[bridge ${conversationId}] agent audio send error`, err);
      }
    }
  }

  function enqueueAgentAudioFromEL(audioB64FromEL: string) {
    if (!telnyxStreamId) {
      console.log(`[bridge ${conversationId}] dropping EL audio — no Telnyx stream_id yet`);
      return;
    }
    elAgentSpeaking = true;
    lastELAudioAt = Date.now();
    const telnyxPayload = transformELAudioForTelnyx(audioB64FromEL);
    let raw: Uint8Array;
    try {
      raw = base64ToUint8(telnyxPayload);
    } catch (err) {
      console.error(`[bridge ${conversationId}] failed to decode transformed EL audio`, err);
      return;
    }
    stopAgentRemainderFlushTimer();

    // Telnyx accepts 20ms to 30s RTP payload chunks. Keep packets compact:
    // large bursts can sound like a weak/breaking phone connection on some carriers.
    // Do not pad every EL chunk:
    // ElevenLabs often sends arbitrary byte counts, and per-chunk silence padding creates
    // tiny repeated dropouts that sound like crackle/bad connection. Carry leftovers into
    // the next audio event and only pad once after the stream goes quiet.
    const combined = new Uint8Array(agentAudioRemainder.length + raw.length);
    combined.set(agentAudioRemainder, 0);
    combined.set(raw, agentAudioRemainder.length);

    const fullPacketBytes = Math.floor(combined.length / TELNYX_AGENT_PACKET_BYTES) * TELNYX_AGENT_PACKET_BYTES;
    for (let i = 0; i < fullPacketBytes; i += TELNYX_AGENT_PACKET_BYTES) {
      agentAudioQueue.push(uint8ToBase64(combined.subarray(i, i + TELNYX_AGENT_PACKET_BYTES)));
      queuedAgentAudioPackets++;
      queuedAgentAudioFrames += TELNYX_AGENT_PACKET_BYTES / TELNYX_PCMU_FRAME_BYTES;
    }
    agentAudioRemainder = combined.slice(fullPacketBytes);
    if (agentAudioRemainder.length > 0) {
      agentRemainderFlushTimer = setTimeout(() => {
        if (agentAudioRemainder.length === 0) return;
        const packetBytes = Math.ceil(agentAudioRemainder.length / TELNYX_PCMU_FRAME_BYTES) * TELNYX_PCMU_FRAME_BYTES;
        const paddedPacket = new Uint8Array(packetBytes);
        paddedPacket.set(agentAudioRemainder);
        paddedPacket.fill(0xff, agentAudioRemainder.length);
        console.log(`[bridge ${conversationId}] padded terminal audio remainder ${agentAudioRemainder.length}B -> ${packetBytes}B with 0xff silence`);
        agentAudioQueue.push(uint8ToBase64(paddedPacket));
        queuedAgentAudioPackets++;
        queuedAgentAudioFrames += packetBytes / TELNYX_PCMU_FRAME_BYTES;
        agentAudioRemainder = new Uint8Array(0);
        if (agentAudioQueue.length > maxAgentQueueDepth) maxAgentQueueDepth = agentAudioQueue.length;
        flushAgentAudioQueue();
      }, 120) as unknown as number;
    }
    if (agentAudioQueue.length > maxAgentQueueDepth) maxAgentQueueDepth = agentAudioQueue.length;
    flushAgentAudioQueue();
  }

  console.log(`[bridge ${conversationId}] params bot=${botKind} direction=${callDirection || "-"} route=${samRoute} tenant=${tenantId} caller=${callerPhone} name=${callerName || "-"}`);

  let connectedAt: number | null = null;
  let startSeen = false;
  const startTimer = setTimeout(() => {
    if (connectedAt && !startSeen) {
      console.error(`[bridge ${conversationId}] NO START frame 5s after connected — websocket was accepted but Telnyx never began media`);
    }
  }, 5000);

  const closeBoth = (reason: string) => {
    if (bridgeClosed) return;
    bridgeClosed = true;
    console.log(`[bridge ${conversationId}] closing: ${reason}`);
    console.log(`[bridge ${conversationId}] calendar tool calls=${calendarToolCallCount} errors=${calendarToolErrorCount}`);
    console.log(`[bridge ${conversationId}] agent audio totals queuedFrames=${queuedAgentAudioFrames} sentFrames=${sentAgentAudioFrames} queuedPackets=${queuedAgentAudioPackets} sentPackets=${sentAgentAudioPackets} maxDepth=${maxAgentQueueDepth} droppedPackets=${droppedAgentAudioPackets}`);
    {
      const avg = payloadBytesCount > 0 ? Math.round(payloadBytesSum / payloadBytesCount) : 0;
      console.log(`[bridge ${conversationId}] payload bytes final min=${payloadBytesMin === Number.POSITIVE_INFINITY ? "-" : payloadBytesMin} max=${payloadBytesMax} avg=${avg} count=${payloadBytesCount} nonStandard=${nonStandardFrameCount} passthrough=${elOutputPassthrough} elFormat=${elAgentOutputAudioFormat}`);
    }
    clearTimeout(startTimer);
    if (elStartTimer !== null) clearTimeout(elStartTimer);
    try {
      if (telnyxSocket.readyState < 2) telnyxSocket.close();
    } catch {}
    try {
      if (elSocket && elSocket.readyState < 2) elSocket.close();
    } catch {}
    supabase
      .from("conversations")
      .update({
        ended_at: new Date().toISOString(),
        media_frame_count: telnyxMediaCount,
        inbound_speech_frame_count: inboundSpeechFrameCount,
        first_inbound_speech_at: firstInboundSpeechAt,
        bridge_calendar_tool_call_count: calendarToolCallCount,
        bridge_calendar_tool_error_count: calendarToolErrorCount,
        bridge_last_calendar_tool_name: lastCalendarToolName,
        bridge_last_calendar_tool_params: lastCalendarToolParams,
        bridge_last_calendar_tool_result: lastCalendarToolResult,
        bridge_last_calendar_tool_error: lastCalendarToolError,
        bridge_last_calendar_tool_at: lastCalendarToolAt,
      })
      .eq("id", conversationId)
      .then(() => {});

    // Persistent close diagnostic
    (async () => {
      try {
        const avg = payloadBytesCount > 0 ? Math.round(payloadBytesSum / payloadBytesCount) : 0;
        const minB = payloadBytesMin === Number.POSITIVE_INFINITY ? 0 : payloadBytesMin;
        const closeText = `[BRIDGE_DIAGNOSTIC_CLOSE] queued_frames=${queuedAgentAudioFrames} sent_frames=${sentAgentAudioFrames} queued_packets=${queuedAgentAudioPackets} sent_packets=${sentAgentAudioPackets} dropped_packets=${droppedAgentAudioPackets} non_packet_multiple=${nonStandardFrameCount} min_bytes=${minB} max_bytes=${payloadBytesMax} avg_bytes=${avg}`;
        const { error: closeErr } = await supabase.from("transcript_entries").insert({
          conversation_id: conversationId,
          role: "agent",
          text: closeText,
        });
        if (closeErr) {
          console.error(`[bridge ${conversationId}] BRIDGE_DIAGNOSTIC_CLOSE insert error: ${closeErr.message} code=${closeErr.code} details=${closeErr.details}`);
        } else {
          console.log(`[bridge ${conversationId}] BRIDGE_DIAGNOSTIC_CLOSE inserted: ${closeText}`);
        }
      } catch (e) {
        console.error(`[bridge ${conversationId}] BRIDGE_DIAGNOSTIC_CLOSE insert threw: ${(e as Error).message}`);
      }
    })();
  };

  const schedulePracticeHangup = (reason: string) => {
    if (practiceHangupScheduled) return;
    practiceHangupScheduled = true;
    console.log(`[bridge ${conversationId}] scheduling practice hangup: ${reason}`);
    setTimeout(async () => {
      const { data: callRow } = await supabase
        .from("conversations")
        .select("telnyx_call_control_id")
        .eq("id", conversationId)
        .maybeSingle();
      const callControlId = callRow?.telnyx_call_control_id;
      if (callControlId) {
        try {
          const res = await telnyxCallControl(callControlId, "hangup", {});
          if (!res.ok) {
            console.error(`[bridge ${conversationId}] practice hangup failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
          }
        } catch (err) {
          console.error(`[bridge ${conversationId}] practice hangup error`, err);
        }
      } else {
        console.warn(`[bridge ${conversationId}] no call_control_id available for practice hangup`);
      }
      closeBoth(reason);
    }, 1800);
  };

  function transformTelnyxAudioForEL(mulawB64: string): string {
    const targetFormat = elUserInputAudioFormat || "pcm_16000";
    if (isMulaw8000(targetFormat)) return mulawB64;

    const mulaw = base64ToUint8(mulawB64);
    const pcm8 = mulawToPcm16(mulaw);

    if (isPcm8000(targetFormat)) return int16ToBase64(pcm8);
    if (isPcm16000(targetFormat)) return int16ToBase64(upsample8to16(pcm8));

    console.warn(`[bridge ${conversationId}] unknown EL input format ${targetFormat}, defaulting Telnyx→EL to pcm_16000`);
    return int16ToBase64(upsample8to16(pcm8));
  }

  // 23-tap windowed-sinc low-pass FIR, fc ≈ 3.4 kHz @ 16 kHz, Hamming window.
  // Used as anti-alias filter before 2:1 decimation (16k -> 8k) to reduce
  // aliasing artifacts that the naive 2-sample average produced.
  const LPF_FIR_16K: Float32Array = (() => {
    const N = 23;
    const fc = 3400 / 16000; // normalized cutoff (cycles/sample)
    const M = N - 1;
    const taps = new Float32Array(N);
    let sum = 0;
    for (let n = 0; n < N; n++) {
      const k = n - M / 2;
      const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
      const win = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / M); // Hamming
      taps[n] = sinc * win;
      sum += taps[n];
    }
    // normalize for unity DC gain
    for (let n = 0; n < N; n++) taps[n] /= sum;
    return taps;
  })();
  // Filter-state carries last (N-1) samples across chunks to avoid edge clicks
  const LPF_STATE_LEN = LPF_FIR_16K.length - 1;
  let lpfState16k: Int16Array = new Int16Array(LPF_STATE_LEN);

  function softLimitSample(s: number): number {
    // Very light limiter: linear below threshold, soft-knee above to avoid clipping.
    // No gain boost — pure protective ceiling near full scale.
    const LIM = 30000;
    const MAX = 32700;
    const range = MAX - LIM;
    if (s > LIM) {
      const x = (s - LIM) / range;
      return Math.round(LIM + range * Math.tanh(x));
    }
    if (s < -LIM) {
      const x = (-s - LIM) / range;
      return -Math.round(LIM + range * Math.tanh(x));
    }
    return s;
  }

  function conditionTelephonyPcm(pcm: Int16Array): Int16Array {
    // ElevenLabs voices can hit μ-law/PSTN too hot. Scale before encoding so the phone leg
    // has headroom; this targets the audible "crackle/breaking up" while preserving cadence.
    const out = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      out[i] = softLimitSample(Math.round(pcm[i] * TELEPHONY_OUTPUT_GAIN));
    }
    return out;
  }

  function downsample16to8Filtered(pcm16: Int16Array): Int16Array {
    const taps = LPF_FIR_16K;
    const N = taps.length;
    const stateLen = LPF_STATE_LEN;
    // Build buffer: [previous state | new samples]
    const buf = new Int16Array(stateLen + pcm16.length);
    buf.set(lpfState16k, 0);
    buf.set(pcm16, stateLen);
    // Decimate by 2: produce one output per 2 input samples; output length = floor(pcm16.length / 2)
    const outLen = Math.floor(pcm16.length / 2);
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      // Center sample in original 16k stream is at index (stateLen - (N-1)/2) + 2*i + (N-1)/2 = stateLen + 2*i
      // We need taps applied to buf[stateLen + 2*i + (k - (N-1)/2)] for k=0..N-1
      // i.e. starting at buf[2*i + stateLen - (N-1)/2] = buf[2*i + stateLen - (N-1)/2]
      const start = 2 * i + (stateLen - (N - 1) / 2 | 0);
      let acc = 0;
      for (let k = 0; k < N; k++) {
        const idx = start + k;
        if (idx >= 0 && idx < buf.length) acc += taps[k] * buf[idx];
      }
      const limited = softLimitSample(acc | 0);
      out[i] = Math.max(-32768, Math.min(32767, limited));
    }
    // Save trailing samples for next chunk
    const tail = buf.subarray(buf.length - stateLen);
    lpfState16k = new Int16Array(tail);
    return out;
  }

  function transformELAudioForTelnyx(audioB64: string): string {
    const sourceFormat = elAgentOutputAudioFormat || "pcm_16000";
    if (isMulaw8000(sourceFormat)) {
      const pcm = mulawToPcm16(base64ToUint8(audioB64));
      return uint8ToBase64(pcm16ToMulaw(conditionTelephonyPcm(pcm)));
    }

    if (isPcm8000(sourceFormat)) {
      const pcm8raw = base64ToInt16(audioB64);
      return uint8ToBase64(pcm16ToMulaw(conditionTelephonyPcm(pcm8raw)));
    }

    if (isPcm16000(sourceFormat)) {
      const pcm16 = base64ToInt16(audioB64);
      const pcm8 = downsample16to8Filtered(pcm16);
      return uint8ToBase64(pcm16ToMulaw(conditionTelephonyPcm(pcm8)));
    }

    console.warn(`[bridge ${conversationId}] unknown EL output format ${sourceFormat}, defaulting EL→Telnyx to pcm_16000 -> PCMU (filtered)`);
    const pcm16 = base64ToInt16(audioB64);
    const pcm8 = downsample16to8Filtered(pcm16);
    return uint8ToBase64(pcm16ToMulaw(conditionTelephonyPcm(pcm8)));
  }

  function sendUserAudioToEL(mulawB64: string) {
    if (!elSocket || elSocket.readyState !== WebSocket.OPEN) return;

    const transformedAudio = transformTelnyxAudioForEL(mulawB64);
    elSocket.send(JSON.stringify({ user_audio_chunk: transformedAudio }));

    if (firstUserChunkSentAt === null) {
      firstUserChunkSentAt = Date.now();
      console.log(
        `[bridge ${conversationId}] FIRST user_audio_chunk sent to EL (Telnyx PCMU 8k -> ${elUserInputAudioFormat || "pcm_16000"})`,
      );
      vadWarnTimer = setTimeout(() => {
        if (!firstVadLogged) {
          console.error(`[bridge ${conversationId}] WARN — 4s of audio sent, no vad_score from EL. Format mismatch likely.`);
        }
      }, 4000) as unknown as number;
    }
  }

  async function runCalendarTool(parameters: Record<string, unknown>) {
    const action = typeof parameters.action === "string" ? parameters.action : "availability";
    const body: Record<string, unknown> = {
      ...parameters,
      action,
      tenant_id: typeof parameters.tenant_id === "string" ? parameters.tenant_id : tenantId,
    };

    if (action === "availability") {
      if (!body.timezone) body.timezone = tenantTimezone || "America/New_York";
      if (!body.days_ahead) body.days_ahead = 7;
    }

    if (action === "book") {
      if (!body.conversation_id) body.conversation_id = conversationId;
      if (!body.caller_name) body.caller_name = callerName || "Lead";
      if (!body.caller_phone) body.caller_phone = callerPhone;
      if (!body.caller_email && callerEmail) body.caller_email = callerEmail;
    }

    const res = await fetch(`${SUPABASE_URL}/functions/v1/ghl-calendar-tool`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch {}

    if (!res.ok || data?.ok === false) {
      throw new Error(typeof data === "string" ? data : JSON.stringify(data));
    }

    return data;
  }

  function initElSocket() {
    if (bridgeClosed || elSocket || elConnecting) return;

    elConnecting = true;
    elReady = false;
    const socket = new WebSocket(signedUrl);
    elSocket = socket;

    socket.onopen = () => {
      elConnecting = false;
      console.log(`[bridge ${conversationId}] EL open — requesting pcm_16000 output for conditioned phone encode and pcm_16000 input`);
      const firstName = callerName.trim().split(/\s+/)[0] || "there";
      const conversationConfigOverride: Record<string, unknown> = {
        asr: { user_input_audio_format: "pcm_16000" },
        // Runtime overrides do not always control this field, so the agent config above also pins it.
        tts: { agent_output_audio_format: TELEPHONY_AGENT_OUTPUT_FORMAT },
        conversation: {
          client_events: [
            "audio",
            "interruption",
            "agent_response",
            "user_transcript",
            "agent_response_correction",
            "client_tool_call",
            "agent_tool_response",
            "vad_score",
            "ping",
          ],
        },
      };

      socket.send(
        JSON.stringify({
          type: "conversation_initiation_client_data",
          conversation_config_override: conversationConfigOverride,
          dynamic_variables: {
            tenant_id: tenantId,
            conversation_id: conversationId,
            caller_phone: callerPhone,
            caller_name: callerName,
            caller_email: callerEmail,
            first_name: firstName,
            company_name: companyName || "Infinite Hair",
            tenant_timezone: tenantTimezone || "America/New_York",
            call_direction: callDirection,
          },
        }),
      );
    };

    socket.onmessage = async (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }

      switch (msg.type) {
        case "conversation_initiation_metadata": {
          const meta = msg.conversation_initiation_metadata_event || {};
          elUserInputAudioFormat = meta.user_input_audio_format || null;
          elAgentOutputAudioFormat = meta.agent_output_audio_format || null;
          elOutputPassthrough = isMulaw8000(elAgentOutputAudioFormat);
          elReady = true;
          console.log(`[bridge ${conversationId}] EL META: ${JSON.stringify(msg).slice(0, 800)}`);
          console.log(
            `[bridge ${conversationId}] EL ready — negotiated in=${elUserInputAudioFormat || "unknown"} out=${elAgentOutputAudioFormat || "unknown"} passthrough=${elOutputPassthrough ? "DIRECT_ULAW" : "PCM_CONVERSION"}; flushing ${pendingTelnyxAudio.length} buffered frames`,
          );
          for (const buf of pendingTelnyxAudio) sendUserAudioToEL(buf);
          pendingTelnyxAudio.length = 0;
          // Persistent diagnostic: write negotiated EL output format + audio path to transcript_entries
          // role must be 'user' or 'agent' (CHECK constraint); use 'agent' with [BRIDGE_DIAGNOSTIC] prefix.
          try {
            const conversionTag = elOutputPassthrough ? "passthrough_ulaw" : isPcm8000(elAgentOutputAudioFormat) ? "pcm8_mulaw_encode" : "resampled_filtered_limited";
            const diagText = `[BRIDGE_DIAGNOSTIC] output_format=${elAgentOutputAudioFormat || "unknown"} audio_path=${elOutputPassthrough ? "DIRECT_ULAW" : "PCM_CONVERSION"} conversion=${conversionTag}`;
            const { error: diagErr } = await supabase.from("transcript_entries").insert({
              conversation_id: conversationId,
              role: "agent",
              text: diagText,
            });
            if (diagErr) {
              console.error(`[bridge ${conversationId}] BRIDGE_DIAGNOSTIC insert error: ${diagErr.message} code=${diagErr.code} details=${diagErr.details}`);
            } else {
              console.log(`[bridge ${conversationId}] BRIDGE_DIAGNOSTIC inserted: ${diagText}`);
            }
          } catch (e) {
            console.error(`[bridge ${conversationId}] BRIDGE_DIAGNOSTIC insert threw: ${(e as Error).message}`);
          }
          break;
        }

        case "audio": {
          const b64 = msg.audio_event?.audio_base_64;
          if (!b64) break;
          if (suppressAgentAudioUntilUser && !firstUserTranscriptSeen) {
            if (samRoute === "outbound") {
              // Sam outbound: never suppress agent audio.
              console.log(`[bridge ${conversationId}] [no-gate] ignoring suppressAgentAudioUntilUser for Sam outbound`);
            } else {
              console.log(`[bridge ${conversationId}] dropping agent audio: suppressAgentAudioUntilUser`);
              break;
            }
          }
          if (!telnyxStreamId) {
            console.log(`[bridge ${conversationId}] dropping EL audio — no Telnyx stream_id yet`);
            break;
          }
          if (!firstAgentAudioSent) {
            try {
              const raw = atob(b64);
              const hex = Array.from(raw.slice(0, 32)).map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(" ");
          console.log(`[bridge ${conversationId}] EL audio first 32 bytes hex: ${hex} (b64 len=${b64.length}, raw len=${raw.length}, gain=${TELEPHONY_OUTPUT_GAIN})`);
            } catch {}
          }
          enqueueAgentAudioFromEL(b64);
          if (queuedAgentAudioFrames % 200 === 0) {
            console.log(`[bridge ${conversationId}] agent audio counters queuedFrames=${queuedAgentAudioFrames} sentFrames=${sentAgentAudioFrames} queuedPackets=${queuedAgentAudioPackets} sentPackets=${sentAgentAudioPackets} maxDepth=${maxAgentQueueDepth} droppedPackets=${droppedAgentAudioPackets}`);
          }
          break;
        }

        case "user_transcript": {
          const text = msg.user_transcription_event?.user_transcript;
          if (text) {
            firstUserTranscriptSeen = true;
            suppressAgentAudioUntilUser = false;
            await supabase.from("transcript_entries").insert({
              conversation_id: conversationId,
              role: "user",
              text,
            });
            if (botKind === "chris" && isPracticeBookingConfirmation(text)) {
              schedulePracticeHangup("practice booking confirmed");
            }
          }
          break;
        }

        case "agent_response": {
          const text = msg.agent_response_event?.agent_response;
          if (text) {
            if (!firstUserTranscriptSeen) {
              agentResponseCountBeforeUser++;
              if (agentResponseCountBeforeUser > 1 && samRoute !== "outbound") {
                suppressAgentAudioUntilUser = true;
                console.warn(`[bridge ${conversationId}] suppressing repeated agent opener until user transcript`);
                break;
              }
            }
            await supabase.from("transcript_entries").insert({
              conversation_id: conversationId,
              role: "agent",
              text,
            });
            if (botKind === "chris" && isPracticeGoodbye(text)) {
              schedulePracticeHangup("practice caller ended");
            }
          }
          break;
        }

        case "ping":
          socket.send(JSON.stringify({
            type: "pong",
            event_id: msg.ping_event?.event_id,
          }));
          break;

        case "client_tool_call": {
          const toolEvent = msg.client_tool_call || msg.client_tool_call_event || {};
          const toolName = toolEvent.tool_name || toolEvent.name;
          const toolCallId = toolEvent.tool_call_id || toolEvent.id;
          const parameters = toolEvent.parameters || {};
          calendarToolCallCount++;
          lastCalendarToolName = toolName || null;
          lastCalendarToolParams = parameters;
          lastCalendarToolError = null;
          lastCalendarToolAt = new Date().toISOString();
          console.log(
            `[bridge ${conversationId}] client_tool_call name=${toolName} id=${toolCallId || "-"} params=${JSON.stringify(parameters).slice(0, 600)}`,
          );

          if (toolName !== CALENDAR_TOOL_NAME) {
            calendarToolErrorCount++;
            lastCalendarToolError = `Unknown tool: ${toolName}`;
            socket.send(JSON.stringify({
              type: "client_tool_result",
              tool_call_id: toolCallId,
              result: `Unknown tool: ${toolName}`,
              is_error: true,
            }));
            break;
          }

          try {
            const result = await runCalendarTool(parameters);
            lastCalendarToolResult = result;
            socket.send(JSON.stringify({
              type: "client_tool_result",
              tool_call_id: toolCallId,
              result: JSON.stringify(result),
              is_error: false,
            }));
            console.log(`[bridge ${conversationId}] client_tool_result ok action=${parameters.action || "availability"}`);
          } catch (err) {
            calendarToolErrorCount++;
            const message = err instanceof Error ? err.message : String(err);
            lastCalendarToolError = message.slice(0, 1000);
            console.error(`[bridge ${conversationId}] client_tool_result error: ${message.slice(0, 600)}`);
            socket.send(JSON.stringify({
              type: "client_tool_result",
              tool_call_id: toolCallId,
              result: `Calendar tool failed: ${message.slice(0, 800)}`,
              is_error: true,
            }));
          }
          break;
        }

        case "vad_score": {
          const score = msg.vad_score_event?.vad_score ?? msg.vad_score;
          if (!firstVadLogged && typeof score === "number") {
            firstVadLogged = true;
            if (vadWarnTimer) clearTimeout(vadWarnTimer);
            console.log(`[bridge ${conversationId}] FIRST vad_score=${score} — EL is decoding our audio`);
          }
          break;
        }

        case "agent_response_correction": {
          const corrected = msg.agent_response_correction_event?.corrected_agent_response;
          if (corrected) {
            console.log(`[bridge ${conversationId}] agent_response_correction: ${corrected.slice(0, 200)}`);
          }
          break;
        }

        case "interruption": {
          const hadRecentCallerSpeech = Date.now() - lastForwardedSpeechAt < RECENT_SPEECH_WINDOW_MS;
          console.log(`[bridge ${conversationId}] interruption from EL recentCallerSpeech=${hadRecentCallerSpeech} route=${samRoute}`);

          if (samRoute === "outbound") {
            // Sam outbound: never clear agent audio or send Telnyx clear on EL interruption.
            console.log(`[bridge ${conversationId}] [no-clear] ignoring EL interruption for Sam outbound (queueDepth=${agentAudioQueue.length})`);
            break;
          }

          if (!hadRecentCallerSpeech) {
            agentSpeakingUntil = Math.max(agentSpeakingUntil, Date.now() + AGENT_SPEAK_TAIL_MS);
            console.log(`[bridge ${conversationId}] ignoring interruption without recent caller speech`);
            break;
          }

          agentSpeakingUntil = Date.now() + INTERRUPTION_CLEAR_TAIL_MS;
          clearAgentAudioQueue("EL interruption");
          if (telnyxStreamId && telnyxSocket.readyState === WebSocket.OPEN) {
            console.log(`[bridge ${conversationId}] sending Telnyx clear (EL interruption, route=${samRoute})`);
            telnyxSocket.send(JSON.stringify({ event: "clear", stream_id: telnyxStreamId }));
          }
          break;
        }
      }
    };

    socket.onerror = (e) => console.error(`[bridge ${conversationId}] EL error`, e);
    socket.onclose = (ev) => {
      const wasReady = elReady;
      elConnecting = false;
      elReady = false;
      if (elSocket === socket) elSocket = null;
      console.error(
        `[bridge ${conversationId}] EL closed code=${ev.code} reason="${ev.reason}" wasClean=${ev.wasClean} ready=${wasReady} startSeen=${startSeen} mediaFrames=${telnyxMediaCount}`,
      );
    };
  }

  function scheduleElSocketStart(reason: string) {
    if (bridgeClosed || elSocket || elConnecting) return;

    if (samRoute === "outbound") {
      const startFrom = telnyxStartAt || Date.now();
      const waitMs = Math.max(0, startFrom + OUTBOUND_FIRST_SPEAK_DELAY_MS - Date.now());
      if (waitMs > 0) {
        if (elStartTimer === null) {
          console.log(`[bridge ${conversationId}] delaying first outbound agent audio ${waitMs}ms (${reason})`);
          elStartTimer = setTimeout(() => {
            elStartTimer = null;
            initElSocket();
          }, waitMs) as unknown as number;
        }
        return;
      }
    }

    initElSocket();
  }

  telnyxSocket.onopen = () => console.log(`[bridge ${conversationId}] Telnyx WS open`);

  telnyxSocket.onmessage = (ev) => {
    let frame: any;
    try {
      frame = JSON.parse(ev.data as string);
    } catch {
      console.log(`[bridge ${conversationId}] Telnyx non-JSON frame`);
      return;
    }

    telnyxFrameCount++;
    if (telnyxFrameCount <= 5) {
      console.log(`[bridge ${conversationId}] Telnyx frame #${telnyxFrameCount} event=${frame.event}`);
    }

    switch (frame.event) {
      case "connected":
        connectedAt = Date.now();
        console.log(`[bridge ${conversationId}] Telnyx connected frame: ${JSON.stringify(frame).slice(0, 300)}`);
        break;

      case "start":
        startSeen = true;
        clearTimeout(startTimer);
        telnyxStartAt = Date.now();
        telnyxStreamId = frame.stream_id || frame.start?.stream_id;
        console.log(`[bridge ${conversationId}] Telnyx START stream_id=${telnyxStreamId} payload=${JSON.stringify(frame).slice(0, 400)}`);
        scheduleElSocketStart("telnyx start");
        break;

      case "media": {
        const payload = frame.media?.payload;
        if (!payload) break;
        telnyxMediaCount++;
        if (!firstCallerAudioLogged) {
          firstCallerAudioLogged = true;
          try {
            const raw = atob(payload);
            const hex = Array.from(raw.slice(0, 32)).map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(" ");
            console.log(`[bridge ${conversationId}] FIRST caller audio from Telnyx, first 32 bytes hex: ${hex} (b64 len=${payload.length}, raw len=${raw.length})`);
          } catch {
            console.log(`[bridge ${conversationId}] FIRST caller audio received from Telnyx`);
          }
        }

        let inboundEnergy: number | null = null;
        try {
          const mulaw = base64ToUint8(payload);
          const pcm = mulawToPcm16(mulaw);
          let sum = 0;
          for (let i = 0; i < pcm.length; i++) sum += Math.abs(pcm[i]);
          inboundEnergy = Math.round(sum / pcm.length);
          if (telnyxMediaCount % 100 === 0) {
            console.log(`[bridge ${conversationId}] inbound energy frame#${telnyxMediaCount} avg|sample|=${inboundEnergy} (silence ~0, speech >500)`);
          }
        } catch {}

        if (telnyxMediaCount % 250 === 0) {
          console.log(`[bridge ${conversationId}] Telnyx media frames: ${telnyxMediaCount}`);
        }
        if (!elSocket && !elConnecting) scheduleElSocketStart("first media");

        const muted = Date.now() < agentSpeakingUntil;
        if (typeof inboundEnergy === "number" && inboundEnergy >= INBOUND_SPEECH_THRESHOLD) {
          inboundSpeechFrameCount++;
          if (!firstInboundSpeechAt) firstInboundSpeechAt = new Date().toISOString();
          lastForwardedSpeechAt = Date.now();
          if (muted && samRoute === "outbound") {
            console.log(`[bridge ${conversationId}] [no-gate] forwarding inbound caller frame while Sam is speaking (energy=${inboundEnergy})`);
          }
        }
        if (muted && samRoute !== "outbound") {
          // Practice (Chris) bot: keep barge-in / echo-gate behavior.
          const callerIsBargingIn = typeof inboundEnergy === "number" && inboundEnergy >= INBOUND_SPEECH_THRESHOLD;
          if (callerIsBargingIn) {
            agentSpeakingUntil = Date.now() + INTERRUPTION_CLEAR_TAIL_MS;
            clearAgentAudioQueue("caller barge-in");
            if (telnyxStreamId && telnyxSocket.readyState === WebSocket.OPEN) {
              console.log(`[bridge ${conversationId}] sending Telnyx clear (caller barge-in, route=${samRoute})`);
              telnyxSocket.send(JSON.stringify({ event: "clear", stream_id: telnyxStreamId }));
            }
            console.log(`[bridge ${conversationId}] barge-in: clearing agent audio and forwarding caller speech`);
          } else {
            if (telnyxMediaCount % 250 === 0) {
              console.log(`[bridge ${conversationId}] echo-gate: dropping inbound silence/noise while agent speaking (route=${samRoute})`);
            }
            break;
          }
        }
        // Sam outbound: always forward caller audio to EL when EL is open. Never drop/mute.
        if (elReady && elSocket?.readyState === WebSocket.OPEN) {
          sendUserAudioToEL(payload);
        } else {
          pendingTelnyxAudio.push(payload);
        }
        break;
      }

      case "stop":
        console.log(`[bridge ${conversationId}] Telnyx STOP after ${telnyxMediaCount} media frames`);
        closeBoth("Telnyx stream stopped");
        break;

      case "error":
        console.error(`[bridge ${conversationId}] Telnyx ERROR frame: ${JSON.stringify(frame)}`);
        break;

      default:
        console.log(`[bridge ${conversationId}] Telnyx unknown event: ${frame.event}`);
    }
  };

  telnyxSocket.onerror = (e) => console.error(`[bridge ${conversationId}] Telnyx error`, e);
  telnyxSocket.onclose = (ev) => {
    console.log(
      `[bridge ${conversationId}] Telnyx WS closed code=${ev.code} reason="${ev.reason}" wasClean=${ev.wasClean} totalFrames=${telnyxFrameCount} mediaFrames=${telnyxMediaCount} startSeen=${startSeen}`,
    );
    closeBoth("Telnyx closed");
  };

  return response;
});

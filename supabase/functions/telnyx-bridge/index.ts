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
const CHRIS_AGENT_NAME = "Chris - Practice Caller";
const DEFAULT_CHRIS_VOICE_ID = "iP95p4xoKVk53GoZ742B";
const SAM_PHONE_UNKNOWN_FIRST_MESSAGE = "Hey — thanks for reaching out. Who am I speaking with?";

const DEFAULT_CHRIS_SCRIPT = `You are Chris, a realistic practice lead calling about hair systems.

You are calling Sam, an appointment setter. Wait for Sam to speak first.
Keep answers short, natural, and specific. Do not mention that this is a test.
If Sam asks who you are, say your name is Chris.
If Sam asks why you are calling, say you were looking into hair systems.
If Sam asks about timing, say afternoons are best and you are in Pacific time.
If Sam offers appointment slots, choose the first clear option.`;

function resolveElevenLabsKeys(): Array<{ key: string; source: "connector" | "custom" }> {
  const keys: Array<{ key: string; source: "connector" | "custom" }> = [];
  const connector = Deno.env.get("ELEVENLABS_API_KEY")?.trim();
  const custom = Deno.env.get("ELEVENLABS_API_KEY_CUSTOM")?.trim();

  if (connector) keys.push({ key: connector, source: "connector" });
  if (custom) keys.push({ key: custom, source: "custom" });

  return keys;
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
      model_id: "eleven_flash_v2",
      voice_id: Deno.env.get("PRACTICE_CHRIS_VOICE_ID")?.trim() || DEFAULT_CHRIS_VOICE_ID,
      stability: 0.68,
      similarity_boost: 0.75,
      speed: 0.97,
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

async function getOrFetchAgentId(
  apiKey: string,
  botKind: string,
  script: string,
  samVariant: "outbound" | "inbound" = "inbound",
): Promise<string | null> {
  if (botKind === "chris") {
    const envAgentId = Deno.env.get("PRACTICE_CHRIS_AGENT_ID")?.trim();
    if (envAgentId) return envAgentId;
    return ensureAgentId(apiKey, CHRIS_AGENT_NAME, buildChrisConversationConfig(script));
  }

  // Sam: prefer variant-specific agent (outbound vs inbound), fall back to generic.
  const variantEnv = samVariant === "outbound"
    ? Deno.env.get("SAM_OUTBOUND_AGENT_ID")?.trim()
    : Deno.env.get("SAM_INBOUND_AGENT_ID")?.trim();
  if (variantEnv) return variantEnv;

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

  if (!conversationId || !tenantId) {
    return new Response("missing conv or tenant", { status: 400 });
  }

  const elevenLabsKeys = resolveElevenLabsKeys();
  if (!elevenLabsKeys.length) {
    return new Response("ElevenLabs key not configured", { status: 500 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: conversationRow } = await supabase
    .from("conversations")
    .select("agent_id, telnyx_event_payload, direction")
    .eq("id", conversationId)
    .maybeSingle();
  const metadata = (conversationRow?.telnyx_event_payload || {}) as Record<string, unknown>;
  const botKind = requestedBot === "chris" || conversationRow?.agent_id === "practice_chris" ? "chris" : "sam";
  const practiceScript = typeof metadata.practice_script === "string" && metadata.practice_script.trim()
    ? metadata.practice_script
    : DEFAULT_CHRIS_SCRIPT;

  // Sam variant: outbound when this is an outbound call AND we have a caller name.
  // Inbound/web/unknown -> inbound agent (unknown-caller opener).
  const samVariant: "outbound" | "inbound" =
    conversationRow?.direction === "outbound" && callerName.trim().length > 0
      ? "outbound"
      : "inbound";

  let signedUrl = "";
  let agentId = "";
  let elevenLabsKeySource = "";
  let lastSignError = "";

  for (const keyInfo of elevenLabsKeys) {
    const candidateAgentId = await getOrFetchAgentId(keyInfo.key, botKind, practiceScript, samVariant);
    if (!candidateAgentId) {
      lastSignError = `${keyInfo.source}: agent not found`;
      console.warn(`[bridge ${conversationId}] ${lastSignError}`);
      continue;
    }

    try {
      const signRes = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${candidateAgentId}`,
        { headers: { "xi-api-key": keyInfo.key } },
      );
      if (!signRes.ok) {
        const txt = await signRes.text();
        lastSignError = `${keyInfo.source}: get-signed-url ${signRes.status}: ${txt.slice(0, 200)}`;
        console.error(`[bridge ${conversationId}] ${lastSignError}`);
        continue;
      }
      const signData = await signRes.json();
      if (!signData.signed_url) {
        lastSignError = `${keyInfo.source}: signed URL missing`;
        console.error(`[bridge ${conversationId}] ${lastSignError}`);
        continue;
      }

      signedUrl = signData.signed_url;
      agentId = candidateAgentId;
      elevenLabsKeySource = keyInfo.source;
      break;
    } catch (err) {
      lastSignError = `${keyInfo.source}: signed url error ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[bridge ${conversationId}] signed url error`, err);
    }
  }

  if (!signedUrl || !agentId) {
    return new Response(`ElevenLabs auth failed: ${lastSignError}`, { status: 500 });
  }

  console.log(`[bridge ${conversationId}] using ElevenLabs ${elevenLabsKeySource} key agent=${agentId} samVariant=${samVariant}`);

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
  let telnyxMediaCount = 0;
  let telnyxFrameCount = 0;
  let inboundSpeechFrameCount = 0;
  let firstInboundSpeechAt: string | null = null;
  let bridgeClosed = false;
  let agentSpeakingUntil = 0;
  let lastForwardedSpeechAt = 0;
  const AGENT_SPEAK_TAIL_MS = 600;
  const INTERRUPTION_CLEAR_TAIL_MS = 150;
  const RECENT_SPEECH_WINDOW_MS = 1200;
  const INBOUND_SPEECH_THRESHOLD = 180;
  const BARGE_IN_SPEECH_THRESHOLD = 650;
  const FIRST_OPENER_BARGE_IN_LOCK_MS = 4500;
  const pendingTelnyxAudio: string[] = [];
  let firstAgentAudioSentAt: number | null = null;

  console.log(`[bridge ${conversationId}] params bot=${botKind} tenant=${tenantId} caller=${callerPhone} name=${callerName || "-"}`);

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
    clearTimeout(startTimer);
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
      })
      .eq("id", conversationId)
      .then(() => {});
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

  function transformELAudioForTelnyx(audioB64: string): string {
    const sourceFormat = elAgentOutputAudioFormat || "pcm_16000";
    if (isMulaw8000(sourceFormat)) return audioB64;

    if (isPcm8000(sourceFormat)) {
      const pcm8 = base64ToInt16(audioB64);
      return uint8ToBase64(pcm16ToMulaw(pcm8));
    }

    if (isPcm16000(sourceFormat)) {
      const pcm16 = base64ToInt16(audioB64);
      const pcm8 = downsample16to8(pcm16);
      return uint8ToBase64(pcm16ToMulaw(pcm8));
    }

    console.warn(`[bridge ${conversationId}] unknown EL output format ${sourceFormat}, defaulting EL→Telnyx to pcm_16000 -> PCMU`);
    const pcm16 = base64ToInt16(audioB64);
    const pcm8 = downsample16to8(pcm16);
    return uint8ToBase64(pcm16ToMulaw(pcm8));
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

  function initElSocket() {
    if (bridgeClosed || elSocket || elConnecting) return;

    elConnecting = true;
    elReady = false;
    const socket = new WebSocket(signedUrl);
    elSocket = socket;

    socket.onopen = () => {
      elConnecting = false;
      console.log(`[bridge ${conversationId}] EL open — requesting pcm_16000 both directions`);
      const firstName = callerName.trim().split(/\s+/)[0] || "";
      // NOTE: agent.first_message override removed — EL agent does not allow it
      // and was closing the WebSocket with code=1008. Personalization now relies
      // on dynamic_variables.first_name being substituted in the agent's saved
      // first_message / prompt.
      const conversationConfigOverride: Record<string, unknown> = {
        asr: { user_input_audio_format: "pcm_16000" },
        tts: { agent_output_audio_format: "pcm_16000" },
        conversation: {
          client_events: [
            "audio",
            "interruption",
            "agent_response",
            "user_transcript",
            "agent_response_correction",
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
            company_name: companyName,
            tenant_timezone: tenantTimezone,
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
          elReady = true;
          console.log(`[bridge ${conversationId}] EL META: ${JSON.stringify(msg).slice(0, 800)}`);
          console.log(
            `[bridge ${conversationId}] EL ready — negotiated in=${elUserInputAudioFormat || "unknown"} out=${elAgentOutputAudioFormat || "unknown"}; flushing ${pendingTelnyxAudio.length} buffered frames`,
          );
          for (const buf of pendingTelnyxAudio) sendUserAudioToEL(buf);
          pendingTelnyxAudio.length = 0;
          break;
        }

        case "audio": {
          const b64 = msg.audio_event?.audio_base_64;
          if (!b64) break;
          if (suppressAgentAudioUntilUser && !firstUserTranscriptSeen) {
            break;
          }
          if (!telnyxStreamId) {
            console.log(`[bridge ${conversationId}] dropping EL audio — no Telnyx stream_id yet`);
            break;
          }
          if (!firstAgentAudioSent) {
            try {
              const raw = atob(b64);
              const hex = Array.from(raw.slice(0, 32)).map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(" ");
              console.log(`[bridge ${conversationId}] EL audio first 32 bytes hex: ${hex} (b64 len=${b64.length}, raw len=${raw.length})`);
            } catch {}
          }

          const telnyxPayload = transformELAudioForTelnyx(b64);
          if (!firstAgentAudioSentAt) firstAgentAudioSentAt = Date.now();
          telnyxSocket.send(JSON.stringify({
            event: "media",
            stream_id: telnyxStreamId,
            media: { payload: telnyxPayload },
          }));
          try {
            const playoutMs = Math.ceil((atob(telnyxPayload).length / 8000) * 1000);
            agentSpeakingUntil = Math.max(agentSpeakingUntil, Date.now() + playoutMs + AGENT_SPEAK_TAIL_MS);
          } catch {}
          if (!firstAgentAudioSent) {
            firstAgentAudioSent = true;
            console.log(
              `[bridge ${conversationId}] FIRST agent audio sent to Telnyx (${elAgentOutputAudioFormat || "pcm_16000"} -> Telnyx PCMU 8k)`,
            );
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
              if (agentResponseCountBeforeUser > 1) {
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
          console.log(`[bridge ${conversationId}] interruption from EL recentCallerSpeech=${hadRecentCallerSpeech}`);

          if (!hadRecentCallerSpeech) {
            agentSpeakingUntil = Math.max(agentSpeakingUntil, Date.now() + AGENT_SPEAK_TAIL_MS);
            console.log(`[bridge ${conversationId}] ignoring interruption without recent caller speech`);
            break;
          }

          agentSpeakingUntil = Date.now() + INTERRUPTION_CLEAR_TAIL_MS;
          if (telnyxStreamId && telnyxSocket.readyState === WebSocket.OPEN) {
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
        telnyxStreamId = frame.stream_id || frame.start?.stream_id;
        console.log(`[bridge ${conversationId}] Telnyx START stream_id=${telnyxStreamId} payload=${JSON.stringify(frame).slice(0, 400)}`);
        initElSocket();
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
        if (!elSocket && !elConnecting) initElSocket();

        const muted = Date.now() < agentSpeakingUntil;
        if (!muted && typeof inboundEnergy === "number" && inboundEnergy >= INBOUND_SPEECH_THRESHOLD) {
          inboundSpeechFrameCount++;
          if (!firstInboundSpeechAt) firstInboundSpeechAt = new Date().toISOString();
          lastForwardedSpeechAt = Date.now();
        }
        if (muted) {
          const firstOpenerLocked = !firstUserTranscriptSeen &&
            firstAgentAudioSentAt !== null &&
            Date.now() - firstAgentAudioSentAt < FIRST_OPENER_BARGE_IN_LOCK_MS;
          const callerIsBargingIn = typeof inboundEnergy === "number" && inboundEnergy >= BARGE_IN_SPEECH_THRESHOLD;
          if (firstOpenerLocked) {
            if (telnyxMediaCount % 100 === 0) {
              console.log(`[bridge ${conversationId}] opener-gate: ignoring inbound energy while first opener is playing`);
            }
            break;
          }
          if (callerIsBargingIn) {
            agentSpeakingUntil = Date.now() + INTERRUPTION_CLEAR_TAIL_MS;
            if (telnyxStreamId && telnyxSocket.readyState === WebSocket.OPEN) {
              telnyxSocket.send(JSON.stringify({ event: "clear", stream_id: telnyxStreamId }));
            }
            console.log(`[bridge ${conversationId}] barge-in: clearing agent audio and forwarding caller speech`);
          } else {
            if (telnyxMediaCount % 250 === 0) {
              console.log(`[bridge ${conversationId}] echo-gate: dropping inbound silence/noise while agent speaking`);
            }
            break;
          }
        }
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

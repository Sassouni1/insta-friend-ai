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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function resolveElevenLabsKey(): string {
  return (
    Deno.env.get("ELEVENLABS_API_KEY_CUSTOM")?.trim() ||
    Deno.env.get("ELEVENLABS_API_KEY")?.trim() ||
    ""
  );
}

async function getOrFetchAgentId(supabase: ReturnType<typeof createClient>, apiKey: string): Promise<string | null> {
  const envAgentId = Deno.env.get("ELEVENLABS_AGENT_ID")?.trim();
  if (envAgentId) return envAgentId;

  try {
    const res = await fetch("https://api.elevenlabs.io/v1/convai/agents", {
      headers: { "xi-api-key": apiKey },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const agent = (data.agents || []).find((a: any) => a.name === "Sam - Hair Systems");
    return agent?.agent_id || null;
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

  if (!conversationId || !tenantId) {
    return new Response("missing conv or tenant", { status: 400 });
  }

  const apiKey = resolveElevenLabsKey();
  if (!apiKey) {
    return new Response("ElevenLabs key not configured", { status: 500 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const agentId = await getOrFetchAgentId(supabase, apiKey);
  if (!agentId) {
    return new Response("ElevenLabs agent not found", { status: 500 });
  }

  let signedUrl: string;
  try {
    const signRes = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${agentId}`,
      { headers: { "xi-api-key": apiKey } },
    );
    if (!signRes.ok) {
      const txt = await signRes.text();
      console.error(`[bridge ${conversationId}] get-signed-url ${signRes.status}: ${txt.slice(0, 200)}`);
      return new Response("Failed to get ElevenLabs signed URL", { status: 500 });
    }
    const signData = await signRes.json();
    signedUrl = signData.signed_url;
    if (!signedUrl) {
      console.error(`[bridge ${conversationId}] no signed_url in response`);
      return new Response("ElevenLabs signed URL missing", { status: 500 });
    }
  } catch (err) {
    console.error(`[bridge ${conversationId}] signed url error`, err);
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
  let firstUserChunkSentAt: number | null = null;
  let firstVadLogged = false;
  let vadWarnTimer: number | null = null;
  let telnyxMediaCount = 0;
  let telnyxFrameCount = 0;
  let bridgeClosed = false;
  // Half-duplex echo gate: when EL is speaking, drop inbound caller frames
  // (Telnyx bidirectional RTP loops our TTS back into the inbound track).
  let agentSpeakingUntil = 0;
  const AGENT_SPEAK_TAIL_MS = 600;
  const pendingTelnyxAudio: string[] = [];

  console.log(`[bridge ${conversationId}] params tenant=${tenantId} caller=${callerPhone} name=${callerName || "-"}`);

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
      .update({ ended_at: new Date().toISOString() })
      .eq("id", conversationId)
      .then(() => {});
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
      const firstName = callerName.trim().split(/\s+/)[0] || "there";
      socket.send(
        JSON.stringify({
          type: "conversation_initiation_client_data",
          conversation_config_override: {
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
          },
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
          telnyxSocket.send(JSON.stringify({
            event: "media",
            stream_id: telnyxStreamId,
            media: { payload: telnyxPayload },
          }));
          // Mark agent as speaking — playback duration ≈ samples / 8000 * 1000 ms.
          // Telnyx PCMU is 8kHz mono so payload byte count == sample count.
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
            await supabase.from("transcript_entries").insert({
              conversation_id: conversationId,
              role: "user",
              text,
            });
          }
          break;
        }

        case "agent_response": {
          const text = msg.agent_response_event?.agent_response;
          if (text) {
            await supabase.from("transcript_entries").insert({
              conversation_id: conversationId,
              role: "agent",
              text,
            });
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

        case "interruption":
          agentSpeakingUntil = 0;
          if (telnyxStreamId && telnyxSocket.readyState === WebSocket.OPEN) {
            telnyxSocket.send(JSON.stringify({ event: "clear", stream_id: telnyxStreamId }));
          }
          break;
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
        // Every 100 frames, sample inbound energy so we can tell if mic audio is real or silence
        if (telnyxMediaCount % 100 === 0) {
          try {
            const mulaw = base64ToUint8(payload);
            const pcm = mulawToPcm16(mulaw);
            let sum = 0;
            for (let i = 0; i < pcm.length; i++) sum += Math.abs(pcm[i]);
            const avg = Math.round(sum / pcm.length);
            console.log(`[bridge ${conversationId}] inbound energy frame#${telnyxMediaCount} avg|sample|=${avg} (silence ~0, speech >500)`);
          } catch {}
        }
        if (telnyxMediaCount % 250 === 0) {
          console.log(`[bridge ${conversationId}] Telnyx media frames: ${telnyxMediaCount}`);
        }
        if (!elSocket && !elConnecting) initElSocket();
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

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
  let lastForwardedSpeechAt = 0;
  const AGENT_SPEAK_TAIL_MS = 600;
  const INTERRUPTION_CLEAR_TAIL_MS = 150;
  const RECENT_SPEECH_WINDOW_MS = 1200;
  const INBOUND_SPEECH_THRESHOLD = 180;
  const pendingTelnyxAudio: string[] = [];
...
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
...
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
        // Echo gate: while agent is speaking (and short tail after), drop inbound
        // frames so EL doesn't transcribe its own TTS bleeding through Telnyx RTP.
        const muted = Date.now() < agentSpeakingUntil;
        if (!muted && typeof inboundEnergy === "number" && inboundEnergy >= INBOUND_SPEECH_THRESHOLD) {
          lastForwardedSpeechAt = Date.now();
        }
        if (muted) {
          if (telnyxMediaCount % 250 === 0) {
            console.log(`[bridge ${conversationId}] echo-gate: dropping inbound (agent speaking)`);
          }
          break;
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

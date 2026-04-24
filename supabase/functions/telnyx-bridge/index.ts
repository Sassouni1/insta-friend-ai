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

  // Best-effort: list agents and find Sam
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

  // Get a signed conversation URL so we can connect via WebSocket without custom headers
  // (Deno's WebSocket constructor does not support a `headers` option — passing it throws "Invalid protocol value").
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
  const elSocket = new WebSocket(signedUrl);

  let telnyxStreamId: string | null = null;
  let elReady = false;
  let firstCallerAudioLogged = false;
  let firstAgentAudioSent = false;
  let telnyxMediaCount = 0;
  const pendingTelnyxAudio: Uint8Array[] = [];

  const closeBoth = (reason: string) => {
    console.log(`[bridge ${conversationId}] closing: ${reason}`);
    try { telnyxSocket.close(); } catch {}
    try { elSocket.close(); } catch {}
    supabase
      .from("conversations")
      .update({ ended_at: new Date().toISOString() })
      .eq("id", conversationId)
      .then(() => {});
  };

  // ElevenLabs → Telnyx
  elSocket.onopen = () => {
    console.log(`[bridge ${conversationId}] EL open`);
    const firstName = callerName.trim().split(/\s+/)[0] || "there";
    elSocket.send(
      JSON.stringify({
        type: "conversation_initiation_client_data",
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
        conversation_config_override: {
          agent: {
            prompt: {
              prompt: `You are Sam, the voice appointment setter for ${companyName || "the company"}.

Your persona, memory, conversational logic, and booking behavior are defined in backend code and must be followed as the source of truth.

Known lead context:
- first_name: ${firstName}
- caller_name: ${callerName || firstName}
- caller_phone: ${callerPhone}
- caller_email: ${callerEmail || "unknown"}
- company_name: ${companyName || "the company"}
- tenant_timezone: ${tenantTimezone || "unknown"}
- tenant_id: ${tenantId}
- conversation_id: ${conversationId}

Style:
- relaxed, grounded, natural
- no hype-man energy
- no forced filler words
- ask one question at a time
- do not use generic praise unless earned
- if unclear, ask instead of guessing

Goal: book a real consultation for hair systems / hair loss options.

Flow:
1. Say: Hey — is this ${firstName}?
2. Say: Got it. This is Sam with ${companyName || "the company"} — you were looking into hair systems or options for hair loss. Does that sound right?
3. Ask one at a time: Is this your first time looking into hair systems? How long have you been dealing with hair loss? Have you looked into anything already — like transplants or medication?
4. Reframe hair systems as non-surgical and immediate-result.
5. Ask: Out of curiosity — do you notice yourself wearing hats more than you'd like, or using something like Toppik a bit?
6. Build desire based on yes/no.
7. Transition to consult.
8. Ask whether mornings or afternoons are better.
9. Ask whether they're in Pacific, Central, or Eastern.
10. Use real booking tools only. Never invent availability.
11. For availability, use tenant_id ${tenantId}.
12. For booking, use tenant_id ${tenantId}, conversation_id ${conversationId}, caller_name ${callerName || firstName}, caller_phone ${callerPhone}, caller_email ${callerEmail || ""}, plus chosen slot_iso.
13. After booking, confirm and end naturally.

Objections:
- thinking about it → explain the consult helps them actually see it, then redirect to earlier/later
- is this legit → explain the consult shows exactly how it works, then redirect to morning/afternoon
- not sure it would work → explain that's why the consult exists, then redirect to earlier/later
- don't want fake looking → explain seeing it makes it click, then redirect to morning/afternoon`,
            },
            first_message: `Hey — is this ${firstName}?`,
            language: "en",
          },
          tts: {
            stability: 0.72,
            similarity_boost: 0.75,
            speed: 0.95,
          },
        },
      }),
    );
  };

  elSocket.onmessage = async (ev) => {
    let msg: any;
    try { msg = JSON.parse(ev.data as string); } catch { return; }

    switch (msg.type) {
      case "conversation_initiation_metadata":
        elReady = true;
        console.log(`[bridge ${conversationId}] EL ready — flushing ${pendingTelnyxAudio.length} buffered frames`);
        // Flush any buffered audio
        for (const buf of pendingTelnyxAudio) sendUserAudioToEL(buf);
        pendingTelnyxAudio.length = 0;
        break;

      case "audio": {
        const b64 = msg.audio_event?.audio_base_64;
        if (!b64) break;
        if (!telnyxStreamId) {
          console.log(`[bridge ${conversationId}] dropping EL audio — no Telnyx stream_id yet`);
          break;
        }
        // EL sends PCM 16k base64. Downsample → μ-law 8k → base64 → Telnyx media frame.
        const pcm16k = base64ToInt16(b64);
        const pcm8k = downsample16to8(pcm16k);
        const mulaw = pcm16ToMulaw(pcm8k);
        const payload = uint8ToBase64(mulaw);
        // Telnyx outbound media frame: spec is { event: "media", media: { payload } }
        // Do NOT include stream_id — Telnyx rejects/ignores frames with extra fields.
        telnyxSocket.send(JSON.stringify({
          event: "media",
          media: { payload },
        }));
        if (!firstAgentAudioSent) {
          firstAgentAudioSent = true;
          console.log(`[bridge ${conversationId}] FIRST agent audio sent to Telnyx`);
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
        elSocket.send(JSON.stringify({
          type: "pong",
          event_id: msg.ping_event?.event_id,
        }));
        break;

      case "interruption":
        if (telnyxStreamId) {
          // Telnyx clear frame — no stream_id field per spec.
          telnyxSocket.send(JSON.stringify({ event: "clear" }));
        }
        break;
    }
  };

  elSocket.onerror = (e) => console.error(`[bridge ${conversationId}] EL error`, e);
  elSocket.onclose = () => closeBoth("EL closed");

  function sendUserAudioToEL(mulawBytes: Uint8Array) {
    // Telnyx μ-law 8k → PCM 16 → upsample to 16k → base64 → user_audio_chunk
    const pcm8k = mulawToPcm16(mulawBytes);
    const pcm16k = upsample8to16(pcm8k);
    elSocket.send(JSON.stringify({
      user_audio_chunk: int16ToBase64(pcm16k),
    }));
  }

  // Telnyx → ElevenLabs
  telnyxSocket.onopen = () => console.log(`[bridge ${conversationId}] Telnyx WS open`);

  telnyxSocket.onmessage = (ev) => {
    let frame: any;
    try { frame = JSON.parse(ev.data as string); } catch {
      console.log(`[bridge ${conversationId}] Telnyx non-JSON frame`);
      return;
    }

    switch (frame.event) {
      case "connected":
        console.log(`[bridge ${conversationId}] Telnyx connected frame: ${JSON.stringify(frame).slice(0, 300)}`);
        break;

      case "start":
        telnyxStreamId = frame.stream_id || frame.start?.stream_id;
        console.log(`[bridge ${conversationId}] Telnyx START stream_id=${telnyxStreamId} payload=${JSON.stringify(frame).slice(0, 400)}`);
        break;

      case "media": {
        const payload = frame.media?.payload;
        if (!payload) break;
        telnyxMediaCount++;
        if (!firstCallerAudioLogged) {
          firstCallerAudioLogged = true;
          console.log(`[bridge ${conversationId}] FIRST caller audio received from Telnyx`);
        }
        if (telnyxMediaCount % 250 === 0) {
          console.log(`[bridge ${conversationId}] Telnyx media frames: ${telnyxMediaCount}`);
        }
        const mulaw = base64ToUint8(payload);
        if (elReady && elSocket.readyState === WebSocket.OPEN) {
          sendUserAudioToEL(mulaw);
        } else {
          pendingTelnyxAudio.push(mulaw);
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
  telnyxSocket.onclose = () => closeBoth("Telnyx closed");

  return response;
});

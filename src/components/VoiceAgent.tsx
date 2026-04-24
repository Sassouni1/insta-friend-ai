import { useConversation } from "@elevenlabs/react";
import { useState, useCallback, useEffect, useRef } from "react";
import { Mic, MicOff, Phone, PhoneOff, Bug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

interface TranscriptEntry {
  role: "user" | "agent";
  text: string;
  timestamp: Date;
  isTentative?: boolean;
  latencyMs?: number;
}

interface DiagnosticEvent {
  type: string;
  data: string;
  timestamp: Date;
}

interface DiagnosticInfo {
  keySource?: string;
  backendDiagnostics?: any[];
  audioEventsReceived: number;
  connectionStatus: string;
  mode: string;
  lastError?: string;
  lastTentativeTranscript?: string;
  lastFinalTranscript?: string;
  vadScore?: number;
}

export function VoiceAgent() {
  const [isConnecting, setIsConnecting] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [diagEvents, setDiagEvents] = useState<DiagnosticEvent[]>([]);
  const [diag, setDiag] = useState<DiagnosticInfo>({
    audioEventsReceived: 0,
    connectionStatus: "disconnected",
    mode: "idle",
  });
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const audioCountRef = useRef(0);
  const conversationIdRef = useRef<string | null>(null);
  const userStartedAtRef = useRef<number | null>(null);
  const userSpeakingRef = useRef(false);
  const lastVoiceAtRef = useRef<number | null>(null);
  const vadIntervalRef = useRef<number | null>(null);
  const agentStartedSpeakingAtRef = useRef<number | null>(null);
  const pendingAgentLatencyRef = useRef<number | null>(null);

  // Compute latency from when user STARTED talking to NOW (agent response time)
  const computeLatency = useCallback((): number | null => {
    const startedAt = userStartedAtRef.current;
    if (!startedAt) return null;
    const ms = Date.now() - startedAt;
    userStartedAtRef.current = null;
    return ms;
  }, []);

  const persistEntry = useCallback(async (role: "user" | "agent", text: string, latencyMs?: number) => {
    const convId = conversationIdRef.current;
    if (!convId) {
      console.warn("[Recording] No conversation id; skipping save", { role, text });
      return;
    }
    const { error } = await supabase.from("transcript_entries").insert({
      conversation_id: convId,
      role,
      text,
      response_latency_ms: latencyMs ?? null,
    });
    if (error) {
      console.error("[Recording] Failed to save entry", error);
    } else {
      console.log("[Recording] Saved", role, text.slice(0, 40));
    }
  }, []);

  const addDiagEvent = useCallback((type: string, data: string) => {
    setDiagEvents((prev) => [...prev.slice(-29), { type, data, timestamp: new Date() }]);
  }, []);

  const conversation = useConversation({
    onConnect: () => {
      console.log("Connected to Sam");
      setError(null);
      setDiag((d) => ({ ...d, connectionStatus: "connected" }));
      addDiagEvent("connect", "Session connected");
    },
    onDisconnect: () => {
      console.log("Disconnected from Sam");
      setDiag((d) => ({ ...d, connectionStatus: "disconnected", mode: "idle" }));
      addDiagEvent("disconnect", "Session ended");
    },
    onMessage: (message: any) => {
      console.log("[onMessage]", message.type, message);
      const eventType = message?.type || message?.source || message?.role || "unknown";
      addDiagEvent(eventType, JSON.stringify(message).slice(0, 120));

      const directText = typeof message?.message === "string" ? message.message.trim() : "";

      if (message?.type === "user_transcript") {
        const text = message.user_transcription_event?.user_transcript;
        if (text) {
          setTranscript((prev) => {
            const filtered = prev.filter((e, i) => !(i === prev.length - 1 && e.isTentative && e.role === "user"));
            return [...filtered, { role: "user", text, timestamp: new Date() }];
          });
          setDiag((d) => ({ ...d, lastFinalTranscript: text }));
          addDiagEvent("final_transcript", text);
          persistEntry("user", text);
        }
      } else if (message?.type === "agent_response") {
        const text = message.agent_response_event?.agent_response;
        if (text) {
          pendingAgentLatencyRef.current = computeLatency();
          setTranscript((prev) => [...prev, { role: "agent", text, timestamp: new Date(), latencyMs: pendingAgentLatencyRef.current ?? undefined }]);
          persistEntry("agent", text, pendingAgentLatencyRef.current ?? undefined);
        }
      } else if (directText && message?.source === "user") {
        setTranscript((prev) => [...prev, { role: "user", text: directText, timestamp: new Date() }]);
        setDiag((d) => ({ ...d, lastFinalTranscript: directText }));
        addDiagEvent("final_transcript", directText);
        persistEntry("user", directText);
      } else if (directText && message?.source === "ai") {
        const latencyMs = computeLatency();
        pendingAgentLatencyRef.current = latencyMs;
        setTranscript((prev) => [...prev, { role: "agent", text: directText, timestamp: new Date(), latencyMs: latencyMs ?? undefined }]);
        persistEntry("agent", directText, latencyMs ?? undefined);
      } else if (message.type === "agent_response_correction") {
        const text = message.agent_response_correction_event?.corrected_agent_response;
        if (text) {
          addDiagEvent("correction", text);
        }
      } else if (message.type === "audio") {
        audioCountRef.current++;
        setDiag((d) => ({ ...d, audioEventsReceived: audioCountRef.current }));
      }
    },
    onError: (err: any) => {
      console.error("Conversation error:", err);
      const errMsg = typeof err === "string" ? err : err?.message || JSON.stringify(err);
      setError(errMsg);
      setDiag((d) => ({ ...d, lastError: errMsg }));
      addDiagEvent("error", errMsg);
    },
    onDebug: (event: any) => {
      console.log("[onDebug]", event);
      addDiagEvent("sdk_debug", JSON.stringify(event).slice(0, 120));
    },
    onModeChange: (mode: any) => {
      console.log("[onModeChange]", mode);
      const modeStr = typeof mode === "string" ? mode : mode?.mode || JSON.stringify(mode);
      setDiag((d) => ({ ...d, mode: modeStr }));
      addDiagEvent("mode", modeStr);
      if (modeStr === "speaking") {
        agentStartedSpeakingAtRef.current = Date.now();
      } else if (modeStr === "listening") {
        agentStartedSpeakingAtRef.current = null;
      }
    },
    onStatusChange: (status: any) => {
      console.log("[onStatusChange]", status);
      const statusStr = typeof status === "string" ? status : status?.status || JSON.stringify(status);
      setDiag((d) => ({ ...d, connectionStatus: statusStr }));
    },
  } as any);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);

  const startConversation = useCallback(async () => {
    setIsConnecting(true);
    setError(null);
    setTranscript([]);
    setDiagEvents([]);
    audioCountRef.current = 0;
    setDiag({ audioEventsReceived: 0, connectionStatus: "connecting", mode: "idle" });

    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      await audioContext.resume();
    } catch {
      // non-critical
    }

    let preferredInputId: string | undefined;
    try {
      // Request mic first — this triggers the browser permission prompt.
      // enumerateDevices() returns empty/unlabeled results until permission is granted.
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("This browser does not support microphone access (mediaDevices unavailable). Try Chrome or Edge over HTTPS.");
      }

      const preflightStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      // Now that permission is granted, enumerate to pick a stable deviceId for the SDK.
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter((d) => d.kind === "audioinput");
        preferredInputId = audioInputs[0]?.deviceId || undefined;
        addDiagEvent("media_devices", `audio inputs: ${audioInputs.length}`);
      } catch (enumErr) {
        console.warn("enumerateDevices failed (non-critical):", enumErr);
      }

      preflightStream.getTracks().forEach((track) => track.stop());

      const { data, error: fnError } = await supabase.functions.invoke(
        "elevenlabs-conversation-token"
      );

      if (fnError) {
        const realMessage = data?.error || data?.diagnostics
          ?.filter((d: any) => !d.ok)
          .map((d: any) => `${d.stage}: ${d.error_text || d.permission_hint || 'failed'}`)
          .join("; ");
        throw new Error(realMessage || fnError.message || "Backend function error");
      }

      if (data?.error) {
        const backendErr = data.error;
        const hint = data.diagnostics?.find((d: any) => d.permission_hint)?.permission_hint;
        const keySource = data.key_source || "unknown";
        const stageInfo = data.diagnostics?.filter((d: any) => !d.ok)
          .map((d: any) => `${d.stage}: ${d.status} ${d.permission_hint || ""}`)
          .join("; ");

        setDiag((d) => ({ ...d, keySource, backendDiagnostics: data.diagnostics }));

        const userMessage = hint
          ? `Permission error (${hint}) using ${keySource} key. Stage: ${stageInfo}`
          : `Backend error: ${backendErr}`;

        console.error("[Backend diagnostics]", JSON.stringify(data.diagnostics, null, 2));
        throw new Error(userMessage);
      }

      if (!data?.token) {
        throw new Error("No conversation token received from backend");
      }

      setDiag((d) => ({ ...d, keySource: data.key_source }));
      console.log(`[Session] Starting WebRTC with key source: ${data.key_source}, agent: ${data.agent_id}`);

      try {
        const { data: convRow, error: convErr } = await supabase
          .from("conversations")
          .insert({ agent_id: data.agent_id })
          .select("id")
          .single();
        if (convErr) throw convErr;
        conversationIdRef.current = convRow.id;
        console.log(`[Recording] Started conversation ${convRow.id}`);
      } catch (e) {
        console.warn("Failed to create conversation record:", e);
        conversationIdRef.current = null;
      }

      await conversation.startSession({
        connectionType: "webrtc",
        conversationToken: data.token,
        ...(preferredInputId ? { inputDeviceId: preferredInputId } : {}),
        dynamicVariables: {
          first_name: "",
          caller_name: "",
          caller_phone: "",
          caller_email: "",
          company_name: "Hair Systems",
          tenant_timezone: "America/Los_Angeles",
          tenant_id: "",
          conversation_id: conversationIdRef.current ?? "",
        },
        overrides: {
          agent: {
            firstMessage: "Hey — thanks for reaching out. Who do I have the pleasure of speaking with?",
          },
        },
      } as any);

      try {
        await conversation.setVolume({ volume: 1 });
      } catch (e) {
        console.warn("setVolume failed (non-critical):", e);
      }

      const SPEECH_THRESHOLD = 0.04;
      const SILENCE_DURATION_MS = 600;
      vadIntervalRef.current = window.setInterval(() => {
        try {
          const vol = (conversation as any).getInputVolume?.() ?? 0;
          const now = Date.now();
          const agentSpeaking = (conversation as any).isSpeaking === true;
          if (agentSpeaking) {
            userStartedAtRef.current = null;
            userSpeakingRef.current = false;
            lastVoiceAtRef.current = null;
            return;
          }
          if (vol > SPEECH_THRESHOLD) {
            lastVoiceAtRef.current = now;
            if (!userSpeakingRef.current) {
              userSpeakingRef.current = true;
              if (userStartedAtRef.current === null) {
                userStartedAtRef.current = now;
              }
            }
          } else if (userSpeakingRef.current && lastVoiceAtRef.current) {
            if (now - lastVoiceAtRef.current >= SILENCE_DURATION_MS) {
              userSpeakingRef.current = false;
            }
          }
        } catch {
          // ignore
        }
      }, 50);
    } catch (err: any) {
      console.error("Failed to start conversation:", err);
      const message = err?.message || "Failed to connect. Please try again.";
      if (/Requested device not found|NotFoundError/i.test(message)) {
        setError("No usable microphone was found. Check browser mic permissions, reconnect your mic, then try again.");
      } else {
        setError(message);
      }
    } finally {
      setIsConnecting(false);
    }
  }, [conversation, addDiagEvent, persistEntry]);

  const stopConversation = useCallback(async () => {
    if (vadIntervalRef.current) {
      clearInterval(vadIntervalRef.current);
      vadIntervalRef.current = null;
    }
    userSpeakingRef.current = false;
    userStartedAtRef.current = null;
    lastVoiceAtRef.current = null;
    await conversation.endSession();
    const convId = conversationIdRef.current;
    if (convId) {
      try {
        await supabase.from("conversations").update({ ended_at: new Date().toISOString() }).eq("id", convId);
      } catch (e) {
        console.warn("Failed to mark conversation ended", e);
      }
      conversationIdRef.current = null;
    }
  }, [conversation]);

  const isConnected = conversation.status === "connected";
  const isSpeaking = conversation.isSpeaking;

  return (
    <div className="flex flex-col items-center gap-8 w-full max-w-2xl mx-auto">
      {/* Orb */}
      <div className="relative flex items-center justify-center">
        <div
          className={cn(
            "w-40 h-40 rounded-full transition-all duration-700 ease-in-out",
            isConnected && isSpeaking
              ? "bg-accent shadow-[0_0_60px_20px_hsl(var(--accent)/0.4)] scale-110"
              : isConnected
                ? "bg-primary/20 shadow-[0_0_40px_10px_hsl(var(--primary)/0.2)] scale-100"
                : "bg-muted/30 scale-95"
          )}
        />
        <div className="absolute inset-0 flex items-center justify-center">
          {isConnected ? (
            isSpeaking ? (
              <Mic className="w-12 h-12 text-accent-foreground animate-pulse" />
            ) : (
              <MicOff className="w-12 h-12 text-muted-foreground" />
            )
          ) : (
            <Phone className="w-12 h-12 text-muted-foreground" />
          )}
        </div>
      </div>

      {/* Status */}
      <p className="text-sm font-medium text-muted-foreground tracking-wide uppercase">
        {isConnecting
          ? "Connecting..."
          : isConnected
            ? isSpeaking
              ? "Sam is speaking..."
              : "Listening..."
            : "Ready to talk"}
      </p>

      {/* Call Button */}
      {!isConnected ? (
        <Button
          onClick={startConversation}
          disabled={isConnecting}
          size="lg"
          className="rounded-full px-10 py-6 text-lg font-semibold gap-3 bg-accent text-accent-foreground hover:bg-accent/90 shadow-[0_0_30px_5px_hsl(var(--accent)/0.3)] transition-all"
        >
          <Phone className="w-5 h-5" />
          {isConnecting ? "Connecting..." : "Talk to Sam"}
        </Button>
      ) : (
        <Button
          onClick={stopConversation}
          variant="destructive"
          size="lg"
          className="rounded-full px-10 py-6 text-lg font-semibold gap-3"
        >
          <PhoneOff className="w-5 h-5" />
          End Call
        </Button>
      )}

      {/* Error */}
      {error && (
        <div className="text-sm text-destructive bg-destructive/10 px-4 py-2 rounded-lg max-w-full overflow-x-auto">
          <p className="font-semibold mb-1">Error Details:</p>
          <p className="whitespace-pre-wrap break-words">{error}</p>
        </div>
      )}

      {/* Debug Toggle */}
      <button
        onClick={() => setShowDebug((v) => !v)}
        className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 opacity-50 hover:opacity-100 transition-opacity"
      >
        <Bug className="w-3 h-3" />
        {showDebug ? "Hide" : "Show"} diagnostics
      </button>

      {/* Debug Panel */}
      {showDebug && (
        <div className="w-full bg-muted/30 border border-border/50 rounded-lg p-3 text-xs font-mono space-y-2">
          <div className="grid grid-cols-2 gap-1">
            <div>Status: <span className="text-foreground">{diag.connectionStatus}</span></div>
            <div>Mode: <span className="text-foreground">{diag.mode}</span></div>
            <div>Audio events: <span className={cn("text-foreground", diag.audioEventsReceived === 0 && isConnected && "text-destructive font-bold")}>{diag.audioEventsReceived}</span></div>
            <div>Key source: <span className="text-foreground">{diag.keySource || "—"}</span></div>
            <div>SDK status: <span className="text-foreground">{conversation.status}</span></div>
            <div>SDK isSpeaking: <span className="text-foreground">{String(isSpeaking)}</span></div>
          </div>

          {/* Transcript comparison */}
          {(diag.lastTentativeTranscript || diag.lastFinalTranscript) && (
            <div className="border-t border-border/30 pt-2 space-y-1">
              <div className="text-muted-foreground font-semibold">Last heard:</div>
              {diag.lastTentativeTranscript && (
                <div>Tentative: <span className="text-accent">{diag.lastTentativeTranscript}</span></div>
              )}
              {diag.lastFinalTranscript && (
                <div>Final: <span className="text-foreground">{diag.lastFinalTranscript}</span></div>
              )}
            </div>
          )}

          {diag.lastError && <div className="text-destructive">Last error: {diag.lastError}</div>}

          {/* Event timeline */}
          {diagEvents.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-muted-foreground">Event timeline ({diagEvents.length})</summary>
              <div className="mt-1 max-h-40 overflow-y-auto space-y-0.5">
                {diagEvents.slice().reverse().map((evt, i) => (
                  <div key={i} className="text-[10px] flex gap-2">
                    <span className="text-muted-foreground shrink-0">
                      {evt.timestamp.toLocaleTimeString()}
                    </span>
                    <span className={cn(
                      "font-semibold shrink-0",
                      evt.type === "error" ? "text-destructive" :
                      evt.type === "final_transcript" ? "text-accent" :
                      evt.type === "mode" ? "text-primary" :
                      "text-muted-foreground"
                    )}>
                      {evt.type}
                    </span>
                    <span className="text-foreground truncate">{evt.data}</span>
                  </div>
                ))}
              </div>
            </details>
          )}

          {diag.backendDiagnostics && (
            <details className="mt-2">
              <summary className="cursor-pointer text-muted-foreground">Backend ops</summary>
              <pre className="mt-1 whitespace-pre-wrap break-words text-[10px]">
                {JSON.stringify(diag.backendDiagnostics, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}

      {/* Transcript */}
      {transcript.length > 0 && (
        <div className="w-full mt-4">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Transcript
          </h3>
          <div className="bg-card/50 border border-border/50 rounded-xl p-4 max-h-80 overflow-y-auto space-y-3">
            {transcript.map((entry, i) => (
              <div
                key={i}
                className={cn(
                  "flex gap-3 text-sm",
                  entry.role === "agent" ? "justify-start" : "justify-end"
                )}
              >
                <div
                  className={cn(
                    "max-w-[80%] rounded-xl px-4 py-2.5",
                    entry.role === "agent"
                      ? "bg-muted text-foreground"
                      : "bg-accent/20 text-foreground",
                    entry.isTentative && "opacity-50 italic"
                  )}
                >
                  <span className="text-xs font-semibold text-muted-foreground block mb-1">
                    {entry.role === "agent" ? "Sam" : "You"}
                    {entry.latencyMs !== undefined && (
                      <span className="ml-2 font-normal text-[10px] opacity-70">
                        ({(entry.latencyMs / 1000).toFixed(2)}s response)
                      </span>
                    )}
                  </span>
                  {entry.text}
                </div>
              </div>
            ))}
            <div ref={transcriptEndRef} />
          </div>
        </div>
      )}
    </div>
  );
}

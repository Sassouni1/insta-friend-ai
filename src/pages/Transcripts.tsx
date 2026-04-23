import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, MessageSquare, Clock } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Conversation {
  id: string;
  agent_id: string | null;
  started_at: string;
  ended_at: string | null;
}

interface Entry {
  id: string;
  role: "user" | "agent";
  text: string;
  spoken_at: string;
  response_latency_ms: number | null;
}

export default function Transcripts() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from("conversations")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(100);
      setConversations((data as Conversation[]) || []);
      setLoading(false);
    };
    load();
  }, []);

  useEffect(() => {
    if (!selected) {
      setEntries([]);
      return;
    }
    const load = async () => {
      const { data } = await supabase
        .from("transcript_entries")
        .select("*")
        .eq("conversation_id", selected)
        .order("spoken_at", { ascending: true });
      setEntries((data as Entry[]) || []);
    };
    load();
  }, [selected]);

  const formatDuration = (start: string, end: string | null) => {
    if (!end) return "—";
    const ms = new Date(end).getTime() - new Date(start).getTime();
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec}s`;
    return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  };

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <Button asChild variant="ghost" size="sm">
            <Link to="/">
              <ArrowLeft className="w-4 h-4 mr-1" /> Back
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold">Call Transcripts</h1>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* List */}
          <div className="md:col-span-1 space-y-2">
            <p className="text-xs uppercase font-semibold text-muted-foreground tracking-wider mb-2">
              Recent calls ({conversations.length})
            </p>
            {loading && <p className="text-sm text-muted-foreground">Loading...</p>}
            {!loading && conversations.length === 0 && (
              <p className="text-sm text-muted-foreground">No calls recorded yet.</p>
            )}
            <div className="space-y-1.5 max-h-[70vh] overflow-y-auto">
              {conversations.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelected(c.id)}
                  className={cn(
                    "w-full text-left rounded-lg border border-border/50 p-3 transition-colors hover:bg-muted/50",
                    selected === c.id && "bg-muted border-primary/50"
                  )}
                >
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <MessageSquare className="w-3.5 h-3.5 text-muted-foreground" />
                    {new Date(c.started_at).toLocaleString()}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
                    <Clock className="w-3 h-3" />
                    {formatDuration(c.started_at, c.ended_at)}
                    {!c.ended_at && <span className="text-accent">(in progress)</span>}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Detail */}
          <div className="md:col-span-2">
            {!selected ? (
              <div className="border border-dashed border-border/50 rounded-xl p-12 text-center text-muted-foreground">
                Select a call to view its transcript.
              </div>
            ) : (
              <div className="bg-card/50 border border-border/50 rounded-xl p-4 max-h-[70vh] overflow-y-auto space-y-3">
                {entries.length === 0 && (
                  <p className="text-sm text-muted-foreground">No transcript entries.</p>
                )}
                {entries.map((entry) => (
                  <div
                    key={entry.id}
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
                          : "bg-accent/20 text-foreground"
                      )}
                    >
                      <span className="text-xs font-semibold text-muted-foreground block mb-1">
                        {entry.role === "agent" ? "Sam" : "You"} ·{" "}
                        {new Date(entry.spoken_at).toLocaleTimeString()}
                        {entry.response_latency_ms !== null && (
                          <span className="ml-2 font-normal opacity-70">
                            ({(entry.response_latency_ms / 1000).toFixed(2)}s response)
                          </span>
                        )}
                      </span>
                      {entry.text}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

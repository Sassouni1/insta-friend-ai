import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, MessageSquare, Clock, Phone, PhoneIncoming, Globe } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

interface Conversation {
  id: string;
  agent_id: string | null;
  started_at: string;
  ended_at: string | null;
  tenant_id: string | null;
  caller_phone: string | null;
  direction: string;
}

interface Entry {
  id: string;
  role: "user" | "agent";
  text: string;
  spoken_at: string;
  response_latency_ms: number | null;
}

interface Tenant { id: string; name: string }

export default function Transcripts() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tenantFilter, setTenantFilter] = useState("all");
  const [directionFilter, setDirectionFilter] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [c, t] = await Promise.all([
        supabase.from("conversations").select("*").order("started_at", { ascending: false }).limit(200),
        supabase.from("tenants").select("id, name").order("name"),
      ]);
      setConversations((c.data as Conversation[]) || []);
      setTenants((t.data as Tenant[]) || []);
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (!selected) { setEntries([]); return; }
    (async () => {
      const { data } = await supabase
        .from("transcript_entries")
        .select("*")
        .eq("conversation_id", selected)
        .order("spoken_at", { ascending: true });
      setEntries((data as Entry[]) || []);
    })();
  }, [selected]);

  const formatDuration = (start: string, end: string | null) => {
    if (!end) return "—";
    const ms = new Date(end).getTime() - new Date(start).getTime();
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec}s`;
    return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  };

  const tenantName = (id: string | null) => id ? tenants.find((t) => t.id === id)?.name || "—" : "—";

  const filtered = conversations.filter((c) => {
    if (tenantFilter !== "all" && c.tenant_id !== tenantFilter) return false;
    if (directionFilter !== "all" && c.direction !== directionFilter) return false;
    return true;
  });

  const directionIcon = (d: string) => {
    if (d === "inbound") return <PhoneIncoming className="w-3 h-3" />;
    if (d === "outbound") return <Phone className="w-3 h-3" />;
    return <Globe className="w-3 h-3" />;
  };

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center gap-3 mb-6 flex-wrap">
          <Button asChild variant="ghost" size="sm">
            <Link to="/"><ArrowLeft className="w-4 h-4 mr-1" /> Back</Link>
          </Button>
          <h1 className="text-2xl font-semibold">Call Transcripts</h1>
          <div className="ml-auto flex gap-2">
            <Select value={directionFilter} onValueChange={setDirectionFilter}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All directions</SelectItem>
                <SelectItem value="web">Web</SelectItem>
                <SelectItem value="inbound">Inbound</SelectItem>
                <SelectItem value="outbound">Outbound</SelectItem>
              </SelectContent>
            </Select>
            <Select value={tenantFilter} onValueChange={setTenantFilter}>
              <SelectTrigger className="w-44"><SelectValue placeholder="Tenant" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All tenants</SelectItem>
                {tenants.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="md:col-span-1 space-y-2">
            <p className="text-xs uppercase font-semibold text-muted-foreground tracking-wider mb-2">
              Recent calls ({filtered.length})
            </p>
            {loading && <p className="text-sm text-muted-foreground">Loading...</p>}
            {!loading && filtered.length === 0 && <p className="text-sm text-muted-foreground">No calls match filters.</p>}
            <div className="space-y-1.5 max-h-[70vh] overflow-y-auto">
              {filtered.map((c) => (
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
                  <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1.5 flex-wrap">
                    <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[10px]">
                      {directionIcon(c.direction)} {c.direction}
                    </Badge>
                    {c.tenant_id && <span className="truncate">{tenantName(c.tenant_id)}</span>}
                    {c.caller_phone && <span className="font-mono">{c.caller_phone}</span>}
                    <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{formatDuration(c.started_at, c.ended_at)}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="md:col-span-2">
            {!selected ? (
              <div className="border border-dashed border-border/50 rounded-xl p-12 text-center text-muted-foreground">
                Select a call to view its transcript.
              </div>
            ) : (
              <div className="bg-card/50 border border-border/50 rounded-xl p-4 max-h-[70vh] overflow-y-auto space-y-3">
                {entries.length === 0 && <p className="text-sm text-muted-foreground">No transcript entries.</p>}
                {entries.map((entry) => (
                  <div key={entry.id} className={cn("flex gap-3 text-sm", entry.role === "agent" ? "justify-start" : "justify-end")}>
                    <div className={cn("max-w-[80%] rounded-xl px-4 py-2.5", entry.role === "agent" ? "bg-muted text-foreground" : "bg-accent/20 text-foreground")}>
                      <span className="text-xs font-semibold text-muted-foreground block mb-1">
                        {entry.role === "agent" ? "Sam" : "Caller"} · {new Date(entry.spoken_at).toLocaleTimeString()}
                        {entry.response_latency_ms !== null && (
                          <span className="ml-2 font-normal opacity-70">({(entry.response_latency_ms / 1000).toFixed(2)}s response)</span>
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

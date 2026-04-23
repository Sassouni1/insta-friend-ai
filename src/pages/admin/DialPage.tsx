import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { PhoneOutgoing } from "lucide-react";

interface Tenant { id: string; name: string }
interface PhoneNumber { id: string; e164_number: string; tenant_id: string; telnyx_connection_id: string | null }

interface Lead { name: string; phone: string }
interface Result { lead: Lead; ok: boolean; message: string }

const MAX_CONCURRENT = 3;

export default function DialPage() {
  const { toast } = useToast();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [numbers, setNumbers] = useState<PhoneNumber[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [fromNumberId, setFromNumberId] = useState("");
  const [leadsText, setLeadsText] = useState("");
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Result[]>([]);

  useEffect(() => {
    (async () => {
      const [t, n] = await Promise.all([
        supabase.from("tenants").select("id, name").eq("active", true).order("name"),
        supabase.from("phone_numbers").select("*").eq("active", true),
      ]);
      setTenants((t.data as Tenant[]) || []);
      setNumbers((n.data as PhoneNumber[]) || []);
    })();
  }, []);

  const availableFromNumbers = numbers.filter((n) => n.tenant_id === tenantId && n.telnyx_connection_id);

  const parseLeads = (): Lead[] => {
    return leadsText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/[,\t]/).map((s) => s.trim());
        if (parts.length === 1) return { name: "", phone: parts[0] };
        return { name: parts[0], phone: parts[1] };
      })
      .filter((l) => l.phone.startsWith("+"));
  };

  const dial = async () => {
    const leads = parseLeads();
    if (!leads.length) { toast({ variant: "destructive", title: "No valid leads", description: "Provide at least one E.164 number per line." }); return; }
    const fromNum = numbers.find((n) => n.id === fromNumberId);
    if (!tenantId || !fromNum?.telnyx_connection_id) { toast({ variant: "destructive", title: "Choose tenant + caller ID number" }); return; }

    setRunning(true);
    setResults([]);

    const queue = [...leads];
    const collected: Result[] = [];

    const worker = async () => {
      while (queue.length) {
        const lead = queue.shift()!;
        try {
          const { data, error } = await supabase.functions.invoke("telnyx-outbound-call", {
            body: {
              tenant_id: tenantId,
              to_number: lead.phone,
              from_number: fromNum.e164_number,
              connection_id: fromNum.telnyx_connection_id,
              caller_name: lead.name || undefined,
            },
          });
          if (error) collected.push({ lead, ok: false, message: error.message });
          else if (data?.error) collected.push({ lead, ok: false, message: typeof data.error === "string" ? data.error : JSON.stringify(data.error) });
          else collected.push({ lead, ok: true, message: `Call started: ${data?.call_control_id || "ok"}` });
        } catch (e: any) {
          collected.push({ lead, ok: false, message: e.message });
        }
        setResults([...collected]);
        // small spacing between dials
        await new Promise((r) => setTimeout(r, 250));
      }
    };

    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, leads.length) }, () => worker()));
    setRunning(false);
  };

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-6">Outbound dial</h1>

      <Card className="mb-6">
        <CardHeader><CardTitle className="text-base">Campaign</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <Label>Tenant</Label>
              <Select value={tenantId} onValueChange={(v) => { setTenantId(v); setFromNumberId(""); }}>
                <SelectTrigger><SelectValue placeholder="Choose tenant" /></SelectTrigger>
                <SelectContent>
                  {tenants.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Caller ID number</Label>
              <Select value={fromNumberId} onValueChange={setFromNumberId} disabled={!tenantId}>
                <SelectTrigger><SelectValue placeholder={tenantId ? "Choose caller ID" : "Pick tenant first"} /></SelectTrigger>
                <SelectContent>
                  {availableFromNumbers.map((n) => <SelectItem key={n.id} value={n.id}>{n.e164_number}</SelectItem>)}
                </SelectContent>
              </Select>
              {tenantId && availableFromNumbers.length === 0 && (
                <p className="text-xs text-muted-foreground mt-1">No numbers with a Telnyx connection ID assigned to this tenant.</p>
              )}
            </div>
          </div>

          <div>
            <Label>Leads (one per line: <code className="text-xs">name, +14155550100</code>)</Label>
            <Textarea
              rows={8}
              placeholder={`Chris, +14155550100\nJordan, +14155550199`}
              value={leadsText}
              onChange={(e) => setLeadsText(e.target.value)}
            />
          </div>

          <Button onClick={dial} disabled={running || !tenantId || !fromNumberId}>
            <PhoneOutgoing className="w-4 h-4 mr-2" />
            {running ? "Dialing..." : `Start dialing (max ${MAX_CONCURRENT} concurrent)`}
          </Button>
        </CardContent>
      </Card>

      {results.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Results ({results.length})</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-1.5 text-sm">
              {results.map((r, i) => (
                <div key={i} className="flex items-center gap-3 p-2 rounded border border-border/50">
                  <span className={r.ok ? "text-accent" : "text-destructive"}>●</span>
                  <span className="font-mono text-xs">{r.lead.phone}</span>
                  <span className="text-muted-foreground">{r.lead.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{r.message}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Bot, PhoneCall } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

interface PhoneNumber {
  id: string;
  e164_number: string;
  tenant_id: string;
  telnyx_connection_id: string | null;
  active: boolean;
}

interface Tenant {
  id: string;
  name: string;
}

const DEFAULT_CHRIS_SCRIPT = `You are Chris, a realistic practice lead calling about hair systems.

Stay natural and concise. Do not mention that you are an AI or a practice caller.
Answer Sam's questions directly, one at a time.

Profile:
- Your name is Chris.
- You have been dealing with thinning hair for about 4 years.
- You have tried hats, fibers, and looking into medication, but you are unsure.
- You are curious but a little skeptical about whether a hair system will look natural.
- If Sam asks about time, say afternoons are better and you are in Pacific time.
- If Sam offers appointment times, pick the first one that sounds available.
- If Sam asks for email, use chris@example.com.
- If Sam asks for phone, use the number you are calling from.`;

export default function PracticePage() {
  const { toast } = useToast();
  const [numbers, setNumbers] = useState<PhoneNumber[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [fromNumberId, setFromNumberId] = useState("");
  const [targetNumberId, setTargetNumberId] = useState("");
  const [script, setScript] = useState(DEFAULT_CHRIS_SCRIPT);
  const [running, setRunning] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [n, t] = await Promise.all([
        supabase.from("phone_numbers").select("*").eq("active", true).order("e164_number"),
        supabase.from("tenants").select("id, name").order("name"),
      ]);
      setNumbers((n.data as PhoneNumber[]) || []);
      setTenants((t.data as Tenant[]) || []);
    })();
  }, []);

  const outboundNumbers = useMemo(
    () => numbers.filter((n) => n.telnyx_connection_id),
    [numbers],
  );

  const tenantName = (id: string) => tenants.find((t) => t.id === id)?.name || "Unknown tenant";

  const startPracticeCall = async () => {
    setRunning(true);
    setConversationId(null);
    setMessage(null);
    try {
      const { data, error } = await supabase.functions.invoke("practice-bot-call", {
        body: {
          from_number_id: fromNumberId,
          target_number_id: targetNumberId,
          chris_script: script,
        },
      });

      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(typeof data.error === "string" ? data.error : JSON.stringify(data.error));

      setConversationId(data?.conversation_id || null);
      setMessage(data?.message || "Practice call started.");
      toast({ title: "Practice call started", description: "Chris is dialing the selected Sam number." });
    } catch (err: unknown) {
      const description = err instanceof Error ? err.message : "Could not start the practice call.";
      toast({ variant: "destructive", title: "Practice call failed", description });
      setMessage(description);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Practice call</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Chris calls one of your Sam numbers so you can test inbound handling and review transcripts.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Bot className="w-4 h-4" /> Chris caller bot</CardTitle>
          <CardDescription>Use two different Telnyx numbers when possible: one caller ID for Chris and one inbound number for Sam.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <Label>Bot 2 caller ID</Label>
              <Select value={fromNumberId} onValueChange={setFromNumberId}>
                <SelectTrigger><SelectValue placeholder="Choose Chris outbound number" /></SelectTrigger>
                <SelectContent>
                  {outboundNumbers.map((n) => (
                    <SelectItem key={n.id} value={n.id}>
                      {n.e164_number} · {tenantName(n.tenant_id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {outboundNumbers.length === 0 && (
                <p className="text-xs text-muted-foreground mt-1">Add a phone number with a Telnyx connection ID first.</p>
              )}
            </div>

            <div>
              <Label>Bot 1 inbound number</Label>
              <Select value={targetNumberId} onValueChange={setTargetNumberId}>
                <SelectTrigger><SelectValue placeholder="Choose Sam inbound number" /></SelectTrigger>
                <SelectContent>
                  {numbers.map((n) => (
                    <SelectItem key={n.id} value={n.id}>
                      {n.e164_number} · {tenantName(n.tenant_id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label>Chris script</Label>
            <Textarea
              rows={13}
              value={script}
              onChange={(e) => setScript(e.target.value)}
              className="font-mono text-xs"
            />
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <Button onClick={startPracticeCall} disabled={running || !fromNumberId || !targetNumberId || !script.trim()}>
              <PhoneCall className="w-4 h-4 mr-2" />
              {running ? "Starting..." : "Start Chris calling Sam"}
            </Button>
            {conversationId && (
              <Button asChild variant="outline">
                <Link to={`/transcripts?conversation=${conversationId}`}>View Chris transcript</Link>
              </Button>
            )}
          </div>

          {message && <p className="text-sm text-muted-foreground">{message}</p>}
        </CardContent>
      </Card>
    </div>
  );
}

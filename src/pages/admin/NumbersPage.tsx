import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, Copy } from "lucide-react";

interface PhoneNumber {
  id: string;
  e164_number: string;
  tenant_id: string;
  telnyx_connection_id: string | null;
  active: boolean;
}
interface Tenant { id: string; name: string }

const PROJECT_REF = import.meta.env.VITE_SUPABASE_PROJECT_ID;
const WEBHOOK_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/telnyx-inbound`;

const empty = { e164_number: "", tenant_id: "", telnyx_connection_id: "", active: true };

export default function NumbersPage() {
  const { toast } = useToast();
  const [numbers, setNumbers] = useState<PhoneNumber[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(empty);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const [n, t] = await Promise.all([
      supabase.from("phone_numbers").select("*").order("created_at", { ascending: false }),
      supabase.from("tenants").select("id, name").order("name"),
    ]);
    setNumbers((n.data as PhoneNumber[]) || []);
    setTenants((t.data as Tenant[]) || []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const tenantName = (id: string) => tenants.find((t) => t.id === id)?.name || "—";

  const save = async () => {
    if (!form.e164_number.startsWith("+")) {
      toast({ variant: "destructive", title: "Invalid number", description: "Use E.164 format like +14155550100" });
      return;
    }
    const { error } = await supabase.from("phone_numbers").insert({
      e164_number: form.e164_number,
      tenant_id: form.tenant_id,
      telnyx_connection_id: form.telnyx_connection_id || null,
      active: form.active,
    });
    if (error) toast({ variant: "destructive", title: "Save failed", description: error.message });
    else { setOpen(false); setForm(empty); load(); }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this phone number?")) return;
    await supabase.from("phone_numbers").delete().eq("id", id);
    load();
  };

  const copyWebhook = () => {
    navigator.clipboard.writeText(WEBHOOK_URL);
    toast({ title: "Copied", description: "Webhook URL copied to clipboard" });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Phone numbers</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="w-4 h-4 mr-1" />Add number</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Add phone number</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>E.164 number</Label><Input placeholder="+14155550100" value={form.e164_number} onChange={(e) => setForm({ ...form, e164_number: e.target.value })} /></div>
              <div>
                <Label>Tenant</Label>
                <Select value={form.tenant_id} onValueChange={(v) => setForm({ ...form, tenant_id: v })}>
                  <SelectTrigger><SelectValue placeholder="Choose tenant" /></SelectTrigger>
                  <SelectContent>
                    {tenants.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div><Label>Telnyx connection ID (for outbound)</Label><Input value={form.telnyx_connection_id} onChange={(e) => setForm({ ...form, telnyx_connection_id: e.target.value })} /></div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={save} disabled={!form.tenant_id}>Add</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="mb-6">
        <CardHeader><CardTitle className="text-base">Telnyx webhook URL</CardTitle></CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <code className="flex-1 p-2 bg-muted rounded text-xs break-all">{WEBHOOK_URL}</code>
            <Button size="sm" variant="outline" onClick={copyWebhook}><Copy className="w-4 h-4" /></Button>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Set this as the webhook URL on your Telnyx Voice API Application, then assign your numbers to that application.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">{numbers.length} number{numbers.length === 1 ? "" : "s"}</CardTitle></CardHeader>
        <CardContent>
          {loading ? <p className="text-sm text-muted-foreground">Loading...</p> : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Connection ID</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {numbers.map((n) => (
                  <TableRow key={n.id}>
                    <TableCell className="font-mono">{n.e164_number}</TableCell>
                    <TableCell>{tenantName(n.tenant_id)}</TableCell>
                    <TableCell className="font-mono text-xs">{n.telnyx_connection_id || "—"}</TableCell>
                    <TableCell>{n.active ? <Badge>Active</Badge> : <Badge variant="secondary">Off</Badge>}</TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => remove(n.id)}><Trash2 className="w-4 h-4" /></Button>
                    </TableCell>
                  </TableRow>
                ))}
                {numbers.length === 0 && <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">No numbers yet.</TableCell></TableRow>}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

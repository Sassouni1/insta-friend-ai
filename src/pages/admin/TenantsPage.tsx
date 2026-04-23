import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Plus, Pencil, Trash2 } from "lucide-react";

interface Tenant {
  id: string;
  name: string;
  ghl_location_id: string | null;
  ghl_api_token: string | null;
  ghl_calendar_id: string | null;
  timezone: string;
  active: boolean;
  created_at: string;
}

const empty = { name: "", ghl_location_id: "", ghl_api_token: "", ghl_calendar_id: "", timezone: "America/Los_Angeles", active: true };

export default function TenantsPage() {
  const { toast } = useToast();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Tenant | null>(null);
  const [form, setForm] = useState(empty);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase.from("tenants").select("*").order("created_at", { ascending: false });
    setTenants((data as Tenant[]) || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const openNew = () => { setEditing(null); setForm(empty); setOpen(true); };
  const openEdit = (t: Tenant) => {
    setEditing(t);
    setForm({
      name: t.name,
      ghl_location_id: t.ghl_location_id || "",
      ghl_api_token: t.ghl_api_token || "",
      ghl_calendar_id: t.ghl_calendar_id || "",
      timezone: t.timezone,
      active: t.active,
    });
    setOpen(true);
  };

  const save = async () => {
    const payload = {
      name: form.name,
      ghl_location_id: form.ghl_location_id || null,
      ghl_api_token: form.ghl_api_token || null,
      ghl_calendar_id: form.ghl_calendar_id || null,
      timezone: form.timezone,
      active: form.active,
    };
    const res = editing
      ? await supabase.from("tenants").update(payload).eq("id", editing.id)
      : await supabase.from("tenants").insert(payload);
    if (res.error) {
      toast({ variant: "destructive", title: "Save failed", description: res.error.message });
    } else {
      setOpen(false);
      load();
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this tenant? Phone numbers and bookings linked to it will also be removed.")) return;
    const { error } = await supabase.from("tenants").delete().eq("id", id);
    if (error) toast({ variant: "destructive", title: "Delete failed", description: error.message });
    else load();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Tenants</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button onClick={openNew}><Plus className="w-4 h-4 mr-1" />New tenant</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{editing ? "Edit tenant" : "New tenant"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div><Label>Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
              <div><Label>GoHighLevel location ID</Label><Input value={form.ghl_location_id} onChange={(e) => setForm({ ...form, ghl_location_id: e.target.value })} /></div>
              <div><Label>GoHighLevel API token (Private Integration)</Label><Input type="password" value={form.ghl_api_token} onChange={(e) => setForm({ ...form, ghl_api_token: e.target.value })} /></div>
              <div><Label>GoHighLevel calendar ID</Label><Input value={form.ghl_calendar_id} onChange={(e) => setForm({ ...form, ghl_calendar_id: e.target.value })} /></div>
              <div><Label>Timezone (IANA)</Label><Input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} /></div>
              <div className="flex items-center gap-2"><input type="checkbox" id="active" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /><Label htmlFor="active">Active</Label></div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={save}>{editing ? "Save" : "Create"}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">{tenants.length} tenant{tenants.length === 1 ? "" : "s"}</CardTitle></CardHeader>
        <CardContent>
          {loading ? <p className="text-sm text-muted-foreground">Loading...</p> : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Timezone</TableHead>
                  <TableHead>GHL configured</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tenants.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">{t.name}</TableCell>
                    <TableCell>{t.timezone}</TableCell>
                    <TableCell>
                      {t.ghl_api_token && t.ghl_calendar_id && t.ghl_location_id
                        ? <Badge variant="default">Yes</Badge>
                        : <Badge variant="secondary">Incomplete</Badge>}
                    </TableCell>
                    <TableCell>{t.active ? <Badge>Active</Badge> : <Badge variant="secondary">Off</Badge>}</TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(t)}><Pencil className="w-4 h-4" /></Button>
                      <Button size="sm" variant="ghost" onClick={() => remove(t.id)}><Trash2 className="w-4 h-4" /></Button>
                    </TableCell>
                  </TableRow>
                ))}
                {tenants.length === 0 && <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">No tenants yet.</TableCell></TableRow>}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

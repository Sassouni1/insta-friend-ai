import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

interface Booking {
  id: string;
  tenant_id: string;
  conversation_id: string | null;
  caller_name: string | null;
  caller_phone: string | null;
  caller_email: string | null;
  slot_iso: string;
  ghl_appointment_id: string | null;
  status: string;
  created_at: string;
}
interface Tenant { id: string; name: string }

export default function BookingsPage() {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tenantFilter, setTenantFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [b, t] = await Promise.all([
        supabase.from("bookings").select("*").order("created_at", { ascending: false }).limit(200),
        supabase.from("tenants").select("id, name").order("name"),
      ]);
      setBookings((b.data as Booking[]) || []);
      setTenants((t.data as Tenant[]) || []);
      setLoading(false);
    })();
  }, []);

  const tenantName = (id: string) => tenants.find((t) => t.id === id)?.name || "—";
  const filtered = tenantFilter === "all" ? bookings : bookings.filter((b) => b.tenant_id === tenantFilter);

  return (
    <div>
      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <h1 className="text-2xl font-semibold">Bookings</h1>
        <Select value={tenantFilter} onValueChange={setTenantFilter}>
          <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All tenants</SelectItem>
            {tenants.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">{filtered.length} booking{filtered.length === 1 ? "" : "s"}</CardTitle></CardHeader>
        <CardContent>
          {loading ? <p className="text-sm text-muted-foreground">Loading...</p> : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Lead</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Slot</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell>{tenantName(b.tenant_id)}</TableCell>
                    <TableCell>{b.caller_name || "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{b.caller_phone || "—"}</TableCell>
                    <TableCell>{new Date(b.slot_iso).toLocaleString()}</TableCell>
                    <TableCell><Badge variant={b.status === "confirmed" ? "default" : "secondary"}>{b.status}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{new Date(b.created_at).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
                {filtered.length === 0 && <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">No bookings.</TableCell></TableRow>}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

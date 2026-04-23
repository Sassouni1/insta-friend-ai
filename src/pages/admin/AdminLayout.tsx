import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { Building2, Phone, Calendar, PhoneOutgoing, FileText, LogOut, Home } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function AdminLayout() {
  const navigate = useNavigate();
  const [checking, setChecking] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let mounted = true;
    const check = async (uid: string | null) => {
      if (!uid) {
        if (mounted) { setIsAdmin(false); setChecking(false); navigate("/auth", { replace: true }); }
        return;
      }
      const { data } = await supabase.from("user_roles").select("role").eq("user_id", uid).eq("role", "admin").maybeSingle();
      if (!mounted) return;
      if (!data) {
        setIsAdmin(false);
        setChecking(false);
      } else {
        setIsAdmin(true);
        setChecking(false);
      }
    };

    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      check(session?.user?.id ?? null);
    });
    supabase.auth.getSession().then(({ data }) => check(data.session?.user?.id ?? null));

    return () => { mounted = false; sub.subscription.unsubscribe(); };
  }, [navigate]);

  const signOut = async () => {
    await supabase.auth.signOut();
    navigate("/auth", { replace: true });
  };

  if (checking) {
    return <div className="min-h-screen bg-background flex items-center justify-center text-muted-foreground">Loading...</div>;
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6 gap-4">
        <p className="text-foreground">Your account does not have admin access.</p>
        <p className="text-sm text-muted-foreground max-w-md text-center">
          Ask an existing admin to grant you the role, or run this SQL with your user id:
          <code className="block mt-2 p-2 bg-muted rounded text-xs">
            insert into user_roles (user_id, role) values ('YOUR_USER_ID', 'admin');
          </code>
        </p>
        <Button variant="outline" onClick={signOut}><LogOut className="w-4 h-4 mr-2" />Sign out</Button>
      </div>
    );
  }

  const navItem = "flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors";

  return (
    <div className="min-h-screen bg-background flex flex-col md:flex-row">
      <aside className="w-full md:w-60 border-b md:border-b-0 md:border-r border-border/50 p-4 flex flex-col gap-1">
        <Link to="/" className="flex items-center gap-2 px-3 py-2 mb-4">
          <span className="text-lg font-semibold">Sam Admin</span>
        </Link>
        <NavLink to="/admin/tenants" className={({ isActive }) => cn(navItem, isActive ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50")}>
          <Building2 className="w-4 h-4" /> Tenants
        </NavLink>
        <NavLink to="/admin/numbers" className={({ isActive }) => cn(navItem, isActive ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50")}>
          <Phone className="w-4 h-4" /> Phone numbers
        </NavLink>
        <NavLink to="/admin/bookings" className={({ isActive }) => cn(navItem, isActive ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50")}>
          <Calendar className="w-4 h-4" /> Bookings
        </NavLink>
        <NavLink to="/admin/dial" className={({ isActive }) => cn(navItem, isActive ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50")}>
          <PhoneOutgoing className="w-4 h-4" /> Outbound dial
        </NavLink>
        <NavLink to="/transcripts" className={cn(navItem, "text-muted-foreground hover:bg-muted/50")}>
          <FileText className="w-4 h-4" /> Transcripts
        </NavLink>
        <div className="mt-auto pt-4 space-y-1">
          <Link to="/" className={cn(navItem, "text-muted-foreground hover:bg-muted/50")}>
            <Home className="w-4 h-4" /> Web orb
          </Link>
          <button onClick={signOut} className={cn(navItem, "w-full text-muted-foreground hover:bg-muted/50")}>
            <LogOut className="w-4 h-4" /> Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 p-6 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}

import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Index from "./pages/Index";
import NotFound from "./pages/NotFound";
import Transcripts from "./pages/Transcripts";
import Auth from "./pages/Auth";
import AdminLayout from "./pages/admin/AdminLayout";
import TenantsPage from "./pages/admin/TenantsPage";
import NumbersPage from "./pages/admin/NumbersPage";
import BookingsPage from "./pages/admin/BookingsPage";
import DialPage from "./pages/admin/DialPage";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Index />} />
          <Route path="/auth" element={<Auth />} />
          <Route path="/transcripts" element={<Transcripts />} />
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<Navigate to="/admin/tenants" replace />} />
            <Route path="tenants" element={<TenantsPage />} />
            <Route path="numbers" element={<NumbersPage />} />
            <Route path="bookings" element={<BookingsPage />} />
            <Route path="dial" element={<DialPage />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;

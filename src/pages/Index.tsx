import { Link } from "react-router-dom";
import { FileText, Settings } from "lucide-react";
import { VoiceAgent } from "@/components/VoiceAgent";

const Index = () => {
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6 relative">
      <div className="absolute top-6 right-6 flex items-center gap-4">
        <Link to="/transcripts" className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1.5">
          <FileText className="w-4 h-4" /> Transcripts
        </Link>
        <Link to="/admin" className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1.5">
          <Settings className="w-4 h-4" /> Admin
        </Link>
      </div>
      <div className="text-center mb-12">
        <h1 className="text-5xl font-bold tracking-tight text-foreground mb-2">Sam</h1>
        <p className="text-muted-foreground text-lg">AI Voice Agent — Barber Launch</p>
      </div>

      <VoiceAgent />
    </div>
  );
};

export default Index;


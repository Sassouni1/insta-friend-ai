import { Link } from "react-router-dom";
import { FileText } from "lucide-react";
import { VoiceAgent } from "@/components/VoiceAgent";

const Index = () => {
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6 relative">
      <Link
        to="/transcripts"
        className="absolute top-6 right-6 text-sm text-muted-foreground hover:text-foreground flex items-center gap-1.5"
      >
        <FileText className="w-4 h-4" />
        Transcripts
      </Link>
      <div className="text-center mb-12">
        <h1 className="text-5xl font-bold tracking-tight text-foreground mb-2">
          Sam
        </h1>
        <p className="text-muted-foreground text-lg">
          AI Voice Agent — Barber Launch
        </p>
      </div>

      <VoiceAgent />
    </div>
  );
};

export default Index;

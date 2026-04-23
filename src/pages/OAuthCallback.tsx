import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

export default function OAuthCallback() {
  const [status, setStatus] = useState<"loading" | "error">("loading");
  const [html, setHtml] = useState<string>("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const callbackUrl = `https://quezinwuuxzyqsntzicm.supabase.co/functions/v1/crm-oauth-callback?${params.toString()}`;

    fetch(callbackUrl)
      .then((r) => r.text())
      .then((text) => {
        setHtml(text);
        setStatus("error"); // we render the result page either way
      })
      .catch(() => setStatus("error"));
  }, []);

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span>Finalizing connection…</span>
        </div>
      </div>
    );
  }

  return (
    <iframe
      title="OAuth result"
      srcDoc={html}
      className="w-full h-screen border-0"
    />
  );
}

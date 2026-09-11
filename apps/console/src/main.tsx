import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const apiBase = import.meta.env.VITE_API_BASE_URL || "https://promoapi-production-8258.up.railway.app";

type Health = { ok?: boolean; transport?: { provider?: string; mode?: string }; worker?: { running?: boolean } };

function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${apiBase}/health/ready`)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error || "API is not ready");
        setHealth(body);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "API status unavailable"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="shell">
      <section className="hero">
        <div className="eyebrow">HULLETS / OPERATIONS</div>
        <h1>Receipt promotions, under control.</h1>
        <p className="lede">A durable operations surface for campaign intake, qualification, auditable draws, winner fulfilment, and WhatsApp delivery.</p>
        <div className="status-row" aria-live="polite">
          <span className={`status-dot ${health?.ok ? "online" : ""}`} />
          {loading ? "Checking platform status…" : health?.ok ? "Platform online" : "Platform needs attention"}
        </div>
      </section>

      <section className="grid" aria-label="Platform status">
        <article className="card accent">
          <div className="card-label">RUNTIME</div>
          <strong>{health?.ok ? "Ready" : error || "Checking"}</strong>
          <span>Database, storage, and extraction services</span>
        </article>
        <article className="card">
          <div className="card-label">MESSAGING</div>
          <strong>{health?.transport?.mode === "configured" ? "Cloud API configured" : "Not configured"}</strong>
          <span>{health?.transport?.provider || "WhatsApp transport"}</span>
        </article>
        <article className="card">
          <div className="card-label">WORKER</div>
          <strong>{health?.worker?.running ? "Running" : "Starting"}</strong>
          <span>Durable intake and fulfilment processing</span>
        </article>
      </section>

      <section className="next">
        <div>
          <div className="card-label">NEXT STEP</div>
          <h2>Sign in to the operations workspace</h2>
          <p>The authenticated workspace is served by the Hullets API. Use the bootstrap administrator credentials configured for this environment.</p>
        </div>
        <a className="button" href={`${apiBase}/api/contract.json`}>View API contract <span>↗</span></a>
      </section>

      <footer>Hullets · controlled delivery infrastructure · {new Date().getFullYear()}</footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);

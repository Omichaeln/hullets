import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/taptap.css";
import { App } from "./app.tsx";
import { initTheme } from "./lib/theme.ts";
initTheme();   // before first paint, so a chosen theme never flashes the other one
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

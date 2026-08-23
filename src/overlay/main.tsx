import React from "react";
import ReactDOM from "react-dom/client";
import RecordingOverlay from "./RecordingOverlay";
import { applyDarkTheme } from "@/lib/utils/theme";
import "@/i18n";

// A separate webview from the settings window, so the overlay has to set
// `data-theme` on its own document. There is nothing to follow any more — the
// app is dark and the flow bar scopes its own colours regardless.
applyDarkTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RecordingOverlay />
  </React.StrictMode>,
);

import React from "react";
import ReactDOM from "react-dom/client";
import { platform } from "@tauri-apps/plugin-os";
import App from "./App";
import { installCompatShims } from "./lib/compat";
import { applyDarkTheme } from "./lib/utils/theme";

installCompatShims();

// Set platform before render so CSS can scope per-platform (e.g. scrollbar styles)
document.documentElement.dataset.platform = platform();

// The app is dark, unconditionally. Set before render so nothing paints light.
applyDarkTheme();

// Initialize i18n
import "./i18n";

// Initialize model store (loads models and sets up event listeners)
import { useModelStore } from "./stores/modelStore";
useModelStore.getState().initialize();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

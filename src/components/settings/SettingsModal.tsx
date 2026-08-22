import React from "react";

export type SettingsPage =
  | "general"
  | "system"
  | "models"
  | "storage"
  | "advanced";

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  initialPage?: SettingsPage;
}

// The props above are the frozen contract the app shell wires against; the
// Wispr-port settings phase replaces the internals.
const SettingsModal: React.FC<SettingsModalProps> = (props) => {
  if (!props.open) return null;
  return null;
};

export default SettingsModal;

// The ported settings modal, plus the three section components the shell still
// mounts as pages of its own. Individual setting components are imported by
// their own path — the barrel is not an inventory.
export { default as SettingsModal } from "./SettingsModal";
export type { SettingsModalProps, SettingsPage } from "./SettingsModal";

export { DebugSettings } from "./debug/DebugSettings";
export { AboutSettings } from "./about/AboutSettings";
export { ModelsSettings } from "./models/ModelsSettings";
export { CustomWords } from "./CustomWords";

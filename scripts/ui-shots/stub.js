/**
 * The Tauri IPC stub the headless UI harness installs before any app module
 * loads. It answers `invoke` from a fixture file instead of a Rust backend, so
 * every screen can be rendered and measured in a browser — no app launch, no
 * window on anyone's screen.
 *
 * Injected by shoot.mjs via addInitScript with the fixtures bound in.
 */
export function installTauriStub(fixtures) {
  // Verbatim, including the retired values Rem's real store still carries
  // (`overlay_style: "minimal"`): what the UI does with those is the point.
  const settings = { ...fixtures.settings };
  const listeners = new Map(); // event name -> Set of callback ids
  const callbacks = new Map(); // callback id -> fn
  let nextId = 1;

  const ok = (value) => Promise.resolve(value);

  // Commands that only mutate and return nothing. The UI's optimistic updates
  // carry the visible state, so acknowledging is enough.
  const ACK = () => ok(null);

  const handlers = {
    // --- app shell -------------------------------------------------------
    get_app_settings: () => ok(settings),
    "plugin:app|version": () => ok(fixtures.version),
    "plugin:app|name": () => ok("Fancy Shmancy"),
    "plugin:os|locale": () => ok("en-US"),
    "plugin:event|listen": (args) => {
      const set = listeners.get(args.event) ?? new Set();
      set.add(args.handler);
      listeners.set(args.event, set);
      return ok(nextId++);
    },
    "plugin:event|unlisten": () => ACK(),
    "plugin:event|emit": () => ACK(),
    "plugin:event|emit_to": () => ACK(),
    "plugin:updater|check": () => ok(null),
    "plugin:autostart|is_enabled": () => ok(true),
    "plugin:macos-permissions|check_accessibility_permission": () => ok(true),
    "plugin:macos-permissions|check_microphone_permission": () => ok(true),

    // --- history ---------------------------------------------------------
    get_history_entries: (args) => {
      const all = fixtures.history;
      const start = args?.cursor
        ? all.findIndex((e) => e.id === args.cursor) + 1
        : 0;
      const limit = args?.limit ?? 30;
      return ok({
        entries: all.slice(start, start + limit),
        has_more: start + limit < all.length,
      });
    },
    get_recording_storage_usage: () => ok(fixtures.storage),
    // Deliberately long: the real default is a deep Application Support path,
    // and this row is where a path pushed its buttons off the card.
    get_recordings_dir: () =>
      ok(
        "/Users/you/Library/Application Support/computer.handy.fancy-shmancy/recordings",
      ),
    get_audio_file_path: () => ok(""),

    // --- models ----------------------------------------------------------
    get_available_models: () => ok(fixtures.models),
    get_current_model: () => ok(fixtures.currentModel),
    get_available_accelerators: () =>
      ok({
        transcribe: ["auto", "gpu", "cpu"],
        ort: ["auto", "cpu"],
        gpu_devices: [{ id: "0", name: "Apple M4 Pro", total_vram_mb: 24576 }],
      }),

    // --- devices and feedback --------------------------------------------
    // Shapes matter here: a null where the UI expects an object takes the whole
    // page down, which is exactly what a screenshot run should catch.
    get_available_microphones: () => ok(["Default", "MacBook Pro Microphone"]),
    get_available_output_devices: () => ok(["Default", "MacBook Pro Speakers"]),
    check_custom_sounds: () => ok({ start: false, stop: false }),
    get_current_microphone: () => ok("Default"),

    // --- misc ------------------------------------------------------------
    is_portable: () => ok(false),
    get_windows_microphone_permission_status: () =>
      ok({ supported: false, overall_access: "granted" }),
  };

  window.__TAURI_INTERNALS__ = {
    // `getCurrentWebviewWindow()` reads this synchronously at module scope.
    // Without it the history list's audio player throws on mount and takes the
    // whole page down, which looks like a UI bug and is not one.
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main", windowLabel: "main" },
    },
    invoke: (cmd, args) => {
      const handler = handlers[cmd];
      if (handler) return handler(args ?? {});
      // Every setter, every initializer: acknowledge and move on. Anything that
      // genuinely needs a value is listed above, and a missing one shows up as
      // an obviously empty region in the screenshot rather than a silent lie.
      return ACK();
    },
    transformCallback: (fn) => {
      const id = nextId++;
      callbacks.set(id, fn);
      return id;
    },
    unregisterCallback: (id) => callbacks.delete(id),
    convertFileSrc: (path) => path,
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  window.__TAURI_OS_PLUGIN_INTERNALS__ = {
    platform: "macos",
    family: "unix",
    os_type: "macos",
    arch: "aarch64",
    version: "26.0.0",
    eol: "\n",
    exe_extension: "",
  };

  // The harness's way of pushing a backend event into the page.
  window.__fsEmit = (event, payload) => {
    for (const id of listeners.get(event) ?? []) {
      callbacks.get(id)?.({ event, id, payload });
    }
  };
}

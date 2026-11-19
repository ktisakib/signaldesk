import { invoke, isTauri } from "@tauri-apps/api/core";
import { create } from "zustand";
import { errorMessage } from "./api";

export interface UpdateInfo {
  version: string;
  notes?: string | null;
}

interface UpdaterStore {
  update: UpdateInfo | null;
  checking: boolean;
  installing: boolean;
  statusMessage: string;
  error: string | null;
  lastChecked: Date | null;
  check: (manual?: boolean) => Promise<void>;
  install: () => Promise<void>;
}

export const useUpdater = create<UpdaterStore>((set, get) => ({
  update: null,
  checking: false,
  installing: false,
  statusMessage: "",
  error: null,
  lastChecked: null,
  check: async (manual = false) => {
    if (!isTauri()) return;
    if (get().checking || get().installing) return;
    set({
      checking: true,
      error: null,
      statusMessage: manual ? "Checking for updates…" : get().statusMessage,
    });
    try {
      const result = await invoke<UpdateInfo | null>("check_update");
      set({
        update: result,
        checking: false,
        lastChecked: new Date(),
        statusMessage: result
          ? `Version ${result.version} is available!`
          : manual
            ? "You are using the latest version."
            : "",
      });
    } catch (e) {
      const msg = errorMessage(e);
      set({
        checking: false,
        error: msg,
        statusMessage: manual ? `Could not check for updates: ${msg}` : "",
      });
    }
  },
  install: async () => {
    if (!isTauri() || get().installing) return;
    set({ installing: true, statusMessage: "Downloading and applying update…" });
    try {
      await invoke("install_update");
    } catch (e) {
      const msg = errorMessage(e);
      set({
        installing: false,
        error: msg,
        statusMessage: `Failed to install update: ${msg}`,
      });
    }
  },
}));

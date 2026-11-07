import { create } from "zustand";
import {
  api,
  errorMessage,
  type BroadcastStatus,
  type Diagnostics,
  type MediaItem,
  type Settings,
} from "./api";

interface StudioStore {
  status: BroadcastStatus | null;
  library: MediaItem[];
  queue: MediaItem[];
  settings: Settings | null;
  diagnostics: Diagnostics | null;
  connected: boolean;
  connectionError: string | null;
  refresh: () => Promise<void>;
  poll: () => Promise<void>;
}

export const useStudio = create<StudioStore>((set, get) => ({
  status: null,
  library: [],
  queue: [],
  settings: null,
  diagnostics: null,
  connected: false,
  connectionError: null,
  refresh: async () => {
    try {
      const [status, library, queue, settings, diagnostics] = await Promise.all(
        [
          api<BroadcastStatus>("/api/status"),
          api<MediaItem[]>("/api/library"),
          api<MediaItem[]>("/api/queue"),
          api<Settings>("/api/settings"),
          api<Diagnostics>("/api/diagnostics"),
        ],
      );
      set({
        status,
        library,
        queue,
        settings,
        diagnostics,
        connected: true,
        connectionError: null,
      });
    } catch (error) {
      set({ connected: false, connectionError: errorMessage(error) });
    }
  },
  poll: async () => {
    if (!get().connected) return get().refresh();
    try {
      const status = await api<BroadcastStatus>("/api/status");
      set({ status, connected: true, connectionError: null });
    } catch (error) {
      set({ connected: false, connectionError: errorMessage(error) });
    }
  },
}));

import { isTauri } from "@tauri-apps/api/core";
import Studio from "@/components/Studio";
import RelayAdmin from "@/components/RelayAdmin";

export default function HomeEntry() {
  if (typeof window !== "undefined" && isTauri()) {
    return <Studio />;
  }
  return <RelayAdmin />;
}

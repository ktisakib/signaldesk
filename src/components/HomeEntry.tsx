import { useEffect, useState } from "react";
import { isTauri } from "@/lib/api";
import Studio from "@/components/Studio";
import RelayAdmin from "@/components/RelayAdmin";

export default function HomeEntry() {
  const [inTauri, setInTauri] = useState(isTauri);

  useEffect(() => {
    if (!inTauri && isTauri()) {
      setInTauri(true);
    }
  }, [inTauri]);

  if (inTauri) {
    return <Studio />;
  }
  return <RelayAdmin />;
}

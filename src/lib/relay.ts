export interface RelayProfile {
  format: "signaldesk-connection-v1";
  channelName: string;
  host: string;
  port: number;
  viewerUrl: string;
  streamKey: string;
}

export function readRelayProfile(text: string): Omit<RelayProfile, "format"> {
  if (text.length > 8192) throw new Error("Connection profile is too large.");
  const value = JSON.parse(text) as RelayProfile | null;
  if (
    !value ||
    value.format !== "signaldesk-connection-v1" ||
    ![value.channelName, value.host, value.viewerUrl, value.streamKey].every(
      (v) => typeof v === "string" && v.length > 0,
    ) ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535
  )
    throw new Error(
      "Choose a SignalDesk connection profile from the relay administrator.",
    );
  const { channelName, host, port, viewerUrl, streamKey } = value;
  return { channelName, host, port, viewerUrl, streamKey };
}

export function downloadRelayProfile(profile: RelayProfile) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(profile, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${profile.channelName}.connection.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

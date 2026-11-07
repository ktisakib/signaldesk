import { useEffect, useRef, useState, type SubmitEvent } from "react";
import { Layers, ImagePlus, Radio, Square, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, errorMessage } from "@/lib/api";
import { useStudio } from "@/lib/store";
interface Graphics {
  enabled: boolean;
  lowerThirdEnabled: boolean;
  lowerTitle: string;
  lowerSubtitle: string;
  tickerEnabled: boolean;
  bannerLabel: string;
  tickerText: string;
  tickerSpeed: number;
  logoEnabled: boolean;
  logoCorner: "left" | "right";
  logoWidth: number;
  logoDataUrl: string | null;
  accent: string;
}
const defaults: Graphics = {
  enabled: false,
  lowerThirdEnabled: false,
  lowerTitle: "Presenter name",
  lowerSubtitle: "Correspondent",
  tickerEnabled: false,
  bannerLabel: "BREAKING NEWS",
  tickerText:
    "Enter the latest headlines, announcements or job advertisements here.",
  tickerSpeed: 85,
  logoEnabled: false,
  logoCorner: "right",
  logoWidth: 120,
  logoDataUrl: null,
  accent: "#e32636",
};
export default function BroadcastGraphics() {
  const { connected, status } = useStudio();
  const [draft, setDraft] = useState(defaults),
    [saved, setSaved] = useState(defaults),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [preview, setPreview] = useState("");
  const pending = useRef(false);
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    void api<Graphics>("/api/graphics/config")
      .then((c) => {
        if (!cancelled) {
          setDraft(c);
          setSaved(c);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      });
    async function poll() {
      try {
        const p = await api<{ image: string; error: string | null }>(
          "/api/graphics/preview",
        );
        if (!cancelled) {
          setPreview(p.image);
          if (p.error) setError(p.error);
        }
      } catch {
        /* Connection state is displayed by the studio. */
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 120);
    }
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [connected]);
  function change<K extends keyof Graphics>(key: K, value: Graphics[K]) {
    setDraft((c) => ({ ...c, [key]: value }));
    setNotice("");
  }
  async function apply(config: Graphics, message: string) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const c = await api<Graphics>("/api/graphics/config", "PUT", config);
      setSaved(c);
      setDraft(c);
      setNotice(message);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    void apply(
      { ...draft, enabled: true },
      "Graphics applied. The local stream, relay and YouTube use the same picture.",
    );
  }
  async function logo(file: File | undefined) {
    if (!file) return;
    setError("");
    if (file.type !== "image/png" || file.size > 2 * 1024 ** 2) {
      setError(
        "Choose a PNG logo up to 2 MiB, no larger than 1024 × 1024 pixels.",
      );
      return;
    }
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () =>
          reject(new Error("Cannot read the selected logo"));
        reader.readAsDataURL(file);
      });
      setDraft((c) => ({ ...c, logoDataUrl: data, logoEnabled: true }));
      setNotice("Logo selected. Apply graphics to send it to the stream.");
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const disabled = !connected || !loaded || busy;
  return (
    <form onSubmit={submit} className="graphics-workspace">
      <section className="panel graphics-monitor">
        <div className="panel-heading">
          <div className="section-title">
            <h2>
              <Layers size={18} /> Program graphics
            </h2>
            <span>
              {saved.enabled ? "Graphics enabled" : "Graphics off"} ·{" "}
              {status?.state === "live"
                ? "Stream is live"
                : "Ready for your next broadcast"}
            </span>
          </div>
          <span className="pill">1280 × 720</span>
        </div>
        <div
          className="graphics-preview"
          aria-label="Applied broadcast graphics preview"
        >
          <div className="graphics-preview-slate">
            PROGRAM / GRAPHICS PREVIEW
          </div>
          {preview && (
            <img
              src={preview}
              alt="Applied lower third, animated news ticker and channel logo"
            />
          )}
        </div>
        <div className="graphics-toolbar">
          <Button
            type="submit"
            disabled={
              disabled ||
              (!draft.lowerThirdEnabled &&
                !draft.tickerEnabled &&
                !draft.logoEnabled)
            }
          >
            <Radio size={15} />
            {busy
              ? "Applying…"
              : saved.enabled
                ? "Update on-air graphics"
                : "Take graphics to air"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={disabled || !saved.enabled}
            onClick={() =>
              void apply(
                { ...saved, enabled: false },
                "All graphics hidden. The broadcast continues.",
              )
            }
          >
            <Square size={14} />
            Hide all graphics
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={disabled || !dirty}
            onClick={() => {
              setDraft(saved);
              setError("");
              setNotice("Draft changes discarded.");
            }}
          >
            Discard edits
          </Button>
          <span>{dirty ? "Unapplied changes" : "Saved on this computer"}</span>
        </div>
        <p className="graphics-hint">
          Edits stay in the form until applied. The preview shows applied
          graphics; they are burned into all stream outputs. Closing the
          dashboard leaves graphics running.
        </p>
        {error && (
          <p role="alert" className="form-error graphics-feedback">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="graphics-feedback">
            {notice}
          </p>
        )}
      </section>
      <div className="graphics-controls">
        <section className="panel graphics-control">
          <div className="graphics-section-heading">
            <h2>Lower third</h2>
            <Switch
              aria-label="Include lower third"
              checked={draft.lowerThirdEnabled}
              disabled={disabled}
              onCheckedChange={(v) => change("lowerThirdEnabled", v)}
            />
          </div>
          <p>
            An animated nameplate for presenters, guests or programme titles.
          </p>
          <label htmlFor="lower-title">Title or presenter name</label>
          <Input
            id="lower-title"
            value={draft.lowerTitle}
            maxLength={90}
            disabled={disabled}
            onChange={(e) => change("lowerTitle", e.target.value)}
          />
          <label htmlFor="lower-subtitle">Subtitle or role</label>
          <Input
            id="lower-subtitle"
            value={draft.lowerSubtitle}
            maxLength={150}
            disabled={disabled}
            onChange={(e) => change("lowerSubtitle", e.target.value)}
          />
        </section>
        <section className="panel graphics-control">
          <div className="graphics-section-heading">
            <h2>News ticker & banner</h2>
            <Switch
              aria-label="Include news ticker"
              checked={draft.tickerEnabled}
              disabled={disabled}
              onCheckedChange={(v) => change("tickerEnabled", v)}
            />
          </div>
          <p>
            A continuously scrolling headline strip with your own banner label.
          </p>
          <label htmlFor="banner-label">Banner label</label>
          <Input
            id="banner-label"
            value={draft.bannerLabel}
            maxLength={32}
            placeholder="BREAKING NEWS, JOBS, ANNOUNCEMENTS…"
            disabled={disabled}
            onChange={(e) => change("bannerLabel", e.target.value)}
          />
          <label htmlFor="ticker-text">Scrolling text</label>
          <textarea
            id="ticker-text"
            className="graphics-textarea"
            rows={4}
            maxLength={2000}
            value={draft.tickerText}
            disabled={disabled}
            onChange={(e) =>
              change("tickerText", e.target.value.replace(/[\r\n]+/g, " • "))
            }
          />
          <label htmlFor="ticker-speed">
            Scroll speed · {draft.tickerSpeed} pixels/second
          </label>
          <Input
            id="ticker-speed"
            type="range"
            min={30}
            max={180}
            value={draft.tickerSpeed}
            disabled={disabled}
            onChange={(e) => change("tickerSpeed", Number(e.target.value))}
          />
        </section>
        <section className="panel graphics-control">
          <div className="graphics-section-heading">
            <h2>
              <ImagePlus size={18} /> Channel logo
            </h2>
            <Switch
              aria-label="Include channel logo"
              checked={draft.logoEnabled}
              disabled={disabled || !draft.logoDataUrl}
              onCheckedChange={(v) => change("logoEnabled", v)}
            />
          </div>
          <p>
            Transparent PNG recommended. Up to 2 MiB and 1024 × 1024 pixels.
          </p>
          <label htmlFor="channel-logo">
            <Upload size={14} /> Choose a channel logo
          </label>
          <Input
            id="channel-logo"
            type="file"
            accept="image/png"
            disabled={disabled}
            onChange={(e) => void logo(e.target.files?.[0])}
          />
          {draft.logoDataUrl && (
            <div className="graphics-logo-preview">
              <img src={draft.logoDataUrl} alt="Selected channel logo" />
              <Button
                type="button"
                variant="outline"
                disabled={disabled}
                onClick={() =>
                  setDraft((c) => ({
                    ...c,
                    logoDataUrl: null,
                    logoEnabled: false,
                  }))
                }
              >
                <X size={14} />
                Remove logo
              </Button>
            </div>
          )}
          <label htmlFor="logo-corner">Logo corner</label>
          <Select
            value={draft.logoCorner}
            disabled={disabled}
            onValueChange={(v) => change("logoCorner", v as "left" | "right")}
          >
            <SelectTrigger id="logo-corner">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="left">Top left</SelectItem>
              <SelectItem value="right">Top right</SelectItem>
            </SelectContent>
          </Select>
          <label htmlFor="logo-width">
            Logo width · {draft.logoWidth} pixels
          </label>
          <Input
            id="logo-width"
            type="range"
            min={64}
            max={240}
            value={draft.logoWidth}
            disabled={disabled}
            onChange={(e) => change("logoWidth", Number(e.target.value))}
          />
        </section>
        <section className="panel graphics-control">
          <h2>On-air accent</h2>
          <label htmlFor="graphics-accent">Banner and nameplate color</label>
          <Input
            id="graphics-accent"
            type="color"
            value={draft.accent}
            disabled={disabled}
            onChange={(e) => change("accent", e.target.value)}
          />
          <p>
            Use graphics on content you own or have permission to modify. Keep
            the bundled complete-program NASA samples free of overlays.
          </p>
        </section>
      </div>
    </form>
  );
}

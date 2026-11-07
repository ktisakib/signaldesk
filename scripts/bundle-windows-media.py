"""Stage signed MSYS2 tools, their imported DLLs, notices and matching source locations."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

root, runtime = map(Path, sys.argv[1:])
bin_dir = root / "ucrt64/bin"
target = runtime / "bin"
notices = runtime / "licenses/media"
target.mkdir(parents=True, exist_ok=True)
notices.mkdir(parents=True, exist_ok=True)
# Traverse the actual PE imports. Package dependencies also include build-time tools.
pending = [bin_dir / "ffmpeg.exe", bin_dir / "ffprobe.exe"]
shipped = set()
while pending:
    path = pending.pop()
    if path.name.lower() in shipped:
        continue
    shutil.copy2(path, target / path.name)
    shipped.add(path.name.lower())
    imports = subprocess.check_output([bin_dir / "objdump.exe", "-p", path], text=True, errors="replace")
    for name in re.findall(r"DLL Name: (.+)", imports):
        dependency = bin_dir / name.strip()
        if dependency.is_file():
            pending.append(dependency)

sources = {}
owners = set()
for desc in (root / "var/lib/pacman/local").glob("*/desc"):
    installed = (desc.parent / "files").read_text(encoding="utf-8").splitlines()
    owned = {name[11:].lower() for name in installed if name.startswith("ucrt64/bin/")}
    if not owned.intersection(shipped):
        continue
    owners.update(owned.intersection(shipped))
    metadata = dict(re.findall(r"%([A-Z0-9_]+)%\n([^\n]+)", desc.read_text(encoding="utf-8")))
    base = metadata.get("BASE", metadata["NAME"])
    version = metadata["VERSION"].split(":")[-1]
    sources[f"{base}-{version}"] = metadata["NAME"]
    for name in installed:
        if "/share/licenses/" in name and (root / name).is_file():
            out = notices / metadata["NAME"] / name.split("/share/licenses/", 1)[1]
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / name, out)
if shipped != owners:
    raise RuntimeError(f"No signed package owner found for {shipped - owners}")

def fetch(url, path):
    subprocess.run(["curl.exe", "-fsSL", "--retry", "3", "--connect-timeout", "20",
                    "--max-time", "600", "-o", str(path), url], check=True)

with tempfile.TemporaryDirectory() as temp:
    temp = Path(temp)
    mirror = "https://repo.msys2.org/mingw/sources/"
    index = temp / "source-index.html"
    fetch(mirror, index)
    names = set(re.findall(r'href="([^"]+)"', index.read_text(encoding="utf-8")))
    lines = ["Matching source archives and build recipes for the bundled Windows media programs and DLLs:"]
    for base in sorted(sources):
        archive = next((base + suffix for suffix in (".src.tar.zst", ".src.tar.xz", ".src.tar.gz") if base + suffix in names), None)
        if not archive:
            raise RuntimeError(f"Missing matching source archive for {base} ({sources[base]})")
        lines.append(mirror + archive)
    tool = next(t for t in json.loads(Path(__file__).with_name("runtime-downloads.json").read_text()) if t["name"] == "mediamtx")
    archive = temp / tool["fileName"]
    fetch(tool["url"], archive)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != tool["sha256"]:
        raise RuntimeError("MediaMTX release checksum mismatch")
    with zipfile.ZipFile(archive) as z:
        for name in ("mediamtx.exe", "LICENSE"):
            with z.open(name) as src, ((target / name) if name.endswith(".exe") else (notices / "MediaMTX-LICENSE")).open("wb") as dst:
                shutil.copyfileobj(src, dst)
    lines.append(tool["source"])
    (notices / "MEDIA-SOURCES.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
print(f"Bundled {len(shipped)} FFmpeg programs and DLLs plus MediaMTX.", flush=True)

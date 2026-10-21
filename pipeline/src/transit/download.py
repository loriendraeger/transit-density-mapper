"""Fetch sources.toml entries into data/raw/. Skips files that already exist unless
forced, since some downloads are large and upstream files change daily."""

import shutil
import subprocess
import urllib.request
import zipfile
from pathlib import Path

from . import config


def run(cmd: list[str]) -> None:
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)


def _fetch(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    print(f"GET {url}", flush=True)
    with urllib.request.urlopen(url) as resp, open(tmp, "wb") as out:
        shutil.copyfileobj(resp, out)
    tmp.rename(dest)


def download_source(name: str, src: dict, force: bool = False) -> None:
    path = config.REPO / src["local_path"]
    method = src.get("fetch", "manual")
    if path.exists() and not force:
        print(f"[{name}] {src['local_path']} exists; skipping (use --force to refetch)")
        return
    if method == "manual":
        raise SystemExit(f"[{name}] download by hand into {src['local_path']}: {src['url']}")
    if method == "http":
        _fetch(src["url"], path)
    elif method == "zip":
        # local_path is the extracted file or directory; the zip lands next to it.
        target = path if path.suffix == "" else path.parent
        archive = path.parent / Path(src["url"]).name
        _fetch(src["url"], archive)
        with zipfile.ZipFile(archive) as z:
            z.extractall(target)
    elif method == "arcgis":
        path.parent.mkdir(parents=True, exist_ok=True)
        path.unlink(missing_ok=True)
        # The ESRIJSON driver pages through the service (resultOffset) on its own.
        url = f"{src['url']}/query?where=1%3D1&outFields=*&f=json&outSR=4326"
        run(["ogr2ogr", "-f", "GPKG", str(path), url, "-nln", src["table"]])
    else:
        raise SystemExit(f"[{name}] unknown fetch method {method!r}")


def download(names: list[str] | None = None, force: bool = False) -> None:
    sources = config.sources()
    default = [
        n
        for n, s in sources.items()
        if s.get("fetch", "manual") != "manual" and s.get("purpose") != "validation"
    ]
    for name in names or default:
        download_source(name, sources[name], force)

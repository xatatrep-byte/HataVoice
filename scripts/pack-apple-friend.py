"""Packs HataVoice for a friend with a Mac (and an iPhone): a zip with one folder, HataVoice, that holds

    Инструкция.html               what to do, step by step (packaging/apple-friend/instructions.html)
    Собрать для Mac.command       builds the Mac app and puts it into Applications
    Собрать для iPhone.command    builds the iPhone app and puts it on the connected iPhone
    src/                          the source, as committed

Nothing can be built for Apple off a Mac, so the friend's Mac builds it (packaging/apple-friend/*.sh). The source is
`git archive HEAD`: what is ignored (the keys in vendor/, target/, node_modules/) cannot get in. Docs, CI and editor
settings are left out as of no use there. The zip is written by hand so that the scripts keep their execute bit and
the Russian names are marked as UTF-8: Archive Utility on a Mac reads both.

    python scripts/pack-apple-friend.py [output.zip]
"""

import io
import json
import subprocess
import sys
import tarfile
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HERE = ROOT / "packaging" / "apple-friend"
TOP = "HataVoice"
LEAVE_OUT = ("docs/", ".github/", ".claude/")
EXTRAS = {
    "Инструкция.html": (HERE / "instructions.html", 0o644),
    "Собрать для Mac.command": (HERE / "mac.command", 0o755),
    "Собрать для iPhone.command": (HERE / "iphone.command", 0o755),
}


def unix_entry(name: str, mode: int, mtime: float) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=time.localtime(max(mtime, 315532800))[:6])
    info.create_system = 3  # Unix, so the mode below counts
    info.external_attr = (0o100000 | mode) << 16
    info.compress_type = zipfile.ZIP_DEFLATED
    return info


def committed_tree() -> tarfile.TarFile:
    status = subprocess.run(["git", "-C", str(ROOT), "status", "--porcelain"], check=True, capture_output=True, text=True)
    if status.stdout.strip():
        print("Внимание: есть незакоммиченные изменения, в архив попадёт только закоммиченное.", file=sys.stderr)
    # As stored, with LF: autocrlf (on for Windows) would turn the scripts into CRLF, which bash on a Mac cannot run.
    data = subprocess.run(
        ["git", "-c", "core.autocrlf=false", "-C", str(ROOT), "archive", "--format=tar", "HEAD"],
        check=True,
        capture_output=True,
    ).stdout
    return tarfile.open(fileobj=io.BytesIO(data))


def must_be_lf(name: str, body: bytes) -> None:
    if name.endswith((".sh", ".command", ".patch")) and b"\r\n" in body:
        sys.exit(f"{name}: переводы строк Windows (CRLF), на Маке так не запустится")


def main() -> None:
    version = json.loads((ROOT / "client" / "package.json").read_text(encoding="utf-8"))["version"]
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "dist" / f"HataVoice-{version}-Mac-iPhone.zip"
    out.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with zipfile.ZipFile(out, "w", compresslevel=9) as zf:
        for name, (path, mode) in EXTRAS.items():
            body = path.read_bytes().replace(b"\r\n", b"\n")
            zf.writestr(unix_entry(f"{TOP}/{name}", mode, path.stat().st_mtime), body)
        with committed_tree() as tar:
            for member in tar:
                if not member.isfile() or member.name.startswith(LEAVE_OUT):
                    continue
                mode = 0o755 if member.mode & 0o111 or member.name.endswith((".sh", ".command")) else 0o644
                body = tar.extractfile(member).read()
                must_be_lf(member.name, body)
                zf.writestr(unix_entry(f"{TOP}/src/{member.name}", mode, member.mtime), body)
                count += 1
    print(f"{out} — {count} файлов исходников, {out.stat().st_size / 1e6:.1f} МБ")


if __name__ == "__main__":
    main()

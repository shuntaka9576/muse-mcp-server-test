"""Reproducible ZIP preserving the Python executable's permissions."""
import sys
import zipfile
from pathlib import Path

source, destination = map(Path, sys.argv[1:])
with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for file in sorted(source.rglob("*")):
        if not file.is_file() or "__pycache__" in file.parts:
            continue
        entry = zipfile.ZipInfo(file.relative_to(source).as_posix(), (2026, 1, 1, 0, 0, 0))
        entry.external_attr = (file.stat().st_mode & 0xFFFF) << 16
        entry.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(entry, file.read_bytes())
print(f"Packaged {destination.stat().st_size // 1024 // 1024} MiB")

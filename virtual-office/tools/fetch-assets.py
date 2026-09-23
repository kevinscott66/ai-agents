"""Development-only source fetch; shipped app never contacts asset providers."""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((ROOT / 'assets/manifest.json').read_text())
SOURCE = ROOT / '.runtime/source-assets'
SOURCE.mkdir(parents=True, exist_ok=True)

for entry in MANIFEST['sourceFiles']:
    target = SOURCE / entry['file']
    if not target.exists():
        subprocess.run(['curl', '--fail', '--location', '--retry', '2', entry['url'], '-o', str(target)], check=True)
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    if digest != entry['sha256']:
        raise SystemExit(f'Checksum mismatch: {target.name}; remove the partial download and retry')
    print(target.name, target.stat().st_size)

for asset in MANIFEST['assets']:
    if 'downloadUrl' not in asset:
        continue
    target = ROOT / 'web/public' / asset['path'].lstrip('/')
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        subprocess.run(['curl', '--fail', '--location', '--retry', '2', asset['downloadUrl'], '-o', str(target)], check=True)
    if hashlib.sha256(target.read_bytes()).hexdigest() != asset['sha256']:
        raise SystemExit(f'Checksum mismatch: {target.name}')
    print(target.name, target.stat().st_size)

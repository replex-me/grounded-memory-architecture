"""공개 배포 전에 스키마·예제·참조 검사·문서 링크를 로컬에서 확인한다."""
import json
import re
import subprocess
import sys
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from reference.model import Invalid, validate

for path in (ROOT / "schema").glob("*.json"):
    Draft202012Validator.check_schema(json.loads(path.read_text()))
validate(json.loads((ROOT / "examples/snapshot.json").read_text()))
try:
    validate(json.loads((ROOT / "examples/invalid-input-link.json").read_text()))
except Invalid:
    pass
else:
    raise SystemExit("금지된 입력 간 연결을 허용했다")
for path in ROOT.rglob("*.md"):
    if ".venv" in path.parts:
        continue
    for target in re.findall(r"\]\(([^\s)]+)\)", path.read_text()):
        if "://" not in target and not target.startswith("#") and not (path.parent / target.split("#")[0]).exists():
            raise SystemExit(f"없는 문서 링크: {path.name}: {target}")
subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"], cwd=ROOT, check=True)
subprocess.run(["node", "--test", *[str(p.relative_to(ROOT)) for p in sorted((ROOT / "runtime").glob("*.test.mjs"))]], cwd=ROOT, check=True)
subprocess.run(["node", "examples/persistent-demo.mjs"], cwd=ROOT, check=True)
print("스키마·예제·문서 링크·참조 전이·영속 코어·재시작 예제 검사 통과")

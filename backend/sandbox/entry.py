import json
import os
import sys
from pathlib import Path


request = json.load(sys.stdin)
for file in request["files"]:
    path = Path(file["path"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(file["content"], encoding="utf-8", newline="")

entry = "./" + request["files"][0]["path"]
language = request["language"]
if language == "html":
    test_file = Path("/tmp/roundtable-test.js")
    test_file.write_text(request.get("test") or "", encoding="utf-8")
    os.execvp("node", ["node", "/opt/runner/html.cjs", entry, str(test_file)])
command = "python" if language == "python" else "node"
os.execvp(command, [command, entry])

import asyncio

import pytest

from app.config import Settings
from app.sandbox import LABEL, Sandbox, control
from app.schemas import RunInput

pytestmark = [pytest.mark.docker, pytest.mark.asyncio]


async def runner(timeout=20):
    sandbox = Sandbox(Settings(":memory:", "TABLE2", sandbox_enabled=True, sandbox_timeout=timeout))
    await sandbox.probe()
    assert sandbox.available, sandbox.reason
    return sandbox


def request(language, path, code, **kwargs):
    return RunInput(language=language, files=[{"path": path, "content": code}], **kwargs)


@pytest.mark.parametrize("language,path,code,test", [
    ("python", "main.py", "import pytest; print(7)", None),
    ("node", "main.js", "console.log(7)", None),
    ("html", "site/play.html",
     "<h1>7</h1><script>localStorage.setItem('score','7'); console.warn('page log'); "
     "setTimeout(() => { throw Error('page error') }, 10);</script>",
     "await sleep(100); console.log(await page.evaluate(() => localStorage.getItem('score')));"),
])
async def test_languages(language, path, code, test):
    sandbox = await runner()
    outcome = await sandbox.run(request(language, path, code, test=test), lambda: None)
    assert outcome["status"] == "ok", outcome
    assert outcome["stdout"].strip() == "7"
    if language == "html":
        assert {"level": "warn", "text": "page log"} in outcome["console"]
        assert outcome["page_errors"] == ["page error"]


async def container_names():
    code, names = await control("ps", "-a", "--filter", f"label={LABEL}", "--format", "{{.Names}}")
    assert code == 0
    return set(names.splitlines())


async def test_timeout_deletes_container():
    sandbox = await runner(timeout=3)
    before = await container_names()
    outcome = await sandbox.run(request("python", "main.py", "import time; time.sleep(30)"), lambda: None)
    assert outcome["status"] == "timeout", outcome
    assert await container_names() == before


async def test_cancellation_deletes_running_container():
    sandbox = await runner()
    before = await container_names()
    task = asyncio.create_task(sandbox.run(request("python", "main.py", "import time; time.sleep(30)"), lambda: None))
    try:
        async with asyncio.timeout(10):
            while await container_names() == before:
                await asyncio.sleep(0.1)
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert await container_names() == before


async def test_network_and_root_filesystem_are_isolated():
    code = """
import errno
import os
import socket

assert os.getuid() == 10001
try:
    socket.create_connection(('198.51.100.1', 80), timeout=1)
except OSError:
    print('no network')
else:
    raise AssertionError('network reachable')
try:
    open('/rootfs-probe', 'w')
except OSError as exc:
    assert exc.errno == errno.EROFS
    print('read-only root')
else:
    raise AssertionError('root is writable')
"""
    sandbox = await runner()
    outcome = await sandbox.run(request("python", "main.py", code), lambda: None)
    assert outcome["status"] == "ok", outcome
    assert outcome["stdout"].splitlines() == ["no network", "read-only root"]

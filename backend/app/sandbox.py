"""Run room submissions in disposable, resource-limited containers."""

import asyncio
import json
import re
from contextlib import suppress
from pathlib import PurePosixPath
from time import monotonic
from uuid import uuid4

from .schemas import RunInput

LANGUAGES = ["python", "node", "html"]
PREFIX = "ai-roundtable-sandbox-"
LABEL = "io.ai-roundtable.sandbox=true"
PROXY_ENV = ("HTTP_PROXY", "HTTPS_PROXY", "FTP_PROXY", "NO_PROXY", "ALL_PROXY")
FILE_LIMIT = 200_000
OUTPUT_LIMIT = 8_000
PROBE_INTERVAL = 30
TOOL = {
    "type": "function",
    "function": {
        "name": "run_code",
        "description": "在隔离环境中运行 Python、Node.js 或 HTML，并返回验证结果。",
        "parameters": {
            "type": "object",
            "properties": {
                "language": {"type": "string", "enum": LANGUAGES},
                "files": {"type": "array", "items": {
                    "type": "object",
                    "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
                    "required": ["path", "content"],
                }},
                "test": {"type": "string", "description": "仅 HTML，可选的 Playwright 测试脚本。Python 和 Node 请省略或留空。"},
            },
            "required": ["language", "files"],
        },
    },
}


def clip(text, maximum):
    if len(text) <= maximum:
        return text
    middle = "\n…输出已截断…\n"
    half = (maximum - len(middle)) // 2
    return text[:half] + middle + text[-half:]


def result(status, *, stderr="", exit_code=None, duration_ms=None, **fields):
    return dict(status=status, exit_code=exit_code, stdout="", stderr=stderr, console=[],
                page_errors=[], truncated=False, duration_ms=duration_ms) | fields


def file_error(request: RunInput):
    if not 1 <= len(request.files) <= 20:
        return "文件数量必须为 1–20"
    paths = set()
    for file in request.files:
        name = file.path
        parts = name.split("/")
        if (not name or ".." in name or re.search(r'[\\:\x00-\x1f\x7f]', name)
                or any(part in {"", "."} for part in parts)):
            return f"文件路径无效：{clip(name, 200)}"
        if name in paths:
            return f"文件路径重复：{clip(name, 200)}"
        paths.add(name)
    if any(str(parent) in paths for name in paths for parent in PurePosixPath(name).parents):
        return "文件与目录路径冲突"
    try:
        size = sum(len(file.content.encode("utf-8")) for file in request.files)
        size += len((request.test or "").encode("utf-8"))
        for name in paths:
            encoded = name.encode("utf-8")
            if len(encoded) > 4090 or any(len(part) > 255 for part in encoded.split(b"/")):
                return "文件路径太长"
    except UnicodeEncodeError:
        return "文件路径、内容和测试必须是有效的 UTF-8"
    if size > FILE_LIMIT:
        return "文件及测试脚本合计不能超过 200 KB"
    if request.test is not None and request.language != "html":
        return "仅 HTML 支持 test"
    return None


def summary(request, outcome):
    states = {"timeout": "超时", "cancelled": "已取消", "unavailable": "环境不可用", "error": "运行失败"}
    code = outcome["exit_code"]
    status = f"退出码 {code}" if code is not None else states.get(outcome["status"], outcome["status"])
    duration = outcome["duration_ms"]
    entry = request.files[0].path if request.files else "（无入口）"
    text = f"运行 {request.language} {clip(entry, 240)}：{status}"
    if duration is not None:
        text += f"，用时 {duration / 1000:g} 秒"
    log = "\n".join(filter(None, [outcome["stdout"], outcome["stderr"], *outcome["page_errors"],
                                  *(item["text"] for item in outcome["console"])]))
    if log:
        log = clip(log, 2000)
        fence = "`" * max(3, max((len(group) + 1 for group in re.findall(r"`+", log)), default=0))
        text += f"\n{fence}text\n{log}\n{fence}"
    return text


async def docker(*args, **kwargs):
    try:
        return await asyncio.create_subprocess_exec("docker", *args, **kwargs)
    except NotImplementedError as exc:
        raise OSError("当前事件循环不支持 Docker 子进程") from exc


async def control(*args):
    process = await docker(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    try:
        stdout, _ = await asyncio.wait_for(process.communicate(), 10)
        return process.returncode, stdout.decode("utf-8", errors="replace").strip()
    except (TimeoutError, asyncio.CancelledError):
        with suppress(ProcessLookupError):
            process.kill()
        await process.wait()
        raise


async def read_output(reader, maximum):
    buffer = bytearray()
    half = maximum // 2
    truncated = False
    while chunk := await reader.read(8192):
        buffer.extend(chunk)
        if len(buffer) > maximum:
            del buffer[half:-half]
            truncated = True
    return buffer.decode("utf-8", errors="replace"), truncated


class Sandbox:
    def __init__(self, settings):
        self.enabled = settings.sandbox_enabled
        self.timeout = settings.sandbox_timeout
        self.turn_limit = settings.sandbox_max_runs_per_turn
        self.image = settings.sandbox_image
        self.memory = settings.sandbox_memory
        self.slots = asyncio.Semaphore(settings.sandbox_max_parallel)
        self.people: dict[str, asyncio.Task] = {}
        self.probe_lock = asyncio.Lock()
        self.last_probe = float("-inf")
        self.reason = "沙箱未启用" if not self.enabled else "沙箱尚未检测"

    @property
    def available(self):
        return self.enabled and self.reason is None

    def initial_state(self, request):
        if self.available and not self.slots.locked() and not file_error(request):
            return "running"
        return "queued"

    def status(self):
        return dict(enabled=self.enabled, available=self.available,
                    languages=list(LANGUAGES) if self.available else [], reason=self.reason)

    async def refresh(self):
        if self.enabled and not self.available:
            await self.probe(if_stale=True)

    async def probe(self, *, if_stale=False, after_failure=False):
        if not self.enabled:
            return
        async with self.probe_lock:
            if if_stale and (self.available or monotonic() - self.last_probe < PROBE_INTERVAL):
                return
            await self.detect()
            if after_failure and self.available:
                self.reason = "Docker 无法创建或启动沙箱容器"
            self.last_probe = monotonic()

    async def detect(self):
        try:
            if (await control("version", "--format", "{{.Server.Version}}"))[0]:
                self.reason = "Docker 未启动或无法连接"
            elif (await control("image", "inspect", "--", self.image))[0]:
                self.reason = f"沙箱镜像 {self.image} 未构建"
            else:
                self.reason = None
        except FileNotFoundError:
            self.reason = "没有找到 Docker"
        except (OSError, TimeoutError):
            self.reason = "无法连接 Docker"

    async def start(self):
        await self.probe()
        if not self.enabled:
            return
        with suppress(OSError, TimeoutError):
            status, names = await control("ps", "-a", "--filter", f"label={LABEL}", "--format", "{{.Names}}")
            if not status:
                for name in names.splitlines():
                    if name.startswith(PREFIX):
                        await self.cleanup(name)

    async def cleanup(self, name):
        with suppress(OSError, TimeoutError):
            await control("kill", name)
        with suppress(OSError, TimeoutError):
            await control("rm", "-f", "-v", name)

    async def run(self, request, on_start):
        if reason := file_error(request):
            return result("error", stderr=reason)
        async with self.slots:
            await self.refresh()
            if not self.available:
                return result("unavailable", stderr=f"运行环境不可用：{self.reason}")
            on_start()
            return await self.execute(request)

    async def execute(self, request):
        name = PREFIX + uuid4().hex
        started = monotonic()
        process = None
        # Docker can inject proxy settings from the local CLI configuration.
        proxy_options = [item for key in PROXY_ENV for spelling in (key, key.lower())
                         for item in ("--env", f"{spelling}=")]
        create = asyncio.create_task(control(
            "create", "-i", "--rm", "--name", name, "--label", LABEL, *proxy_options,
            "--network", "none", "--read-only", "--tmpfs", "/work:rw,nosuid,nodev,size=64m,uid=10001,gid=10001",
            "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m,mode=1777",
            "--user", "10001:10001", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--memory", self.memory, "--memory-swap", self.memory, "--cpus", "1", "--pids-limit", "128",
            "--log-driver", "none", "--pull", "never", "--", self.image,
        ))
        try:
            async with asyncio.timeout(self.timeout):
                if (await asyncio.shield(create))[0]:
                    return await self.failed()
                process = await docker("start", "-ai", name, stdin=asyncio.subprocess.PIPE,
                                       stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)

                async def send():
                    with suppress(BrokenPipeError, ConnectionResetError):
                        payload = request.model_dump(include={"language", "files", "test"})
                        process.stdin.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
                        await process.stdin.drain()
                    process.stdin.close()

                async with asyncio.TaskGroup() as tasks:
                    tasks.create_task(send())
                    stdout = tasks.create_task(read_output(process.stdout, 512_000 if request.language == "html" else 32_000))
                    stderr = tasks.create_task(read_output(process.stderr, 32_000))
                code = await process.wait()
            if code and not (await self.docker_alive()):
                return await self.failed()
            return decode_result(request.language, code, stdout.result(), stderr.result(),
                                 int((monotonic() - started) * 1000))
        except TimeoutError:
            return result("timeout", duration_ms=int((monotonic() - started) * 1000))
        except OSError:
            return await self.failed()
        finally:
            # Creation must settle before cleanup, otherwise a cancelled CLI can leave a new container.
            with suppress(OSError, TimeoutError):
                await create
            await self.cleanup(name)
            if process is not None and process.returncode is None:
                with suppress(ProcessLookupError):
                    process.kill()
                await process.communicate()

    async def docker_alive(self):
        try:
            return (await control("version", "--format", "{{.Server.Version}}"))[0] == 0
        except (OSError, TimeoutError):
            return False

    async def failed(self):
        await self.probe(after_failure=True)
        return result("unavailable", stderr=f"运行环境不可用：{self.reason}")


def decode_result(language, code, stdout, stderr, duration):
    out, clipped_out = stdout
    err, clipped_err = stderr
    fields = {}
    if language == "html":
        try:
            if clipped_out:
                raise ValueError
            fields = json.loads(out)
            if not isinstance(fields, dict):
                raise ValueError
            out, err = fields["stdout"], fields["stderr"] + err
            if not isinstance(out, str):
                raise ValueError
        except (ValueError, TypeError, KeyError):
            code = code or 1
            out, fields = "", {}
            err = err or "HTML 运行器未返回有效结果"
    console = fields.get("console", [])
    errors = fields.get("page_errors", [])
    console = [item for item in console if isinstance(item, dict) and isinstance(item.get("text"), str)
               and item.get("level") in ("log", "info", "warn", "error")] if isinstance(console, list) else []
    errors = [item for item in errors if isinstance(item, str)] if isinstance(errors, list) else []
    truncated = (clipped_out or clipped_err or fields.get("truncated") is True
                 or len(console) > 200 or len(errors) > 200
                 or any(len(item) > OUTPUT_LIMIT for item in [out, err, *errors, *(line["text"] for line in console)]))
    return result("error" if code else "ok", exit_code=code, duration_ms=duration,
                  stdout=clip(out, OUTPUT_LIMIT), stderr=clip(err, OUTPUT_LIMIT),
                  console=[dict(level=line["level"], text=clip(line["text"], OUTPUT_LIMIT)) for line in console[:200]],
                  page_errors=[clip(item, OUTPUT_LIMIT) for item in errors[:200]], truncated=truncated)


class FakeSandbox(Sandbox):
    async def detect(self):
        if self.enabled:
            self.reason = None

    async def start(self):
        await self.probe()

    async def execute(self, request):
        await asyncio.sleep(0)
        code = request.files[0].content
        if "while True" in code:
            return result("timeout", duration_ms=self.timeout * 1000)
        if "raise" in code:
            return result("error", exit_code=1, stderr="模拟异常", duration_ms=1)
        return result("ok", exit_code=0, stdout="模拟运行成功", duration_ms=1)

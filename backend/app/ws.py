from contextlib import suppress
from json import JSONDecodeError
from typing import Annotated

from anyio import create_task_group
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import Field, TypeAdapter, ValidationError

from .auth import COOKIE, get_session
from .room import Room
from .schemas import Action, Hello, RunEvent, Say, Steer


ws = APIRouter()
client_event = TypeAdapter(Annotated[Say | Steer | RunEvent | Action, Field(discriminator="type")])


def error(code, message):
    return dict(type="error", code=code, message=message)


async def send_events(socket, queue):
    while (event := await queue.get()) is not None:
        await socket.send_json(event)
    await socket.close(code=4404)


async def receive_events(socket, runtime, queue, user):
    while True:
        try:
            event = client_event.validate_python(await socket.receive_json())
        except (JSONDecodeError, ValidationError, KeyError, TypeError):
            queue.put_nowait(error("invalid_event", "消息格式无效"))
            continue
        if result := runtime.handle(user, event):
            queue.put_nowait(error(*result))


@ws.websocket("/ws/rooms/{room_id}")
async def room_socket(socket: WebSocket, room_id: str):
    await socket.accept()
    state = socket.app.state
    user = get_session(state.db, socket.cookies.get(COOKIE))
    if user is None:
        await socket.close(code=4401)
        return
    record = state.db.get("rooms", room_id)
    runtime = state.rooms.get(room_id)
    if record is None or (runtime and runtime.deleting):
        await socket.close(code=4404)
        return
    while True:
        try:
            hello = Hello.model_validate(await socket.receive_json())
            break
        except WebSocketDisconnect:
            return
        except (JSONDecodeError, ValidationError, KeyError, TypeError):
            await socket.send_json(error("invalid_hello", "请先发送有效的 hello"))
    if room_id not in state.rooms:
        record = state.db.get("rooms", room_id)
        if record is None:
            await socket.close(code=4404)
            return
        state.rooms[room_id] = Room(state.db, record, state.llm, state.sandbox, state.settings.tool_models)
    runtime = state.rooms[room_id]
    if runtime.deleting:
        await socket.close(code=4404)
        return
    queue = runtime.join(user, hello.last_seq)
    try:
        async with create_task_group() as tasks:
            async def pump(handler, *args):
                try:
                    with suppress(WebSocketDisconnect, OSError):
                        await handler(*args)
                finally:
                    tasks.cancel_scope.cancel()

            tasks.start_soon(pump, send_events, socket, queue)
            tasks.start_soon(pump, receive_events, socket, runtime, queue, user)
    finally:
        runtime.leave(queue)

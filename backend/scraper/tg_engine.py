#!/usr/bin/env python3
"""
tg_engine.py — Telethon MTProto UserBot engine for Telegram channel archive autoscraping.
Subcommands:
  - check_connection <api_id> <api_hash> <session_string>
  - test_password_script --script <script_file> --message <message_file>
  - scrape_messages <api_id> <api_hash> <session_string> <channel_id> <limit> [--script <script_file>]
  - download_document <api_id> <api_hash> <session_string> <channel_id> <message_id> <dest_path>
"""
import sys
import os
import json
import asyncio
import math
import time
import re
DEFAULT_PASSWORD_SCRIPT = """import re

def extract_password(message_content: str) -> str:
    \"\"\"
    Sample template:
    👻 Password: None
    👻 Password: @HUNTER_CLOUDS
    \"\"\"
    m = re.search(r'(?:👻\\s*)?Password:\\s*([^\\r\\n]+)', message_content, re.IGNORECASE)
    if m:
        pwd = m.group(1).strip()
        if pwd.lower() in ("none", "null", "no", "false", ""):
            return ""
        return pwd
    return ""
"""

def execute_password_script(script_code: str, message_text: str) -> str:
    """Safely executes the user's password extraction script on the message content."""
    scope = {"re": re, "message_content": message_text}
    code = script_code.strip() if script_code and script_code.strip() else DEFAULT_PASSWORD_SCRIPT
    try:
        exec(code, scope)
        # 1. Look for extract_password(text) or Password(self)
        if "extract_password" in scope and callable(scope["extract_password"]):
            res = scope["extract_password"](message_text)
            return str(res).strip() if res else ""
        if "Password" in scope and callable(scope["Password"]):
            # Emulate class self object if defined as def Password(self)
            class MsgContext:
                message_content = message_text
            try:
                res = scope["Password"](MsgContext())
            except TypeError:
                res = scope["Password"](message_text)
            return str(res).strip() if res else ""
    except Exception as e:
        # Fallback regex search
        pass
    m = re.search(r'(?:👻\s*)?Password:\s*([^\r\n]+)', message_text, re.IGNORECASE)
    if m:
        val = m.group(1).strip()
        if val.lower() not in ("none", "null", "false", ""):
            return val
    return ""

async def check_connection(api_id: int, api_hash: str, session_str: str):
    from telethon import TelegramClient
    from telethon.sessions import StringSession
    try:
        client = TelegramClient(StringSession(session_str), api_id, api_hash)
        await client.connect()
        if not await client.is_user_authorized():
            print(json.dumps({"status": "unauthorized", "message": "Session string is invalid or expired"}))
            return
        me = await client.get_me()
        user_data = {
            "id": me.id,
            "username": me.username or "",
            "firstName": me.first_name or "",
            "phone": me.phone or ""
        }
        await client.disconnect()
        print(json.dumps({"status": "ok", "user": user_data}))
    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}))

async def scrape_messages(api_id: int, api_hash: str, session_str: str, channel_target: str, limit: int, script_code: str):
    from telethon import TelegramClient
    from telethon.sessions import StringSession
    try:
        client = TelegramClient(StringSession(session_str), api_id, api_hash)
        await client.connect()
        if not await client.is_user_authorized():
            print(json.dumps({"status": "unauthorized", "message": "Session string is invalid or expired"}))
            return

        # Resolve entity: could be numeric channel id (-100...), username (@channel), or invite link
        entity = channel_target
        if channel_target.startswith("-100"):
            try:
                entity = int(channel_target)
            except ValueError:
                pass
        elif channel_target.isdigit():
            entity = int(channel_target)

        target_channel = await client.get_entity(entity)
        items = []

        async for message in client.iter_messages(target_channel, limit=limit):
            if not message.media or not getattr(message, "file", None):
                continue
            name = message.file.name or ""
            lower_name = name.lower()
            if not (lower_name.endswith(".zip") or lower_name.endswith(".rar") or lower_name.endswith(".7z")):
                continue
            
            caption = message.text or message.message or ""
            resolved_pw = execute_password_script(script_code, caption)
            
            items.append({
                "messageId": message.id,
                "date": message.date.isoformat(),
                "filename": name,
                "sizeBytes": message.file.size or 0,
                "caption": caption,
                "resolvedPassword": resolved_pw,
            })

        await client.disconnect()
        print(json.dumps({"status": "ok", "items": items}))
    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}))

async def parallel_download_document(client, doc, dest_path, progress_callback=None, max_workers=8):
    from telethon import utils
    from telethon.errors import FloodWaitError
    from telethon.network import MTProtoSender
    from telethon.tl.alltlobjects import LAYER
    from telethon.tl.functions import InvokeWithLayerRequest
    from telethon.tl.functions.auth import ExportAuthorizationRequest, ImportAuthorizationRequest
    from telethon.tl.functions.upload import GetFileRequest
    file_size = getattr(doc, "size", 0)
    if file_size <= 0:
        return await client.download_media(doc, file=dest_path, progress_callback=progress_callback)

    dc_id, location = utils.get_input_location(doc)
    dc = await client._get_dc(dc_id)

    # 1. Primary sender: handle cross-DC authentication correctly
    is_cross_dc = (dc_id != client.session.dc_id)
    initial_auth_key = None if is_cross_dc else client.session.auth_key
    sender1 = MTProtoSender(initial_auth_key, loggers=client._log)
    await sender1.connect(client._connection(dc.ip_address, dc.port, dc.id, loggers=client._log))

    if is_cross_dc:
        auth = await client(ExportAuthorizationRequest(dc_id))
        client._init_request.query = ImportAuthorizationRequest(id=auth.id, bytes=auth.bytes)
        await sender1.send(InvokeWithLayerRequest(LAYER, client._init_request))
    else:
        try:
            await sender1.send(InvokeWithLayerRequest(LAYER, client._init_request))
        except Exception:
            pass

    auth_key = sender1.auth_key
    if not auth_key:
        raise RuntimeError(f"Failed to establish MTProto authorization key on DC {dc_id}")

    # 2. Parallel sender connections
    chunk_size = 512 * 1024  # 512 KiB per part (max Telegram chunk)
    total_parts = math.ceil(file_size / chunk_size)
    num_connections = min(max_workers, max(2, total_parts))
    if file_size < 10 * 1024 * 1024:
        num_connections = min(4, total_parts)

    async def make_sender():
        s = MTProtoSender(auth_key, loggers=client._log)
        await s.connect(client._connection(dc.ip_address, dc.port, dc.id, loggers=client._log))
        return s

    additional_senders = await asyncio.gather(*[make_sender() for _ in range(num_connections - 1)])
    all_senders = [sender1] + list(additional_senders)

    os.makedirs(os.path.dirname(os.path.abspath(dest_path)), exist_ok=True)
    with open(dest_path, "wb") as f:
        f.truncate(file_size)

    out_file = open(dest_path, "r+b")

    queue = asyncio.Queue()
    for part in range(total_parts):
        queue.put_nowait(part)

    downloaded = 0
    completed_parts = 0
    lock = asyncio.Lock()
    part_retries = {}
    consecutive_errors = 0
    worker_error = None
    abort_event = asyncio.Event()

    async def worker(sender):
        nonlocal downloaded, completed_parts, consecutive_errors, worker_error
        while completed_parts < total_parts and not abort_event.is_set():
            try:
                part = await asyncio.wait_for(queue.get(), timeout=1.0)
            except asyncio.TimeoutError:
                continue

            offset = part * chunk_size
            # Telegram MTProto specification requires limit to be divisible by 4096 (4 KiB)
            # and between 4096 and 524288 (512 KiB). Passing non-divisible limit raises LimitInvalidError.
            # Telegram automatically returns only the available remaining bytes at end of file.
            limit = chunk_size
            try:
                # Per-chunk timeout to avoid silent network stalls
                res = await asyncio.wait_for(
                    client._call(sender, GetFileRequest(location, offset=offset, limit=limit)),
                    timeout=40.0
                )
                async with lock:
                    out_file.seek(offset)
                    out_file.write(res.bytes)
                    downloaded += len(res.bytes)
                    completed_parts += 1
                    consecutive_errors = 0
                    if progress_callback:
                        progress_callback(downloaded, file_size)
                queue.task_done()
            except FloodWaitError as e:
                await queue.put(part)
                queue.task_done()
                wait_secs = min(getattr(e, "seconds", 5) + 1, 60)
                await asyncio.sleep(wait_secs)
            except Exception as e:
                async with lock:
                    consecutive_errors += 1
                    err_cnt = part_retries.get(part, 0) + 1
                    part_retries[part] = err_cnt

                err_str = str(e).lower()
                if "file reference" in err_str or "filereference" in err_str:
                    worker_error = e
                    abort_event.set()
                    queue.task_done()
                    break

                if err_cnt > 3 or consecutive_errors > 12:
                    worker_error = e
                    abort_event.set()
                    queue.task_done()
                    break

                await queue.put(part)
                queue.task_done()
                await asyncio.sleep(0.5)

    try:
        await asyncio.gather(*[worker(s) for s in all_senders])
        if worker_error is not None:
            raise worker_error
        if downloaded < file_size:
            raise RuntimeError(f"Parallel download incomplete: {downloaded}/{file_size} bytes downloaded")
    finally:
        try:
            out_file.close()
        except Exception:
            pass
        for s in all_senders:
            try:
                await s.disconnect()
            except Exception:
                pass

    return dest_path

async def download_document(api_id: int, api_hash: str, session_str: str, channel_target: str, message_id: int, dest_path: str):
    from telethon import TelegramClient
    from telethon.sessions import StringSession
    try:
        client = TelegramClient(StringSession(session_str), api_id, api_hash)
        await client.connect()
        if not await client.is_user_authorized():
            print(json.dumps({"status": "unauthorized", "message": "Telegram UserBot session string is invalid or expired"}), flush=True)
            sys.exit(1)

        entity = channel_target
        if channel_target.startswith("-100"):
            try:
                entity = int(channel_target)
            except ValueError:
                pass
        elif channel_target.isdigit():
            entity = int(channel_target)

        try:
            target_channel = await client.get_entity(entity)
        except Exception as e:
            print(json.dumps({"status": "error", "message": f"Channel '{channel_target}' not accessible: {str(e)}"}), flush=True)
            await client.disconnect()
            sys.exit(1)

        message = await client.get_messages(target_channel, ids=message_id)
        if not message or not message.media:
            print(json.dumps({"status": "error", "message": f"Message {message_id} or document attachment not found in channel"}), flush=True)
            await client.disconnect()
            sys.exit(1)

        doc = getattr(message, "document", None) or getattr(message, "media", None)
        file_size = getattr(doc, "size", 0)

        # Pre-check available disk space
        dest_dir = os.path.dirname(os.path.abspath(dest_path))
        os.makedirs(dest_dir, exist_ok=True)
        try:
            st = os.statvfs(dest_dir)
            avail_bytes = st.f_bavail * st.f_frsize
            if file_size > 0 and avail_bytes < (file_size + 300 * 1024 * 1024):
                req_gb = file_size / (1024**3)
                free_gb = avail_bytes / (1024**3)
                print(json.dumps({"status": "error", "message": f"Insufficient disk space: archive requires {req_gb:.2f} GB, but only {free_gb:.2f} GB is available"}), flush=True)
                await client.disconnect()
                sys.exit(1)
        except (AttributeError, OSError):
            pass

        last_report = [0.0]
        start_time = time.time()

        def on_progress(current, total):
            now = time.time()
            if now - last_report[0] >= 0.25 or current >= total:
                last_report[0] = now
                elapsed = max(0.001, now - start_time)
                speed_mbps = (current * 8.0) / (elapsed * 1_000_000.0)
                pct = (current / total * 100.0) if total > 0 else 0.0
                print(f"PROGRESS:{json.dumps({'loaded': current, 'total': total, 'percent': round(pct, 1), 'speedMbps': round(speed_mbps, 2)})}", flush=True)

        downloaded = None

        # 1. Attempt multi-connection fast download for files >= 1 MB
        if doc and hasattr(doc, "id") and file_size >= 1024 * 1024:
            try:
                downloaded = await parallel_download_document(client, doc, dest_path, progress_callback=on_progress, max_workers=8)
            except Exception as e:
                print(f"WARNING: Fast parallel download failed ({type(e).__name__}: {e}); falling back to standard Telethon download...", file=sys.stderr, flush=True)
                if os.path.exists(dest_path):
                    try:
                        os.remove(dest_path)
                    except Exception:
                        pass
                downloaded = None

        # 2. Fallback to standard Telethon download_media if parallel failed or was skipped
        if not downloaded or not os.path.exists(dest_path) or os.path.getsize(dest_path) == 0:
            try:
                downloaded = await client.download_media(message, file=dest_path, progress_callback=on_progress)
            except Exception as e:
                if "file reference" in str(e).lower():
                    message = await client.get_messages(target_channel, ids=message_id)
                    downloaded = await client.download_media(message, file=dest_path, progress_callback=on_progress)
                else:
                    raise e

        await client.disconnect()

        if downloaded and os.path.exists(downloaded) and os.path.getsize(downloaded) > 0:
            print(json.dumps({"status": "ok", "path": downloaded, "sizeBytes": os.path.getsize(downloaded)}), flush=True)
        else:
            print(json.dumps({"status": "error", "message": "Download finished but destination file is empty or missing"}), flush=True)
            sys.exit(1)

    except Exception as e:
        print(json.dumps({"status": "error", "message": f"Telegram download error: {str(e)}"}), flush=True)
        sys.exit(1)
def test_password_script(script_code: str, message_content: str):
    pwd = execute_password_script(script_code, message_content)
    print(json.dumps({"status": "ok", "resolvedPassword": pwd}))

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"status": "error", "message": "Subcommand required"}))
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "test_password_script":
        # python3 tg_engine.py test_password_script --script <file> --message <file>
        script_code = DEFAULT_PASSWORD_SCRIPT
        msg_text = ""
        args = sys.argv[2:]
        for i in range(len(args) - 1):
            if args[i] == "--script":
                with open(args[i+1], "r", encoding="utf-8", errors="ignore") as f:
                    script_code = f.read()
            elif args[i] == "--message":
                with open(args[i+1], "r", encoding="utf-8", errors="ignore") as f:
                    msg_text = f.read()
        test_password_script(script_code, msg_text)

    elif cmd == "check_connection":
        # python3 tg_engine.py check_connection <api_id> <api_hash> <session_str>
        if len(sys.argv) < 5:
            print(json.dumps({"status": "error", "message": "api_id, api_hash, and session_string required"}))
            sys.exit(1)
        api_id = int(sys.argv[2])
        api_hash = sys.argv[3]
        session_str = sys.argv[4]
        asyncio.run(check_connection(api_id, api_hash, session_str))

    elif cmd == "scrape_messages":
        # python3 tg_engine.py scrape_messages <api_id> <api_hash> <session_str> <channel_target> <limit> [--script <file>]
        if len(sys.argv) < 7:
            print(json.dumps({"status": "error", "message": "Missing arguments for scrape_messages"}))
            sys.exit(1)
        api_id = int(sys.argv[2])
        api_hash = sys.argv[3]
        session_str = sys.argv[4]
        channel_target = sys.argv[5]
        limit = int(sys.argv[6])
        script_code = DEFAULT_PASSWORD_SCRIPT
        if "--script" in sys.argv:
            idx = sys.argv.index("--script")
            if idx + 1 < len(sys.argv):
                with open(sys.argv[idx+1], "r", encoding="utf-8", errors="ignore") as f:
                    script_code = f.read()
        asyncio.run(scrape_messages(api_id, api_hash, session_str, channel_target, limit, script_code))

    elif cmd == "download_document":
        # python3 tg_engine.py download_document <api_id> <api_hash> <session_str> <channel_target> <message_id> <dest_path>
        if len(sys.argv) < 8:
            print(json.dumps({"status": "error", "message": "Missing arguments for download_document"}))
            sys.exit(1)
        api_id = int(sys.argv[2])
        api_hash = sys.argv[3]
        session_str = sys.argv[4]
        channel_target = sys.argv[5]
        message_id = int(sys.argv[6])
        dest_path = sys.argv[7]
        asyncio.run(download_document(api_id, api_hash, session_str, channel_target, message_id, dest_path))

    else:
        print(json.dumps({"status": "error", "message": f"Unknown subcommand {cmd}"}))
        sys.exit(1)

if __name__ == "__main__":
    main()

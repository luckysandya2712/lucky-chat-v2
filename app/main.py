from pathlib import Path
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import asyncio
import base64
import hashlib
import hmac
import json
import os
import shutil
import time
import traceback

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, Form, UploadFile, File
from fastapi.responses import HTMLResponse, RedirectResponse, FileResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy import and_, or_, inspect, text as sqlalchemy_text, func, case
from starlette.middleware.sessions import SessionMiddleware

from app.websocket import manager
from app.models import Message, User, Status, StatusView, StatusLike, StatusReply
from app.database import SessionLocal, Base, engine
from app import models
from app.auth import hash_password, verify_password
from app.notification import (
    VAPID_PUBLIC_KEY,
    add_subscription,
    push_configured,
    remove_subscription,
    send_push_to_user,
)

Base.metadata.create_all(bind=engine)

def utc_now_iso():
    """Return a canonical UTC ISO-8601 timestamp for new messages."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


app = FastAPI(title="Lucky Chat v2")

app.mount("/static", StaticFiles(directory="static"), name="static")

UPLOAD_DIR = Path("static/uploads/chat")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

STATUS_UPLOAD_DIR = Path("static/uploads/status")
STATUS_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def _storage_user_key(username: str) -> str:
    """Return a filesystem-safe stable identifier for per-user uploads."""
    value = str(username or "").strip()
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:24]

# Session signing must come from deployment configuration, never from a
# source-controlled hardcoded secret. Set SESSION_SECRET_KEY in Railway/local
# environment variables before starting the application.
SESSION_SECRET_KEY = os.environ.get("SESSION_SECRET_KEY", "").strip()
if not SESSION_SECRET_KEY:
    raise RuntimeError(
        "SESSION_SECRET_KEY is not configured. "
        "Set a long random secret in the deployment environment before startup."
    )

app.add_middleware(
    SessionMiddleware,
    secret_key=SESSION_SECRET_KEY
)

models.Base.metadata.create_all(bind=engine)


def _ensure_message_media_columns():
    """Add voice metadata columns to existing databases without deleting data."""
    try:
        inspector = inspect(engine)
        if not inspector.has_table("messages"):
            return

        columns = {column["name"] for column in inspector.get_columns("messages")}
        statements = []

        if "media_duration" not in columns:
            statements.append(
                "ALTER TABLE messages ADD COLUMN media_duration INTEGER DEFAULT 0"
            )

        if "media_waveform" not in columns:
            statements.append(
                "ALTER TABLE messages ADD COLUMN media_waveform TEXT"
            )

        if statements:
            with engine.begin() as connection:
                for statement in statements:
                    connection.execute(sqlalchemy_text(statement))

            print("MESSAGE MEDIA SCHEMA: voice metadata columns added")
    except Exception as exc:
        print("MESSAGE MEDIA SCHEMA ERROR:", exc)
        traceback.print_exc()


_ensure_message_media_columns()


def _ensure_message_forwarded_column():
    """Add the persistent forwarded flag to existing message tables."""
    try:
        inspector = inspect(engine)
        if not inspector.has_table("messages"):
            return

        columns = {column["name"] for column in inspector.get_columns("messages")}
        if "forwarded" in columns:
            return

        with engine.begin() as connection:
            connection.execute(
                sqlalchemy_text(
                    "ALTER TABLE messages "
                    "ADD COLUMN forwarded INTEGER DEFAULT 0"
                )
            )

        print("MESSAGE SCHEMA: forwarded column added")
    except Exception as exc:
        print("MESSAGE SCHEMA ERROR (forwarded):", exc)
        traceback.print_exc()


_ensure_message_forwarded_column()


def _ensure_message_status_reply_columns():
    """Add persistent metadata used to render Status replies in chat."""
    try:
        inspector = inspect(engine)
        if not inspector.has_table("messages"):
            return

        columns = {column["name"] for column in inspector.get_columns("messages")}
        statements = []

        if "status_reply" not in columns:
            statements.append(
                "ALTER TABLE messages ADD COLUMN status_reply INTEGER DEFAULT 0"
            )
        if "status_reply_status_id" not in columns:
            statements.append(
                "ALTER TABLE messages ADD COLUMN status_reply_status_id INTEGER"
            )
        if "status_reply_owner" not in columns:
            statements.append(
                "ALTER TABLE messages ADD COLUMN status_reply_owner VARCHAR"
            )

        if statements:
            with engine.begin() as connection:
                for statement in statements:
                    connection.execute(sqlalchemy_text(statement))
            print("MESSAGE SCHEMA: Status reply columns added")
    except Exception as exc:
        print("MESSAGE SCHEMA ERROR (status reply):", exc)
        traceback.print_exc()


_ensure_message_status_reply_columns()


def _ensure_crypto_key_columns():
    """Add encrypted-key-recovery columns to existing users tables."""
    try:
        inspector = inspect(engine)
        if not inspector.has_table("users"):
            return

        columns = {column["name"] for column in inspector.get_columns("users")}
        statements = []

        if "public_key_history" not in columns:
            statements.append(
                "ALTER TABLE users ADD COLUMN public_key_history TEXT DEFAULT '[]'"
            )

        if "crypto_key_backup" not in columns:
            statements.append(
                "ALTER TABLE users ADD COLUMN crypto_key_backup TEXT"
            )

        if statements:
            with engine.begin() as connection:
                for statement in statements:
                    connection.execute(sqlalchemy_text(statement))

            print("CRYPTO KEY SCHEMA: recovery columns added")
    except Exception as exc:
        print("CRYPTO KEY SCHEMA ERROR:", exc)
        traceback.print_exc()


_ensure_crypto_key_columns()

def _ensure_read_receipt_settings_column():
    """Add the per-account Read Receipts preference to existing users."""
    try:
        inspector = inspect(engine)
        if not inspector.has_table("users"):
            return

        columns = {column["name"] for column in inspector.get_columns("users")}
        if "read_receipts_enabled" in columns:
            return

        with engine.begin() as connection:
            connection.execute(
                sqlalchemy_text(
                    "ALTER TABLE users "
                    "ADD COLUMN read_receipts_enabled INTEGER DEFAULT 1"
                )
            )

        print("SETTINGS SCHEMA: read_receipts_enabled column added")
    except Exception as exc:
        print("SETTINGS SCHEMA ERROR:", exc)
        traceback.print_exc()


_ensure_read_receipt_settings_column()

def _ensure_online_status_settings_column():
    """Add the per-account Online Status preference to existing users."""
    try:
        inspector = inspect(engine)
        if not inspector.has_table("users"):
            return

        columns = {column["name"] for column in inspector.get_columns("users")}
        if "online_status_enabled" in columns:
            return

        with engine.begin() as connection:
            connection.execute(
                sqlalchemy_text(
                    "ALTER TABLE users "
                    "ADD COLUMN online_status_enabled INTEGER DEFAULT 1"
                )
            )

        print("SETTINGS SCHEMA: online_status_enabled column added")
    except Exception as exc:
        print("SETTINGS SCHEMA ERROR:", exc)
        traceback.print_exc()


_ensure_online_status_settings_column()





def resolve_user_by_username(db, username):
    """Resolve a user by exact username, then normalized username.

    Normalization trims surrounding whitespace and compares usernames
    case-insensitively. This also handles legacy records that accidentally
    contain leading/trailing spaces in the stored username.
    """
    value = str(username or "").strip()
    if not value:
        return None

    # Fast path for correctly stored usernames.
    user = db.query(User).filter(User.username == value).first()
    if user:
        return user

    # Legacy-safe path: ignore surrounding whitespace and case on both sides.
    return (
        db.query(User)
        .filter(func.lower(func.trim(User.username)) == value.lower())
        .first()
    )


# Short-lived record of recent forwards so a client that both:
#   1) sends type="forward_message" to the chosen recipient, and
#   2) also emits a regular type="message" on the open chat socket
# does not persist a duplicate copy into the conversation that is
# currently on screen (e.g. forwarding to LuckyNova while chatting
# with GautAm).
_recent_forwards = {}
_RECENT_FORWARD_TTL = 10.0


def _remember_forward(username, text, target):
    now = time.time()
    items = [
        item
        for item in _recent_forwards.get(username, [])
        if now - item["t"] < _RECENT_FORWARD_TTL
    ]
    items.append({
        "t": now,
        "text": str(text or ""),
        "target": str(target or "").strip(),
    })
    _recent_forwards[username] = items[-20:]


def _is_accidental_forward_resend(username, text, receiver):
    """True when this outgoing text was just forwarded to someone else."""
    now = time.time()
    receiver_key = str(receiver or "").strip().casefold()
    text_key = str(text or "")
    for item in _recent_forwards.get(username, []):
        if now - item["t"] > _RECENT_FORWARD_TTL:
            continue
        if item["text"] != text_key:
            continue
        if str(item["target"] or "").strip().casefold() != receiver_key:
            return True
    return False


def _payload_is_forward(data):
    if not isinstance(data, dict):
        return False
    if data.get("type") == "forward_message":
        return True
    for key in ("forward", "forwarded", "is_forward", "isForward"):
        value = data.get(key)
        if value is True or value == 1 or str(value).strip().lower() in {"true", "1", "yes"}:
            return True
    return False


templates = Jinja2Templates(directory="app/templates")

def get_authenticated_username(scope):
    """Return the authenticated username from the signed session cookie."""
    username = scope.session.get("username")
    if not username:
        return None
    return str(username).strip()



TURN_SERVER_URL = os.environ.get("TURN_SERVER_URL", "").strip()
TURN_SHARED_SECRET = os.environ.get("TURN_SHARED_SECRET", "").strip()
TURN_CREDENTIAL_TTL = max(
    60,
    min(
        int(os.environ.get("TURN_CREDENTIAL_TTL", "3600") or "3600"),
        86400
    )
)

@app.get("/turn-credentials")
async def get_turn_credentials(request: Request):
    """
    Return short-lived TURN credentials for the authenticated Lucky Chat user.

    The TURN server must be configured with coturn's REST/shared-secret
    authentication mode using the same TURN_SHARED_SECRET.
    """
    username = request.session.get("username")
    if not username:
        return {"success": False, "error": "Not logged in"}

    if not TURN_SERVER_URL or not TURN_SHARED_SECRET:
        return {
            "success": True,
            "enabled": False,
            "ice_servers": []
        }

    expires_at = int(time.time()) + TURN_CREDENTIAL_TTL
    turn_username = f"{expires_at}:{username}"
    digest = hmac.new(
        TURN_SHARED_SECRET.encode("utf-8"),
        turn_username.encode("utf-8"),
        hashlib.sha1
    ).digest()
    turn_password = base64.b64encode(digest).decode("ascii")

    urls = [
        TURN_SERVER_URL,
        TURN_SERVER_URL.replace("turn:", "turns:")
            if TURN_SERVER_URL.startswith("turn:") else TURN_SERVER_URL
    ]
    urls = list(dict.fromkeys(urls))

    return {
        "success": True,
        "enabled": True,
        "ice_servers": [{
            "urls": urls,
            "username": turn_username,
            "credential": turn_password
        }]
    }


@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="index.html"
    )

@app.get("/login", response_class=HTMLResponse)
async def login(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="login.html"
    )

@app.get("/push/config")
async def get_push_config(request: Request):
    username = request.session.get("username")

    if not username:
        return {
            "success": False,
            "enabled": False,
            "error": "Not logged in"
        }

    return {
        "success": True,
        "enabled": push_configured(),
        "public_key": VAPID_PUBLIC_KEY if push_configured() else ""
    }


@app.post("/subscribe")
async def subscribe(request: Request):
    """Legacy-compatible push subscription endpoint."""
    username = request.session.get("username")

    if not username:
        return {
            "success": False,
            "error": "Not logged in"
        }

    body = await request.json()
    subscription = body.get("subscription")

    if not subscription:
        return {
            "success": False,
            "error": "Missing subscription"
        }

    try:
        saved = add_subscription(username, subscription)
    except ValueError as exc:
        return {
            "success": False,
            "error": str(exc)
        }

    return {
        "success": bool(saved)
    }


@app.delete("/subscribe")
async def unsubscribe(request: Request):
    username = request.session.get("username")

    if not username:
        return {
            "success": False,
            "error": "Not logged in"
        }

    try:
        subscription = await request.json()
    except Exception:
        subscription = {}

    remove_subscription(username, subscription)

    return {
        "success": True
    }

@app.get("/register", response_class=HTMLResponse)
async def register(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="register.html"
    )

@app.post("/register")
async def register_user(
    username: str = Form(...),
    email: str = Form(...),
    password: str = Form(...)
):
    username = (username or "").strip()
    email = (email or "").strip()

    if not username or len(username) > 64 or any(ch in username for ch in "/\\"):
        return {"message": "Invalid username"}
    if not email or len(email) > 320:
        return {"message": "Invalid email"}
    if len(password or "") < 8 or len(password or "") > 256:
        return {"message": "Password must be 8-256 characters"}

    db = SessionLocal()
    try:

        existing = db.query(User).filter(
            (User.username == username) |
            (User.email == email)
        ).first()

        if existing:
            db.close()
            return {"message": "Username or email already exists"}

        user = User(
            username=username,
            email=email,
            password=hash_password(password)
        )

        db.add(user)
        db.commit()
        return RedirectResponse(url="/login", status_code=303)

    finally:
        db.close()


class PublicKeyUpload(BaseModel):
    public_key: str





class ChangePasswordPayload(BaseModel):
    current_password: str
    new_password: str

class ReadReceiptsPayload(BaseModel):
    enabled: bool


class OnlineStatusPayload(BaseModel):
    enabled: bool


class CryptoBackupPayload(BaseModel):
    backup: str


class StatusLikePayload(BaseModel):
    liked: bool = True


class StatusReplyPayload(BaseModel):
    encrypted_text: str


@app.get("/crypto/backup")
async def get_crypto_backup(request: Request):
    username = request.session.get("username")
    if not username:
        return {"success": False, "error": "Not logged in"}

    db = SessionLocal()
    try:
        user = resolve_user_by_username(db, username)
        if not user:
            return {"success": False, "error": "User not found"}
        return {"success": True, "backup": user.crypto_key_backup or ""}
    finally:
        db.close()


@app.post("/crypto/backup")
async def save_crypto_backup(
    data: CryptoBackupPayload,
    request: Request
):
    username = request.session.get("username")
    if not username:
        return {"success": False, "error": "Not logged in"}

    backup = (data.backup or "").strip()
    if not backup:
        return {"success": False, "error": "Backup is required"}
    if len(backup) > 200_000:
        return {"success": False, "error": "Backup is too large"}

    db = SessionLocal()
    try:
        user = resolve_user_by_username(db, username)
        if not user:
            return {"success": False, "error": "User not found"}

        # The backup is encrypted in the browser with the recovery code.
        # The server never receives the recovery code itself.
        user.crypto_key_backup = backup
        db.commit()
        return {"success": True}
    except Exception as exc:
        db.rollback()
        print("CRYPTO BACKUP SAVE ERROR:", exc)
        traceback.print_exc()
        return {"success": False, "error": "Could not save crypto backup"}
    finally:
        db.close()


@app.post("/keys/upload")
async def upload_public_key(
    data: PublicKeyUpload,
    request: Request
):
    username = request.session.get("username")

    if not username:
        return {
            "success": False,
            "error": "Not logged in"
        }

    public_key = (data.public_key or "").strip()

    if not public_key:
        return {
            "success": False,
            "error": "Public key is required"
        }

    db = SessionLocal()

    try:
        user = resolve_user_by_username(db, username)

        if not user:
            return {
                "success": False,
                "error": "User not found"
            }

        history = []
        try:
            parsed = json.loads(user.public_key_history or "[]")
            if isinstance(parsed, list):
                history = [
                    str(value).strip()
                    for value in parsed
                    if str(value).strip()
                ]
        except Exception:
            history = []

        current = str(user.public_key or "").strip()

        if current and current != public_key and current not in history:
            history.append(current)

        user.public_key = public_key
        user.public_key_history = json.dumps(history[-12:], separators=(",", ":"))
        db.commit()

        return {
            "success": True,
            "username": user.username,
            "key_count": len(history[-12:]) + 1
        }

    except Exception as e:
        db.rollback()
        print("PUBLIC KEY UPLOAD ERROR:", e)
        traceback.print_exc()

        return {
            "success": False,
            "error": "Could not save public key"
        }

    finally:
        db.close()


@app.get("/keys/{username}")
async def get_public_key(username: str, request: Request):
    # Public keys are used by the authenticated chat client for E2EE.
    # Do not expose account key material to unauthenticated visitors.
    current_username = get_authenticated_username(request)
    if not current_username:
        return {"success": False, "error": "Not logged in"}

    db = SessionLocal()

    try:
        user = resolve_user_by_username(db, username)

        if not user:
            return {
                "success": False,
                "error": "User not found"
            }

        history = []
        try:
            parsed = json.loads(user.public_key_history or "[]")
            if isinstance(parsed, list):
                history = [
                    str(value).strip()
                    for value in parsed
                    if str(value).strip()
                ]
        except Exception:
            history = []

        public_keys = []
        for value in history + [str(user.public_key or "").strip()]:
            if value and value not in public_keys:
                public_keys.append(value)

        return {
            "success": True,
            "username": user.username,
            "public_key": user.public_key,
            "public_keys": public_keys
        }

    finally:
        db.close()

@app.get("/dashboard", response_class=HTMLResponse)
async def dashboard(request: Request):
    """Render the dashboard with batched conversation queries."""
    current_user = get_authenticated_username(request)
    if not current_user:
        return RedirectResponse("/login", status_code=303)

    db = SessionLocal()
    try:
        users = db.query(User).all()

        peer_expr = case(
            (Message.sender == current_user, Message.receiver),
            else_=Message.sender
        )

        latest_ids = (
            db.query(
                peer_expr.label("peer"),
                func.max(Message.id).label("last_id")
            )
            .filter(
                or_(
                    Message.sender == current_user,
                    Message.receiver == current_user
                )
            )
            .group_by(peer_expr)
            .subquery()
        )

        latest_rows = (
            db.query(Message)
            .join(latest_ids, Message.id == latest_ids.c.last_id)
            .all()
        )

        last_messages = {
            str(message.sender if message.receiver == current_user else message.receiver): message
            for message in latest_rows
        }

        # Keep the template contract from the original dashboard route:
        # every other user must have a dictionary entry, even when there is no
        # conversation yet. Jinja dot-lookup raises UndefinedError for a
        # missing username key, so populate empty defaults before rendering.
        for user in users:
            if user.username == current_user:
                continue
            last_messages.setdefault(user.username, None)

        unread_rows = (
            db.query(
                Message.sender.label("peer"),
                func.count(Message.id).label("unread")
            )
            .filter(
                Message.receiver == current_user,
                Message.unread == 1
            )
            .group_by(Message.sender)
            .all()
        )

        unread_counts = {
            str(row.peer): int(row.unread or 0)
            for row in unread_rows
        }

        # Preserve the original template behavior for users with no unread
        # messages by providing an explicit zero for every chat-list user.
        for user in users:
            if user.username == current_user:
                continue
            unread_counts.setdefault(user.username, 0)

        chat_list = []
        for user in users:
            if user.username == current_user:
                continue

            msg = last_messages.get(user.username)
            chat_list.append({
                "user": user,
                "last_message": msg,
                "time": msg.timestamp if msg else ""
            })

        chat_list.sort(
            key=lambda item: item["last_message"].id
            if item["last_message"] else 0,
            reverse=True
        )

        return templates.TemplateResponse(
            request=request,
            name="dashboard.html",
            context={
                "request": request,
                "chat_list": chat_list,
                "username": current_user,
                "last_messages": last_messages,
                "unread_counts": unread_counts
            }
        )
    finally:
        db.close()


@app.get("/crypto-recovery", response_class=HTMLResponse)
async def crypto_recovery(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="crypto_recovery.html"
    )

@app.get("/chat/{friend}", response_class=HTMLResponse)
async def chat(friend: str, request: Request):

    current_username = get_authenticated_username(request)
    if not current_username:
        return RedirectResponse("/login", status_code=303)

    db = SessionLocal()

    user = resolve_user_by_username(db, friend)
    canonical_friend = user.username if user else friend

    db.close()

    return templates.TemplateResponse(
        request=request,
        name="chat.html",
        context={
            "request": request,
            "friend": canonical_friend,
            "friend_user": user
        }
    )


@app.post("/login")
async def login_user(
    request: Request,
    username: str = Form(...),
    password: str = Form(...)
):

    db = SessionLocal()
    try:

        user = db.query(User).filter(
            User.username == username
        ).first()

        if not user:
            db.close()
            return {"message": "Invalid username or password"}


        if not verify_password(password, user.password):
            db.close()
            return {"message": "Invalid username or password"}

        request.session["username"] = user.username

        response = RedirectResponse(
            url="/dashboard",
            status_code=303
        )

        # Legacy compatibility cookie used by the existing client-side chat/crypto
        # code. Server authorization still uses the signed session; this cookie is
        # never trusted for authentication or authorization.
        response.set_cookie(
            "username",
            user.username,
            httponly=False,
            samesite="lax",
        )

        return response

    finally:
        db.close()


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):

    # Authenticate the WebSocket using the same signed-session helper used
    # by normal HTTP routes. Never trust a username supplied by the query string.
    username = get_authenticated_username(websocket)
    if not username:
        await websocket.close(code=1008)
        return

    friend = websocket.query_params.get("friend", "")
    page = websocket.query_params.get("page", "chat")

    # Normalize the chat partner to the canonical username stored in the DB.
    # This prevents display-name/casing differences from breaking messaging
    # and voice-call routing.
    if page != "dashboard":
        db = SessionLocal()
        try:
            friend_user = resolve_user_by_username(db, friend) if friend else None
            if friend_user and friend_user.username != username:
                friend = friend_user.username
            else:
                # A chat WebSocket must never target an arbitrary/invalid user.
                # Keep the connection usable for the UI, but disable message
                # routing until a valid chat partner is supplied.
                friend = ""
        finally:
            db.close()

    if page == "dashboard":
        await websocket.accept()

        manager.dashboard_connections[username] = websocket

        print(f"{username} connected from dashboard")

        try:
            while True:
                await websocket.receive_text()

        except WebSocketDisconnect:
            manager.dashboard_connections.pop(username, None)
            print(f"{username} dashboard disconnected")

        return

    await manager.connect(username, websocket)

    print(f"{username} connected from chat")

    try:
        while True:
            raw = await websocket.receive_text()
            data = json.loads(raw)

            # Browser heartbeat. This keeps the chat WebSocket active through
            # idle proxy/load-balancer timeouts without touching chat messages.
            if data.get("type") == "ws_heartbeat":
                await websocket.send_json({
                    "type": "ws_heartbeat_ack",
                    "ts": data.get("ts")
                })
                continue

            # Avoid logging full client payloads in production.


            async def persist_call_history_event(call_id, caller, callee, event_type):
                """Persist a single voice-call lifecycle row and notify both participants."""
                if not call_id or not caller or not callee:
                    return None

                db_call = SessionLocal()
                try:
                    marker = "call:" + str(call_id)
                    row = (
                        db_call.query(Message)
                        .filter(
                            Message.media_type == "call",
                            Message.media_url == marker
                        )
                        .first()
                    )

                    if row is None:
                        row = Message(
                            sender=caller,
                            receiver=callee,
                            text="{}",
                            timestamp=utc_now_iso(),
                            media_url=marker,
                            media_type="call",
                            media_duration=0,
                            unread=0,
                            delivered=1,
                            read=1,
                            seen_in_chat=1
                        )
                        db_call.add(row)

                    status = {
                        "ringing": "ringing",
                        "active": "active",
                        "ended": "ended",
                        "missed": "missed",
                        "rejected": "rejected",
                        "busy": "busy",
                        "unavailable": "unavailable"
                    }.get(event_type, "ended")

                    duration = int(row.media_duration or 0)

                    if status == "ended":
                        try:
                            started = datetime.fromisoformat(
                                str(row.timestamp).replace("Z", "+00:00")
                            )
                            duration = max(
                                0,
                                int(
                                    (datetime.now(timezone.utc) - started).total_seconds()
                                )
                            )
                        except Exception:
                            pass

                    row.text = json.dumps(
                        {
                            "type": "voice_call",
                            "status": status,
                            "duration": duration
                        },
                        separators=(",", ":")
                    )
                    row.media_duration = duration
                    row.unread = 0
                    row.delivered = 1
                    row.read = 1
                    row.seen_in_chat = 1

                    db_call.commit()
                    db_call.refresh(row)

                    payload = {
                        "type": "call_history_update",
                        "call": {
                            "id": row.id,
                            "sender": row.sender,
                            "receiver": row.receiver,
                            "text": row.text,
                            "timestamp": row.timestamp,
                            "media_url": row.media_url,
                            "media_type": row.media_type,
                            "media_duration": row.media_duration or 0
                        }
                    }

                    await manager.send(row.sender, payload)
                    if row.receiver != row.sender:
                        await manager.send(row.receiver, payload)

                    return row
                except Exception as exc:
                    db_call.rollback()
                    print("CALL HISTORY ERROR:", exc)
                    traceback.print_exc()
                    return None
                finally:
                    db_call.close()

            VOICE_CALL_SIGNAL_TYPES = {"call_offer","call_answer","call_ice","call_reject","call_busy","call_end","call_ping"}
            if data.get("type") in VOICE_CALL_SIGNAL_TYPES:
                signal_type=data.get("type")
                requested_target=(data.get("target") or friend or "").strip()
                if not requested_target:
                    continue

                db = SessionLocal()
                try:
                    target_user = resolve_user_by_username(db, requested_target)
                finally:
                    db.close()

                if not target_user:
                    print(f"VOICE CALL TARGET USER NOT FOUND: {requested_target} ({signal_type})")
                    if signal_type in {"call_ping", "call_offer"}:
                        if data.get("call_id"):
                            await persist_call_history_event(
                                data.get("call_id"),
                                username,
                                requested_target,
                                "unavailable"
                            )
                        await manager.send(username, {
                            "type": "call_unavailable",
                            "call_id": data.get("call_id"),
                            "target": requested_target,
                            "reason": "user_not_found"
                        })
                    continue

                target = target_user.username
                if target == username:
                    continue

                call_id = data.get("call_id")

                # Persist the call lifecycle. ICE-restart offers/answers are
                # renegotiations and must not create duplicate history rows.
                if call_id and signal_type == "call_ping":
                    await persist_call_history_event(
                        call_id, username, target, "ringing"
                    )
                elif call_id and signal_type == "call_offer" and not data.get("ice_restart"):
                    await persist_call_history_event(
                        call_id, username, target, "ringing"
                    )
                elif call_id and signal_type == "call_answer" and not data.get("ice_restart"):
                    await persist_call_history_event(
                        call_id, target, username, "active"
                    )
                elif call_id and signal_type == "call_reject":
                    await persist_call_history_event(
                        call_id, target, username, "rejected"
                    )
                elif call_id and signal_type == "call_busy":
                    await persist_call_history_event(
                        call_id, target, username, "busy"
                    )
                elif call_id and signal_type == "call_end":
                    db_lookup = SessionLocal()
                    try:
                        marker = "call:" + str(call_id)
                        existing = (
                            db_lookup.query(Message)
                            .filter(
                                Message.media_type == "call",
                                Message.media_url == marker
                            )
                            .first()
                        )

                        caller = existing.sender if existing else target
                        callee = existing.receiver if existing else username
                        prior_status = "ended"

                        if existing and existing.text:
                            try:
                                prior_status = json.loads(
                                    existing.text or "{}"
                                ).get("status", "ended")
                            except Exception:
                                pass
                    finally:
                        db_lookup.close()

                    await persist_call_history_event(
                        call_id,
                        caller,
                        callee,
                        "missed" if prior_status == "ringing" else "ended"
                    )

                payload={"type":signal_type,"call_id":call_id,"sender":username}
                if signal_type == "call_offer":
                    asyncio.create_task(
                        send_push_to_user(
                            target_user.username,
                            {
                                "type": "call",
                                "sender": username,
                            },
                        )
                    )
                if signal_type in {"call_offer","call_answer"}: payload["sdp"]=data.get("sdp")
                elif signal_type=="call_ice": payload["candidate"]=data.get("candidate")
                delivered = await manager.send(target, payload)
                if not delivered and signal_type in {"call_ping", "call_offer"}:
                    print(f"VOICE CALL TARGET NOT CONNECTED: {target} ({signal_type})")
                    if data.get("call_id"):
                        await persist_call_history_event(
                            data.get("call_id"),
                            username,
                            target,
                            "unavailable"
                        )
                    await manager.send(username, {
                        "type": "call_unavailable",
                        "call_id": data.get("call_id"),
                        "target": target,
                        "reason": "target_not_connected"
                    })
                continue

            if data["type"] == "typing":
                if not friend:
                    continue

                payload = {
                    "type": "typing",
                    "sender": username
                }

                await manager.send_personal(payload, friend)
                continue

            if data["type"] == "stop_typing":
                if not friend:
                    continue

                payload = {
                    "type": "stop_typing",
                    "sender": username
                }

                await manager.send_personal(payload, friend)
                continue

            if data["type"] == "delivered":
                db = SessionLocal()

                msg = db.query(Message).filter(
                Message.id == data["id"]
                ).first()

                if msg and msg.receiver == username:
                    msg.delivered = 1
                    db.commit()

                    print("Sending DELIVERED event:", msg.id, "to", msg.sender)

                    await manager.send(msg.sender, {
                        "type": "delivered",
                        "id": msg.id
                    })

                db.close()
                continue

            if data["type"] == "read":
                db = SessionLocal()

                try:
                    msg = db.query(Message).filter(
                        Message.id == data["id"]
                    ).first()

                    if msg and msg.receiver == username:
                        # Enforce Read Receipts on the server so the preference
                        # cannot be bypassed by another browser/device.
                        read_receipts_enabled = True
                        try:
                            row = db.execute(
                                sqlalchemy_text(
                                    "SELECT read_receipts_enabled "
                                    "FROM users WHERE username = :username"
                                ),
                                {"username": username}
                            ).first()
                            if row is not None and row[0] is not None:
                                read_receipts_enabled = bool(int(row[0]))
                        except Exception:
                            # Preserve the existing behavior if an older
                            # database has not yet added the setting column.
                            read_receipts_enabled = True

                        if read_receipts_enabled:
                            msg.read = 1
                            db.commit()

                            await manager.send(msg.sender, {
                                "type": "read",
                                "id": msg.id
                            })
                finally:
                    db.close()

                continue

            if data["type"] == "reaction":

                db = SessionLocal()

                try:
                    msg = db.query(Message).filter(
                        Message.id == data.get("id")
                    ).first()

                    if not msg:
                        continue

                    # Only participants in this message's conversation
                    # may change its reaction.
                    if username not in (msg.sender, msg.receiver):
                        continue

                    reaction = (data.get("reaction") or "").strip()

                    # The current Message model may not yet have a
                    # persistent reaction column. In that case we still
                    # broadcast the reaction live without touching the DB.
                    if hasattr(msg, "reaction"):
                        msg.reaction = reaction
                        db.commit()

                    payload = {
                        "type": "reaction",
                        "id": msg.id,
                        "reaction": reaction,
                        "sender": username
                    }

                    await manager.send(msg.sender, payload)

                    if msg.receiver != msg.sender:
                        await manager.send(msg.receiver, payload)

                except Exception as e:
                    db.rollback()
                    print("REACTION ERROR:", e)
                    traceback.print_exc()

                finally:
                    db.close()

                continue


            if data["type"] == "delete_everyone":
                db = SessionLocal()

                try:
                    msg = db.query(Message).filter(
                        Message.id == data["id"]
                    ).first()

                    if not msg:
                        continue

                    # Only the original sender can delete for everyone.
                    if msg.sender != username:
                        continue

                    msg.text = "🚫 This message was deleted"
                    msg.deleted_for_everyone = 1

                    # Clear attached content and reactions as part of the
                    # permanent deleted state.
                    msg.media_url = None
                    msg.media_type = None

                    if hasattr(msg, "reaction"):
                        msg.reaction = ""

                    if hasattr(msg, "reactions"):
                        msg.reactions = "{}"

                    db.commit()

                    payload = {
                        "type": "delete_everyone",
                        "id": msg.id,
                        "text": msg.text
                    }

                    await manager.send(msg.sender, payload)

                    if msg.receiver != msg.sender:
                        await manager.send(msg.receiver, payload)

                except Exception as e:
                    db.rollback()
                    print("DELETE EVERYONE ERROR:", e)
                    traceback.print_exc()

                finally:
                    db.close()

                continue

            if data["type"] == "forward_message":
                # Forwarding currently sends encrypted text only. Resolve the
                # selected recipient to the canonical database username and
                # never reuse the current chat's `friend` value.
                text = data.get("text", "").strip()
                requested_target = (
                    data.get("target")
                    or data.get("receiver")
                    or data.get("to")
                    or data.get("username")
                    or ""
                )
                requested_target = str(requested_target).strip()

                if not text or not requested_target:
                    continue

                db = SessionLocal()
                payload = None
                target = None
                try:
                    target_user = resolve_user_by_username(db, requested_target)

                    if not target_user:
                        print(
                            "FORWARD TARGET USER NOT FOUND:",
                            requested_target
                        )
                        continue

                    target = target_user.username

                    message = Message(
                        sender=username,
                        receiver=target,
                        text=text,
                        timestamp=utc_now_iso(),
                        unread=1,
                        seen_in_chat=0,
                        forwarded=1,
                        reply_to=None,
                        media_url=data.get("media_url"),
                        media_type=data.get("media_type"),
                        media_duration=int(data.get("media_duration") or 0),
                        media_waveform=data.get("media_waveform"),
                    )

                    db.add(message)
                    db.commit()
                    db.refresh(message)

                    _remember_forward(username, text, target)

                    print(
                        "FORWARDED MESSAGE:",
                        message.id,
                        username,
                        "->",
                        target
                    )

                    payload = {
                        "type": "message",
                        "id": message.id,
                        "sender": username,
                        "receiver": target,
                        "text": message.text,
                        "timestamp": message.timestamp,
                        "delivered": message.delivered,
                        "read": message.read,
                        "reply_to": None,
                        "media_url": message.media_url,
                        "media_type": message.media_type,
                        "media_duration": message.media_duration or 0,
                        "media_waveform": message.media_waveform,
                        "forwarded": True,
                        "client_id": data.get("client_id"),
                    }
                except Exception as exc:
                    db.rollback()
                    print("FORWARD MESSAGE ERROR:", exc)
                    traceback.print_exc()
                    continue
                finally:
                    db.close()

                if not payload or not target:
                    continue

                await manager.send_dashboard(
                    target,
                    {
                        "type": "dashboard_update",
                        "from": username
                    }
                )

                await manager.send_dashboard(
                    username,
                    {
                        "type": "dashboard_update",
                        "from": target
                    }
                )

                # Deliver the forwarded message to the chosen recipient.
                if target != username:
                    await manager.send(target, payload)
                    asyncio.create_task(
                        send_push_to_user(
                            target,
                            {
                                "type": "message",
                                "sender": username,
                                "title": username,
                                "body": "You have a new message.",
                            },
                        )
                    )

                # Only echo a renderable "message" event back to the sender
                # when they are already viewing that recipient's chat.
                # Otherwise the open conversation (GautAm) would draw a
                # brand-new outgoing bubble for a message that belongs to
                # LuckyNova.
                current_friend = str(friend or "").strip().casefold()
                if current_friend and current_friend == str(target).strip().casefold():
                    await manager.send(username, payload)
                else:
                    await manager.send(username, {
                        "type": "forward_ack",
                        "id": payload["id"],
                        "sender": username,
                        "receiver": target,
                        "timestamp": payload["timestamp"],
                        "forwarded": True,
                        "client_id": data.get("client_id"),
                    })

                continue

            if data["type"] == "edit_message":
                db = SessionLocal()

                msg = db.query(Message).filter(
                    Message.id == data["id"]
                ).first()

                if msg and msg.sender == username:
                    msg.text = data["text"]
                    msg.edited = 1
                    db.commit()

                    payload = {
                        "type": "edit_message",
                        "id": msg.id,
                        "text": msg.text,
                        "edited": msg.edited
                    }

                    await manager.send(msg.sender, payload)
                    await manager.send(msg.receiver, payload)

                db.close()
                continue

            if data.get("type") == "message":

                if not friend:
                    continue

                text = data.get("text", "").strip()
                media_url = data.get("media_url")
                media_type = data.get("media_type")

                if not text and not media_url:
                    continue

                is_forward = _payload_is_forward(data)
                requested_target = (
                    data.get("target")
                    or data.get("receiver")
                    or data.get("to")
                    or ""
                )
                requested_target = str(requested_target).strip()

                # Regular composer messages stay in the open chat. Forwarded
                # messages must go only to the selected recipient.
                if is_forward and requested_target:
                    receiver_name = requested_target
                elif requested_target and str(requested_target).strip().casefold() != str(friend or "").strip().casefold():
                    # Client included an explicit other recipient. Treat that
                    # as a forward so it is not also saved to the open chat.
                    receiver_name = requested_target
                    is_forward = True
                else:
                    receiver_name = friend

                if is_forward and not requested_target:
                    print("FORWARD MESSAGE MISSING TARGET, ignoring open-chat fallback")
                    continue

                if _is_accidental_forward_resend(username, text, receiver_name):
                    print(
                        "SKIP DUPLICATE FORWARD RESEND:",
                        username,
                        "->",
                        receiver_name
                    )
                    continue

                db = SessionLocal()

                try:
                    target_user = resolve_user_by_username(db, receiver_name)
                    receiver_name = target_user.username if target_user else str(receiver_name or "").strip()

                    if not receiver_name:
                        continue

                    if is_forward:
                        _remember_forward(username, text, receiver_name)

                    message = Message(
                        sender=username,
                        receiver=receiver_name,
                        text=text,
                        timestamp=utc_now_iso(),
                        unread=1,
                        seen_in_chat=0,
                        forwarded=1 if is_forward else 0,
                        reply_to=None if is_forward else data.get("reply_to"),
                        media_url=media_url,
                        media_type=media_type,
                        media_duration=int(data.get("media_duration") or 0),
                        media_waveform=data.get("media_waveform"),
                    )

                    db.add(message)
                    db.commit()
                    db.refresh(message)

                    # Do not scan/print the entire message table here.
                    # That synchronous debug loop became increasingly expensive
                    # as the chat grew and could delay the WebSocket echo.
                    print(
                        "MESSAGE SAVED:",
                        message.id,
                        username,
                        "->",
                        receiver_name,
                        "(forwarded)" if is_forward else ""
                    )

                    payload = {
                        "type": "message",
                        "id": message.id,
                        "sender": username,
                        "receiver": receiver_name,
                        "text": message.text,
                        "timestamp": message.timestamp,
                        "delivered": message.delivered,
                        "read": message.read,
                        "reply_to": message.reply_to,
                        "media_url": message.media_url,
                        "media_type": message.media_type,
                        "media_duration": message.media_duration or 0,
                        "media_waveform": message.media_waveform,
                        "client_id": data.get("client_id"),
                        "forwarded": True if is_forward else False,
                    }

                    # Deliver the actual chat message first. Dashboard
                    # notifications must never delay message delivery.
                    current_friend = str(friend or "").strip().casefold()
                    same_open_chat = current_friend == str(receiver_name).strip().casefold()

                    if not is_forward or same_open_chat:
                        await manager.send(username, payload)
                    else:
                        await manager.send(username, {
                            "type": "forward_ack",
                            "id": payload["id"],
                            "sender": username,
                            "receiver": receiver_name,
                            "timestamp": payload["timestamp"],
                            "forwarded": True,
                            "client_id": data.get("client_id"),
                        })

                    if receiver_name != username:
                        await manager.send(receiver_name, payload)

                        # Push payload intentionally contains NO message text.
                        # The chat content is end-to-end encrypted.
                        asyncio.create_task(
                            send_push_to_user(
                                receiver_name,
                                {
                                    "type": "message",
                                    "sender": username,
                                    "title": username,
                                    "body": "You have a new message.",
                                },
                            )
                        )

                    # Dashboard updates are secondary.
                    await manager.send_dashboard(
                        receiver_name,
                        {
                            "type": "dashboard_update",
                            "from": username
                        }
                    )

                    await manager.send_dashboard(
                        username,
                        {
                            "type": "dashboard_update",
                            "from": receiver_name
                        }
                    )

                except Exception as e:
                    print("MESSAGE ERROR:", e)
                    traceback.print_exc()

                finally:
                    db.close()

                continue

    except WebSocketDisconnect:
            print(f"{username} disconnected")
            await manager.disconnect(username, websocket)

@app.websocket("/dashboard_ws")
async def dashboard_ws(websocket: WebSocket):
    # Authenticate the dashboard WebSocket through the same signed-session
    # helper used everywhere else.
    username = get_authenticated_username(websocket)
    if not username:
        await websocket.close(code=1008)
        return

    await websocket.accept()

    manager.dashboard_connections[username] = websocket

    print("Dashboard connected:", username)

    try:
        while True:
            msg = await websocket.receive_text()
            print("Dashboard ping:", username, msg)
    except WebSocketDisconnect:
      pass

    finally:

        manager.dashboard_connections.pop(username, None)

        print("Dashboard disconnected:", username)

@app.get("/messages/{friend}")
async def get_messages(friend: str, request: Request):

    username = get_authenticated_username(request)
    if not username:
        return {"success": False, "error": "Not logged in", "messages": []}

    db = SessionLocal()

    # Resolve both participants to their canonical database usernames first.
    # This prevents case/whitespace differences from making an existing
    # conversation appear empty on only one account.
    current_user = resolve_user_by_username(db, username)
    friend_user = resolve_user_by_username(db, friend)

    canonical_username = current_user.username if current_user else str(username or "").strip()
    canonical_friend = friend_user.username if friend_user else str(friend or "").strip()

    print("COOKIE USERNAME =", username, "FRIEND =", friend)
    print("CANONICAL USERNAME =", canonical_username)
    print("CANONICAL FRIEND =", canonical_friend)

    # Also normalize the stored Message values so legacy messages saved with
    # different username casing/whitespace remain visible to both participants.
    normalized_username = canonical_username.strip().casefold()
    normalized_friend = canonical_friend.strip().casefold()

    # First try a normal SQL lookup using the canonical names.
    msgs = db.query(Message).filter(
        or_(
            and_(
                Message.sender == canonical_username,
                Message.receiver == canonical_friend
            ),
            and_(
                Message.sender == canonical_friend,
                Message.receiver == canonical_username
            )
        )
    ).order_by(Message.id.asc()).all()

    # Legacy-safe fallback: some older rows may contain different casing or
    # surrounding whitespace. Read only the conversation's candidate rows and
    # normalize them in Python, avoiding SQL-dialect-specific string functions.
    if not msgs:
        candidate_rows = db.query(Message).filter(
            or_(
                Message.sender.in_([canonical_username, canonical_friend]),
                Message.receiver.in_([canonical_username, canonical_friend])
            )
        ).order_by(Message.id.asc()).all()

        msgs = [
            m for m in candidate_rows
            if (
                str(m.sender or "").strip().casefold() == normalized_username
                and str(m.receiver or "").strip().casefold() == normalized_friend
            )
            or (
                str(m.sender or "").strip().casefold() == normalized_friend
                and str(m.receiver or "").strip().casefold() == normalized_username
            )
        ]

    print("USERNAME:", canonical_username)
    print("FRIEND:", canonical_friend)
    print("FOUND MESSAGES:", len(msgs))

    result=[]

    for m in msgs:

        result.append({
            "id": m.id,
            "sender": m.sender,
            "receiver": m.receiver,
            "text": m.text,
            "timestamp": m.timestamp,
            "delivered": m.delivered,
            "read": m.read,
            "reply_to": m.reply_to,
            "media_url": m.media_url,
            "media_type": m.media_type,
            "media_duration": getattr(m, "media_duration", 0) or 0,
            "media_waveform": getattr(m, "media_waveform", None),
            "edited": m.edited,
            "reaction": getattr(m, "reaction", ""),
            "forwarded": bool(int(getattr(m, "forwarded", 0) or 0)),
            "status_reply": bool(int(getattr(m, "status_reply", 0) or 0)),
            "status_reply_status_id": getattr(m, "status_reply_status_id", None),
            "status_reply_owner": getattr(m, "status_reply_owner", None),
        })

    unread_candidates = db.query(Message).filter(
        Message.unread == 1,
        or_(
            Message.sender.in_([canonical_friend, canonical_username]),
            Message.receiver.in_([canonical_friend, canonical_username])
        )
    ).all()

    for unread_message in unread_candidates:
        sender_norm = str(unread_message.sender or "").strip().casefold()
        receiver_norm = str(unread_message.receiver or "").strip().casefold()

        if (
            sender_norm == normalized_friend
            and receiver_norm == normalized_username
        ):
            unread_message.unread = 0
            unread_message.seen_in_chat = 1

    db.commit()
    db.close()

    return result

@app.get("/dashboard-data")
async def dashboard_data(request: Request):
    """Return dashboard conversation data with batched Message queries."""
    current_user = get_authenticated_username(request)
    if not current_user:
        return {"success": False, "error": "Not logged in", "users": []}

    db = SessionLocal()
    try:
        users = db.query(User).all()

        peer_expr = case(
            (Message.sender == current_user, Message.receiver),
            else_=Message.sender
        )

        latest_ids = (
            db.query(
                peer_expr.label("peer"),
                func.max(Message.id).label("last_id")
            )
            .filter(
                or_(
                    Message.sender == current_user,
                    Message.receiver == current_user
                )
            )
            .group_by(peer_expr)
            .subquery()
        )

        latest_rows = (
            db.query(Message)
            .join(latest_ids, Message.id == latest_ids.c.last_id)
            .all()
        )

        last_by_user = {
            str(message.sender if message.receiver == current_user else message.receiver): message
            for message in latest_rows
        }

        unread_rows = (
            db.query(
                Message.sender.label("peer"),
                func.count(Message.id).label("unread")
            )
            .filter(
                Message.receiver == current_user,
                Message.unread == 1
            )
            .group_by(Message.sender)
            .all()
        )

        unread_by_user = {
            str(row.peer): int(row.unread or 0)
            for row in unread_rows
        }

        result = []
        for user in users:
            if user.username == current_user:
                continue

            last = last_by_user.get(user.username)
            result.append({
                "username": user.username,
                "display_name": user.display_name or user.username,
                "profile": user.profile_picture,
                "unread": unread_by_user.get(user.username, 0),
                "last": last.text if last else "",
                "sender": last.sender if last else "",
                "time": last.timestamp if last else "",
                "id": last.id if last else 0,
                "media_url": last.media_url if last else None,
                "media_type": last.media_type if last else None
            })

        result.sort(key=lambda item: item["id"], reverse=True)
        return result
    finally:
        db.close()


@app.get("/users")
async def get_users(request: Request):
    # This endpoint is used by the client-side forward-message picker.
    # Require an authenticated session and return only the public fields
    # that the picker actually needs. Never serialize the full User model,
    # which contains password hashes and private crypto/backup material.
    current_username = get_authenticated_username(request)
    if not current_username:
        return {"success": False, "error": "Not logged in"}

    db = SessionLocal()

    try:
        users = (
            db.query(User)
            .order_by(User.username.asc())
            .all()
        )

        return [
            {
                "username": user.username,
                "display_name": user.display_name or user.username,
                "profile_picture": user.profile_picture
                    or "/static/profile/default.png",
            }
            for user in users
        ]
    finally:
        db.close()

@app.post("/upload-chat-image")
async def upload_chat_image(
    request: Request,
    file: UploadFile = File(...)
):
    username = request.session.get("username")

    if not username:
        return {"error": "Not logged in"}

    allowed_types = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp"
    }

    if file.content_type not in allowed_types:
        return {"error": "Only PNG, JPEG, and WebP images are allowed"}

    max_size = 5 * 1024 * 1024

    data = await file.read(max_size + 1)

    if len(data) > max_size:
        return {"error": "Image is too large. Maximum size is 5 MB"}

    extension = allowed_types[file.content_type]

    filename = (
        f"{_storage_user_key(username)}_{datetime.now().strftime('%Y%m%d%H%M%S%f')}"
        f"{extension}"
    )

    filepath = UPLOAD_DIR / filename

    with open(filepath, "wb") as buffer:
        buffer.write(data)

    return {
        "success": True,
        "url": "/static/uploads/chat/" + filename,
        "media_type": "image"
    }


@app.post("/upload-chat-video")
async def upload_chat_video(
    request: Request,
    file: UploadFile = File(...)
):
    """Stream a chat video to disk with bounded memory usage."""
    username = request.session.get("username")

    if not username:
        return {"success": False, "error": "Not logged in"}

    allowed_types = {
        "video/mp4": ".mp4",
        "video/webm": ".webm",
        "video/ogg": ".ogv",
    }

    content_type = (file.content_type or "").split(";", 1)[0].strip().lower()

    if content_type not in allowed_types:
        return {
            "success": False,
            "error": "Only MP4, WebM, and OGG videos are allowed"
        }

    max_size = 30 * 1024 * 1024
    chunk_size = 1024 * 1024  # 1 MiB
    filename = (
        f"{_storage_user_key(username)}_{datetime.now().strftime('%Y%m%d%H%M%S%f')}"
        f"{allowed_types[content_type]}"
    )
    filepath = UPLOAD_DIR / filename

    total = 0
    signature = bytearray()

    try:
        with open(filepath, "wb") as buffer:
            while True:
                chunk = await file.read(chunk_size)
                if not chunk:
                    break

                total += len(chunk)

                if total > max_size:
                    raise ValueError("Video is too large. Maximum size is 30 MB")

                # Keep only enough bytes to validate the container signature.
                if len(signature) < 16:
                    signature.extend(chunk[:16 - len(signature)])

                buffer.write(chunk)

        if total == 0:
            raise ValueError("Empty video file")

        header = bytes(signature)
        valid = False

        if content_type == "video/mp4":
            # MP4 uses an ftyp box near the beginning of the file.
            valid = len(header) >= 12 and header[4:8] == b"ftyp"
        elif content_type == "video/webm":
            valid = header.startswith(b"\x1a\x45\xdf\xa3")
        elif content_type == "video/ogg":
            valid = header.startswith(b"OggS")

        if not valid:
            raise ValueError("Invalid video file")

        return {
            "success": True,
            "url": "/static/uploads/chat/" + filename,
            "media_type": "video"
        }

    except ValueError as exc:
        try:
            filepath.unlink(missing_ok=True)
        except Exception:
            pass
        return {"success": False, "error": str(exc)}

    except Exception as exc:
        try:
            filepath.unlink(missing_ok=True)
        except Exception:
            pass
        print("VIDEO UPLOAD ERROR:", exc)
        traceback.print_exc()
        return {"success": False, "error": "Could not save video"}

    finally:
        try:
            await file.close()
        except Exception:
            pass


@app.post("/upload-chat-audio")
async def upload_chat_audio(request: Request):
    """Receive a voice recording as the raw request body.

    Using a raw audio body avoids multipart-upload issues that can occur
    through HTTPS tunnels on some mobile/browser setups.
    """
    username = request.session.get("username")

    if not username:
        return {"error": "Not logged in"}

    allowed_types = {
        "audio/webm": ".webm",
        "audio/ogg": ".ogg",
        "audio/mp4": ".m4a",
        "audio/mpeg": ".mp3",
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
    }

    content_type = (request.headers.get("content-type") or "")
    content_type = content_type.split(";", 1)[0].strip().lower()

    if content_type not in allowed_types:
        return {"error": f"Unsupported audio format: {content_type or 'unknown'}"}

    max_size = 10 * 1024 * 1024
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > max_size:
                return {"error": "Voice message is too large. Maximum size is 10 MB"}
        except ValueError:
            return {"error": "Invalid content length"}

    data = await request.body()

    if len(data) > max_size:
        return {"error": "Voice message is too large. Maximum size is 10 MB"}

    if not data:
        return {"error": "Empty audio file"}

    # Basic container/signature validation.
    valid = False

    if content_type == "audio/webm":
        valid = data.startswith(b"\x1a\x45\xdf\xa3")
    elif content_type == "audio/ogg":
        valid = data.startswith(b"OggS")
    elif content_type == "audio/mp4":
        valid = len(data) >= 12 and data[4:8] == b"ftyp"
    elif content_type == "audio/mpeg":
        valid = data.startswith(b"ID3") or (
            len(data) >= 2 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0
        )
    elif content_type in ("audio/wav", "audio/x-wav"):
        valid = (
            len(data) >= 12
            and data[:4] == b"RIFF"
            and data[8:12] == b"WAVE"
        )

    if not valid:
        return {"error": "Invalid audio file"}

    extension = allowed_types[content_type]
    filename = (
        f"{_storage_user_key(username)}_{datetime.now().strftime('%Y%m%d%H%M%S%f')}"
        f"{extension}"
    )

    filepath = UPLOAD_DIR / filename
    with open(filepath, "wb") as buffer:
        buffer.write(data)

    return {
        "success": True,
        "url": "/static/uploads/chat/" + filename,
        "media_type": "audio"
    }


# ---------------------------------------------------------
# SERVER-PERSISTENT DASHBOARD PINNED CHATS
# ---------------------------------------------------------
PINNED_CHATS_FILE = Path("data/pinned_chats.json")
PINNED_CHATS_FILE.parent.mkdir(parents=True, exist_ok=True)


def _load_pinned_chats():
    try:
        if not PINNED_CHATS_FILE.exists():
            return {}
        with open(PINNED_CHATS_FILE, "r", encoding="utf-8") as f:
            value = json.load(f)
        return value if isinstance(value, dict) else {}
    except Exception as e:
        print("PINNED CHAT LOAD ERROR:", e)
        return {}


def _save_pinned_chats(value):
    tmp = PINNED_CHATS_FILE.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
    os.replace(tmp, PINNED_CHATS_FILE)


@app.get("/pinned-chats")
async def get_pinned_chats(request: Request):
    username = request.session.get("username")
    if not username:
        return {"success": False, "pinned": []}

    data = _load_pinned_chats()
    pinned = data.get(username, [])
    if not isinstance(pinned, list):
        pinned = []

    return {"success": True, "pinned": pinned}


@app.post("/pinned-chats")
async def set_pinned_chat(request: Request):
    username = request.session.get("username")
    if not username:
        return {"success": False, "error": "Not logged in"}

    try:
        body = await request.json()
    except Exception:
        return {"success": False, "error": "Invalid request"}

    friend = str(body.get("friend", "")).strip()
    pinned = bool(body.get("pinned", False))

    if not friend:
        return {"success": False, "error": "Missing friend"}

    data = _load_pinned_chats()
    current = data.get(username, [])
    if not isinstance(current, list):
        current = []

    if pinned:
        if friend in current:
            current.remove(friend)
        current.insert(0, friend)
    else:
        current = [x for x in current if x != friend]

    data[username] = current
    _save_pinned_chats(data)

    return {"success": True, "pinned": current}


@app.get("/online")
async def online_users(request: Request):
    # Online presence is not public account data. Only authenticated users
    # may query it, and accounts that disabled Online Status must remain hidden.
    username = get_authenticated_username(request)
    if not username:
        return {"success": False, "error": "Not logged in", "users": []}

    db = SessionLocal()
    try:
        connected = set(manager.connections.keys())
        if not connected:
            return []

        rows = db.query(User.username).filter(User.username.in_(connected)).all()
        usernames = [row[0] for row in rows]
        enabled_users = []

        for name in usernames:
            if str(name).strip().casefold() == str(username).strip().casefold():
                enabled_users.append(name)
                continue

            row = db.execute(
                sqlalchemy_text(
                    "SELECT online_status_enabled "
                    "FROM users WHERE username = :username"
                ),
                {"username": name}
            ).first()

            enabled = True
            if row is not None and row[0] is not None:
                enabled = bool(int(row[0]))

            if enabled:
                enabled_users.append(name)

        return enabled_users
    finally:
        db.close()

@app.get("/user-status/{friend}")
async def user_status(friend: str, request: Request):
    current_username = get_authenticated_username(request)
    if not current_username:
        return {"online": False, "last_seen": None, "hidden": True}

    db = SessionLocal()

    try:
        user = resolve_user_by_username(db, friend)

        if not user:
            return {
                "online": False,
                "last_seen": None
            }

        # Online Status is privacy-controlled per account.
        enabled = True
        row = db.execute(
            sqlalchemy_text(
                "SELECT online_status_enabled "
                "FROM users WHERE id = :user_id"
            ),
            {"user_id": user.id}
        ).first()

        if row is not None and row[0] is not None:
            enabled = bool(int(row[0]))

        # Users can always see their own status locally.
        if current_username != user.username and not enabled:
            db.close()
            return {
                "online": False,
                "last_seen": None,
                "hidden": True
            }

        canonical_friend = user.username
        is_online = canonical_friend in manager.connections

        last_seen = None
        if user.last_seen:
            last_seen = user.last_seen.isoformat()

        return {
            "online": is_online,
            "last_seen": last_seen
        }
    finally:
        db.close()



# ---------------------------------------------------------
# LUCKY CHAT STATUS / STORIES
# ---------------------------------------------------------

STATUS_MAX_SIZE = 25 * 1024 * 1024
STATUS_LIFETIME = timedelta(hours=24)



def status_timestamp_iso(value):
    """Serialize stored status timestamps as explicit UTC ISO-8601 strings."""
    if value is None:
        return None
    if value.tzinfo is None:
        return value.isoformat(timespec="milliseconds") + "Z"
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

STATUS_ALLOWED_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}


@app.post("/upload-status")
async def upload_status(
    request: Request,
    file: UploadFile = File(...),
    text: str = Form("")
):
    username = request.session.get("username")

    if not username:
        return {"success": False, "error": "Not logged in"}

    if file.content_type not in STATUS_ALLOWED_TYPES:
        return {
            "success": False,
            "error": "Only PNG, JPEG, and WebP images are allowed"
        }

    text = (text or "").strip()
    if len(text) > 5000:
        return {
            "success": False,
            "error": "Status text is too long. Maximum size is 5000 characters"
        }

    data = await file.read(STATUS_MAX_SIZE + 1)

    if len(data) > STATUS_MAX_SIZE:
        return {
            "success": False,
            "error": "Status image is too large. Maximum size is 25 MB"
        }

    if not data:
        return {"success": False, "error": "Empty image"}

    # Verify the actual file signature before saving it.
    valid = False

    if file.content_type == "image/png":
        valid = data.startswith(b"\x89PNG\r\n\x1a\n")
    elif file.content_type == "image/jpeg":
        valid = data.startswith(b"\xff\xd8\xff")
    elif file.content_type == "image/webp":
        valid = (
            len(data) >= 12
            and data[:4] == b"RIFF"
            and data[8:12] == b"WEBP"
        )

    if not valid:
        return {"success": False, "error": "Invalid image file"}

    now = datetime.utcnow()
    filename = (
        f"{_storage_user_key(username)}_{now.strftime('%Y%m%d%H%M%S%f')}"
        f"{STATUS_ALLOWED_TYPES[file.content_type]}"
    )

    filepath = STATUS_UPLOAD_DIR / filename

    with open(filepath, "wb") as buffer:
        buffer.write(data)

    db = SessionLocal()

    try:
        # Remove expired records while the status list is being updated.
        db.query(Status).filter(Status.expires_at <= now).delete(
            synchronize_session=False
        )

        status = Status(
            username=username,
            text=text or None,
            media_url="/static/uploads/status/" + filename,
            media_type="image",
            created_at=now,
            expires_at=now + STATUS_LIFETIME,
        )

        db.add(status)
        db.commit()
        db.refresh(status)

        return {
            "success": True,
            "status": {
                "id": status.id,
                "username": status.username,
                "text": status.text or "",
                "media_url": status.media_url,
                "media_type": status.media_type,
                "created_at": status_timestamp_iso(status.created_at),
                "expires_at": status_timestamp_iso(status.expires_at),
            }
        }

    except Exception as e:
        db.rollback()
        try:
            filepath.unlink(missing_ok=True)
        except Exception:
            pass

        print("STATUS UPLOAD ERROR:", e)
        traceback.print_exc()
        return {"success": False, "error": "Could not save status"}

    finally:
        db.close()


@app.get("/statuses")
async def get_statuses(request: Request):
    username = request.session.get("username")

    if not username:
        return {"success": False, "error": "Not logged in", "statuses": []}

    now = datetime.utcnow()
    db = SessionLocal()

    try:
        # Expired statuses are no longer returned.
        db.query(Status).filter(Status.expires_at <= now).delete(
            synchronize_session=False
        )
        db.commit()

        statuses = (
            db.query(Status)
            .filter(Status.expires_at > now)
            .order_by(Status.created_at.desc())
            .all()
        )

        result = []

        for status in statuses:
            result.append({
                "id": status.id,
                "username": status.username,
                "text": status.text or "",
                "media_url": status.media_url,
                "media_type": status.media_type,
                "created_at": status_timestamp_iso(status.created_at),
                "expires_at": status_timestamp_iso(status.expires_at),
                "is_mine": status.username == username,
            })

        return {"success": True, "statuses": result}

    finally:
        db.close()


@app.get("/statuses/{status_id}/engagement")
async def get_status_engagement(status_id: int, request: Request):
    """Return authoritative viewers, likes, and private replies for the owner."""
    username = request.session.get("username")
    if not username:
        return {"success": False, "error": "Not logged in"}

    db = SessionLocal()
    try:
        status = db.query(Status).filter(Status.id == status_id).first()
        if not status:
            return {"success": False, "error": "Status not found"}

        if status.username != username:
            return {
                "success": False,
                "error": "Only the status owner can view engagement"
            }

        if status.expires_at and status.expires_at <= datetime.utcnow():
            return {"success": False, "error": "Status has expired"}

        views = (
            db.query(StatusView)
            .filter(StatusView.status_id == status_id)
            .order_by(StatusView.seen_at.desc())
            .all()
        )
        likes = (
            db.query(StatusLike)
            .filter(StatusLike.status_id == status_id)
            .order_by(StatusLike.created_at.desc())
            .all()
        )
        replies = (
            db.query(StatusReply)
            .filter(StatusReply.status_id == status_id)
            .order_by(StatusReply.replied_at.desc())
            .all()
        )

        usernames = {
            str(row.username).strip()
            for row in [*views, *likes, *replies]
            if getattr(row, "username", None)
        }

        profiles = {}
        if usernames:
            users = db.query(User).filter(
                User.username.in_(list(usernames))
            ).all()
            profiles = {
                user.username: {
                    "display_name": user.display_name or user.username,
                    "profile_picture": (
                        user.profile_picture or
                        "/static/profile/default.png"
                    ),
                }
                for user in users
            }

        like_users = {
            str(row.username).strip().casefold()
            for row in likes
        }

        reply_by_user = {}
        for reply in replies:
            key = str(reply.username).strip().casefold()
            if key not in reply_by_user:
                reply_by_user[key] = reply

        def person(username_value):
            raw = str(username_value or "").strip()
            profile = profiles.get(raw, {})
            return {
                "username": raw,
                "display_name": profile.get("display_name") or raw,
                "profile_picture": profile.get(
                    "profile_picture",
                    "/static/profile/default.png"
                ),
            }

        viewer_items = []
        for view in views:
            key = str(view.username).strip().casefold()
            viewer_items.append({
                **person(view.username),
                "seen_at": status_timestamp_iso(view.seen_at),
                "liked": key in like_users,
                "replied": key in reply_by_user,
            })

        liker_items = [
            {
                **person(row.username),
                "liked_at": status_timestamp_iso(row.created_at),
            }
            for row in likes
        ]

        reply_items = [
            {
                **person(row.username),
                "replied_at": status_timestamp_iso(row.replied_at),
                "encrypted_text": row.encrypted_text,
            }
            for row in replies
        ]

        return {
            "success": True,
            "status_id": status_id,
            "views": len(viewer_items),
            "likes": len(liker_items),
            "replies": len(reply_items),
            "viewers": viewer_items,
            "likers": liker_items,
            "replies_list": reply_items,
        }
    finally:
        db.close()


@app.post("/statuses/{status_id}/view")
async def record_status_view(status_id: int, request: Request):
    """Record one unique viewer per status and notify the owner."""
    username = request.session.get("username")
    if not username:
        return {"success": False, "error": "Not logged in"}

    db = SessionLocal()
    try:
        status = db.query(Status).filter(Status.id == status_id).first()
        if not status:
            return {"success": False, "error": "Status not found"}

        if status.username == username:
            return {
                "success": False,
                "error": "You cannot record a view on your own status"
            }

        if status.expires_at and status.expires_at <= datetime.utcnow():
            return {"success": False, "error": "Status has expired"}

        seen_at = datetime.utcnow()
        view = (
            db.query(StatusView)
            .filter(
                StatusView.status_id == status_id,
                StatusView.username == username
            )
            .first()
        )

        created = view is None
        if view is None:
            view = StatusView(
                status_id=status_id,
                username=username,
                seen_at=seen_at,
            )
            db.add(view)
        else:
            view.seen_at = seen_at

        db.commit()
        db.refresh(view)

        viewer = resolve_user_by_username(db, username)
        await manager.send_dashboard(
            status.username,
            {
                "type": "status_view",
                "status_id": status_id,
                "viewer": username,
                "username": username,
                "display_name": viewer.display_name if viewer else username,
                "profile_picture": (
                    viewer.profile_picture
                    if viewer and viewer.profile_picture
                    else "/static/profile/default.png"
                ),
                "seen_at": status_timestamp_iso(view.seen_at),
                "new_viewer": created,
            }
        )

        return {
            "success": True,
            "viewed": True,
            "new_viewer": created,
            "seen_at": status_timestamp_iso(view.seen_at),
        }
    except Exception as exc:
        db.rollback()
        print("STATUS VIEW ERROR:", exc)
        traceback.print_exc()
        return {"success": False, "error": "Could not record status view"}
    finally:
        db.close()


@app.post("/statuses/{status_id}/like")
async def record_status_like(
    status_id: int,
    data: StatusLikePayload,
    request: Request
):
    """Persist or remove one viewer's like on a status."""
    username = request.session.get("username")
    if not username:
        return {"success": False, "error": "Not logged in"}

    db = SessionLocal()
    try:
        status = db.query(Status).filter(Status.id == status_id).first()
        if not status:
            return {"success": False, "error": "Status not found"}

        if status.username == username:
            return {
                "success": False,
                "error": "You cannot like your own status"
            }

        if status.expires_at and status.expires_at <= datetime.utcnow():
            return {"success": False, "error": "Status has expired"}

        # A like implies the status was viewed, so make the two datasets
        # consistent even when the like request arrives before the view call.
        view = (
            db.query(StatusView)
            .filter(
                StatusView.status_id == status_id,
                StatusView.username == username
            )
            .first()
        )
        if view is None:
            db.add(StatusView(
                status_id=status_id,
                username=username,
                seen_at=datetime.utcnow()
            ))

        liked = bool(data.liked)
        row = (
            db.query(StatusLike)
            .filter(
                StatusLike.status_id == status_id,
                StatusLike.username == username
            )
            .first()
        )

        if liked and row is None:
            db.add(StatusLike(
                status_id=status_id,
                username=username
            ))
        elif not liked and row is not None:
            db.delete(row)

        db.commit()

        like_count = (
            db.query(StatusLike)
            .filter(StatusLike.status_id == status_id)
            .count()
        )

        viewer = resolve_user_by_username(db, username)
        await manager.send_dashboard(
            status.username,
            {
                "type": "status_like" if liked else "status_unlike",
                "status_id": status_id,
                "viewer": username,
                "username": username,
                "display_name": viewer.display_name if viewer else username,
                "profile_picture": (
                    viewer.profile_picture
                    if viewer and viewer.profile_picture
                    else "/static/profile/default.png"
                ),
                "liked": liked,
                "like_count": like_count,
            }
        )

        return {
            "success": True,
            "liked": liked,
            "likes": like_count,
        }
    except Exception as exc:
        db.rollback()
        print("STATUS LIKE ERROR:", exc)
        traceback.print_exc()
        return {"success": False, "error": "Could not update status like"}
    finally:
        db.close()


@app.post("/statuses/{status_id}/reply")
async def record_status_reply(
    status_id: int,
    data: StatusReplyPayload,
    request: Request
):
    """Persist a private reply as ciphertext, never plaintext."""
    username = request.session.get("username")
    if not username:
        return {"success": False, "error": "Not logged in"}

    encrypted_text = (data.encrypted_text or "").strip()
    if not encrypted_text:
        return {"success": False, "error": "Reply is required"}
    if len(encrypted_text) > 200_000:
        return {"success": False, "error": "Reply is too large"}
    if not (
        encrypted_text.startswith("LCE1:") or
        encrypted_text.startswith("LCE2:")
    ):
        return {"success": False, "error": "Encrypted reply required"}

    db = SessionLocal()
    try:
        status = db.query(Status).filter(Status.id == status_id).first()
        if not status:
            return {"success": False, "error": "Status not found"}

        if status.username == username:
            return {
                "success": False,
                "error": "You cannot reply to your own status"
            }

        if status.expires_at and status.expires_at <= datetime.utcnow():
            return {"success": False, "error": "Status has expired"}

        # A reply also implies a view, keeping the viewer and engagement
        # datasets internally consistent.
        view = (
            db.query(StatusView)
            .filter(
                StatusView.status_id == status_id,
                StatusView.username == username
            )
            .first()
        )
        if view is None:
            db.add(StatusView(
                status_id=status_id,
                username=username,
                seen_at=datetime.utcnow()
            ))

        replied_at = datetime.utcnow()
        reply = StatusReply(
            status_id=status_id,
            username=username,
            encrypted_text=encrypted_text,
            replied_at=replied_at
        )
        db.add(reply)

        # Persist the private reply as a first-class chat message too. The
        # message body stays encrypted; these fields identify it as a reply
        # to this status so the chat UI can render it distinctly.
        chat_message = Message(
            sender=username,
            receiver=status.username,
            text=encrypted_text,
            timestamp=utc_now_iso(),
            unread=1,
            seen_in_chat=0,
            delivered=0,
            read=0,
            reply_to=None,
            media_url=None,
            media_type=None,
            media_duration=0,
            media_waveform=None,
            forwarded=0,
            status_reply=1,
            status_reply_status_id=status_id,
            status_reply_owner=status.username,
        )
        db.add(chat_message)
        db.commit()
        db.refresh(reply)
        db.refresh(chat_message)

        sender = resolve_user_by_username(db, username)
        reply_count = (
            db.query(StatusReply)
            .filter(StatusReply.status_id == status_id)
            .count()
        )

        await manager.send_dashboard(
            status.username,
            {
                "type": "status_reply",
                "status_id": status_id,
                "viewer": username,
                "username": username,
                "display_name": sender.display_name if sender else username,
                "profile_picture": (
                    sender.profile_picture
                    if sender and sender.profile_picture
                    else "/static/profile/default.png"
                ),
                "replied_at": status_timestamp_iso(reply.replied_at),
                "encrypted_text": reply.encrypted_text,
                "replies": reply_count,
            }
        )

        chat_payload = {
            "type": "message",
            "id": chat_message.id,
            "sender": chat_message.sender,
            "receiver": chat_message.receiver,
            "text": chat_message.text,
            "timestamp": chat_message.timestamp,
            "delivered": chat_message.delivered,
            "read": chat_message.read,
            "reply_to": None,
            "media_url": None,
            "media_type": None,
            "media_duration": 0,
            "media_waveform": None,
            "forwarded": False,
            "status_reply": True,
            "status_reply_status_id": status_id,
            "status_reply_owner": status.username,
        }
        await manager.send(status.username, chat_payload)
        await manager.send(username, chat_payload)

        return {
            "success": True,
            "reply_id": reply.id,
            "message_id": chat_message.id,
            "replies": reply_count,
        }
    except Exception as exc:
        db.rollback()
        print("STATUS REPLY ERROR:", exc)
        traceback.print_exc()
        return {"success": False, "error": "Could not save status reply"}
    finally:
        db.close()


@app.delete("/statuses/{status_id}")
async def delete_status(status_id: int, request: Request):
    username = request.session.get("username")

    if not username:
        return {"success": False, "error": "Not logged in"}

    db = SessionLocal()

    try:
        status = db.query(Status).filter(Status.id == status_id).first()

        if not status:
            return {"success": False, "error": "Status not found"}

        if status.username != username:
            return {"success": False, "error": "You can only delete your own status"}

        media_url = status.media_url

        # Remove all engagement records with the status so no stale views,
        # likes, or replies survive after the status is deleted.
        db.query(StatusView).filter(
            StatusView.status_id == status_id
        ).delete(synchronize_session=False)
        db.query(StatusLike).filter(
            StatusLike.status_id == status_id
        ).delete(synchronize_session=False)
        db.query(StatusReply).filter(
            StatusReply.status_id == status_id
        ).delete(synchronize_session=False)

        db.delete(status)
        db.commit()

        if media_url and media_url.startswith("/static/uploads/status/"):
            filename = media_url.rsplit("/", 1)[-1]
            try:
                (STATUS_UPLOAD_DIR / filename).unlink(missing_ok=True)
            except Exception:
                pass

        return {"success": True}

    except Exception as e:
        db.rollback()
        print("STATUS DELETE ERROR:", e)
        traceback.print_exc()
        return {"success": False, "error": "Could not delete status"}

    finally:
        db.close()



# PWA root files

@app.get("/manifest.json")
async def pwa_manifest():
    return FileResponse("manifest.json", media_type="application/manifest+json")

@app.get("/service-worker.js")
async def pwa_service_worker():
    return FileResponse("service-worker.js", media_type="application/javascript")

@app.get("/offline.html")
async def pwa_offline():
    return FileResponse("offline.html", media_type="text/html")


@app.get("/settings/online-status")
async def get_online_status_setting(request: Request):
    """Return the signed-in account's server-side Online Status preference."""
    username = request.session.get("username")
    if not username:
        return {"success": False, "error": "Not logged in"}

    db = SessionLocal()
    try:
        user = resolve_user_by_username(db, username)
        if not user:
            return {"success": False, "error": "User not found"}

        enabled = True
        row = db.execute(
            sqlalchemy_text(
                "SELECT online_status_enabled "
                "FROM users WHERE id = :user_id"
            ),
            {"user_id": user.id}
        ).first()
        if row is not None and row[0] is not None:
            enabled = bool(int(row[0]))

        return {"success": True, "enabled": enabled}
    finally:
        db.close()


@app.post("/settings/online-status")
async def set_online_status_setting(
    data: OnlineStatusPayload,
    request: Request
):
    """Persist the signed-in account's Online Status preference."""
    username = request.session.get("username")
    if not username:
        return {"success": False, "error": "Not logged in"}

    db = SessionLocal()
    try:
        user = resolve_user_by_username(db, username)
        if not user:
            return {"success": False, "error": "User not found"}

        value = 1 if data.enabled else 0
        db.execute(
            sqlalchemy_text(
                "UPDATE users "
                "SET online_status_enabled = :value "
                "WHERE id = :user_id"
            ),
            {"value": value, "user_id": user.id}
        )
        db.commit()
        return {"success": True, "enabled": bool(value)}
    except Exception as exc:
        db.rollback()
        print("ONLINE STATUS SETTING ERROR:", exc)
        traceback.print_exc()
        return {"success": False, "error": "Could not save Online Status setting"}
    finally:
        db.close()


@app.post("/settings/change-password")
async def change_password(
    data: ChangePasswordPayload,
    request: Request
):
    # Change the signed-in user's password after verifying the current password.
    username = request.session.get("username")
    if not username:
        return {"success": False, "error": "Not logged in"}

    current_password = str(data.current_password or "")
    new_password = str(data.new_password or "")

    if not current_password:
        return {"success": False, "error": "Current password is required"}

    if len(new_password) < 8 or len(new_password) > 256:
        return {"success": False, "error": "New password must be 8-256 characters"}

    if current_password == new_password:
        return {"success": False, "error": "New password must be different from the current password"}

    db = SessionLocal()
    try:
        user = resolve_user_by_username(db, username)
        if not user:
            return {"success": False, "error": "User not found"}

        if not verify_password(current_password, user.password):
            return {"success": False, "error": "Current password is incorrect"}

        user.password = hash_password(new_password)
        db.commit()
        return {"success": True}
    except Exception as exc:
        db.rollback()
        print("CHANGE PASSWORD ERROR:", exc)
        traceback.print_exc()
        return {"success": False, "error": "Could not change password"}
    finally:
        db.close()

@app.get("/settings/read-receipts")
async def get_read_receipts_setting(request: Request):
    """Return the signed-in account's server-side Read Receipts preference."""
    username = request.session.get("username")
    if not username:
        return {"success": False, "error": "Not logged in"}

    db = SessionLocal()
    try:
        user = resolve_user_by_username(db, username)
        if not user:
            return {"success": False, "error": "User not found"}

        enabled = True
        try:
            value = getattr(user, "read_receipts_enabled", None)
            if value is not None:
                enabled = bool(int(value))
        except Exception:
            pass

        # For compatibility with deployments where the ORM model has not
        # been regenerated yet, read the column directly when available.
        try:
            row = db.execute(
                sqlalchemy_text(
                    "SELECT read_receipts_enabled "
                    "FROM users WHERE id = :user_id"
                ),
                {"user_id": user.id}
            ).first()
            if row is not None and row[0] is not None:
                enabled = bool(int(row[0]))
        except Exception:
            pass

        return {"success": True, "enabled": enabled}
    finally:
        db.close()


@app.post("/settings/read-receipts")
async def set_read_receipts_setting(
    data: ReadReceiptsPayload,
    request: Request
):
    """Persist the signed-in account's Read Receipts preference on the server."""
    username = request.session.get("username")
    if not username:
        return {"success": False, "error": "Not logged in"}

    db = SessionLocal()
    try:
        user = resolve_user_by_username(db, username)
        if not user:
            return {"success": False, "error": "User not found"}

        value = 1 if data.enabled else 0
        db.execute(
            sqlalchemy_text(
                "UPDATE users "
                "SET read_receipts_enabled = :value "
                "WHERE id = :user_id"
            ),
            {"value": value, "user_id": user.id}
        )
        db.commit()

        return {"success": True, "enabled": bool(value)}
    except Exception as exc:
        db.rollback()
        print("READ RECEIPTS SETTING ERROR:", exc)
        traceback.print_exc()
        return {"success": False, "error": "Could not save Read Receipts setting"}
    finally:
        db.close()


@app.get("/settings", response_class=HTMLResponse)
async def settings(request: Request):
    """Render the Lucky Chat settings page for the signed-in user."""
    username = request.session.get("username")

    if not username:
        return RedirectResponse("/login", status_code=303)

    return templates.TemplateResponse(
        request=request,
        name="settings.html",
        context={
            "request": request,
            "username": username
        }
    )

@app.get("/profile", response_class=HTMLResponse)
async def profile(request: Request):

    username = get_authenticated_username(request)
    if not username:
        return RedirectResponse("/login", status_code=303)

    db = SessionLocal()

    user = db.query(User).filter(
        User.username == username
    ).first()

    db.close()

    return templates.TemplateResponse(
        request=request,
        name="profile.html",
        context={
            "request": request,
            "user": user
        }
    )

@app.post("/upload-profile")
async def upload_profile(
    request: Request,
    file: UploadFile = File(...)
):
    username = request.session.get("username")

    if not username:
        return RedirectResponse(
            "/login",
            status_code=303
        )

    # Only allow common image MIME types
    allowed_types = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp"
    }

    content_type = (file.content_type or "").split(";", 1)[0].strip().lower()

    if content_type not in allowed_types:
        return RedirectResponse(
            "/profile?error=invalid_image",
            status_code=303
        )

    # Read at most 10 MB + 1 byte
    max_size = 10 * 1024 * 1024
    try:
        data = await file.read(max_size + 1)
    finally:
        try:
            await file.close()
        except Exception:
            pass

    if len(data) > max_size:
        return RedirectResponse(
            "/profile?error=image_too_large",
            status_code=303
        )

    # Verify the actual file signature
    valid_signatures = {
        "image/png": data.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg": data.startswith(b"\xff\xd8\xff"),
        "image/webp": (
            len(data) >= 12
            and data[:4] == b"RIFF"
            and data[8:12] == b"WEBP"
        )
    }

    if not valid_signatures[content_type]:
        return RedirectResponse(
            "/profile?error=invalid_image",
            status_code=303
        )

    extension = allowed_types[content_type]
    filename = f"{_storage_user_key(username)}{extension}"

    filepath = os.path.join(
        "static",
        "profile",
        filename
    )

    with open(filepath, "wb") as buffer:
        buffer.write(data)

    db = SessionLocal()

    try:
        user = db.query(User).filter(
            User.username == username
        ).first()

        if not user:
            return {
                "success": False,
                "error": "User not found"
            }

        cache_version = int(time.time() * 1000)
        profile_picture_url = (
            "/static/profile/" + filename + "?v=" + str(cache_version)
        )

        user.profile_picture = profile_picture_url
        db.commit()

    except Exception as exc:
        db.rollback()
        print("PROFILE PICTURE DB ERROR:", exc)
        traceback.print_exc()
        return {
            "success": False,
            "error": "Could not save profile picture"
        }
    finally:
        db.close()

    async def broadcast_profile_picture_update():
        try:
            await asyncio.wait_for(
                manager.broadcast_profile_update(
                    username,
                    profile_picture_url
                ),
                timeout=2.0
            )
        except Exception as exc:
            print("PROFILE PICTURE BROADCAST ERROR:", exc)

    asyncio.create_task(broadcast_profile_picture_update())

    return {
        "success": True,
        "profile_picture": profile_picture_url
    }

@app.post("/update-profile")
async def update_profile(
    request: Request,
    display_name: str = Form(""),
    bio: str = Form("")
):
    username = get_authenticated_username(request)
    if not username:
        return RedirectResponse("/login", status_code=303)

    db = SessionLocal()
    try:

        user = db.query(User).filter(
            User.username == username
        ).first()

        if user:
            clean_display_name = (display_name or "").strip()
            clean_bio = (bio or "").strip()

            if len(clean_display_name) > 120:
                return RedirectResponse("/profile?error=display_name_too_long", status_code=303)
            if len(clean_bio) > 5000:
                return RedirectResponse("/profile?error=bio_too_long", status_code=303)

            user.display_name = clean_display_name
            user.bio = clean_bio

            db.commit()

        return RedirectResponse(
            "/profile",
            status_code=303
        )
    finally:
        db.close()

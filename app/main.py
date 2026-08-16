from app.websocket import manager
from app.models import Message
from app.database import engine
from app import models
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from fastapi import Form
from fastapi.responses import RedirectResponse
from app.database import SessionLocal
from app.models import User, Status
from app.auth import hash_password
from app.database import Base, engine
from starlette.middleware.sessions import SessionMiddleware
from sqlalchemy import and_, or_
from fastapi.staticfiles import StaticFiles
from fastapi import UploadFile, File
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
import shutil
import os
import asyncio
import traceback
from pathlib import Path
from .notification import add_subscription

Base.metadata.create_all(bind=engine)

app = FastAPI(title="Lucky Chat v2")

app.mount("/static", StaticFiles(directory="static"), name="static")

UPLOAD_DIR = Path("static/uploads/chat")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

STATUS_UPLOAD_DIR = Path("static/uploads/status")
STATUS_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

app.add_middleware(
    SessionMiddleware,
    secret_key="my_super_secret_key"
)

models.Base.metadata.create_all(bind=engine)

templates = Jinja2Templates(directory="app/templates")

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

@app.post("/subscribe")
async def subscribe(request: Request):
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

    add_subscription(username, subscription)

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
    db = SessionLocal()

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
    db.close()

    return RedirectResponse(url="/login", status_code=303)

@app.get("/dashboard", response_class=HTMLResponse)
async def dashboard(request: Request):
    db = SessionLocal()
    users = db.query(User).all()
    chat_list = []
    last_messages = {}
    unread_counts = {}

    for user in users:

        current_user = request.cookies.get("username")

        count = db.query(Message).filter(
        Message.sender == user.username,
        Message.receiver == request.cookies.get("username"),
        Message.unread == 1
        ).count()

        unread_counts[user.username] = count

        msg = (
        db.query(Message)
        .filter(
        (
            (Message.sender == current_user) &
            (Message.receiver == user.username)
        ) |
        (
            (Message.sender == user.username) &
            (Message.receiver == current_user)
        )
        )
        .order_by(Message.id.desc())
        .first()
        )

        print("USER:", user.username)
        print("MSG :", msg.text if msg else "NO MESSAGE")
        print("TIME:", msg.timestamp if msg else "NO TIME")
        print("----------------")

        last_messages[user.username] = msg

        chat_list.append({
            "user": user,
            "last_message": msg,
            "time": msg.timestamp if msg else ""
        })

        chat_list.sort(
        key=lambda x: x["last_message"].id if x["last_message"] else 0,
        reverse=True
        )

    db.close()

    return templates.TemplateResponse(
    request=request,
    name="dashboard_backup.html",

    context={
        "request": request,
        "chat_list": chat_list,
        "username": request.cookies.get("username"),
        "last_messages": last_messages,
        "unread_counts": unread_counts
    }

)

@app.get("/chat/{friend}", response_class=HTMLResponse)
async def chat(friend: str, request: Request):

    db = SessionLocal()

    user = db.query(User).filter(
        User.username == friend
    ).first()

    db.close()

    return templates.TemplateResponse(
        request=request,
        name="chat.html",
        context={
            "request": request,
            "friend": friend,
            "friend_user": user
        }
    )

from fastapi import Request

@app.post("/login")
async def login_user(
    request: Request,
    username: str = Form(...),
    password: str = Form(...)
):

    db = SessionLocal()

    user = db.query(User).filter(
        User.username == username
    ).first()

    if not user:
        db.close()
        return {"message": "Invalid username or password"}

    from app.auth import verify_password

    if not verify_password(password, user.password):
        db.close()
        return {"message": "Invalid username or password"}

    request.session["username"] = user.username

    response = RedirectResponse(
        url="/dashboard",
        status_code=303
    )

    response.set_cookie("username",
    user.username)

    db.close()

    return response

from fastapi import WebSocket
from app.websocket import manager
import json

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):

    # Authenticate the WebSocket using the signed session cookie.
    # Never trust a username supplied by the browser query string.
    username = websocket.session.get("username")
    if not username:
        await websocket.close(code=1008)
        return

    friend = websocket.query_params.get("friend", "")
    page = websocket.query_params.get("page", "chat")

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

            print("Received:", data)

            if data["type"] == "typing":
                payload = {
                    "type": "typing",
                    "sender": username
                }

                await manager.send_personal(payload, friend)
                continue

            if data["type"] == "stop_typing":
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

                msg = db.query(Message).filter(
       	        Message.id == data["id"]
              	).first()

                if msg and msg.receiver == username:
                    msg.read = 1
                    db.commit()

                    await manager.send(msg.sender, {
                        "type": "read",
                        "id": msg.id
                    })

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
                text = data.get("text", "").strip()
                target = data.get("target", "").strip()

                if not text or not target:
                    continue

                db = SessionLocal()

                target_user = db.query(User).filter(
                    User.username == target
                ).first()

                if not target_user:
                    db.close()
                    continue

                message = Message(
                    sender=username,
                    receiver=friend,
                    text=text,
                    timestamp=datetime.now(ZoneInfo("Asia/Kolkata")).strftime("%I:%M %p"),
                    unread=1,
                    seen_in_chat=0,
                    reply_to=data.get("reply_to"),
                    media_url=media_url,
                    media_type=media_type,
                )

                db.add(message)
                db.commit()
                db.refresh(message)

                print("SAVED SENDER:", message.sender)
                print("SAVED RECEIVER:", message.receiver)

                payload = {
                    "type": "message",
                    "id": message.id,
                    "sender": username,
                    "receiver": target,
                    "text": message.text,
                    "timestamp": message.timestamp,
                    "delivered": message.delivered,
                    "read": message.read,
                    "reply_to": None
                }

                db.close()

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

                await manager.send(username, payload)

                if target != username:
                    await manager.send(target, payload)

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

                text = data.get("text", "").strip()
                media_url = data.get("media_url")
                media_type = data.get("media_type")

                if not text and not media_url:
                    continue

                db = SessionLocal()

                try:
                    message = Message(
                        sender=username,
                        receiver=friend,
                        text=text,
                        timestamp=datetime.now(ZoneInfo("Asia/Kolkata")).strftime("%I:%M %p"),
                        unread=1,
                        seen_in_chat=0,
                        reply_to=data.get("reply_to"),
                        media_url=media_url,
                        media_type=media_type,
                    )

                    db.add(message)
                    db.commit()
                    db.refresh(message)

                    all_msgs = db.query(Message).all()
                    print("TOTAL MESSAGES:", len(all_msgs))
                    for m in all_msgs:
                        print(m.id, m.sender, "->", m.receiver, m.text)

                    print(
                        "MESSAGE SAVED:",
                        message.id,
                        username,
                        "->",
                        friend
                    )

                    payload = {
                        "type": "message",
                        "id": message.id,
                        "sender": username,
                        "receiver": friend,
                        "text": message.text,
                        "timestamp": message.timestamp,
                        "delivered": message.delivered,
                        "read": message.read,
                        "reply_to": message.reply_to,
                        "media_url": message.media_url,
                        "media_type": message.media_type,
                        "media_duration": data.get("media_duration", 0)

                    }

                    # Update dashboard
                    await manager.send_dashboard(
                        friend,
                        {
                            "type": "dashboard_update",
                            "from": username
                        }
                    )

                    await manager.send_dashboard(
                        username,
                        {
                            "type": "dashboard_update",
                            "from": friend
                        }
                    )

                    # Send the message to the current user's chat
                    await manager.send(username, payload)

                    # Send the message to the friend's chat
                    if friend != username:
                        await manager.send(friend, payload)

                except Exception as e:
                    print("MESSAGE ERROR:", e)
                    traceback.print_exc()

                finally:
                    db.close()

                continue

    except WebSocketDisconnect:
            print(f"{username} disconnected")
            await manager.disconnect(username)

@app.websocket("/dashboard_ws")
async def dashboard_ws(websocket: WebSocket):
    # Authenticate the dashboard WebSocket from the signed session.
    username = websocket.session.get("username")
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

    username=request.cookies.get("username")

    print("COOKIE USERNAME =", username, "FRIEND =", friend)

    db=SessionLocal()

    msgs=db.query(Message).filter(

        or_(

            and_(
                Message.sender==username,
                Message.receiver==friend
            ),

            and_(
                Message.sender==friend,
                Message.receiver==username
            )

        )

    ).order_by(Message.id.asc()).all()

    print("USERNAME:", username)
    print("FRIEND:", friend)
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
            "edited": m.edited,
            "reaction": getattr(m, "reaction", ""),
        })

    db.query(Message).filter(
    Message.sender == friend,
    Message.receiver == username,
    Message.unread == 1
    ).update({
        "unread": 0,
        "seen_in_chat": 1
    })

    db.commit()
    db.close()

    return result

@app.get("/dashboard-data")
async def dashboard_data(request: Request):

    db = SessionLocal()

    current_user = request.cookies.get("username")

    users = db.query(User).all()

    result = []

    for user in users:

        if user.username == current_user:
            continue

        unread = db.query(Message).filter(
            Message.sender == user.username,
            Message.receiver == current_user,
            Message.unread == 1
        ).count()

        last = (
            db.query(Message)
            .filter(
                (
                    (Message.sender == current_user) &
                    (Message.receiver == user.username)
                ) |
                (
                    (Message.sender == user.username) &
                    (Message.receiver == current_user)
                )
            )
            .order_by(Message.id.desc())
            .first()
        )

        result.append({
           "username": user.username,
           "profile": user.profile_picture,
           "unread": unread,
           "last": last.text if last else "",
           "sender": last.sender if last else "",
           "time": last.timestamp if last else "",
           "id": last.id if last else 0
        })

    result.sort(key=lambda x: x["id"], reverse=True)

    db.close()

    return result

@app.get("/users")
async def get_users():
    db = SessionLocal()

    users = db.query(User).all()

    db.close()

    return users

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
        f"{username}_{datetime.now().strftime('%Y%m%d%H%M%S%f')}"
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
        f"{username}_{datetime.now().strftime('%Y%m%d%H%M%S%f')}"
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
    import json
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
    import json
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
async def online_users():
    return list(manager.connections.keys())

@app.get("/user-status/{friend}")
async def user_status(friend: str):
    db = SessionLocal()

    user = db.query(User).filter(
        User.username == friend
    ).first()

    if not user:
        db.close()
        return {
            "online": False,
            "last_seen": None
        }

    is_online = friend in manager.connections

    last_seen = None

    if user.last_seen:
        last_seen = user.last_seen.isoformat()

    db.close()

    return {
        "online": is_online,
        "last_seen": last_seen
    }



# ---------------------------------------------------------
# LUCKY CHAT STATUS / STORIES
# ---------------------------------------------------------

STATUS_MAX_SIZE = 10 * 1024 * 1024
STATUS_LIFETIME = timedelta(hours=24)

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

    data = await file.read(STATUS_MAX_SIZE + 1)

    if len(data) > STATUS_MAX_SIZE:
        return {
            "success": False,
            "error": "Status image is too large. Maximum size is 10 MB"
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
        f"{username}_{now.strftime('%Y%m%d%H%M%S%f')}"
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
            text=(text or "").strip() or None,
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
                "created_at": status.created_at.isoformat(),
                "expires_at": status.expires_at.isoformat(),
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
                "created_at": status.created_at.isoformat(),
                "expires_at": status.expires_at.isoformat(),
                "is_mine": status.username == username,
            })

        return {"success": True, "statuses": result}

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
from fastapi.responses import FileResponse

@app.get("/manifest.json")
async def pwa_manifest():
    return FileResponse("manifest.json", media_type="application/manifest+json")

@app.get("/service-worker.js")
async def pwa_service_worker():
    return FileResponse("service-worker.js", media_type="application/javascript")

@app.get("/offline.html")
async def pwa_offline():
    return FileResponse("offline.html", media_type="text/html")

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
    username = request.cookies.get("username")

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

    if file.content_type not in allowed_types:
        return RedirectResponse(
            "/profile?error=invalid_image",
            status_code=303
        )

    # Read at most 5 MB + 1 byte
    max_size = 5 * 1024 * 1024
    data = await file.read(max_size + 1)

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

    if not valid_signatures[file.content_type]:
        return RedirectResponse(
            "/profile?error=invalid_image",
            status_code=303
        )

    extension = allowed_types[file.content_type]
    filename = f"{username}{extension}"

    filepath = os.path.join(
        "static",
        "profile",
        filename
    )

    with open(filepath, "wb") as buffer:
        buffer.write(data)

    db = SessionLocal()

    user = db.query(User).filter(
        User.username == username
    ).first()

    if user:

        user.profile_picture = "/static/profile/" + filename

        db.commit()

    # Tell the user's other open pages that the profile picture changed

    await manager.broadcast_profile_update(
        username,
        user.profile_picture
)

    db.close()

    return RedirectResponse(
        "/profile",
        status_code=303
    )

@app.post("/update-profile")
async def update_profile(
    request: Request,
    display_name: str = Form(""),
    bio: str = Form("")
):
    username = request.session.get("username")

    db = SessionLocal()

    user = db.query(User).filter(
        User.username == username
    ).first()

    if user:
        user.display_name = display_name.strip()
        user.bio = bio.strip()

        db.commit()

    db.close()

    return RedirectResponse(
        "/profile",
        status_code=303
    )

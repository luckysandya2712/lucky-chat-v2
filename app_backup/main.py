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
from app.models import User
from app.auth import hash_password
from app.database import Base, engine
from starlette.middleware.sessions import SessionMiddleware
from sqlalchemy import and_, or_
from fastapi.staticfiles import StaticFiles
from fastapi import UploadFile, File
from datetime import datetime
import shutil
import os
import asyncio
import traceback

Base.metadata.create_all(bind=engine)

app = FastAPI(title="Lucky Chat v2")

app.mount("/static", StaticFiles(directory="static"), name="static")

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

    username = websocket.query_params.get("username", "Guest")
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

            if data["type"] == "delivered":

              db = SessionLocal()

              msg = db.query(Message).filter(Message.id == data["id"]).first()

              if msg:
                 msg.delivered = 1
                 db.commit()

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

                if msg:
                   msg.read = 1
                   db.commit()

                   await manager.send(msg.sender, {
                     "type": "read",
                     "id": msg.id
                })

                db.close()
                continue

            if data["type"] == "delete_everyone":
                db = SessionLocal()

                msg = db.query(Message).filter(
                Message.id == data["id"]
                ).first()

                if msg:
                   msg.text = "🚫 This message was deleted"
                   msg.deleted_for_everyone = 1
                   db.commit()

                   print("READ RECEIVED")
                   print("Sender:", msg.sender)
                   print("Connected users:", manager.active_connections.keys())

                   await manager.send(msg.sender, {
                     "type": "delete_everyone",
                     "id": msg.id,
                     "text": msg.text
                })

                   await manager.send(msg.receiver, {
                     "type": "delete_everyone",
                     "id": msg.id,
                     "text": msg.text
                })

                db.close()
                continue

            if data["type"] == "typing":
               print("Typing from:", username)
               print("Sending typing to:", friend)

               await manager.send(friend, {
                "type": "typing",
                "sender": username
             })
               continue

            if data["type"] == "stop_typing":
               await manager.send(friend, {
                "type": "stop_typing",
                "sender": username
             })
               continue

            reply_to = data.get("reply_to")

            text = data["text"]

            db = SessionLocal()

            message = Message(
            sender=username,
            receiver=friend,
            text=text,
            timestamp=datetime.now().strftime("%I:%M %p"),
            unread=1,
            seen_in_chat=0,
            reply_to=data.get("reply_to")
            )

            db.add(message)
            db.commit()

            print("MESSAGE SENT:", username, "->", friend)

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
                "from": username
            }
            )

            message_id = message.id

            payload = {
                "type": "message",
                "id": message.id,
                "sender": username,
                "receiver": friend,
                "text": text,
                "timestamp": message.timestamp,
                "delivered": message.delivered,
                "read": message.read,
                "reply_to": message.reply_to,
            }

            db.close()

            await manager.send(username, payload)

            # Force the event loop to flush the send

            # Send to receiver if online
            if friend != username:
                await manager.send(friend, payload)

    except WebSocketDisconnect:
        print(f"{username} disconnected")
        await manager.disconnect(username)

    finally:
        await manager.disconnect(username)

@app.websocket("/dashboard_ws/{username}")
async def dashboard_ws(websocket: WebSocket, username: str):
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
            "reply_to": m.reply_to
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

@app.get("/online")
async def online_users():
    return list(manager.connections.keys())

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
    username = request.cookies.get("username")

    filename = f"{username}.png"

    filepath = os.path.join(
        "static",
        "profile",
        filename
    )

    with open(filepath, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    db = SessionLocal()

    user = db.query(User).filter(
        User.username == username
    ).first()

    user.profile_picture = "/static/profile/" + filename

    db.commit()
    db.close()

    return RedirectResponse(
        "/profile",
        status_code=303
    )

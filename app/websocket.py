import json
from datetime import datetime
from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect

from app.database import SessionLocal
from app.models import User

class ConnectionManager:

    def __init__(self):
        self.connections = {}
        self.dashboard_connections = {}

    async def connect(self, username: str, websocket: WebSocket):
        await websocket.accept()

        # Replace an older connection for the same user
        old_ws = self.connections.get(username)

        if old_ws is not None and old_ws is not websocket:
            try:
                await old_ws.close(code=4001)
            except Exception:
                pass

        self.connections[username] = websocket

        print(f"ONLINE: {username}")
        await self.broadcast_online()


    async def disconnect(self, username: str, websocket: WebSocket = None):

        current_ws = self.connections.get(username)

        # Don't let an old socket remove a newer connection
        if current_ws is None:
            return

        if websocket is not None and current_ws is not websocket:
            return

        self.connections.pop(username, None)

        # Save the user's last seen time
        db = SessionLocal()

        try:
            user = db.query(User).filter(
                User.username == username
            ).first()

            if user:
                user.last_seen = datetime.utcnow()
                db.commit()

                print(
                    f"LAST SEEN UPDATED: "
                    f"{username} -> {user.last_seen}"
                )

        except Exception as e:
            print("LAST SEEN UPDATE FAILED:", e)

        finally:
            db.close()

        print(f"OFFLINE: {username}")

        await self.broadcast_online()

    async def send(self, username: str, payload: dict):

        ws = self.connections.get(username)

        if not ws:
            print(
                f"SEND SKIPPED - NO ACTIVE CHAT SOCKET ({username}):",
                payload.get("type")
            )
            return False

        try:
            await ws.send_json(payload)
            return True
        except Exception as e:
            print(f"SEND ERROR ({username}):", e)
            import traceback
            traceback.print_exc()

            # Clean up the failed socket through the same guarded path used
            # by normal WebSocketDisconnect handling. This prevents a dead
            # socket from remaining registered as the user's active connection.
            if self.connections.get(username) is ws:
                await self.disconnect(username, ws)

            return False

    async def send_personal(self, payload: dict, username: str):
        await self.send(username, payload)

    async def send_dashboard(self, username: str, payload: dict):
        print("Dashboard update for:", username)
        print("Connected dashboards:", list(self.dashboard_connections.keys()))

        ws = self.dashboard_connections.get(username)

        if not ws:
          print("NO DASHBOARD CONNECTION:", username)
          return

        try:
          await ws.send_json(payload)
          print("Dashboard update SUCCESS:", username)

        except Exception as e:
          print("Dashboard update FAILED:", username, e)

          # Remove the dead socket
          if self.dashboard_connections.get(username) == ws:
            self.dashboard_connections.pop(username, None)

    async def broadcast_profile_update(self, username, profile_picture):
        payload = {
            "type": "profile_picture_update",
            "username": username,
            "profile": profile_picture
        }

        # Update open chat pages
        dead_chat = []
        for user, ws in list(self.connections.items()):
            try:
                await ws.send_json(payload)
            except Exception:
                if self.connections.get(user) is ws:
                    dead_chat.append((user, ws))

        # Remove failed chat sockets
        for user, ws in dead_chat:
            await self.disconnect(user, ws)

        # Update open dashboards
        dead_dashboards = []
        for user, ws in list(self.dashboard_connections.items()):
            try:
                await ws.send_json(payload)
            except Exception:
                if self.dashboard_connections.get(user) is ws:
                    dead_dashboards.append((user, ws))

        # Remove failed dashboard sockets
        for user, ws in dead_dashboards:
            self.dashboard_connections.pop(user, None)

    async def broadcast_online(self):

        payload = {
            "type": "online",
            "users": list(self.connections.keys())
        }

        dead = []

        for username, ws in list(self.connections.items()):

            try:
                await ws.send_json(payload)

            except Exception:

                # Only remove this socket if it is still
                # the active socket for this username
                if self.connections.get(username) is ws:
                    dead.append((username, ws))

        # Clean up dead connections properly
        for username, ws in dead:
            await self.disconnect(username, ws)

manager = ConnectionManager()

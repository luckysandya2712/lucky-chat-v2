import asyncio
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

        # Documents are persisted first. When a recipient has no active chat
        # socket, keep the live payload queued until that user opens a chat
        # with the sender.
        self.pending_messages = {}
        self.connection_friends = {}

    async def connect(self, username: str, websocket: WebSocket, friend: str = ""):
        await websocket.accept()

        # Replace an older connection for the same user
        old_ws = self.connections.get(username)

        if old_ws is not None and old_ws is not websocket:
            # A half-open old socket can make close() hang; never let that
            # delay the new connection (or its pending-message flush).
            try:
                await asyncio.wait_for(old_ws.close(code=4001), timeout=2)
            except Exception:
                pass

        self.connections[username] = websocket
        self.connection_friends[username] = str(friend or "").strip()

        print(f"ONLINE: {username}")
        await self.broadcast_online()

        # Deliver any documents that were saved while this user had no
        # suitable chat socket. Only flush messages belonging to the chat
        # that was just opened; messages for other chats remain queued.
        if friend:
            await self.flush_pending(username, friend)


    async def disconnect(self, username: str, websocket: WebSocket = None):

        current_ws = self.connections.get(username)

        # Don't let an old socket remove a newer connection
        if current_ws is None:
            return

        if websocket is not None and current_ws is not websocket:
            return

        self.connections.pop(username, None)
        self.connection_friends.pop(username, None)

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

    def queue_pending(self, username: str, payload: dict):
        """Queue a persisted live message until the recipient opens its chat."""
        key = str(username or "").strip()
        if not key:
            return

        queue = self.pending_messages.setdefault(key, [])
        message_id = payload.get("id")

        # Avoid duplicate queue entries when multiple delivery paths report
        # the same persisted message.
        if message_id is not None:
            queue = [
                item for item in queue
                if item.get("id") != message_id
            ]

        queue.append(dict(payload))
        self.pending_messages[key] = queue[-100:]

        print(
            f"PENDING CHAT MESSAGE QUEUED ({key}):",
            payload.get("type"),
            payload.get("id"),
        )

    async def flush_pending(self, username: str, friend: str):
        """Send queued messages belonging to the chat currently being opened."""
        key = str(username or "").strip()
        friend_key = str(friend or "").strip().casefold()

        if not key or not friend_key:
            return

        queue = self.pending_messages.get(key, [])
        if not queue:
            return

        remaining = []
        ws = self.connections.get(key)

        for index, payload in enumerate(queue):
            sender_key = str(payload.get("sender") or "").strip().casefold()
            receiver_key = str(payload.get("receiver") or "").strip().casefold()

            if receiver_key != key.casefold() or sender_key != friend_key:
                remaining.append(payload)
                continue

            if not ws:
                remaining.append(payload)
                continue

            try:
                await ws.send_json(payload)
                print(
                    f"PENDING CHAT MESSAGE DELIVERED ({key}):",
                    payload.get("type"),
                    payload.get("id"),
                )
            except Exception as exc:
                print(f"PENDING CHAT MESSAGE ERROR ({key}):", exc)

                # Keep the failed payload AND everything not yet attempted.
                # Breaking after appending only the failed one silently
                # dropped the rest of the queue.
                remaining.extend(queue[index:])

                # Same dead-socket cleanup as send()/send_chat().
                if self.connections.get(key) is ws:
                    await self.disconnect(key, ws)
                break

        if remaining:
            self.pending_messages[key] = remaining
        else:
            self.pending_messages.pop(key, None)

    async def send_chat(self, username: str, friend: str, payload: dict):
        """Deliver a chat payload only when the recipient has this chat open.

        Generic send() only knows the user's active socket. This guarded path
        also checks which conversation that socket represents, preventing a
        document from being delivered into a different open chat.
        """
        key = str(username or "").strip()
        friend_key = str(friend or "").strip().casefold()

        if not key or not friend_key:
            return False

        ws = self.connections.get(key)
        open_friend = str(self.connection_friends.get(key) or "").strip().casefold()

        # An empty open-friend means the socket is live but the partner was
        # not resolved at connect time. Still deliver so documents are not
        # silently dropped; the client keeps only the current conversation.
        if not ws or (open_friend and open_friend != friend_key):
            print(
                f"CHAT SEND DEFERRED ({key}): "
                f"requested={friend_key!r}, open={open_friend!r}, "
                f"type={payload.get('type')}"
            )
            return False

        try:
            await ws.send_json(payload)
            print(
                f"CHAT SEND SUCCESS ({key} <- {friend_key}):",
                payload.get("type"),
                payload.get("id"),
            )
            return True
        except Exception as e:
            print(f"CHAT SEND ERROR ({key}):", e)
            import traceback
            traceback.print_exc()

            if self.connections.get(key) is ws:
                await self.disconnect(key, ws)

            return False

    async def deliver_or_queue(self, username: str, friend: str, payload: dict):
        """Deliver a persisted chat payload, or queue it until the chat opens."""
        delivered = await self.send_chat(username, friend, payload)
        if delivered:
            return True

        # Always queue when the matching chat is not open. A generic send()
        # may hit a different conversation's socket; queuing first keeps the
        # document available when the correct chat is opened.
        self.queue_pending(username, payload)
        await self.send(username, payload)
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

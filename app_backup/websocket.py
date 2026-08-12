import json
from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect


class ConnectionManager:

    def __init__(self):
        self.connections = {}
        self.dashboard_connections = {}

    async def connect(self, username: str, websocket: WebSocket):
        await websocket.accept()

        self.connections[username] = websocket

        await self.broadcast_online()

    async def disconnect(self, username: str):

        if username in self.connections:
            del self.connections[username]

        await self.broadcast_online()

    async def send(self, username: str, payload: dict):

        ws = self.connections.get(username)

        if ws:
            try:
                await ws.send_json(payload)
            except Exception:
                pass

    async def send_dashboard(self, username: str, payload: dict):
        print("Dashboard update sent to:", username)
        print("Connected dashboards:", self.dashboard_connections.keys())

        ws = self.dashboard_connections.get(username)

        if ws:
           try:
             await ws.send_json(payload)
           except Exception:
             pass

    async def broadcast_online(self):

        payload = {
            "type": "online",
            "users": list(self.connections.keys())
        }

        dead = []

        for username, ws in self.connections.items():

            try:
                await ws.send_json(payload)

            except WebSocketDisconnect:
                dead.append(username)

            except Exception:
                dead.append(username)

        for username in dead:

            self.connections.pop(username, None)


manager = ConnectionManager()

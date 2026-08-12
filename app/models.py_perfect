from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime
from .database import Base

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)

    username = Column(String, unique=True, index=True)
    email = Column(String, unique=True, index=True)

    display_name = Column(String, default="")
    bio = Column(String, default="")

    password = Column(String)

    profile_picture = Column(
        String,
        default="/static/profile/default.png"
    )

    last_seen = Column(DateTime, nullable=True)

class Message(Base):
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, index=True)

    sender = Column(String, index=True)
    receiver = Column(String, index=True)

    text = Column(String)

    media_url = Column(String, nullable=True)
    media_type = Column(String, nullable=True)

    timestamp = Column(String)

    delivered = Column(Integer, default=0)
    read = Column(Integer, default=0)

    unread = Column(Integer, default=1)
    seen_in_chat = Column(Integer, default=0)

    deleted = Column(Integer, default=0)
    deleted_for_everyone = Column(Integer, default=0)
    edited = Column(Integer, default=0)

    reaction = Column(String, default="")

    reply_to = Column(Integer, nullable=True)

    reactions = Column(String, default="{}")


class Status(Base):
    __tablename__ = "statuses"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, index=True)
    text = Column(String, nullable=True)
    media_url = Column(String, nullable=True)
    media_type = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    expires_at = Column(DateTime, index=True)

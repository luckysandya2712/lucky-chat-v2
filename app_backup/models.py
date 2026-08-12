from sqlalchemy import Column, Integer, String
from .database import Base

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)

    username = Column(String, unique=True, index=True)
    email = Column(String, unique=True, index=True)

    password = Column(String)

    profile_picture = Column(
        String,
        default="/static/profile/default.png"
    )

class Message(Base):
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, index=True)

    sender = Column(String, index=True)
    receiver = Column(String, index=True)

    text = Column(String)

    timestamp = Column(String)

    delivered = Column(Integer, default=0)
    read = Column(Integer, default=0)

    unread = Column(Integer, default=1)
    seen_in_chat = Column(Integer, default=0)

    deleted = Column(Integer, default=0)
    deleted_for_everyone = Column(Integer, default=0)

    reply_to = Column(Integer, nullable=True)

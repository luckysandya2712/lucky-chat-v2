from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime, Text, UniqueConstraint, Index
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

    public_key = Column(String, nullable=True)
    public_key_history = Column(Text, nullable=True, default="[]")
    crypto_key_backup = Column(Text, nullable=True)

    # Account-level privacy preferences. main.py already contains runtime
    # migrations for existing databases, so adding these here also keeps fresh
    # database creation aligned with the deployed schema.
    read_receipts_enabled = Column(Integer, default=1, nullable=False)
    online_status_enabled = Column(Integer, default=1, nullable=False)

class Message(Base):
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, index=True)

    sender = Column(String, index=True)
    receiver = Column(String, index=True)

    text = Column(String)

    media_url = Column(String, nullable=True)
    media_type = Column(String, nullable=True)
    media_duration = Column(Integer, nullable=True, default=0)
    media_waveform = Column(Text, nullable=True)

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

    forwarded = Column(Integer, default=0)

    # Composite indexes match the production dashboard/chat query patterns:
    # conversation lookups by participant pair, newest-message lookups, and
    # unread-message counts for a receiver/sender pair.
    __table_args__ = (
        Index(
            "ix_messages_sender_receiver_id",
            "sender",
            "receiver",
            "id",
        ),
        Index(
            "ix_messages_receiver_unread_sender_id",
            "receiver",
            "unread",
            "sender",
            "id",
        ),
        # Reverse participant order for the other side of the conversation
        # lookup. This complements sender/receiver/id above and keeps both
        # directions efficient without changing message behavior.
        Index(
            "ix_messages_receiver_sender_id",
            "receiver",
            "sender",
            "id",
        ),
    )

    # Persistent metadata for messages created by a Status private reply.
    # The reply text itself remains encrypted in the normal `text` column.
    status_reply = Column(Integer, default=0)
    status_reply_status_id = Column(Integer, nullable=True)
    status_reply_owner = Column(String, nullable=True)


class Status(Base):
    __tablename__ = "statuses"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, index=True)
    text = Column(String, nullable=True)
    media_url = Column(String, nullable=True)
    media_type = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    expires_at = Column(DateTime, index=True)

    __table_args__ = (
        # Status listing first filters on expiry and then sorts newest first.
        # This composite index complements the existing expires_at index for
        # the production status-list query.
        Index(
            "ix_statuses_expires_created_id",
            "expires_at",
            "created_at",
            "id",
        ),
    )


class StatusView(Base):
    __tablename__ = "status_views"

    id = Column(Integer, primary_key=True, index=True)
    status_id = Column(Integer, index=True, nullable=False)
    username = Column(String, index=True, nullable=False)
    seen_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    __table_args__ = (
        UniqueConstraint(
            "status_id",
            "username",
            name="uq_status_view_status_user"
        ),
        Index(
            "ix_status_views_status_seen",
            "status_id",
            "seen_at",
        ),
    )


class StatusLike(Base):
    __tablename__ = "status_likes"

    id = Column(Integer, primary_key=True, index=True)
    status_id = Column(Integer, index=True, nullable=False)
    username = Column(String, index=True, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    __table_args__ = (
        UniqueConstraint(
            "status_id",
            "username",
            name="uq_status_like_status_user"
        ),
        Index(
            "ix_status_likes_status_created",
            "status_id",
            "created_at",
        ),
    )


class StatusReply(Base):
    __tablename__ = "status_replies"

    id = Column(Integer, primary_key=True, index=True)
    status_id = Column(Integer, index=True, nullable=False)
    username = Column(String, index=True, nullable=False)
    encrypted_text = Column(Text, nullable=False)
    replied_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    __table_args__ = (
        Index(
            "ix_status_replies_status_replied",
            "status_id",
            "replied_at",
        ),
    )


class PushSubscription(Base):
    __tablename__ = "push_subscriptions"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, index=True, nullable=False)
    endpoint = Column(Text, unique=True, index=True, nullable=False)
    p256dh = Column(Text, nullable=False)
    auth = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)

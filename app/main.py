from pathlib import Path
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import asyncio
import base64
import hashlib
import mimetypes
import hmac
import json
import os
import shutil
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, Form, UploadFile, File
from fastapi.responses import HTMLResponse, RedirectResponse, FileResponse, JSONResponse
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

# Profile uploads live inside the existing persistent Railway Volume at
# /app/static/uploads. The default avatar remains in static/profile.
PROFILE_UPLOAD_DIR = Path("static/uploads/profile")
PROFILE_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# Chat images can use Cloudinary for persistent, shared delivery in production.
# When Cloudinary is not configured, the existing local filesystem behavior is
# preserved for local development.
CLOUDINARY_CLOUD_NAME = os.environ.get("CLOUDINARY_CLOUD_NAME", "").strip()
CLOUDINARY_API_KEY = os.environ.get("CLOUDINARY_API_KEY", "").strip()
CLOUDINARY_API_SECRET = os.environ.get("CLOUDINARY_API_SECRET", "").strip()


def _cloudinary_configured() -> bool:
    return bool(
        CLOUDINARY_CLOUD_NAME
        and CLOUDINARY_API_KEY
        and CLOUDINARY_API_SECRET
    )


def _cloudinary_configuration_error() -> str | None:
    """Return a safe configuration error when Cloudinary variables are incomplete."""
    values = {
        "CLOUDINARY_CLOUD_NAME": CLOUDINARY_CLOUD_NAME,
        "CLOUDINARY_API_KEY": CLOUDINARY_API_KEY,
        "CLOUDINARY_API_SECRET": CLOUDINARY_API_SECRET,
    }
    present = [name for name, value in values.items() if value]
    if not present:
        return None

    missing = [name for name, value in values.items() if not value]
    if missing:
        return (
            "Cloudinary configuration is incomplete. Missing Railway variable(s): "
            + ", ".join(missing)
        )
    return None


def _cloudinary_upload_image(data: bytes, filename: str) -> str:
    """Upload chat-image bytes to Cloudinary using Basic Auth + Data URI."""
    public_id = Path(filename).stem
    folder = "lucky_chat/chat"

    # Cloudinary's REST Upload API supports backend Basic Authentication.
    # The file parameter may be supplied as a Base64 Data URI, which avoids
    # multipart framing issues while still using the authenticated server upload.
    credentials = f"{CLOUDINARY_API_KEY}:{CLOUDINARY_API_SECRET}"
    authorization = base64.b64encode(
        credentials.encode("utf-8")
    ).decode("ascii")

    suffix = Path(filename).suffix.lower()
    mime_type = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
    }.get(suffix)

    if not mime_type:
        guessed_type, _ = mimetypes.guess_type(filename)
        mime_type = guessed_type if guessed_type and guessed_type.startswith("image/") else "application/octet-stream"

    file_data_uri = (
        f"data:{mime_type};base64,"
        + base64.b64encode(data).decode("ascii")
    )

    fields = {
        "file": file_data_uri,
        "folder": folder,
        "public_id": public_id,
    }

    body = urllib.parse.urlencode(fields).encode("utf-8")

    endpoint = (
        f"https://api.cloudinary.com/v1_1/"
        f"{urllib.parse.quote(CLOUDINARY_CLOUD_NAME, safe='')}/image/upload"
    )

    request = urllib.request.Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Basic {authorization}",
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read().decode("utf-8")
            payload = json.loads(raw)
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode("utf-8", errors="replace")
        except Exception:
            detail = str(exc)
        raise RuntimeError(
            f"Cloudinary upload failed (HTTP {exc.code}): {detail[:700]}"
        )
    except (urllib.error.URLError, TimeoutError) as exc:
        raise RuntimeError(f"Cloudinary upload failed: {exc}")
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Cloudinary returned invalid JSON: {exc}")

    secure_url = str(payload.get("secure_url") or "").strip()
    if not secure_url:
        message = str(payload.get("error", {}).get("message") or "").strip()
        raise RuntimeError(
            "Cloudinary upload returned no secure URL"
            + (f": {message}" if message else "")
        )

    return secure_url


async def _store_chat_image(data: bytes, filename: str) -> str:
    """Store a chat image in shared cloud storage or the existing local fallback."""
    configuration_error = _cloudinary_configuration_error()
    if configuration_error:
        raise RuntimeError(configuration_error)

    if _cloudinary_configured():
        return await asyncio.to_thread(
            _cloudinary_upload_image,
            data,
            filename,
        )

    # No Cloudinary variables at all: preserve the existing local-development
    # behavior. This fallback is intentionally disabled as soon as any
    # Cloudinary variable is present but incomplete, preventing silent local
    # storage on production deployments.
    filepath = UPLOAD_DIR / filename
    with open(filepath, "wb") as buffer:
        buffer.write(data)
    return "/static/uploads/chat/" + filename


def _storage_user_key(username: str) -> str:
    """Return a filesystem-safe stable identifier for per-user uploads."""
    value = str(username or "").strip()
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:24]


def _migrate_profile_picture_urls_to_persistent_storage():
    """Move existing profile-picture DB URLs onto the persistent Volume.

    Legacy default-avatar URLs remain under /static/profile/. Only real
    uploaded profile files are rewritten, and only when the corresponding
    file already exists in static/uploads/profile.
    """
    db = SessionLocal()
    changed = 0
    skipped = 0
    try:
        users = db.query(User).filter(User.profile_picture.isnot(None)).all()
        for user in users:
            value = str(user.profile_picture or "").strip()
            if not value.startswith("/static/profile/"):
                continue
            parsed = urllib.parse.urlparse(value)
            if parsed.scheme or parsed.netloc:
                continue

            path = parsed.path or ""
            prefix = "/static/profile/"
            if not path.startswith(prefix):
                continue

            filename = Path(path).name
            if not filename or filename == "default.png":
                continue

            filepath = (PROFILE_UPLOAD_DIR / filename).resolve()
            upload_root = PROFILE_UPLOAD_DIR.resolve()
            if filepath.parent != upload_root or not filepath.is_file():
                skipped += 1
                continue

            new_value = "/static/uploads/profile/" + filename
            if parsed.query:
                new_value += "?" + parsed.query
            if parsed.fragment:
                new_value += "#" + parsed.fragment

            if value != new_value:
                user.profile_picture = new_value
                changed += 1

        if changed:
            db.commit()
        print(
            "PROFILE STORAGE MIGRATION: changed=",
            changed,
            "skipped=",
            skipped,
        )
    except Exception as exc:
        db.rollback()
        print("PROFILE STORAGE MIGRATION ERROR:", exc)
        traceback.print_exc()
    finally:
        db.close()


CHAT_MEDIA_URL_PREFIX = "/static/uploads/chat/"


def _delete_local_chat_media_if_unreferenced(db, media_url, excluded_message_id=None):
    """Delete a local chat asset only when no remaining message references it.

    Forwarded media can intentionally reuse the original local asset, so
    deleting the file when only one message row is removed would break the
    forwarded copy. This helper therefore checks the Message table first and
    only removes a safe local file when the URL is no longer referenced.
    """
    value = str(media_url or "").strip()
    if not value.startswith(CHAT_MEDIA_URL_PREFIX):
        return False

    parsed = urllib.parse.urlparse(value)
    if parsed.scheme or parsed.netloc:
        return False

    path = parsed.path or ""
    if not path.startswith(CHAT_MEDIA_URL_PREFIX):
        return False

    filename = Path(path).name
    if not filename:
        return False

    canonical_url = CHAT_MEDIA_URL_PREFIX + filename

    try:
        query = db.query(Message.id).filter(Message.media_url == canonical_url)
        if excluded_message_id is not None:
            query = query.filter(Message.id != excluded_message_id)
        if query.first() is not None:
            return False

        filepath = (UPLOAD_DIR / filename).resolve()
        upload_root = UPLOAD_DIR.resolve()

        if filepath.parent != upload_root or not filepath.is_file():
            return False

        filepath.unlink(missing_ok=True)
        if not filepath.exists():
            print("CHAT MEDIA CLEANUP: removed", filename)
            return True
    except (OSError, ValueError) as exc:
        print("CHAT MEDIA CLEANUP ERROR:", exc)

    return False


# Session signing must come from deployment configuration, never from a
# source-controlled hardcoded secret. Set SESSION_SECRET_KEY in Railway/local
# environment variables before starting the application.
SESSION_SECRET_KEY = os.environ.get("SESSION_SECRET_KEY", "").strip()
if not SESSION_SECRET_KEY:
    raise RuntimeError(
        "SESSION_SECRET_KEY is not configured. "
        "Set a long random secret in the deployment environment before startup."
    )

# Keep local HTTP development working while automatically protecting the
# signed session cookie on Railway. Explicit SESSION_COOKIE_SECURE values
# always override the environment-based default.
_SESSION_COOKIE_SECURE_RAW = os.environ.get("SESSION_COOKIE_SECURE")
if _SESSION_COOKIE_SECURE_RAW is None:
    SESSION_COOKIE_SECURE = bool(
        os.environ.get("RAILWAY_PROJECT_ID", "").strip()
    )
else:
    SESSION_COOKIE_SECURE = _SESSION_COOKIE_SECURE_RAW.strip().lower() in {
        "1", "true", "yes", "on"
    }

app.add_middleware(
    SessionMiddleware,
    secret_key=SESSION_SECRET_KEY,
    max_age=14 * 24 * 60 * 60,
    same_site="lax",
    https_only=SESSION_COOKIE_SECURE,
)

models.Base.metadata.create_all(bind=engine)
_migrate_profile_picture_urls_to_persistent_storage()


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

        if "media_name" not in columns:
            statements.append(
                "ALTER TABLE messages ADD COLUMN media_name VARCHAR"
            )

        if "media_size" not in columns:
            statements.append(
                "ALTER TABLE messages ADD COLUMN media_size INTEGER DEFAULT 0"
            )

        if statements:
            with engine.begin() as connection:
                for statement in statements:
                    connection.execute(sqlalchemy_text(statement))

            print("MESSAGE MEDIA SCHEMA: media metadata columns added")
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


def _ensure_model_indexes():
    """Create model indexes that may be missing on pre-existing databases.

    SQLAlchemy's create_all() creates tables that do not exist, but schema
    changes to already-existing tables do not reliably add newly introduced
    indexes. Keep this migration additive and non-destructive: only create
    the named indexes when their tables exist and the index is absent.
    """
    required_indexes = {
        "messages": {
            "ix_messages_sender_receiver_id",
            "ix_messages_receiver_unread_sender_id",
            "ix_messages_receiver_sender_id",
        },
        "statuses": {
            "ix_statuses_expires_created_id",
        },
        "status_views": {
            "ix_status_views_status_seen",
        },
        "status_likes": {
            "ix_status_likes_status_created",
        },
        "status_replies": {
            "ix_status_replies_status_replied",
        },
    }

    try:
        inspector = inspect(engine)

        metadata_tables = {
            "messages": Message.__table__,
            "statuses": Status.__table__,
            "status_views": StatusView.__table__,
            "status_likes": StatusLike.__table__,
            "status_replies": StatusReply.__table__,
        }

        created = 0

        for table_name, index_names in required_indexes.items():
            if not inspector.has_table(table_name):
                continue

            table = metadata_tables.get(table_name)
            if table is None:
                continue

            existing = {
                str(index.get("name") or "")
                for index in inspector.get_indexes(table_name)
            }

            for index in table.indexes:
                if not index.name or index.name not in index_names:
                    continue
                if index.name in existing:
                    continue

                index.create(bind=engine, checkfirst=True)
                existing.add(index.name)
                created += 1
                print(
                    "DATABASE INDEX SCHEMA: created",
                    index.name,
                    "on",
                    table_name,
                )

        if created:
            print("DATABASE INDEX SCHEMA: created", created, "missing index(es)")
    except Exception as exc:
        print("DATABASE INDEX SCHEMA ERROR:", exc)
        traceback.print_exc()


_ensure_model_indexes()


def canonicalize_chat_media_type(media_type, media_url=None, media_name=None):
    """Normalize browser MIME/extension variants to Lucky Chat media types."""
    value = str(media_type or "").strip().lower().split(";", 1)[0]
    if value in {"image", "video", "audio", "document", "call"}:
        return value

    if value.startswith("image/"):
        return "image"
    if value.startswith("video/"):
        return "video"
    if value.startswith("audio/"):
        return "audio"

    source = str(media_url or media_name or "").strip().lower()
    suffix = Path(source.split("?", 1)[0].split("#", 1)[0]).suffix
    if suffix in {".mp4", ".webm", ".ogv", ".ogg"}:
        return "video"
    if suffix in {".mp3", ".wav", ".m4a", ".aac", ".oga"}:
        return "audio"
    if suffix in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
        return "image"
    if suffix in {".pdf", ".doc", ".docx", ".txt", ".csv", ".xls", ".xlsx", ".ppt", ".pptx", ".zip", ".rtf"}:
        return "document"

    return value


def _prepare_server_side_forward_video(source_media_url, username):
    """Validate and reuse an existing local chat video for forwarding.

    The browser never downloads and re-uploads the video, and the server does
    not duplicate the already-stored file. The source message access check in
    the WebSocket handler establishes that the authenticated user may forward
    the attachment; this helper validates that the referenced asset is a real
    local chat video within the upload root before reusing its URL.
    """
    source_url = str(source_media_url or "").strip()
    parsed = urllib.parse.urlparse(source_url)

    if parsed.scheme or parsed.netloc:
        raise ValueError("Video URL must be a local chat upload")

    path = parsed.path or ""
    prefix = "/static/uploads/chat/"
    if not path.startswith(prefix):
        raise ValueError("Video URL must be a chat upload")

    filename = Path(path).name
    suffix = Path(filename).suffix.lower()
    if suffix not in {".mp4", ".webm", ".ogv"}:
        raise ValueError("Unsupported video format")

    source_path = (UPLOAD_DIR / filename).resolve()
    upload_root = UPLOAD_DIR.resolve()
    if source_path.parent != upload_root or not source_path.is_file():
        raise ValueError("Source video is no longer available")

    size = source_path.stat().st_size
    max_size = 30 * 1024 * 1024
    if size <= 0 or size > max_size:
        raise ValueError("Source video is invalid or too large")

    # No file copy is necessary. Reusing the validated original asset makes the
    # forward operation O(1) with respect to video size instead of rewriting the
    # entire video before the database row can be created.
    return "/static/uploads/chat/" + filename, size


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


def _chat_preview_text(message) -> str:
    """Dashboard/chat list preview that works for media-only messages."""
    if message is None:
        return ""

    media_type = str(getattr(message, "media_type", "") or "").strip().lower()
    media_name = str(getattr(message, "media_name", "") or "").strip()
    text = str(getattr(message, "text", "") or "")

    if media_type == "document" or media_name:
        return "📄 " + (media_name or "Document")
    if media_type == "image":
        return "📷 Photo"
    if media_type == "video":
        return "🎬 Video"
    if media_type == "audio":
        return "🎙️ Voice message"
    if media_type == "call":
        return "📞 Voice call"
    if text.startswith("LCE1:") or text.startswith("LCE2:"):
        return "New message"
    return text


def _dashboard_preview_text(message) -> str:
    """Return the dashboard preview payload without destroying E2EE ciphertext.

    The dashboard client decrypts LCE1/LCE2 values locally. The normal chat
    serializer intentionally keeps its existing safe "New message" placeholder,
    so only /dashboard-data receives the ciphertext required for local preview
    decryption. Media-only messages keep their human-readable preview labels.
    """
    if message is None:
        return ""

    media_type = str(getattr(message, "media_type", "") or "").strip().lower()
    media_name = str(getattr(message, "media_name", "") or "").strip()
    text = str(getattr(message, "text", "") or "")

    if media_type == "document" or media_name:
        return "📄 " + (media_name or "Document")
    if media_type == "image":
        return "📷 Photo"
    if media_type == "video":
        return "🎬 Video"
    if media_type == "audio":
        return "🎙️ Voice message"
    if media_type == "call":
        return "📞 Voice call"

    # Pass encrypted chat text through unchanged. It is still protected by
    # HTTPS/session authentication in transit, and the dashboard client needs
    # the ciphertext in order to decrypt it locally with LuckyCrypto.
    if text.startswith("LCE1:") or text.startswith("LCE2:"):
        return text

    return text


def _serialize_chat_message(m) -> dict:
    """JSON shape used by /messages and the chat-page bootstrap payload."""
    media_type = str(getattr(m, "media_type", "") or "").strip().lower()
    media_url = getattr(m, "media_url", None)
    media_name = getattr(m, "media_name", None)
    is_document = media_type == "document" or bool(media_name)
    preview = _chat_preview_text(m)
    text = str(getattr(m, "text", "") or "").strip() or preview
    return {
        "id": m.id,
        "sender": m.sender,
        "receiver": m.receiver,
        "text": text,
        "timestamp": m.timestamp,
        "delivered": m.delivered,
        "read": m.read,
        "reply_to": m.reply_to,
        "media_url": media_url,
        "media_type": "document" if is_document and media_type not in {"image", "video", "audio", "call"} else (media_type or None),
        "media_duration": getattr(m, "media_duration", 0) or 0,
        "media_waveform": getattr(m, "media_waveform", None),
        "media_name": media_name,
        "media_size": getattr(m, "media_size", 0) or 0,
        "document_url": media_url if is_document else None,
        "document_name": media_name if is_document else None,
        "file_name": media_name if is_document else None,
        "edited": getattr(m, "edited", 0),
        "reaction": getattr(m, "reaction", ""),
        "forwarded": bool(int(getattr(m, "forwarded", 0) or 0)),
        "status_reply": bool(int(getattr(m, "status_reply", 0) or 0)),
        "status_reply_status_id": getattr(m, "status_reply_status_id", None),
        "status_reply_owner": getattr(m, "status_reply_owner", None),
        "preview": preview,
    }


def _conversation_messages(db, username: str, friend: str, current_user=None, friend_user=None):
    """Load every message in a 1:1 chat using database-side filtering."""
    current_user = current_user or resolve_user_by_username(db, username)
    friend_user = friend_user or resolve_user_by_username(db, friend)

    names_me = []
    names_friend = []
    for value in (
        username,
        getattr(current_user, "username", None),
    ):
        clean = str(value or "").strip()
        if clean and clean not in names_me:
            names_me.append(clean)
    for value in (
        friend,
        getattr(friend_user, "username", None),
    ):
        clean = str(value or "").strip()
        if clean and clean not in names_friend:
            names_friend.append(clean)

    # Filter the conversation in SQL instead of loading the entire Message
    # table and then scanning it in Python. This scales with the current
    # conversation rather than the size of every chat in the database.
    return (
        db.query(Message)
        .filter(
            or_(
                and_(
                    Message.sender.in_(names_me),
                    Message.receiver.in_(names_friend),
                ),
                and_(
                    Message.sender.in_(names_friend),
                    Message.receiver.in_(names_me),
                ),
            )
        )
        .order_by(Message.id.asc())
        .all()
    )


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
    user = None
    try:
        # Resolve only the friend needed by the template. Do not query the
        # conversation here: chat.core loads history asynchronously after the
        # shell is painted, so a page request stays fast even for huge chats.
        user = resolve_user_by_username(db, friend)
        canonical_friend = user.username if user else str(friend or "").strip()
    finally:
        db.close()

    response = templates.TemplateResponse(
        request=request,
        name="chat.html",
        context={
            "request": request,
            "friend": canonical_friend,
            "friend_user": user,
            # Kept for backwards compatibility with the existing template and
            # client fallback, but deliberately empty to avoid embedding the
            # entire document history into the initial HTML response.
            "embedded_documents": [],
        }
    )
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    return response

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


@app.post("/logout")
async def logout(request: Request):
    """Clear the signed application session and legacy username cookie."""
    request.session.clear()

    response = JSONResponse({"success": True})
    response.delete_cookie(
        "username",
        samesite="lax",
    )
    return response


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
            if manager.dashboard_connections.get(username) is websocket:
                manager.dashboard_connections.pop(username, None)
            print(f"{username} dashboard disconnected")

        return

    await manager.connect(username, websocket, friend=friend)

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

                    # Save the attachment URL before clearing the message.
                    # The file is removed only after the DB commit and only if
                    # no other message (including a forwarded copy) still
                    # references the same local asset.
                    deleted_media_url = str(msg.media_url or "").strip()

                    # Clear attached content and reactions as part of the
                    # permanent deleted state.
                    msg.media_url = None
                    msg.media_type = None

                    if hasattr(msg, "reaction"):
                        msg.reaction = ""

                    if hasattr(msg, "reactions"):
                        msg.reactions = "{}"

                    db.commit()

                    if deleted_media_url:
                        _delete_local_chat_media_if_unreferenced(
                            db,
                            deleted_media_url,
                            excluded_message_id=msg.id,
                        )

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
                # Forwarding supports encrypted text plus an optional
                # attachment. Resolve the selected recipient to the canonical
                # database username and never reuse the current chat's `friend`
                # value.
                text = str(data.get("text") or "").strip()
                source_message_id = data.get("source_message_id")
                try:
                    source_message_id = int(source_message_id) if source_message_id is not None else None
                except (TypeError, ValueError):
                    source_message_id = None

                media_url = str(data.get("media_url") or "").strip()
                media_type = canonicalize_chat_media_type(
                    data.get("media_type"),
                    media_url,
                    data.get("media_name"),
                )
                forwardable_media_types = {"image", "video", "audio", "document"}
                has_attachment = bool(
                    media_url and media_type in forwardable_media_types
                )
                requested_target = (
                    data.get("target")
                    or data.get("receiver")
                    or data.get("to")
                    or data.get("username")
                    or ""
                )
                requested_target = str(requested_target).strip()

                if not requested_target:
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

                    # Prefer the authoritative attachment metadata from the
                    # original message. Only the original sender may forward it.
                    source_message = None
                    if source_message_id is not None:
                        source_message = (
                            db.query(Message)
                            .filter(Message.id == source_message_id)
                            .first()
                        )
                        if not source_message or username not in (
                            source_message.sender,
                            source_message.receiver,
                        ):
                            print(
                                "FORWARD SOURCE MESSAGE NOT ACCESSIBLE:",
                                source_message_id,
                                username,
                            )
                            continue

                    source_media_url = (
                        getattr(source_message, "media_url", None)
                        if source_message is not None
                        else (media_url or None)
                    )
                    source_media_type = canonicalize_chat_media_type(
                        getattr(source_message, "media_type", None)
                        if source_message is not None
                        else media_type,
                        getattr(source_message, "media_url", None)
                        if source_message is not None
                        else media_url,
                        getattr(source_message, "media_name", None)
                        if source_message is not None
                        else data.get("media_name"),
                    )
                    source_media_duration = (
                        getattr(source_message, "media_duration", 0)
                        if source_message is not None
                        else data.get("media_duration")
                    )
                    source_media_waveform = (
                        getattr(source_message, "media_waveform", None)
                        if source_message is not None
                        else data.get("media_waveform")
                    )
                    source_media_name = (
                        getattr(source_message, "media_name", None)
                        if source_message is not None
                        else data.get("media_name")
                    )
                    source_media_size = (
                        getattr(source_message, "media_size", 0)
                        if source_message is not None
                        else data.get("media_size")
                    )

                    # Video forwarding is handled entirely server-side. The
                    # browser no longer fetches/re-uploads the source video.
                    # Copy the already stored local video after the source-message
                    # access check so the forwarded row receives its own valid
                    # chat-upload URL.
                    if source_media_type == "video" and source_media_url:
                        try:
                            source_media_url, copied_video_size = _prepare_server_side_forward_video(
                                source_media_url,
                                username,
                            )
                            source_media_size = copied_video_size
                        except (OSError, ValueError) as exc:
                            print(
                                "FORWARD VIDEO PREPARATION ERROR:",
                                source_message_id,
                                username,
                                exc,
                            )
                            continue


                    has_authoritative_attachment = bool(
                        source_media_url
                        and str(source_media_type or "").strip().lower()
                        in forwardable_media_types
                    )
                    if not text and not has_authoritative_attachment:
                        print(
                            "FORWARD MESSAGE EMPTY:",
                            source_message_id,
                            username,
                            "->",
                            target,
                        )
                        continue

                    message = Message(
                        sender=username,
                        receiver=target,
                        text=text,
                        timestamp=utc_now_iso(),
                        unread=1,
                        seen_in_chat=0,
                        forwarded=1,
                        reply_to=None,
                        media_url=source_media_url,
                        media_type=str(source_media_type or "").strip().lower() or None,
                        media_duration=int(source_media_duration or 0),
                        media_waveform=source_media_waveform,
                        media_name=source_media_name,
                        media_size=int(source_media_size or 0),
                    )

                    db.add(message)
                    db.commit()
                    db.refresh(message)

                    # The duplicate-forward guard is only needed for
                    # text forwards. Do not record attachment-only forwards with
                    # an empty text key, otherwise a normal media-only message
                    # could be mistaken for a duplicate forward.
                    if text:
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
                        "media_name": getattr(message, "media_name", None),
                        "media_size": getattr(message, "media_size", 0) or 0,
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

                # Confirm the persisted forward to the sending client first.
                # The dashboard's temporary WebSocket uses this acknowledgement
                # to decide whether the status forward succeeded. Keeping this
                # delivery ahead of optional dashboard/push notifications prevents
                # an unrelated notification failure from looking like a failed forward.
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

            if data.get("type") == "document_message":
                # Documents use a dedicated wire type so attachment-only messages
                # cannot be confused with ordinary encrypted text.
                requested_target = str(
                    data.get("receiver") or friend or ""
                ).strip()

                if not requested_target:
                    print("DOCUMENT MESSAGE MISSING TARGET")
                    continue

                document_url = str(data.get("media_url") or "").strip()
                document_name = str(
                    data.get("media_name") or data.get("document_name")
                    or data.get("file_name") or "Document"
                ).strip()[:255]
                document_size = int(data.get("media_size") or 0)

                if not document_url:
                    print("DOCUMENT MESSAGE MISSING URL")
                    continue

                db = SessionLocal()
                try:
                    target_user = resolve_user_by_username(db, requested_target)
                    receiver_name = (
                        target_user.username
                        if target_user
                        else requested_target
                    )

                    if not receiver_name:
                        continue

                    preview_text = "📄 " + (document_name or "Document")
                    message = Message(
                        sender=username,
                        receiver=receiver_name,
                        text=preview_text,
                        timestamp=utc_now_iso(),
                        unread=1,
                        seen_in_chat=0,
                        forwarded=0,
                        reply_to=data.get("reply_to"),
                        media_url=document_url,
                        media_type="document",
                        media_duration=0,
                        media_waveform=None,
                        media_name=document_name,
                        media_size=document_size,
                    )

                    db.add(message)
                    db.commit()
                    db.refresh(message)

                    # Deliver documents as the normal chat "message" wire type.
                    # The payload still carries media_type="document" plus all
                    # document metadata. Using the standard message type keeps
                    # delivery compatible with clients that only recognize the
                    # normal chat message event.
                    payload = {
                        "type": "message",
                        "id": message.id,
                        "sender": username,
                        "receiver": receiver_name,
                        "text": preview_text,
                        "timestamp": message.timestamp,
                        "delivered": message.delivered,
                        "read": message.read,
                        "reply_to": message.reply_to,
                        "media_url": message.media_url,
                        "media_type": "document",
                        "media_duration": 0,
                        "media_waveform": None,
                        "media_name": getattr(message, "media_name", None),
                        "media_size": getattr(message, "media_size", 0) or 0,
                        "client_id": data.get("client_id"),
                        "forwarded": False,
                        "document_url": message.media_url,
                        "document_name": getattr(message, "media_name", None),
                        "file_name": getattr(message, "media_name", None),
                        "name": getattr(message, "media_name", None),
                    }

                    print(
                        "DOCUMENT MESSAGE SAVED:",
                        message.id,
                        username,
                        "->",
                        receiver_name,
                        document_name,
                        document_size,
                    )

                    await manager.send(username, payload)

                    if receiver_name != username:
                        delivered = await manager.deliver_or_queue(
                            receiver_name,
                            username,
                            payload,
                        )
                        if delivered:
                            message.delivered = 1
                            db.commit()
                            db.refresh(message)
                            payload["delivered"] = message.delivered
                        asyncio.create_task(
                            send_push_to_user(
                                receiver_name,
                                {
                                    "type": "message",
                                    "sender": username,
                                    "title": username,
                                    "body": "You have a new document.",
                                },
                            )
                        )

                    await manager.send_dashboard(
                        receiver_name,
                        {"type": "dashboard_update", "from": username},
                    )
                    await manager.send_dashboard(
                        username,
                        {"type": "dashboard_update", "from": receiver_name},
                    )

                except Exception as e:
                    db.rollback()
                    print("DOCUMENT MESSAGE ERROR:", e)
                    traceback.print_exc()
                finally:
                    db.close()

                continue

            if data.get("type") == "message":

                if not friend:
                    continue

                text = data.get("text", "").strip()
                media_url = data.get("media_url")
                media_type = canonicalize_chat_media_type(
                    data.get("media_type"),
                    media_url,
                    data.get("media_name"),
                )

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
                        media_name=data.get("media_name"),
                        media_size=int(data.get("media_size") or 0),
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
                        "media_name": getattr(message, "media_name", None),
                        "media_size": getattr(message, "media_size", 0) or 0,
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
    except Exception as exc:
        print(f"CHAT WS ERROR ({username}):", exc)
        traceback.print_exc()
    finally:
        # Guarded in the manager: a socket that was already replaced by a
        # newer connection for this user is ignored. Without this, any
        # non-disconnect exception left a dead socket registered as "online".
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

        # Only remove our own registration. A reload/reconnect registers the
        # new socket before the old one finishes closing, and an unguarded
        # pop() evicted the live one (no more dashboard updates).
        if manager.dashboard_connections.get(username) is websocket:
            manager.dashboard_connections.pop(username, None)

        print("Dashboard disconnected:", username)

@app.get("/messages/{friend}")
async def get_messages(friend: str, request: Request):

    username = get_authenticated_username(request)
    if not username:
        return JSONResponse(
            content={"success": False, "error": "Not logged in", "messages": []},
            headers={"Cache-Control": "no-store"},
        )

    db = SessionLocal()

    try:
        current_user = resolve_user_by_username(db, username)
        friend_user = resolve_user_by_username(db, friend)
        canonical_username = current_user.username if current_user else str(username or "").strip()
        canonical_friend = friend_user.username if friend_user else str(friend or "").strip()

        print("COOKIE USERNAME =", username, "FRIEND =", friend)
        print("CANONICAL USERNAME =", canonical_username)
        print("CANONICAL FRIEND =", canonical_friend)

        msgs = _conversation_messages(db, canonical_username, canonical_friend, current_user, friend_user)
        print("USERNAME:", canonical_username)
        print("FRIEND:", canonical_friend)
        print("FOUND MESSAGES:", len(msgs))
        print(
            "FOUND DOCUMENTS:",
            sum(1 for m in msgs if str(getattr(m, "media_type", "") or "").lower() == "document"),
        )

        result = [_serialize_chat_message(m) for m in msgs]

        # Only incoming unread rows from this conversation are relevant.
        unread_candidates = (
            db.query(Message)
            .filter(
                Message.unread == 1,
                Message.sender.in_([canonical_friend, friend]),
                Message.receiver.in_([canonical_username, username]),
            )
            .all()
        )

        normalized_username = canonical_username.strip().casefold()
        normalized_friend = canonical_friend.strip().casefold()

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
    finally:
        db.close()

    return JSONResponse(
        content=result,
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Pragma": "no-cache",
        },
    )

@app.post("/messages/{friend}/sync")
async def sync_messages(friend: str, request: Request):
    """Same history as GET /messages, but POST avoids stale service-worker caches."""
    return await get_messages(friend, request)

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
                "last": _dashboard_preview_text(last) if last else "",
                "sender": last.sender if last else "",
                "time": last.timestamp if last else "",
                "id": last.id if last else 0,
                "media_url": last.media_url if last else None,
                "media_type": last.media_type if last else None,
                "media_name": getattr(last, "media_name", None) if last else None
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

    try:
        media_url = await _store_chat_image(data, filename)
    except Exception as exc:
        print("CHAT IMAGE STORAGE ERROR:", exc)
        return {
            "success": False,
            "error": str(exc)[:1000]
        }

    storage_backend = "cloudinary" if media_url.startswith("https://res.cloudinary.com/") else "local"
    print("CHAT IMAGE STORED:", storage_backend, media_url[:200])

    return {
        "success": True,
        "url": media_url,
        "media_type": "image",
        "storage": storage_backend
    }


@app.post("/send-chat-document")
async def send_chat_document(request: Request):
    """
    Persist and deliver an already-uploaded chat document.

    This endpoint deliberately does not depend on the browser chat WebSocket
    being open on the sender. The document is committed first, then live
    delivery is attempted for the recipient. History therefore remains the
    source of truth even when either chat socket is temporarily unavailable.
    """
    username = get_authenticated_username(request)
    if not username:
        return {"success": False, "error": "Not logged in"}

    try:
        data = await request.json()
    except Exception:
        return {"success": False, "error": "Invalid document message"}

    requested_target = str(
        data.get("receiver") or data.get("target") or ""
    ).strip()
    document_url = str(
        data.get("media_url") or data.get("document_url")
        or data.get("file_url") or data.get("url") or ""
    ).strip()
    document_name = str(
        data.get("media_name") or data.get("document_name")
        or data.get("file_name") or data.get("name") or "Document"
    ).strip()[:255]

    try:
        document_size = int(
            data.get("media_size") or data.get("document_size")
            or data.get("file_size") or data.get("size") or 0
        )
    except (TypeError, ValueError):
        document_size = 0

    if not requested_target:
        return {"success": False, "error": "Missing recipient"}

    if not document_url:
        return {"success": False, "error": "Missing document URL"}

    # Never trust a browser-supplied document URL blindly. Documents uploaded
    # through /upload-chat-document are stored under the authenticated user's
    # stable filename prefix. Accept only that local upload shape, keep the
    # resolved path inside UPLOAD_DIR, and require the file to exist. This
    # prevents a client from attaching an arbitrary /static path or another
    # user's uploaded document to a chat message.
    try:
        parsed_document_url = urllib.parse.urlparse(document_url)
        if parsed_document_url.scheme or parsed_document_url.netloc:
            raise ValueError("Invalid document URL")

        document_path_text = parsed_document_url.path or document_url
        document_path = Path(document_path_text)
        expected_prefix = _storage_user_key(username) + "_"

        if document_path.parts[:3] != ("/", "static", "uploads"):
            # Relative paths such as static/uploads/... are normalized below.
            # Reject anything that is not rooted at our chat upload directory.
            if document_path_text.startswith("/static/") is False:
                raise ValueError("Invalid document URL")

        filename_only = document_path.name
        upload_root = UPLOAD_DIR.resolve()
        resolved_document_path = (upload_root / filename_only).resolve()

        if resolved_document_path.parent != upload_root:
            raise ValueError("Invalid document URL")
        if not filename_only.startswith(expected_prefix):
            raise ValueError("Invalid document ownership")
        if not resolved_document_path.is_file():
            raise ValueError("Uploaded document not found")

        document_url = "/static/uploads/chat/" + filename_only
        actual_document_size = resolved_document_path.stat().st_size
        if actual_document_size > 20 * 1024 * 1024:
            raise ValueError("Document is too large. Maximum size is 20 MB")
        document_size = actual_document_size
    except (OSError, ValueError) as exc:
        return {"success": False, "error": str(exc) or "Invalid document URL"}

    db = SessionLocal()
    try:
        target_user = resolve_user_by_username(db, requested_target)
        if not target_user:
            return {"success": False, "error": "Recipient not found"}

        receiver_name = target_user.username

        preview_text = "📄 " + (document_name or "Document")
        message = Message(
            sender=username,
            receiver=receiver_name,
            text=preview_text,
            timestamp=utc_now_iso(),
            unread=1,
            seen_in_chat=0,
            forwarded=0,
            reply_to=data.get("reply_to"),
            media_url=document_url,
            media_type="document",
            media_duration=0,
            media_waveform=None,
            media_name=document_name,
            media_size=document_size,
        )

        db.add(message)
        db.commit()
        db.refresh(message)

        payload = {
            "type": "message",
            "id": message.id,
            "sender": message.sender,
            "receiver": message.receiver,
            "text": preview_text,
            "timestamp": message.timestamp,
            "delivered": message.delivered,
            "read": message.read,
            "reply_to": message.reply_to,
            "media_url": message.media_url,
            "media_type": "document",
            "media_duration": 0,
            "media_waveform": None,
            "media_name": getattr(message, "media_name", None),
            "media_size": getattr(message, "media_size", 0) or 0,
            "client_id": data.get("client_id"),
            "forwarded": False,
            "document_url": message.media_url,
            "document_name": getattr(message, "media_name", None),
            "file_name": getattr(message, "media_name", None),
            "name": getattr(message, "media_name", None),
        }

        print(
            "DOCUMENT MESSAGE SAVED:",
            message.id,
            username,
            "->",
            receiver_name,
            document_name,
            document_size,
        )

        # The sender is authenticated over this HTTP request, so the response
        # below is the authoritative reconciliation source for the sender.
        delivered = False
        if receiver_name != username:
            delivered = await manager.deliver_or_queue(
                receiver_name,
                username,
                payload,
            )
            if delivered:
                message.delivered = 1
                db.commit()
                db.refresh(message)
                payload["delivered"] = message.delivered

            asyncio.create_task(
                send_push_to_user(
                    receiver_name,
                    {
                        "type": "message",
                        "sender": username,
                        "title": username,
                        "body": "You have a new document.",
                    },
                )
            )

        await manager.send_dashboard(
            receiver_name,
            {"type": "dashboard_update", "from": username},
        )
        if receiver_name != username:
            await manager.send_dashboard(
                username,
                {"type": "dashboard_update", "from": receiver_name},
            )

        return {
            "success": True,
            "message": payload,
            "delivered": bool(delivered),
        }

    except Exception as exc:
        db.rollback()
        print("DOCUMENT HTTP SEND ERROR:", exc)
        traceback.print_exc()
        return {"success": False, "error": "Could not save document message"}
    finally:
        db.close()


@app.post("/upload-chat-document")
async def upload_chat_document(
    request: Request,
    file: UploadFile = File(...)
):
    """Store an attached chat document in the existing chat upload directory."""
    username = request.session.get("username")

    if not username:
        return {"success": False, "error": "Not logged in"}

    allowed_types = {
        "application/pdf": ".pdf",
        "application/msword": ".doc",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
        "text/plain": ".txt",
        "text/csv": ".csv",
        "application/rtf": ".rtf",
        "application/vnd.ms-excel": ".xls",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
        "application/vnd.ms-powerpoint": ".ppt",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
        "application/zip": ".zip",
    }
    extension_types = {suffix: mime for mime, suffix in allowed_types.items()}

    original_name = Path(file.filename or "document").name.strip() or "document"
    original_name = original_name[:255]
    suffix = Path(original_name).suffix.lower()
    content_type = (file.content_type or "").split(";", 1)[0].strip().lower()

    # Some Android browsers provide an empty/generic MIME type; the extension
    # remains a safe second signal because the server chooses the stored suffix.
    if content_type not in allowed_types and suffix in extension_types:
        content_type = extension_types[suffix]

    if content_type not in allowed_types:
        return {
            "success": False,
            "error": "Only PDF, Word, text, CSV, RTF, Excel, PowerPoint, and ZIP files are allowed"
        }

    extension = allowed_types[content_type]
    max_size = 20 * 1024 * 1024
    filename = (
        f"{_storage_user_key(username)}_{datetime.now().strftime('%Y%m%d%H%M%S%f')}"
        f"{extension}"
    )
    filepath = UPLOAD_DIR / filename
    total = 0

    try:
        with open(filepath, "wb") as buffer:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_size:
                    raise ValueError("Document is too large. Maximum size is 20 MB")
                buffer.write(chunk)

        if total == 0:
            raise ValueError("Empty document file")

        return {
            "success": True,
            "url": "/static/uploads/chat/" + filename,
            "media_type": "document",
            "name": original_name,
            "size": total,
            "mime_type": content_type,
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
        print("DOCUMENT UPLOAD ERROR:", exc)
        traceback.print_exc()
        return {"success": False, "error": "Could not save document"}
    finally:
        try:
            await file.close()
        except Exception:
            pass


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
# Pinned-chat state used to live in data/pinned_chats.json. That location is
# outside the persistent Railway Volume, so a deployment could silently reset
# the user's pinned chats. Keep the legacy file only as a one-time migration
# source and store active state in the database instead.
PINNED_CHATS_FILE = Path("data/pinned_chats.json")
PINNED_CHATS_TABLE = "pinned_chats"


def _ensure_pinned_chats_table():
    """Create the DB-backed pinned-chat table and migrate legacy JSON once."""
    try:
        with engine.begin() as connection:
            connection.execute(
                sqlalchemy_text(
                    "CREATE TABLE IF NOT EXISTS pinned_chats ("
                    "username VARCHAR(320) PRIMARY KEY, "
                    "pinned_json TEXT NOT NULL DEFAULT '[]'"
                    ")"
                )
            )
    except Exception as exc:
        print("PINNED CHAT SCHEMA ERROR:", exc)
        traceback.print_exc()
        return

    # Migrate any legacy JSON file that still exists in the current deployment.
    # Existing DB rows always win, so a restart cannot overwrite newer pinned
    # state with an older legacy snapshot.
    if not PINNED_CHATS_FILE.is_file():
        return

    try:
        with open(PINNED_CHATS_FILE, "r", encoding="utf-8") as f:
            legacy = json.load(f)

        if not isinstance(legacy, dict):
            return

        with engine.begin() as connection:
            for raw_username, raw_pinned in legacy.items():
                username = str(raw_username or "").strip()
                if not username:
                    continue

                pinned = (
                    raw_pinned
                    if isinstance(raw_pinned, list)
                    else []
                )
                pinned = [
                    str(value).strip()
                    for value in pinned
                    if str(value).strip()
                ]

                exists = connection.execute(
                    sqlalchemy_text(
                        "SELECT 1 FROM pinned_chats "
                        "WHERE username = :username"
                    ),
                    {"username": username},
                ).first()

                if exists is None:
                    connection.execute(
                        sqlalchemy_text(
                            "INSERT INTO pinned_chats "
                            "(username, pinned_json) "
                            "VALUES (:username, :pinned_json)"
                        ),
                        {
                            "username": username,
                            "pinned_json": json.dumps(
                                pinned,
                                ensure_ascii=False,
                                separators=(",", ":"),
                            ),
                        },
                    )

        print("PINNED CHAT STORAGE: database-backed state ready")
    except Exception as exc:
        print("PINNED CHAT MIGRATION ERROR:", exc)
        traceback.print_exc()


_ensure_pinned_chats_table()


def _load_pinned_chats(username):
    """Load one user's pinned chats from the database."""
    db = SessionLocal()
    try:
        row = db.execute(
            sqlalchemy_text(
                "SELECT pinned_json FROM pinned_chats "
                "WHERE username = :username"
            ),
            {"username": username},
        ).first()

        if row is None:
            return []

        try:
            value = json.loads(row[0] or "[]")
        except (TypeError, ValueError):
            value = []

        if not isinstance(value, list):
            return []

        return [
            str(item).strip()
            for item in value
            if str(item).strip()
        ]
    finally:
        db.close()


@app.get("/pinned-chats")
async def get_pinned_chats(request: Request):
    username = request.session.get("username")
    if not username:
        return {"success": False, "pinned": []}

    try:
        pinned = _load_pinned_chats(username)
        return {"success": True, "pinned": pinned}
    except Exception as exc:
        print("PINNED CHAT LOAD ERROR:", exc)
        traceback.print_exc()
        return {"success": False, "pinned": []}


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

    db = SessionLocal()

    try:
        row = db.execute(
            sqlalchemy_text(
                "SELECT pinned_json FROM pinned_chats "
                "WHERE username = :username"
            ),
            {"username": username},
        ).first()

        if row is None:
            current = []
        else:
            try:
                parsed = json.loads(row[0] or "[]")
                current = parsed if isinstance(parsed, list) else []
            except (TypeError, ValueError):
                current = []

            current = [
                str(value).strip()
                for value in current
                if str(value).strip()
            ]

        if pinned:
            if friend in current:
                current.remove(friend)
            current.insert(0, friend)
        else:
            current = [x for x in current if x != friend]

        pinned_json = json.dumps(
            current,
            ensure_ascii=False,
            separators=(",", ":"),
        )

        if row is None:
            db.execute(
                sqlalchemy_text(
                    "INSERT INTO pinned_chats "
                    "(username, pinned_json) "
                    "VALUES (:username, :pinned_json)"
                ),
                {
                    "username": username,
                    "pinned_json": pinned_json,
                },
            )
        else:
            db.execute(
                sqlalchemy_text(
                    "UPDATE pinned_chats "
                    "SET pinned_json = :pinned_json "
                    "WHERE username = :username"
                ),
                {
                    "username": username,
                    "pinned_json": pinned_json,
                },
            )

        db.commit()
        return {"success": True, "pinned": current}

    except Exception as exc:
        db.rollback()
        print("PINNED CHAT SAVE ERROR:", exc)
        traceback.print_exc()
        return {"success": False, "error": "Could not save pinned chat"}
    finally:
        db.close()


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
STATUS_MEDIA_URL_PREFIX = "/static/uploads/status/"


def _collect_expired_status_media_urls(db, now):
    """Delete expired Status rows and return their local media URLs."""
    expired_rows = (
        db.query(Status.media_url)
        .filter(Status.expires_at <= now)
        .all()
    )

    if not expired_rows:
        return []

    media_urls = [
        str(row[0]).strip()
        for row in expired_rows
        if row[0]
    ]

    db.query(Status).filter(Status.expires_at <= now).delete(
        synchronize_session=False
    )

    return media_urls


def _delete_local_status_media(media_urls):
    """Remove local status assets belonging to expired/deleted statuses."""
    removed = 0
    failed = 0

    for media_url in media_urls or []:
        value = str(media_url or "").strip()
        if not value.startswith(STATUS_MEDIA_URL_PREFIX):
            continue

        filename = Path(value.split("?", 1)[0].split("#", 1)[0]).name
        if not filename:
            continue

        try:
            filepath = (STATUS_UPLOAD_DIR / filename).resolve()
            upload_root = STATUS_UPLOAD_DIR.resolve()
            if filepath.parent != upload_root:
                continue

            existed = filepath.exists()
            filepath.unlink(missing_ok=True)
            if existed and not filepath.exists():
                removed += 1
        except OSError:
            failed += 1

    if removed or failed:
        print("STATUS MEDIA CLEANUP: removed=", removed, "failed=", failed)


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
        expired_media_urls = _collect_expired_status_media_urls(db, now)

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

        # Only remove old files after the DB transaction succeeds.
        _delete_local_status_media(expired_media_urls)

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
        # Expired statuses are no longer returned. Clean up their local media
        # at the same time while preserving the existing response shape.
        expired_media_urls = _collect_expired_status_media_urls(db, now)
        if expired_media_urls:
            db.commit()
            _delete_local_status_media(expired_media_urls)

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
            db.commit()
            db.refresh(view)
        else:
            # Preserve the user's original first-view timestamp.
            # Re-opening a Status must not make the viewer appear as
            # "Just now" in the owner's engagement panel.
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

        # Viewing is recorded only by the explicit /view endpoint.
        # Do not create a StatusView as a side effect of a like request.
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

        if media_url and media_url.startswith(STATUS_MEDIA_URL_PREFIX):
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

    filepath = PROFILE_UPLOAD_DIR / filename

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
            "/static/uploads/profile/" + filename + "?v=" + str(cache_version)
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

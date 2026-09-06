import asyncio
import json
import os
import traceback
from datetime import datetime

from app.database import SessionLocal
from app.models import PushSubscription

try:
    from pywebpush import WebPushException, webpush
except ImportError:  # Installed by requirements.txt in deployment.
    WebPushException = Exception
    webpush = None


VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY", "").strip()
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT", "").strip()


def push_configured() -> bool:
    """Return True only when Web Push is completely configured."""
    return bool(
        webpush is not None
        and VAPID_PUBLIC_KEY
        and VAPID_PRIVATE_KEY
        and VAPID_SUBJECT
    )


def _normalize_subscription(subscription: dict):
    if not isinstance(subscription, dict):
        raise ValueError("Invalid push subscription.")

    endpoint = str(subscription.get("endpoint") or "").strip()
    keys = subscription.get("keys") or {}
    p256dh = str(keys.get("p256dh") or "").strip()
    auth = str(keys.get("auth") or "").strip()

    if not endpoint or not p256dh or not auth:
        raise ValueError("Incomplete push subscription.")

    return endpoint, p256dh, auth


def add_subscription(username: str, subscription: dict) -> bool:
    """Create or update one persisted browser push subscription."""
    username = str(username or "").strip()
    if not username:
        raise ValueError("Username is required.")

    endpoint, p256dh, auth = _normalize_subscription(subscription)

    db = SessionLocal()
    try:
        row = (
            db.query(PushSubscription)
            .filter(PushSubscription.endpoint == endpoint)
            .first()
        )

        now = datetime.utcnow()

        if row is None:
            db.add(
                PushSubscription(
                    username=username,
                    endpoint=endpoint,
                    p256dh=p256dh,
                    auth=auth,
                    created_at=now,
                    updated_at=now,
                )
            )
        else:
            row.username = username
            row.p256dh = p256dh
            row.auth = auth
            row.updated_at = now

        db.commit()
        return True

    except Exception:
        db.rollback()
        print("PUSH SUBSCRIPTION SAVE ERROR:")
        traceback.print_exc()
        return False

    finally:
        db.close()


def get_subscriptions(username: str) -> list[dict]:
    """Return all persisted push subscriptions belonging to a user."""
    username = str(username or "").strip()
    if not username:
        return []

    db = SessionLocal()
    try:
        rows = (
            db.query(PushSubscription)
            .filter(PushSubscription.username == username)
            .all()
        )

        return [
            {
                "endpoint": row.endpoint,
                "keys": {
                    "p256dh": row.p256dh,
                    "auth": row.auth,
                },
            }
            for row in rows
        ]

    finally:
        db.close()


def remove_subscription(username: str, subscription: dict) -> None:
    """Remove one browser subscription owned by the authenticated user."""
    username = str(username or "").strip()

    try:
        endpoint, _, _ = _normalize_subscription(subscription)
    except ValueError:
        return

    db = SessionLocal()
    try:
        (
            db.query(PushSubscription)
            .filter(
                PushSubscription.username == username,
                PushSubscription.endpoint == endpoint,
            )
            .delete(synchronize_session=False)
        )
        db.commit()

    except Exception:
        db.rollback()
        print("PUSH SUBSCRIPTION REMOVE ERROR:")
        traceback.print_exc()

    finally:
        db.close()


def _remove_subscription_by_endpoint(endpoint: str) -> None:
    db = SessionLocal()
    try:
        (
            db.query(PushSubscription)
            .filter(PushSubscription.endpoint == endpoint)
            .delete(synchronize_session=False)
        )
        db.commit()

    except Exception:
        db.rollback()
        print("PUSH SUBSCRIPTION CLEANUP ERROR:")
        traceback.print_exc()

    finally:
        db.close()


def _send_one(subscription: dict, payload: dict) -> bool:
    endpoint = subscription.get("endpoint", "")

    try:
        webpush(
            subscription_info=subscription,
            data=json.dumps(payload, separators=(",", ":")),
            vapid_private_key=VAPID_PRIVATE_KEY,
            vapid_claims={"sub": VAPID_SUBJECT},
        )
        return True

    except WebPushException as exc:
        status = getattr(getattr(exc, "response", None), "status_code", None)

        # Browser subscriptions return 404/410 when they are no longer valid.
        if status in (404, 410) and endpoint:
            _remove_subscription_by_endpoint(endpoint)

        print("WEB PUSH ERROR:", status, exc)
        return False

    except Exception as exc:
        print("WEB PUSH SEND ERROR:", exc)
        traceback.print_exc()
        return False


async def send_push_to_user(username: str, payload: dict) -> int:
    """
    Send a best-effort push notification without blocking the WebSocket
    message/call path.
    """
    username = str(username or "").strip()
    print("PUSH START:", username)

    configured = push_configured()
    print("PUSH CONFIGURED:", configured)
    if not configured:
        return 0

    subscriptions = get_subscriptions(username)
    print("PUSH SUBSCRIPTIONS FOUND:", len(subscriptions))
    if not subscriptions:
        return 0

    results = await asyncio.gather(
        *(
            asyncio.to_thread(_send_one, subscription, payload)
            for subscription in subscriptions
        ),
        return_exceptions=True,
    )

    sent = sum(result is True for result in results)
    print("PUSH SEND RESULTS:", sent, "/", len(subscriptions))
    return sent

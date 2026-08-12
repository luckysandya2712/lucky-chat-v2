from typing import Dict, List

# Stores browser push subscriptions
# (Later we'll move this to a database.)
subscriptions: Dict[str, List[dict]] = {}


def add_subscription(username: str, subscription: dict):
    """Save or update a user's push subscription."""
    if username not in subscriptions:
        subscriptions[username] = []

    # Prevent duplicate subscriptions
    if subscription not in subscriptions[username]:
        subscriptions[username].append(subscription)


def get_subscriptions(username: str):
    """Return all subscriptions for a user."""
    return subscriptions.get(username, [])


def remove_subscription(username: str, subscription: dict):
    """Remove an invalid subscription."""
    if username in subscriptions:
        try:
            subscriptions[username].remove(subscription)
        except ValueError:
            pass

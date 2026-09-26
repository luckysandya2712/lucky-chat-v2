import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

DATABASE_URL = os.getenv("DATABASE_URL")

if not DATABASE_URL:
    # Keep SQLite as the local-development fallback, but never silently
    # fall back to ephemeral SQLite when the app is running on Railway.
    # Railway exposes RAILWAY_PROJECT_ID to deployed services.
    if os.getenv("RAILWAY_PROJECT_ID"):
        raise RuntimeError(
            "DATABASE_URL is required on Railway; refusing to fall back to local SQLite."
        )
    DATABASE_URL = "sqlite:///./luckychat.db"

if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

connect_args = {}

if DATABASE_URL.startswith("sqlite"):
    connect_args = {"check_same_thread": False}

engine_kwargs = {
    "connect_args": connect_args,
}

# Railway/PostgreSQL connections can become stale while the service remains
# alive (idle periods, network changes, database failover, etc.). Re-pinging
# pooled connections before use prevents a dead connection from surfacing as
# an intermittent request failure. SQLite keeps its existing configuration.
if not DATABASE_URL.startswith("sqlite"):
    engine_kwargs.update({
        "pool_pre_ping": True,
        "pool_recycle": 1800,
    })

engine = create_engine(
    DATABASE_URL,
    **engine_kwargs,
)

SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine
)

Base = declarative_base()

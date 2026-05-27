import os
import re
from logging.config import fileConfig

from sqlalchemy import engine_from_config, pool
from alembic import context
from dotenv import load_dotenv

# 載入 .env，讓 DATABASE_URL 等環境變數生效
load_dotenv()

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# 不使用 SQLAlchemy ORM，所以 target_metadata 為 None（手動撰寫 SQL migration）
target_metadata = None


def _get_url() -> str:
    """從環境變數讀取 DATABASE_URL，並移除 psycopg2 不支援的 channel_binding 參數。"""
    raw = os.getenv("DATABASE_URL", "")
    if not raw:
        raise RuntimeError("DATABASE_URL 環境變數未設定，請確認 .env 或 Vercel 設定")
    # 將 postgres:// 轉換為 postgresql://（SQLAlchemy 2.x 要求）
    url = re.sub(r"^postgres://", "postgresql://", raw)
    # 移除 channel_binding 查詢參數
    url = re.sub(r"[&?]channel_binding=[^&]*", "", url)
    return url


def run_migrations_offline() -> None:
    """離線模式：只輸出 SQL，不真正連線。"""
    url = _get_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """線上模式：真正連線並執行 migration。"""
    configuration = config.get_section(config.config_ini_section, {})
    configuration["sqlalchemy.url"] = _get_url()

    connectable = engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()

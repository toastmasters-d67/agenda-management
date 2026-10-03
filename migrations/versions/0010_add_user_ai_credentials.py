"""add_user_ai_credentials

Revision ID: 0010
Revises: 0009
Create Date: 2026-08-29 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


revision: str = '0010'
down_revision: Union[str, None] = '0009'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Each user connects their own AI accounts, so the keys are per-user, not
    # per-club and not global.
    #
    # `key_cipher` holds a Fernet token, never the raw key — the column name
    # says so on purpose, so that a future reader cannot mistake it for
    # something readable. `key_hint` is the last few characters only, which is
    # all the UI ever needs to show ("sk-…4f2a") to confirm which key is set.
    # The plaintext key is never returned by any endpoint once stored.
    op.execute("""
        CREATE TABLE IF NOT EXISTS user_ai_credentials (
            id         SERIAL PRIMARY KEY,
            username   VARCHAR(50) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
            provider   VARCHAR(20) NOT NULL,
            key_cipher TEXT        NOT NULL,
            key_hint   VARCHAR(20) NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (username, provider)
        )
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS user_ai_credentials")

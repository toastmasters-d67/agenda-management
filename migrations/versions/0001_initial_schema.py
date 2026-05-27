"""initial_schema

Revision ID: 0001
Revises: 
Create Date: 2026-05-26 10:41:03.185506

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0001'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- users ---
    op.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id            SERIAL PRIMARY KEY,
            username      VARCHAR(50) UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            name_en       VARCHAR(100),
            name_zh       VARCHAR(100),
            created_at    TIMESTAMPTZ DEFAULT NOW()
        )
    """)

    # --- agendas ---
    op.execute("""
        CREATE TABLE IF NOT EXISTS agendas (
            id           SERIAL PRIMARY KEY,
            username     VARCHAR(50) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
            data         JSONB NOT NULL,
            meeting_date DATE,
            created_at   TIMESTAMPTZ DEFAULT NOW(),
            updated_at   TIMESTAMPTZ DEFAULT NOW()
        )
    """)

    # --- members ---
    op.execute("""
        CREATE TABLE IF NOT EXISTS members (
            id         SERIAL PRIMARY KEY,
            name_zh    VARCHAR(100) NOT NULL,
            name_en    VARCHAR(100) NOT NULL,
            level      VARCHAR(100) NOT NULL DEFAULT 'TM',
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS agendas")
    op.execute("DROP TABLE IF EXISTS users")
    op.execute("DROP TABLE IF EXISTS members")

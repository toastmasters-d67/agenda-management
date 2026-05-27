"""add_clubs

Revision ID: 0003
Revises: 0002
Create Date: 2026-05-26 13:06:13.498037

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0003'
down_revision: Union[str, None] = '0002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Create clubs table
    op.execute("""
        CREATE TABLE IF NOT EXISTS clubs (
            id         SERIAL PRIMARY KEY,
            name       VARCHAR(100) NOT NULL UNIQUE,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    # Add club_id FK to members (nullable — existing members have no club yet)
    op.execute("""
        ALTER TABLE members
        ADD COLUMN IF NOT EXISTS club_id INTEGER REFERENCES clubs(id) ON DELETE SET NULL
    """)


def downgrade() -> None:
    op.execute("ALTER TABLE members DROP COLUMN IF EXISTS club_id")
    op.execute("DROP TABLE IF EXISTS clubs")

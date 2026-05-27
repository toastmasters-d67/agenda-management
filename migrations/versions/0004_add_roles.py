"""add_roles

Revision ID: 0004
Revises: 0003
Create Date: 2026-05-26 13:25:45.201355

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0004'
down_revision: Union[str, None] = '0003'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add role to users (default: club_member)
    op.execute("""
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'club_member'
    """)
    # Add club_id FK to users
    op.execute("""
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS club_id INTEGER REFERENCES clubs(id) ON DELETE SET NULL
    """)
    # Add club_id FK to agendas
    op.execute("""
        ALTER TABLE agendas
        ADD COLUMN IF NOT EXISTS club_id INTEGER REFERENCES clubs(id) ON DELETE SET NULL
    """)
    # Promote initial admin to system_admin
    op.execute("UPDATE users SET role = 'system_admin' WHERE username = 'admin'")


def downgrade() -> None:
    op.execute("UPDATE users SET role = 'club_member' WHERE username = 'admin'")
    op.execute("ALTER TABLE agendas DROP COLUMN IF EXISTS club_id")
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS club_id")
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS role")

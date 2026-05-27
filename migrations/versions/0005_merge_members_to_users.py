"""merge_members_to_users

Revision ID: 0005
Revises: 0004
Create Date: 2026-05-26 18:00:00.000000

Add level column to users, drop members table.
Every user IS a club member now; level is tracked on the users row.
"""
from alembic import op

revision = '0005'
down_revision = '0004'
branch_labels = None
depends_on = None


def upgrade():
    op.execute(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS level VARCHAR(100) NOT NULL DEFAULT 'TM'"
    )
    op.execute("DROP TABLE IF EXISTS members")


def downgrade():
    op.execute("""
        CREATE TABLE IF NOT EXISTS members (
            id         SERIAL PRIMARY KEY,
            name_zh    VARCHAR(100) NOT NULL,
            name_en    VARCHAR(100) NOT NULL,
            level      VARCHAR(100) NOT NULL DEFAULT 'TM',
            club_id    INTEGER REFERENCES clubs(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS level")

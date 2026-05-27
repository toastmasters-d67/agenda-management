"""add_status

Revision ID: 0007
Revises: 0006
Create Date: 2026-05-26 00:00:00.000000

Add status column to users.
  'active'  (default) — normal, can login
  'pending'           — self-registered, awaiting admin approval
"""
from alembic import op

revision = '0007'
down_revision = '0006'
branch_labels = None
depends_on = None


def upgrade():
    op.execute(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS"
        " status VARCHAR(20) NOT NULL DEFAULT 'active'"
    )


def downgrade():
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS status")

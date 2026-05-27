"""add_must_change_pw

Revision ID: 0006
Revises: 0005
Create Date: 2026-05-26 00:00:00.000000

Add must_change_pw column to users.
Newly created accounts (by admin) will have this set to true,
forcing the member to set their own password on first login.
"""
from alembic import op

revision = '0006'
down_revision = '0005'
branch_labels = None
depends_on = None


def upgrade():
    op.execute(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS"
        " must_change_pw BOOLEAN NOT NULL DEFAULT false"
    )


def downgrade():
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS must_change_pw")

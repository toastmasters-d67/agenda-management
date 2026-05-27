"""seed_admin_user

Revision ID: 0002
Revises: 0001
Create Date: 2026-05-26 11:06:52.557216

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0002'
down_revision: Union[str, None] = '0001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Insert admin user only if not already exists.
    # Password: 20260504 (bcrypt hashed)
    op.execute("""
        INSERT INTO users (username, password_hash, name_en, name_zh)
        SELECT 'admin', '$2b$12$5cM4c0aFXO2mq5qzVJdCAuMuS6gcDlYs3BvxQw0/LXyZ1xXMPqStO', 'Admin', 'Admin'
        WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = 'admin')
    """)


def downgrade() -> None:
    op.execute("DELETE FROM users WHERE username = 'admin'")

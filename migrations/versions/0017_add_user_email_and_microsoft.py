"""add_user_email_and_microsoft

Revision ID: 0017
Revises: 0016
Create Date: 2026-10-03 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


revision: str = '0017'
down_revision: Union[str, None] = '0016'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Sign in with Microsoft.
    #
    # `email` is how an existing account is found the first time someone signs
    # in with Microsoft — but only when Microsoft vouches for the address (see
    # _ms_email_verified in api/index.py). Unique case-insensitively, so one
    # address can never match two accounts. Nullable: most existing accounts
    # have none until an admin fills it in.
    #
    # `ms_sub` is the Microsoft identity the account is bound to after that
    # first match (the id_token `sub`, stable per user per app). Every later
    # sign-in matches on this, never on email again — an address can change
    # hands, the subject cannot.
    #
    # Accounts created through Microsoft sign-up have no password:
    # password_hash is '' (the column stays NOT NULL), which the password login
    # treats as "no password set".
    op.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(254)")
    op.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS ms_sub VARCHAR(100)")
    op.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email_lower
        ON users (lower(email)) WHERE email IS NOT NULL
    """)
    op.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS ux_users_ms_sub
        ON users (ms_sub) WHERE ms_sub IS NOT NULL
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ux_users_ms_sub")
    op.execute("DROP INDEX IF EXISTS ux_users_email_lower")
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS ms_sub")
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS email")

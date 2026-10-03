"""add_oauth_client_name

Revision ID: 0016
Revises: 0015
Create Date: 2026-10-03 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


revision: str = '0016'
down_revision: Union[str, None] = '0015'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # The name the client gave in its metadata document, captured at consent
    # time so the "authorized apps" page can say "Claude" instead of a URL.
    #
    # Stored rather than re-fetched: listing grants must not fan out to
    # arbitrary client-controlled URLs, and the name the user actually agreed
    # to is the one worth showing — a client renaming itself later should not
    # change what the user sees they approved.
    #
    # Carried on oauth_codes too because the refresh token is minted in a
    # different invocation (the token call), where only the code row survives.
    op.execute("""
        ALTER TABLE oauth_codes
        ADD COLUMN IF NOT EXISTS client_name VARCHAR(200) NOT NULL DEFAULT ''
    """)
    op.execute("""
        ALTER TABLE oauth_refresh_tokens
        ADD COLUMN IF NOT EXISTS client_name VARCHAR(200) NOT NULL DEFAULT ''
    """)


def downgrade() -> None:
    op.execute("ALTER TABLE oauth_refresh_tokens DROP COLUMN IF EXISTS client_name")
    op.execute("ALTER TABLE oauth_codes DROP COLUMN IF EXISTS client_name")

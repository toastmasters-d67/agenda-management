"""rotate_refresh_tokens

Revision ID: 0018
Revises: 0017
Create Date: 2026-10-05 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


revision: str = '0018'
down_revision: Union[str, None] = '0017'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # OAuth 2.1 requires a public client's refresh token to be rotated: every
    # use hands back a new one and retires the old. Until now the token's hash
    # was also the grant's identity (access tokens point at it, the settings
    # page revokes by it), so rotating the token would have changed the grant.
    #
    # `grant_id` splits the two. It is fixed for the life of the grant; the
    # token_hash beside it changes on every refresh.
    #
    # Backfilled with the current token_hash, which is exactly the value
    # already-issued access tokens carry in their `grant` claim — so nothing
    # in flight is invalidated by this migration.
    op.execute("""
        ALTER TABLE oauth_refresh_tokens
        ADD COLUMN IF NOT EXISTS grant_id TEXT
    """)
    op.execute("UPDATE oauth_refresh_tokens SET grant_id = token_hash WHERE grant_id IS NULL")
    op.execute("ALTER TABLE oauth_refresh_tokens ALTER COLUMN grant_id SET NOT NULL")
    # Vercel does not run migrations, so for a while the previous code may be
    # serving against this schema. It inserts without grant_id; the default
    # keeps those inserts from failing. (Its access tokens point at token_hash
    # rather than this id, so they are refused once the new code is live and
    # the client simply refreshes.)
    op.execute("""
        ALTER TABLE oauth_refresh_tokens
        ALTER COLUMN grant_id SET DEFAULT md5(random()::text || clock_timestamp()::text)
    """)
    op.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS ux_oauth_refresh_grant
        ON oauth_refresh_tokens (grant_id)
    """)

    # The token this one replaced. A retired token showing up again means two
    # parties hold the same grant — the legitimate client and whoever copied
    # it — and there is no telling which is which, so the grant is revoked.
    op.execute("""
        ALTER TABLE oauth_refresh_tokens
        ADD COLUMN IF NOT EXISTS prev_token_hash TEXT
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_oauth_refresh_prev
        ON oauth_refresh_tokens (prev_token_hash)
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_oauth_refresh_prev")
    op.execute("ALTER TABLE oauth_refresh_tokens DROP COLUMN IF EXISTS prev_token_hash")
    op.execute("DROP INDEX IF EXISTS ux_oauth_refresh_grant")
    op.execute("ALTER TABLE oauth_refresh_tokens DROP COLUMN IF EXISTS grant_id")

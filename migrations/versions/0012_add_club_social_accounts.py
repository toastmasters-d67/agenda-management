"""add_club_social_accounts

Revision ID: 0012
Revises: 0011
Create Date: 2026-08-29 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


revision: str = '0012'
down_revision: Union[str, None] = '0011'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Club-level secrets, kept OUT of clubs.settings on purpose: GET /api/clubs
    # is a public, unauthenticated endpoint (the register form reads it), so
    # anything landing in that JSONB is world-readable. Same encryption rules as
    # user_ai_credentials — `value_cipher` is a Fernet token, `hint` is the last
    # few characters, and no endpoint ever returns the plaintext.
    op.execute("""
        CREATE TABLE IF NOT EXISTS club_secrets (
            id           SERIAL PRIMARY KEY,
            club_id      INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
            name         VARCHAR(40) NOT NULL,
            value_cipher TEXT        NOT NULL,
            hint         VARCHAR(20) NOT NULL DEFAULT '',
            created_at   TIMESTAMPTZ DEFAULT NOW(),
            updated_at   TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (club_id, name)
        )
    """)

    # One row per connected destination (a Facebook Page, an Instagram
    # professional account, a Threads profile).
    #
    # Per *club*, not per user: a Page is a club asset, and the education VP has
    # to be able to post to the same Page the president connected. This is the
    # opposite of user_ai_credentials, where the key is personal because it is
    # the personal account being billed.
    #
    # `token_cipher` is the long-lived access token. Meta's long-lived tokens
    # expire (~60 days), so `expires_at` is stored to let the UI warn before a
    # post fails rather than after.
    op.execute("""
        CREATE TABLE IF NOT EXISTS club_social_accounts (
            id           SERIAL PRIMARY KEY,
            club_id      INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
            platform     VARCHAR(20) NOT NULL,
            account_id   VARCHAR(64) NOT NULL,
            account_name VARCHAR(200) NOT NULL DEFAULT '',
            token_cipher TEXT        NOT NULL,
            expires_at   TIMESTAMPTZ,
            created_at   TIMESTAMPTZ DEFAULT NOW(),
            updated_at   TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (club_id, platform)
        )
    """)

    # Where a published post ended up, so the UI can link to it and a retry can
    # tell "already posted" from "never posted".
    op.execute("""
        ALTER TABLE social_posts
        ADD COLUMN IF NOT EXISTS published JSONB NOT NULL DEFAULT '{}'::jsonb
    """)


def downgrade() -> None:
    op.execute("ALTER TABLE social_posts DROP COLUMN IF EXISTS published")
    op.execute("DROP TABLE IF EXISTS club_social_accounts")
    op.execute("DROP TABLE IF EXISTS club_secrets")

"""add_social_posts

Revision ID: 0009
Revises: 0008
Create Date: 2026-08-29 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


revision: str = '0009'
down_revision: Union[str, None] = '0008'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # One row per social post draft.
    #
    # `variants` and `images` are JSONB rather than columns/side tables for the
    # same reason clubs.settings is: the set of platforms is expected to grow
    # (LinkedIn is deferred, not cancelled) and a new one must not need a
    # migration. Shape:
    #   variants = { "<platform>": { "text": str, "enabled": bool } }
    #   images   = [ { "url": str, "name": str } ]
    #
    # agenda_id is nullable + SET NULL: a post outlives the meeting it was
    # written for, and losing the link must not lose the copy.
    op.execute("""
        CREATE TABLE IF NOT EXISTS social_posts (
            id         SERIAL PRIMARY KEY,
            club_id    INTEGER REFERENCES clubs(id)   ON DELETE CASCADE,
            agenda_id  INTEGER REFERENCES agendas(id) ON DELETE SET NULL,
            title      VARCHAR(200) NOT NULL DEFAULT '',
            status     VARCHAR(20)  NOT NULL DEFAULT 'draft',
            body       TEXT         NOT NULL DEFAULT '',
            variants   JSONB        NOT NULL DEFAULT '{}'::jsonb,
            images     JSONB        NOT NULL DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ  DEFAULT NOW(),
            updated_at TIMESTAMPTZ  DEFAULT NOW()
        )
    """)
    # The list view is always "this club's posts, newest first".
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_social_posts_club_created
        ON social_posts (club_id, created_at DESC)
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_social_posts_club_created")
    op.execute("DROP TABLE IF EXISTS social_posts")

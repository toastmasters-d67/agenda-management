"""add_post_governance

Revision ID: 0023
Revises: 0022
Create Date: 2026-11-01 00:00:00.000000

PostGenerator's governed copy engine (api/_postgen) is now how promo and recap
posts are written. It needs three things the social feature did not have:

- club_post_prefs: each club's brand signature, fixed hashtags, banned words,
  copy persona and per-kind notes, default tuning and register link. One JSONB
  per club rather than columns: the engine owns the keys (api/_postgen/context.py
  PREF_TEXT_KEYS / PREF_LIST_KEYS) and validates them, and a new key should not
  need a migration. Not in clubs.settings because GET /api/clubs is public.
- post_templates: PPTX poster templates a club uploaded (files in R2). The
  built-in templates ship with the code and have no rows.
- social_posts.review_state / governance: the generation's QC result, compliance
  notes and the facts it was written from, plus the human review gate.
  review_state 'none' = not written by the engine (kind 'other', hand-written,
  or older rows) and is never gated; 'pending' / 'approved' / 'rejected' are.
"""
from typing import Sequence, Union

from alembic import op


revision: str = '0023'
down_revision: Union[str, None] = '0022'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS club_post_prefs (
            club_id    INTEGER PRIMARY KEY REFERENCES clubs(id) ON DELETE CASCADE,
            prefs      JSONB       NOT NULL DEFAULT '{}'::jsonb,
            updated_by VARCHAR(100),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    op.execute("""
        CREATE TABLE IF NOT EXISTS post_templates (
            id                  VARCHAR(80) PRIMARY KEY,
            club_id             INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
            use                 VARCHAR(20) NOT NULL,
            name                VARCHAR(100) NOT NULL DEFAULT '',
            style               JSONB       NOT NULL DEFAULT '[]'::jsonb,
            file_url            TEXT        NOT NULL,
            role_slots_per_page INTEGER     NOT NULL DEFAULT 4,
            role_pages          INTEGER,
            enabled             BOOLEAN     NOT NULL DEFAULT TRUE,
            created_by          VARCHAR(100),
            created_at          TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS ix_post_templates_club ON post_templates (club_id)")
    op.execute("""
        ALTER TABLE social_posts
            ADD COLUMN IF NOT EXISTS review_state VARCHAR(20) NOT NULL DEFAULT 'none',
            ADD COLUMN IF NOT EXISTS governance   JSONB       NOT NULL DEFAULT '{}'::jsonb,
            ADD COLUMN IF NOT EXISTS reviewed_by  VARCHAR(100),
            ADD COLUMN IF NOT EXISTS reviewed_at  TIMESTAMPTZ
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE social_posts
            DROP COLUMN IF EXISTS reviewed_at,
            DROP COLUMN IF EXISTS reviewed_by,
            DROP COLUMN IF EXISTS governance,
            DROP COLUMN IF EXISTS review_state
    """)
    op.execute("DROP INDEX IF EXISTS ix_post_templates_club")
    op.execute("DROP TABLE IF EXISTS post_templates")
    op.execute("DROP TABLE IF EXISTS club_post_prefs")

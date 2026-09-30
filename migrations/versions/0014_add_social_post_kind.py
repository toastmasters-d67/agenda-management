"""add_social_post_kind

Revision ID: 0014
Revises: 0013
Create Date: 2026-09-30 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


revision: str = '0014'
down_revision: Union[str, None] = '0013'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # What the post is for. Three kinds that read differently and are checked
    # differently: a promo is an invitation and is worthless without the date,
    # address and door fee; a recap is a record of something that already
    # happened; everything else is a one-off announcement.
    #
    # A column rather than a key in some JSONB, because this one is queried
    # (list filters) and validated, unlike the free-form per-platform variants.
    #
    # Existing rows become 'other': they were written before the distinction
    # existed, so calling any of them a promo would be a guess.
    op.execute("""
        ALTER TABLE social_posts
        ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'other'
    """)


def downgrade() -> None:
    op.execute("ALTER TABLE social_posts DROP COLUMN IF EXISTS kind")

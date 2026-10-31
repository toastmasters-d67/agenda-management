"""club_template_default_compact

Revision ID: 0021
Revises: 0020
Create Date: 2026-10-24 00:00:00.000000

New clubs default to the neutral `compact` agenda template rather than
`standard` (the frozen Entrepreneur layout), matching the frontend fallback
in lib/agendaTemplates.js. Existing clubs keep whatever template_key they have.
"""
from typing import Sequence, Union

from alembic import op


revision: str = '0021'
down_revision: Union[str, None] = '0020'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TABLE clubs ALTER COLUMN template_key SET DEFAULT 'compact'")


def downgrade() -> None:
    op.execute("ALTER TABLE clubs ALTER COLUMN template_key SET DEFAULT 'standard'")

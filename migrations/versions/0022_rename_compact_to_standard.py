"""rename_compact_to_standard

Revision ID: 0022
Revises: 0021
Create Date: 2026-10-30 00:00:00.000000

The neutral single-column agenda template is renamed from `compact` to
`standard` (lib/agendaTemplates.js). The old frozen `standard` layout — a copy
of `entrepreneur` — is gone; its last club had already moved to
`entrepreneur`. Clubs still on `compact` are carried over and new clubs
default to `standard`.
"""
from typing import Sequence, Union

from alembic import op


revision: str = '0022'
down_revision: Union[str, None] = '0021'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("UPDATE clubs SET template_key='standard' WHERE template_key='compact'")
    op.execute("ALTER TABLE clubs ALTER COLUMN template_key SET DEFAULT 'standard'")


def downgrade() -> None:
    op.execute("ALTER TABLE clubs ALTER COLUMN template_key SET DEFAULT 'compact'")
    op.execute("UPDATE clubs SET template_key='compact' WHERE template_key='standard'")

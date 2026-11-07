"""files_links_to_root

Revision ID: 0028
Revises: 0027
Create Date: 2026-11-06 00:00:00.000000

The Azure VM deployment moves from https://host/club-management to the
domain root. Its files are served by /api/files (Azure Blob), so stored
links like https://host/club-management/api/files/media/... become
https://host/api/files/media/... — otherwise _store_key no longer
recognises them as ours (deleting or replacing a club image would leave the
old blob behind). nginx also 308-redirects the old prefix, so links that
were already sent out keep working.

Every text / json column is scanned, the same way api/migrate_storage.py
rewrites R2 links. Deployments on R2 (Vercel / Neon) have no such links,
so this is a no-op there.

No downgrade: going back to the sub-path is a redeploy decision, and the
nginx redirect only runs in this direction.
"""
from typing import Sequence, Union

from alembic import op
from sqlalchemy import text


revision: str = '0028'
down_revision: Union[str, None] = '0027'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

OLD = "/club-management/api/files/"
NEW = "/api/files/"


def upgrade() -> None:
    conn = op.get_bind()
    columns = conn.execute(text("""
        SELECT table_name, column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'public'
           AND data_type IN ('text', 'character varying', 'json', 'jsonb')
           AND table_name <> 'alembic_version'
         ORDER BY table_name, column_name
    """)).fetchall()
    for table, column, dtype in columns:
        cast = {"character varying": "text"}.get(dtype, dtype)
        conn.execute(
            text(f'UPDATE "{table}" SET "{column}" = replace("{column}"::text, :old, :new)::{cast}'
                 f' WHERE strpos("{column}"::text, :old) > 0'),
            {"old": OLD, "new": NEW},
        )


def downgrade() -> None:
    pass

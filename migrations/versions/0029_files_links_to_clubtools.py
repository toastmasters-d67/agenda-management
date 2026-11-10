"""files_links_to_clubtools

Revision ID: 0029
Revises: 0028
Create Date: 2026-11-10 00:00:00.000000

The Azure VM deployment moves from https://postgen-d67.eastasia.cloudapp.azure.com
to https://clubtools.toastmasters.org.tw (PUBLIC_BASE_URL changes with it).
Stored file links like https://postgen-d67…/api/files/media/... become
https://clubtools.toastmasters.org.tw/api/files/media/... — otherwise
_store_key no longer recognises them as ours (deleting or replacing a club
image would leave the old blob behind). nginx 301-redirects the old host, so
links that were already sent out keep working.

Every text / json column is scanned, the same way as 0028. Deployments on R2
(Vercel / Neon) have no such links, so this is a no-op there.

No downgrade: going back to the old host is a redeploy decision.
"""
from typing import Sequence, Union

from alembic import op
from sqlalchemy import text


revision: str = '0029'
down_revision: Union[str, None] = '0028'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

OLD = "https://postgen-d67.eastasia.cloudapp.azure.com/api/files/"
NEW = "https://clubtools.toastmasters.org.tw/api/files/"


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

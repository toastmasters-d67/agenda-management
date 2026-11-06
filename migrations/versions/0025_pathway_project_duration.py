"""pathway_project_duration

Revision ID: 0025
Revises: 0024
Create Date: 2026-11-06 00:00:00.000000

Each Pathways project gets a suggested speech length (`duration`, e.g. 5'-7')
and its speech objectives (`objectives`, printed by the Word mark
{{演講目標}}). Both are edited by system admins on 「Pathways 路徑管理」.
When an agenda picks a project and the speech's 時長 is still blank or the
default 5'-7', the suggested length is filled in.

Only a few lengths that differ from the 5'-7' default are seeded; objectives
start empty. Both are to be checked against the current Toastmasters project
materials on the admin page.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = '0025'
down_revision: Union[str, None] = '0024'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SEED = {
    'Ice Breaker': "4'-6'",
    'Reflect on Your Path': "10'-12'",
    'Prepare to Speak Professionally': "18'-22'",
}


def upgrade() -> None:
    op.execute("ALTER TABLE pathway_projects ADD COLUMN duration TEXT NOT NULL DEFAULT ''")
    op.execute("ALTER TABLE pathway_projects ADD COLUMN objectives TEXT NOT NULL DEFAULT ''")
    stmt = sa.text("UPDATE pathway_projects SET duration = :d WHERE name_en = :n")
    for name, duration in SEED.items():
        op.get_bind().execute(stmt, {"d": duration, "n": name})


def downgrade() -> None:
    op.execute("ALTER TABLE pathway_projects DROP COLUMN objectives")
    op.execute("ALTER TABLE pathway_projects DROP COLUMN duration")

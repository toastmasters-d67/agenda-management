"""chillhihigh_theme_question

Revision ID: 0024
Revises: 0023
Create Date: 2026-11-06 00:00:00.000000

主題題目 (themeQuestion) and 即席題目 (tableTopicsQuestion) are now two
separate per-meeting fields. Until now the agenda editor's box labelled
「主題題目」 saved to `tableTopicsQuestion`, and only the Chill Hi High
template printed it — as its 主題題目. Those values move to `themeQuestion`,
where the 角色 page and the sheet import already put that club's 主題題目.
Agendas that already have a themeQuestion are left alone.

No downgrade: once moved, a value can't be told apart from one typed into the
new 主題題目 box (the Chill Hi High template reads either field anyway).
"""
from typing import Sequence, Union

from alembic import op


revision: str = '0024'
down_revision: Union[str, None] = '0023'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        UPDATE agendas a
           SET data = (a.data - 'tableTopicsQuestion')
                      || jsonb_build_object('themeQuestion', a.data->>'tableTopicsQuestion')
          FROM clubs c
         WHERE a.club_id = c.id
           AND c.template_key = 'chillhihigh'
           AND COALESCE(a.data->>'tableTopicsQuestion', '') <> ''
           AND COALESCE(a.data->>'themeQuestion', '') = ''
    """)


def downgrade() -> None:
    pass

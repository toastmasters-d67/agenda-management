"""add_club_branding

Revision ID: 0008
Revises: 0007
Create Date: 2026-06-29 00:00:00.000000

Add per-chapter branding + agenda template support to clubs.
  name_zh / name_en / charter_no / founded_date / fee — header branding text
    (name_zh is the agenda header full name, distinct from `name` used in pickers)
  logo_url / fb_qr_url / line_qr_url        — R2 image URLs
  template_key                              — which agenda layout to render
  settings                                  — reserved JSONB for template extras

All new columns are nullable except template_key (defaults to 'standard'),
so existing clubs keep the current hard-coded layout/branding via frontend fallback.
"""
from alembic import op

revision = '0008'
down_revision = '0007'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE clubs ADD COLUMN IF NOT EXISTS name_zh VARCHAR(150)")
    op.execute("ALTER TABLE clubs ADD COLUMN IF NOT EXISTS name_en VARCHAR(150)")
    op.execute("ALTER TABLE clubs ADD COLUMN IF NOT EXISTS charter_no VARCHAR(50)")
    op.execute("ALTER TABLE clubs ADD COLUMN IF NOT EXISTS founded_date VARCHAR(20)")
    op.execute("ALTER TABLE clubs ADD COLUMN IF NOT EXISTS fee VARCHAR(50)")
    op.execute("ALTER TABLE clubs ADD COLUMN IF NOT EXISTS logo_url TEXT")
    op.execute("ALTER TABLE clubs ADD COLUMN IF NOT EXISTS fb_qr_url TEXT")
    op.execute("ALTER TABLE clubs ADD COLUMN IF NOT EXISTS line_qr_url TEXT")
    op.execute(
        "ALTER TABLE clubs ADD COLUMN IF NOT EXISTS"
        " template_key VARCHAR(50) NOT NULL DEFAULT 'standard'"
    )
    op.execute("ALTER TABLE clubs ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}'::jsonb")


def downgrade():
    op.execute("ALTER TABLE clubs DROP COLUMN IF EXISTS settings")
    op.execute("ALTER TABLE clubs DROP COLUMN IF EXISTS template_key")
    op.execute("ALTER TABLE clubs DROP COLUMN IF EXISTS line_qr_url")
    op.execute("ALTER TABLE clubs DROP COLUMN IF EXISTS fb_qr_url")
    op.execute("ALTER TABLE clubs DROP COLUMN IF EXISTS logo_url")
    op.execute("ALTER TABLE clubs DROP COLUMN IF EXISTS fee")
    op.execute("ALTER TABLE clubs DROP COLUMN IF EXISTS founded_date")
    op.execute("ALTER TABLE clubs DROP COLUMN IF EXISTS charter_no")
    op.execute("ALTER TABLE clubs DROP COLUMN IF EXISTS name_en")
    op.execute("ALTER TABLE clubs DROP COLUMN IF EXISTS name_zh")

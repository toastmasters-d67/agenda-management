"""add_ai_jobs

Revision ID: 0011
Revises: 0010
Create Date: 2026-08-29 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


revision: str = '0011'
down_revision: Union[str, None] = '0010'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # A generation job the browser can poll instead of holding one long HTTP
    # request open. The row — not the response — is what owns the result, so a
    # dropped connection, a closed modal, or a page reload no longer loses a
    # picture the user already paid OpenAI for.
    #
    # Note what this does NOT buy on serverless: there is no worker process, so
    # /run still does the work inside one invocation and still has to finish
    # inside the function's maxDuration. `updated_at` is what lets a poller
    # call a job dead when that invocation was killed mid-flight.
    op.execute("""
        CREATE TABLE IF NOT EXISTS ai_jobs (
            id         TEXT PRIMARY KEY,
            username   VARCHAR(50) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
            club_id    INTEGER,
            kind       VARCHAR(20) NOT NULL,
            status     VARCHAR(20) NOT NULL DEFAULT 'queued',
            params     JSONB       NOT NULL DEFAULT '{}'::jsonb,
            result     JSONB,
            error      TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_ai_jobs_user_created
        ON ai_jobs (username, created_at DESC)
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_ai_jobs_user_created")
    op.execute("DROP TABLE IF EXISTS ai_jobs")

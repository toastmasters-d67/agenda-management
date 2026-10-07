"""add_club_memberships

Revision ID: 0019
Revises: 0018
Create Date: 2026-10-07 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


revision: str = '0019'
down_revision: Union[str, None] = '0018'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # A member may belong to several clubs, with a role in each. One row per
    # (person, club). The education level stays on `users`: it is the person's
    # own Toastmasters credential, the same in every club.
    #
    # `users.club_id` / `users.role` remain as the member's *primary* club and
    # their role there — the club a session starts in — kept in step with this
    # table by api/index.py (_ensure_membership / _sync_primary). A
    # system_admin's `users.role` stays 'system_admin' everywhere; a membership
    # row for them only records that they belong to that club (rosters).
    op.execute("""
        CREATE TABLE IF NOT EXISTS club_memberships (
            username   VARCHAR(50) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
            club_id    INTEGER     NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
            role       VARCHAR(20) NOT NULL CHECK (role IN ('club_admin', 'club_member')),
            created_at TIMESTAMPTZ DEFAULT NOW(),
            PRIMARY KEY (username, club_id)
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS ix_club_memberships_club ON club_memberships (club_id)")

    # Everyone's current club becomes their first membership. Pending
    # registrations too: that row is how the club's admins see the request.
    op.execute("""
        INSERT INTO club_memberships (username, club_id, role)
        SELECT username, club_id,
               CASE WHEN role = 'club_admin' THEN 'club_admin'
                    WHEN role = 'system_admin' THEN 'club_admin'
                    ELSE 'club_member' END
        FROM users WHERE club_id IS NOT NULL
        ON CONFLICT DO NOTHING
    """)

    # The club an MCP grant currently acts in (switch_club). NULL: the
    # member's primary club.
    op.execute("""
        ALTER TABLE oauth_refresh_tokens
        ADD COLUMN IF NOT EXISTS active_club_id INTEGER REFERENCES clubs(id) ON DELETE SET NULL
    """)


def downgrade() -> None:
    op.execute("ALTER TABLE oauth_refresh_tokens DROP COLUMN IF EXISTS active_club_id")
    op.execute("DROP INDEX IF EXISTS ix_club_memberships_club")
    op.execute("DROP TABLE IF EXISTS club_memberships")

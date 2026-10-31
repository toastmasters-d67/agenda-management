"""add_machines

Revision ID: 0020
Revises: 0019
Create Date: 2026-10-22 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


revision: str = '0020'
down_revision: Union[str, None] = '0019'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # A machine is an electronic name badge. It registers itself (by serial),
    # shows a pairing code, and a club admin enters that code to bind it to
    # one member of their club. A member may wear several badges; a badge
    # shows one member.
    #
    # status: 'pending'  — registered, not (or no longer) bound
    #         'active'   — bound, showing its member
    #         'disabled' — cut off by an admin; keeps its binding and token,
    #                      so re-enabling needs no re-pairing
    #
    # The binding is only valid while the member still belongs to the
    # machine's club; api/index.py checks that on every badge read, so the
    # several places that remove a membership need not know about machines.
    op.execute("""
        CREATE TABLE IF NOT EXISTS machines (
            id             SERIAL PRIMARY KEY,
            serial         VARCHAR(100) NOT NULL UNIQUE,
            name           VARCHAR(100),
            club_id        INTEGER     REFERENCES clubs(id) ON DELETE SET NULL,
            bound_username VARCHAR(50) REFERENCES users(username) ON DELETE SET NULL,
            status         VARCHAR(20) NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'active', 'disabled')),
            bound_by       VARCHAR(50),
            bound_at       TIMESTAMPTZ,
            last_seen_at   TIMESTAMPTZ,
            created_at     TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS ix_machines_club ON machines (club_id)")

    # The pairing in flight: at most one per machine. Only hashes are stored,
    # as with oauth_codes — the code and poll secret are bearer credentials
    # for the few minutes they live. paired_at is set when an admin enters the
    # code; the machine's next poll then collects its token and the row goes.
    op.execute("""
        CREATE TABLE IF NOT EXISTS machine_pairings (
            machine_id       INTEGER PRIMARY KEY REFERENCES machines(id) ON DELETE CASCADE,
            code_hash        TEXT        NOT NULL UNIQUE,
            poll_secret_hash TEXT        NOT NULL,
            paired_at        TIMESTAMPTZ,
            expires_at       TIMESTAMPTZ NOT NULL
        )
    """)

    # A machine's own credential. It identifies the machine, not a member, and
    # opens only the machine endpoints. Revocable, hence stored (hashed).
    op.execute("""
        CREATE TABLE IF NOT EXISTS machine_tokens (
            token_hash   TEXT PRIMARY KEY,
            machine_id   INTEGER     NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
            revoked_at   TIMESTAMPTZ,
            last_used_at TIMESTAMPTZ,
            created_at   TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS ix_machine_tokens_machine ON machine_tokens (machine_id)")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_machine_tokens_machine")
    op.execute("DROP TABLE IF EXISTS machine_tokens")
    op.execute("DROP TABLE IF EXISTS machine_pairings")
    op.execute("DROP INDEX IF EXISTS ix_machines_club")
    op.execute("DROP TABLE IF EXISTS machines")

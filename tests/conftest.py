"""Shared test setup.

Two kinds of tests live here:

- engine tests (tests/postgen/test_engine.py) need nothing but the code;
- API tests (tests/test_governed_posts.py) need a throwaway PostgreSQL with
  the Alembic schema, named by TEST_DATABASE_URL. Without it they are skipped.
  **Never point it at a database you care about** — the tests create and
  delete clubs, users and posts.

Everything runs with LLM_FAKE=1: PostGenerator's fake model, no key, no cost.
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

os.environ["LLM_FAKE"] = "1"
if os.environ.get("TEST_DATABASE_URL"):
    # api/index.py calls load_dotenv(), which never overrides a variable that is
    # already set — so this wins over a developer's .env.
    os.environ["DATABASE_URL"] = os.environ["TEST_DATABASE_URL"]
else:
    os.environ.setdefault("DATABASE_URL", "")

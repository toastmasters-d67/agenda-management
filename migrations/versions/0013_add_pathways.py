"""add_pathways

Revision ID: 0013
Revises: 0012
Create Date: 2026-09-27 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0013'
down_revision: Union[str, None] = '0012'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# ------------------------------------------------------------------ seed data
# Pathways catalog as of 2026-09 — Paths and Projects Catalog V6.1 for the
# English names; Chinese names follow 劉雨軒的 Pathways 動力中心
# (https://ckc300.github.io/). After this migration the DB is the source of
# truth, edited on the 「Pathways 路徑管理」page; this list is only the seed.

# (en, zh) in display order.
PROJECTS = [
    ('Ice Breaker', '初試啼聲'),
    ('Writing a Speech with Purpose', '撰寫具備目的性的演講稿'),
    ('Introduction to Vocal Variety and Body Language', '抑揚頓挫與肢體語言入門'),
    ('Evaluation and Feedback', '講評與回饋'),
    ('Understanding Your Leadership Style', '瞭解你的領導風格'),
    ('Understanding Your Communication Style', '了解自身溝通風格'),
    ('Introduction to Toastmasters Mentoring', '國際演講會指導計畫介紹'),
    ('Know Your Sense of Humor', '發掘幽默感'),
    ('Connect with Your Audience', '連結觀眾交流共鳴'),
    ('Active Listening', '積極聆聽'),
    ('Effective Body Language', '有效的肢體語言'),
    ('Managing Time', '時間管理'),
    ('Negotiate the Best Outcome', '協調最佳結果'),
    ('Engage Your Audience with Humor', '使用幽默吸引觀眾'),
    ('Understanding Emotional Intelligence', '了解情緒智能'),
    ('Understanding Conflict Resolution', '掌握解決衝突之道'),
    ('Persuasive Speaking', '說服型演講'),
    ('Develop a Communication Plan', '制定溝通計畫'),
    ('Reaching Consensus', '達成共識'),
    ('Present a Proposal', '發表企畫案'),
    ('Planning and Implementing', '計劃與執行'),
    ('Make Connections Through Networking', '運用人際網絡建立關係'),
    ('Successful Collaboration', '成功的合作'),
    ('Connect with Storytelling', '巧說故事拉近距離'),
    ('Creating Effective Visual Aids', '製作有效的視覺輔具'),
    ('Deliver Social Speeches', '發表社交演講'),
    ('Focus on the Positive', '聚焦正面思考'),
    ('Inspire Your Audience', '激勵啟發'),
    ('Prepare for an Interview', '準備面談'),
    ('Understanding Vocal Variety', '了解抑揚頓挫'),
    ('Using Descriptive Language', '運用描述性語彙'),
    ('Using Presentation Software', '使用簡報軟體'),
    ('Researching and Presenting', '研究和發表'),
    ('Manage Change', '掌理改變'),
    ('The Power of Humor in an Impromptu Speech', '在即席演講展示幽默力量'),
    ('Motivate Others', '激勵他人'),
    ('Leading in Difficult Situations', '困境中領導'),
    ('Managing a Difficult Audience', '應對棘手的觀眾'),
    ('Communicate Change', '傳達改變'),
    ('Improvement Through Positive Coaching', '透過正向教練達成改進'),
    ('Manage Projects Successfully', '成功管理專案'),
    ('Leading Your Team', '領導您的團隊'),
    ('Public Relations Strategies', '公關策略'),
    ('Building a Social Media Presence', '提高社群媒體能見度'),
    ('Create a Podcast', '製作播客'),
    ('Manage Online Meetings', '組織線上會議'),
    ('Question-and-Answer Session', '問答時間'),
    ('Write a Compelling Blog', '撰寫吸引人的部落格'),
    ('Lead in Any Situation', '時時挺身領導'),
    ('Deliver Your Message with Humor', '運用幽默傳達訊息'),
    ('Team Building', '團隊營造'),
    ('High Performance Leadership', '高成效領導'),
    ('Prepare to Speak Professionally', '為專業演講做好準備'),
    ('Develop Your Vision', '建立您的願景'),
    ('Manage Successful Events', '舉辦成功的活動'),
    ('Leading in Your Volunteer Organization', '於志工組織領導'),
    ('Reflect on Your Path', '回顧您的學習路徑'),
    ('Ethical Leadership', '道德領導'),
    ('Lessons Learned', '學習心得'),
    ('Moderate a Panel Discussion', '主持小組專題討論'),
]

# (code, en, zh, legacy) in display order.
PATHS = [
    ('DL', 'Dynamic Leadership',      '動態領導',   False),
    ('EH', 'Engaging Humor',          '風趣表達',   False),
    ('MS', 'Motivational Strategies', '激勵策略',   False),
    ('PI', 'Persuasive Influence',    '說服影響',   False),
    ('PM', 'Presentation Mastery',    '演講精粹',   False),
    ('VC', 'Visionary Communication', '願景溝通',   False),
    ('EC', 'Effective Coaching',      '高效教練',   True),
    ('IP', 'Innovative Planning',     '創新規劃',   True),
    ('SR', 'Strategic Relationships', '策略人脈',   True),
    ('TC', 'Team Collaboration',      '團隊合作',   True),
    ('LD', 'Leadership Development',  '領導力發展', True),
]

_L1 = ['Ice Breaker', 'Writing a Speech with Purpose',
       'Introduction to Vocal Variety and Body Language', 'Evaluation and Feedback']
_MENTOR = 'Introduction to Toastmasters Mentoring'
_REFLECT = 'Reflect on Your Path'


def _req(l2, l3, l4, l5):
    return {1: _L1, 2: l2 + [_MENTOR], 3: [l3], 4: [l4], 5: [l5, _REFLECT]}


REQUIRED = {
    'DL': _req(['Understanding Your Leadership Style', 'Understanding Your Communication Style'],
               'Negotiate the Best Outcome', 'Manage Change', 'Lead in Any Situation'),
    'EH': _req(['Know Your Sense of Humor', 'Connect with Your Audience'],
               'Engage Your Audience with Humor', 'The Power of Humor in an Impromptu Speech',
               'Deliver Your Message with Humor'),
    'MS': _req(['Understanding Your Communication Style', 'Active Listening'],
               'Understanding Emotional Intelligence', 'Motivate Others', 'Team Building'),
    'PI': _req(['Understanding Your Leadership Style', 'Active Listening'],
               'Understanding Conflict Resolution', 'Leading in Difficult Situations',
               'High Performance Leadership'),
    'PM': _req(['Understanding Your Communication Style', 'Effective Body Language'],
               'Persuasive Speaking', 'Managing a Difficult Audience', 'Prepare to Speak Professionally'),
    'VC': _req(['Understanding Your Leadership Style', 'Understanding Your Communication Style'],
               'Develop a Communication Plan', 'Communicate Change', 'Develop Your Vision'),
    'EC': _req(['Understanding Your Communication Style', 'Understanding Your Leadership Style'],
               'Reaching Consensus', 'Improvement Through Positive Coaching', 'High Performance Leadership'),
    'IP': _req(['Connect with Your Audience', 'Understanding Your Leadership Style'],
               'Present a Proposal', 'Manage Projects Successfully', 'High Performance Leadership'),
    'SR': _req(['Active Listening', 'Understanding Your Leadership Style'],
               'Make Connections Through Networking', 'Public Relations Strategies',
               'Leading in Your Volunteer Organization'),
    'TC': _req(['Active Listening', 'Understanding Your Leadership Style'],
               'Successful Collaboration', 'Motivate Others', 'Lead in Any Situation'),
    'LD': _req(['Managing Time', 'Understanding Your Leadership Style'],
               'Planning and Implementing', 'Leading Your Team', 'Manage Successful Events'),
}

ELECTIVES = {
    3: ['Active Listening', 'Connect with Storytelling', 'Connect with Your Audience',
        'Creating Effective Visual Aids', 'Deliver Social Speeches', 'Effective Body Language',
        'Focus on the Positive', 'Inspire Your Audience', 'Know Your Sense of Humor',
        'Make Connections Through Networking', 'Prepare for an Interview', 'Researching and Presenting',
        'Understanding Vocal Variety', 'Using Descriptive Language', 'Using Presentation Software'],
    4: ['Building a Social Media Presence', 'Create a Podcast', 'Manage Online Meetings',
        'Manage Projects Successfully', 'Managing a Difficult Audience', 'Public Relations Strategies',
        'Question-and-Answer Session', 'Write a Compelling Blog'],
    5: ['Ethical Leadership', 'High Performance Leadership', 'Leading in Your Volunteer Organization',
        'Lessons Learned', 'Moderate a Panel Discussion', 'Prepare to Speak Professionally'],
}


def upgrade() -> None:
    # The Pathways catalog behind the agenda editor's / role matrix's dropdowns.
    # Global, not per club — Toastmasters publishes one catalog for everyone —
    # so only a system admin edits it.
    #
    # Agendas reference a project by its English name (speeches[].pathwayProject),
    # not by id: that field predates the catalog and also holds free-text notes.
    # PUT /api/pathways rewrites those references when a project is renamed.
    op.execute("""
        CREATE TABLE IF NOT EXISTS pathway_projects (
            id         SERIAL PRIMARY KEY,
            name_en    VARCHAR(200) NOT NULL UNIQUE,
            name_zh    VARCHAR(200) NOT NULL DEFAULT '',
            sort_order INTEGER      NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ  DEFAULT NOW(),
            updated_at TIMESTAMPTZ  DEFAULT NOW()
        )
    """)
    op.execute("""
        CREATE TABLE IF NOT EXISTS pathways (
            code       VARCHAR(8)   PRIMARY KEY,
            name_en    VARCHAR(200) NOT NULL,
            name_zh    VARCHAR(200) NOT NULL DEFAULT '',
            legacy     BOOLEAN      NOT NULL DEFAULT FALSE,
            sort_order INTEGER      NOT NULL DEFAULT 0,
            updated_at TIMESTAMPTZ  DEFAULT NOW()
        )
    """)
    # A path's required projects, level by level (Level 1, Mentoring and
    # Reflect on Your Path included — nothing is implied by code).
    op.execute("""
        CREATE TABLE IF NOT EXISTS pathway_required (
            pathway_code VARCHAR(8) NOT NULL REFERENCES pathways(code) ON DELETE CASCADE,
            level        SMALLINT   NOT NULL CHECK (level BETWEEN 1 AND 5),
            project_id   INTEGER    NOT NULL REFERENCES pathway_projects(id) ON DELETE CASCADE,
            sort_order   INTEGER    NOT NULL DEFAULT 0,
            PRIMARY KEY (pathway_code, level, project_id)
        )
    """)
    # Elective pools are shared by every path; a path never offers its own
    # required projects as electives (applied when the list is built).
    op.execute("""
        CREATE TABLE IF NOT EXISTS pathway_electives (
            level      SMALLINT NOT NULL CHECK (level BETWEEN 1 AND 5),
            project_id INTEGER  NOT NULL REFERENCES pathway_projects(id) ON DELETE CASCADE,
            sort_order INTEGER  NOT NULL DEFAULT 0,
            PRIMARY KEY (level, project_id)
        )
    """)

    conn = op.get_bind()
    ids = {}
    for i, (en, zh) in enumerate(PROJECTS):
        ids[en] = conn.execute(
            sa.text("INSERT INTO pathway_projects (name_en, name_zh, sort_order)"
                    " VALUES (:en, :zh, :o)"
                    " ON CONFLICT (name_en) DO UPDATE SET name_zh = EXCLUDED.name_zh"
                    " RETURNING id"),
            {"en": en, "zh": zh, "o": i},
        ).scalar()
    for i, (code, en, zh, legacy) in enumerate(PATHS):
        conn.execute(
            sa.text("INSERT INTO pathways (code, name_en, name_zh, legacy, sort_order)"
                    " VALUES (:c, :en, :zh, :l, :o) ON CONFLICT (code) DO NOTHING"),
            {"c": code, "en": en, "zh": zh, "l": legacy, "o": i},
        )
        for level, names in REQUIRED[code].items():
            for j, name in enumerate(names):
                conn.execute(
                    sa.text("INSERT INTO pathway_required (pathway_code, level, project_id, sort_order)"
                            " VALUES (:c, :l, :p, :o) ON CONFLICT DO NOTHING"),
                    {"c": code, "l": level, "p": ids[name], "o": j},
                )
    for level, names in ELECTIVES.items():
        for j, name in enumerate(names):
            conn.execute(
                sa.text("INSERT INTO pathway_electives (level, project_id, sort_order)"
                        " VALUES (:l, :p, :o) ON CONFLICT DO NOTHING"),
                {"l": level, "p": ids[name], "o": j},
            )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS pathway_electives")
    op.execute("DROP TABLE IF EXISTS pathway_required")
    op.execute("DROP TABLE IF EXISTS pathways")
    op.execute("DROP TABLE IF EXISTS pathway_projects")

"""pathway_project_objectives_en

Revision ID: 0027
Revises: 0026
Create Date: 2026-11-06 00:00:00.000000

- pathway_projects.objectives_en: the English speech objectives. The Word
  mark {{演講目標}} prints objectives (中文) for a 國語 speech and
  objectives_en for an English one, falling back to the other when blank.
  Seeded from each project's official English evaluation resource (the
  「Purpose Statement」), toastmasters.org, read 2026-11-06. Evaluation and
  Feedback's second-speech line uses the 2021 form's wording: the 11/2024
  form repeats the evaluator-speech purpose there.
- duration may now be a bulleted list for projects with several parts or
  options; the agenda shows it as a hint under 時長 and does not fill it in.
  The nine projects 0026 left blank get their list from the 講評表.

Only empty values are filled, so system admins' entries are kept.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = '0027'
down_revision: Union[str, None] = '0026'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# (name_en, objectives_en)
OBJECTIVES_EN = [
    ('Evaluation and Feedback',
     'The purpose of this project is to practice applying feedback and serve as a speech evaluator during a club meeting.\nFirst speech: The purpose of this speech is for the member to present a speech and receive feedback from the evaluator.\nSecond speech: The purpose of this speech is for the member to demonstrate that he or she has applied the feedback received from his or her first speech.\nEvaluator speech: The purpose of this speech is for the member to deliver constructive feedback on another member’s presentation.'),
    ('Ice Breaker',
     'The purpose of this project is for the member to introduce themselves to the club and learn the basic structure of a public speech.'),
    ('Researching and Presenting',
     'The purpose of this project is for the member to learn or review basic research methods and present a well-organized, well-researched speech on any topic.'),
    ('Writing a Speech with Purpose',
     'The purpose of this project is to learn or review basic methods for writing a speech with a defined purpose and to present a well-organized speech on any topic.'),
    ('Introduction to Vocal Variety and Body Language',
     'The purpose of this project is for the member to practice using vocal variety or body language to enhance a speech.'),
    ('Active Listening',
     'The purpose of this project is for the member to demonstrate his or her ability to listen to what others say.'),
    ('Connect with Your Audience',
     'The purpose of this project is for the member to practice the skills needed to connect with an unfamiliar audience.'),
    ('Effective Body Language',
     'The purpose of this project is for the member to deliver a speech with awareness of intentional and unintentional body language, as well as to learn, practice, and refine how he or she uses nonverbal communication when delivering a speech.'),
    ('Introduction to Toastmasters Mentoring',
     'The purpose of this project is for the member to clearly define how Toastmasters envisions mentoring.\nThe purpose of this speech is for the member to share some aspect of a previous experience as a protégé.'),
    ('Managing Time',
     'The purpose of this project is for the member to observe his or her time management patterns.'),
    ('Understanding Your Communication Style',
     'The purpose of this project is for the member to learn about different communication styles and identify his or her primary style.\nThe purpose of this speech is for the member to share the impact of his or her style on others.'),
    ('Understanding Your Leadership Style',
     'The purpose of this project is for the member to identify his or her primary leadership style or styles.\nThe purpose of this speech is for the member to share some aspect of his or her primary leadership style or discuss leadership styles in general.'),
    ('Know Your Sense of Humor',
     'The purpose of this project is to begin developing a collection of humorous stories and to present a speech that includes humor.'),
    ('Connect with Storytelling',
     'The purpose of this project is for the member to practice using a story within a speech or giving a speech that is a story.'),
    ('Creating Effective Visual Aids',
     'The purpose of this project is for the member to practice selecting and using a variety of visual aids during a speech.'),
    ('Deliver Social Speeches',
     'The purpose of this project is for the member to practice delivering social speeches in front of club members.'),
    ('Develop a Communication Plan',
     'The purpose of this project is for the member to practice developing a communication plan.'),
    ('Focus on the Positive',
     'The purpose of this project is for the member to practice being aware of his or her thoughts and feelings, as well as the impact of his or her responses on others.\nThe purpose of this speech is for the member to share his or her experience completing the project.'),
    ('Inspire Your Audience',
     'The purpose of this project is for the member to practice writing and delivering a speech that inspires others.\nThe purpose of the speech is for the member to inspire the audience.'),
    ('Make Connections Through Networking',
     'The purpose of this project is for the member to develop and practice a personal strategy for building connections through networking.\nThe purpose of this speech is for the member to share some aspect of his or her experience networking.'),
    ('Negotiate the Best Outcome',
     'The purpose of this project is for the member to learn about different types of negotiation and the strategies that can be used when negotiating.\nThe purpose of this speech is for the member to share some aspect of a past or future negotiation in his or her life.'),
    ('Persuasive Speaking',
     'The purpose of this project is for the member to understand the types of persuasive speeches and deliver a persuasive speech at a club meeting.'),
    ('Planning and Implementing',
     'The purpose of this project is for the member to practice developing a plan and bringing that plan to fruition.\nThe purpose of this speech is for the member to share some aspect of planning and implementing his or her small-scale project.'),
    ('Prepare for an Interview',
     'The purpose of this project is for the member to practice the skills needed to present himself or herself well in an interview.'),
    ('Present a Proposal',
     'The purpose of this project is for the member to practice developing and presenting a proposal.'),
    ('Reaching Consensus',
     'The purpose of this project is for the member to work with a group to practice reaching consensus on any topic.\nTask option 2: The purpose of this speech is for the member to discuss his or her experience leading a non-Toastmasters group toward consensus.'),
    ('Successful Collaboration',
     'The purpose of this project is for the member to be introduced to or review strategies for working in a collaborative group.\nThe purpose of this speech is for the member to share some aspect of his or her experience practicing collaboration with a small team.'),
    ('Understanding Conflict Resolution',
     'The purpose of this project is for the member to develop or enhance his or her understanding of the steps and strategies to address conflict.\nThe purpose of this speech is for the member to share some aspect of his or her experience learning about and/or resolving conflict.'),
    ('Understanding Emotional Intelligence',
     'The purpose of this project is for the member to cultivate an understanding of how his or her emotions impact relationships. It is also designed to help the member identify how others’ emotions impact his or her emotional state.\nThe purpose of this speech is for the member to share some aspect of his or her experience journaling emotions or being aware of emotions when interacting with others.'),
    ('Understanding Vocal Variety',
     'The purpose of this project is for the member to practice using vocal variety to enhance a speech.'),
    ('Using Descriptive Language',
     'The purpose of this project is for the member to practice writing a speech with an emphasis on adding language to increase interest and impact.'),
    ('Using Presentation Software',
     'The purpose of this project is for the member to introduce or review basic presentation software strategies for creating and using slides to support or enhance a speech.\nThe purpose of this speech is for the member to demonstrate his or her understanding of how to use presentation software, including the creation of slides and incorporating the technology into a speech.'),
    ('Engage Your Audience with Humor',
     'The purpose of this project is for the member to determine their style of humor and apply it to a speech that centers around a central message.'),
    ('Building a Social Media Presence',
     'The purpose of this project is for the member to apply his or her understanding of social media to enhance an established or new social media presence.\nThe purpose of this speech is for the member to share some aspect of his or her experience establishing or enhancing a social media presence.'),
    ('Communicate Change',
     'The purpose of this project is for the member to practice the skills needed to effectively communicate change to a group or organization.\nThe purpose of this speech is for the member to practice speaking about change.'),
    ('Create a Podcast',
     'The purpose of this project is for the member to be introduced to the skills needed to organize and present a podcast.\nThe purpose of this speech is for the member to introduce his or her podcast and to present a segment of the podcast.'),
    ('Improvement Through Positive Coaching',
     'The purpose of this project is for the member to develop and apply skills for coaching a fellow member or a person outside of Toastmasters who can benefit from his or her expertise.\nThe purpose of this speech is for the member to share some aspect of his or her experience coaching.'),
    ('Leading in Difficult Situations',
     'The purpose of this project is for the member to practice strategies for adjusting to unexpected changes to a finalized plan.'),
    ('Leading Your Team',
     'The purpose of this project is for the member to lead a small team to the completion of a project.\nThe purpose of this speech is for the member to share some aspect of his or her experience leading a team.'),
    ('Manage Change',
     'The purpose of this project is for the member to practice developing a change management plan.\nThe purpose of this speech is for the member to share some aspect of a change management plan.'),
    ('Manage Online Meetings',
     'The purpose of this project is for the member to practice facilitating an online meeting or leading a webinar.'),
    ('Manage Projects Successfully',
     'The purpose of this project is for the member to practice developing a plan, building a team, and fulfilling the plan with the help of his or her team.\nThe purpose of the first speech is for the member to give a short overview of the plan for his or her project.\nThe purpose of the second speech is for the member to share some aspect of his or her experience managing a project.'),
    ('Managing a Difficult Audience',
     'The purpose of this project is for the member to practice the skills needed to address audience challenges when he or she presents outside of the Toastmasters club.'),
    ('Motivate Others',
     'The purpose of this project is for the member to practice the skills needed to motivate team members through the completion of a project.\nThe purpose of this speech is for the member to share some aspect of his or her experience motivating team members through the completion of a project.'),
    ('Public Relations Strategies',
     'The purpose of this project is for the member to practice the skills needed to effectively use public relations strategies for any group or situation.\nThe purpose of this speech is for the member to share some aspect of his or her public relations strategy.'),
    ('Question-and-Answer Session',
     'The purpose of this project is for the member to learn about and practice facilitating a question-and-answer session.\nThe purpose of this speech is for the member to practice delivering an informative speech and running a well-organized question-and-answer session. The member is responsible for managing time so there is adequate opportunity for both.'),
    ('Write a Compelling Blog',
     'The purpose of this project is for the member to review or introduce the skills needed to write and maintain a blog.\nThe purpose of this speech is for the member to share some aspect of his or her experience maintaining a blog.'),
    ('The Power of Humor in an Impromptu Speech',
     'The purpose of this project is for the member to develop their method for giving impromptu speeches and practice adapting rehearsed stories during a presentation.'),
    ('Develop Your Vision',
     'The purpose of this project is for the member to develop a detailed vision for his or her personal life, professional life, or an organization.\nThe purpose of this first speech is for the member to share some aspect of his or her vision.\nThe purpose of this second speech is for the member to share some aspect of the plan to implement his or her vision.'),
    ('Ethical Leadership',
     'The purpose of this project is for the member to develop a clear understanding of his or her ethical framework and create an opportunity for others to hear about and discuss ethics in the member’s organization or community.'),
    ('High Performance Leadership',
     'The purpose of this project is for the member to apply his or her leadership and planning knowledge to develop a project plan, organize a guidance committee, and implement the plan with the help of a team.\nThe purpose of the first speech is for the member to introduce his or her plan and vision.\nThe purpose of the second speech is for the member to share some aspect of his or her experience completing the project.'),
    ('Lead in Any Situation',
     'The purpose of this project is for the member to apply the skills needed to successfully lead in a volunteer or other organization.\nThe purpose of this speech is for the member to share some aspect of his or her experience as a leader and/or the impact of the 360° evaluation.'),
    ('Leading in Your Volunteer Organization',
     'The purpose of this project is for the member to apply the skills needed to successfully lead in a volunteer organization.\nThe purpose of this speech is for the member to share some aspect of his or her experience serving as a leader in a volunteer organization.'),
    ('Lessons Learned',
     'The purpose of this project is for the member to learn about and apply the skills needed to run a lessons learned meeting during a project or after its completion.\nThe purpose of this speech is for the member to share some aspect of his or her leadership experience and the impact of a lessons learned meeting.'),
    ('Manage Successful Events',
     'The purpose of this project is for the member to practice planning, organizing, leading, and implementing an event.\nThe purpose of this speech is for the member to share his or her experience planning, organizing, leading, and implementing an event.'),
    ('Moderate a Panel Discussion',
     'The purpose of this project is for the member to apply their skills as a public speaker and leader to facilitate a panel discussion.'),
    ('Prepare to Speak Professionally',
     'The purpose of this project is for the member to practice developing and presenting a longer speech.'),
    ('Reflect on Your Path',
     'The purpose of this project is for the member to reflect on his or her growth during the completion of an entire path.\nThe purpose of the speech is for the member to share some aspect of his or her growth during the completion of a path.'),
    ('Team Building',
     'The purpose of this project is for the member to practice the skills needed to build a cohesive team and host an event.\nThe purpose of this first speech is for the member to introduce the team-building event he or she plans to host.\nThe purpose of this second speech is for the member to share some aspect of his or her experience building a team and leading a team-building event.'),
    ('Deliver Your Message with Humor',
     'The purpose of this project is for the member to practice developing and presenting a longer humorous speech.'),
]

# (name_en, duration list)
DURATION_LISTS = [
    ('Evaluation and Feedback', "• 第一、二篇演講 5'-7'\n• 講評者演講 2'-3'"),
    ('Active Listening', '• 沒有演講：擔任即席演講主持人（時間依議程安排）'),
    ('Focus on the Positive', "• 選項一：2'-3'\n• 選項二：5'-7'"),
    ('Planning and Implementing', "• 選項一：2'-3'\n• 選項二：5'-7'"),
    ('Reaching Consensus', "• 任務選項 1：20' 帶領練習＋2'-3' 結語\n• 任務選項 2：5'-7' 演講"),
    ('Create a Podcast', "• 介紹 2'-3'\n• Podcast 片段 5'-10'"),
    ('Leading in Difficult Situations', "• 備稿演講 5'-7'\n• 即席回應 5'-10'"),
    ('Manage Projects Successfully', "• 第一篇（專案概要）2'-3'\n• 第二篇（專案經驗）5'-7'"),
    ('Team Building', "• 第一篇（活動介紹）2'-3'\n• 第二篇（經驗分享）5'-7'"),
]


def upgrade() -> None:
    op.execute("ALTER TABLE pathway_projects ADD COLUMN objectives_en TEXT NOT NULL DEFAULT ''")
    bind = op.get_bind()
    for name, text in OBJECTIVES_EN:
        bind.execute(sa.text("UPDATE pathway_projects SET objectives_en = :t WHERE name_en = :n"),
                     {"t": text, "n": name})
    for name, text in DURATION_LISTS:
        bind.execute(sa.text("UPDATE pathway_projects SET duration = :t WHERE name_en = :n AND duration = ''"),
                     {"t": text, "n": name})


def downgrade() -> None:
    bind = op.get_bind()
    for name, text in DURATION_LISTS:
        bind.execute(sa.text("UPDATE pathway_projects SET duration = '' WHERE name_en = :n AND duration = :t"),
                     {"t": text, "n": name})
    op.execute("ALTER TABLE pathway_projects DROP COLUMN objectives_en")

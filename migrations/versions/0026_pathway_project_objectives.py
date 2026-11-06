"""pathway_project_objectives

Revision ID: 0026
Revises: 0025
Create Date: 2026-11-06 00:00:00.000000

Fills each Pathways project's speech objectives (printed by {{演講目標}})
and suggested length from the Traditional Chinese Toastmasters evaluation
forms (講評表): objectives = the form's 「目的敘述」 (one line per bullet; for
two-speech projects the unit purpose plus each speech's purpose), duration =
its 「演講長度」. Forms read 2026-11-06 via 劉雨軒的 Pathways 動力中心
(https://ckc300.github.io/pdf/). Exceptions:
- Writing a Speech with Purpose: its current form has no 目的敘述, so the
  text is that site's 「單元目的」 summary, not the form.
- Duration left blank (agenda falls back to 5'-7') where the form gives more
  than one part or option: Evaluation and Feedback, Active Listening, Focus on
  the Positive, Planning and Implementing, Reaching Consensus, Create a
  Podcast, Leading in Difficult Situations, Manage Projects Successfully,
  Team Building.

Only empty values are filled, so anything a system admin already entered on
「Pathways 路徑管理」 is kept.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = '0026'
down_revision: Union[str, None] = '0025'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# (form code, name_en, duration, objectives)
SEED = [
    ('8100', 'Evaluation and Feedback', '',
     '本單元的目的是讓會員針對任何主題發表演講，同時聽取回饋，然後再於第二篇演講落實回饋\n第一篇演講：此演講的目的在於讓會員發表演講，然後聽取講評者回饋。\n第二篇演講：本演講的目的在於讓會員展現他或她自第一場演講所得到回饋的落實程度。\n講評者演講：此演講的目的在於讓會員針對另一名會員的演講發表有建設性的回饋。'),
    ('8101', 'Ice Breaker', "4'-6'",
     '本單元目的是向分會會員介紹自己，並從中學習公開演講的基本構架。'),
    ('8102', 'Researching and Presenting', "5'-7'",
     '本單元目的是讓會員學習或回顧基本研究方法，同時發表針對任何主題組織嚴謹、研究充分的演講。'),
    ('8103', 'Writing a Speech with Purpose', "5'-7'",
     '學習或複習撰寫演講的基本方法，並針對自選主題發表一篇組織良好的演講。'),
    ('8104', 'Introduction to Vocal Variety and Body Language', "5'-7'",
     '本單元的目標是讓會員練習運用聲音變化或肢體語言來強化演講的表現。'),
    ('8200', 'Active Listening', '',
     '本單元的目的是讓會員展現聆聽他人談話內容的能力。'),
    ('8201', 'Connect with Your Audience', "5'-7'",
     '本單元目的是要讓會員練習引起陌生觀眾共鳴的必要技巧。'),
    ('8203', 'Effective Body Language', "5'-7'",
     '本單元的目的是在發表演講過程中，留意您刻意或非刻意的肢體語言，並學習、演練及精練演講時如何運用非語言的溝通。'),
    ('8204', 'Introduction to Toastmasters Mentoring', "5'-7'",
     '本單元的目的是清楚界定 Toastmasters 對指導計畫的願景。\n本演講目的是讓會員分享過去學員經驗的某些層面。'),
    ('8205', 'Managing Time', "5'-7'",
     '本單元目的是要讓會員觀察他或她的時間管理模式。'),
    ('8206', 'Understanding Your Communication Style', "5'-7'",
     '本單元的目的是學習不同的溝通風格，並找出會員的主要風格。\n本演講的目的是讓會員分享他或她的風格對他人的影響。'),
    ('8207', 'Understanding Your Leadership Style', "5'-7'",
     '本單元的目的是讓會員找出他或她的主要領導風格。\n本演講的目的是讓會員分享他或他的主要領導風格，或探討各種不同領導風格。'),
    ('8208', 'Know Your Sense of Humor', "5'-7'",
     '本單元的目的為學習構思幽默故事集，並在演講時展現幽默。'),
    ('8300', 'Connect with Storytelling', "5'-7'",
     '本單元目的是要讓會員練習在演講中運用巧說故事技巧，或演講內容本身就是一則故事。'),
    ('8301', 'Creating Effective Visual Aids', "5'-7'",
     '本單元目的是要讓會員練習選擇並在演講中運用各種視覺輔具。'),
    ('8302', 'Deliver Social Speeches', "3'-4'",
     '本單元的目的是讓會員練習在分會會員面前發表社交演講。'),
    ('8303', 'Develop a Communication Plan', "5'-7'",
     '本單元的目的是要讓會員練習制定溝通計劃。'),
    ('8304', 'Focus on the Positive', '',
     '本單元目的是要讓會員練習瞭解他或她的想法與感受以及他或她對他人反應所造成的影響。\n本演講的目的是要讓會員在完成單元後，分享他或她的經驗。'),
    ('8305', 'Inspire Your Audience', "5'-7'",
     '本單元目的是要讓會員練習撰寫並發表激勵啟發他人的演講。\n本演講的目的是讓會員激勵啟發觀眾。'),
    ('8306', 'Make Connections Through Networking', "5'-7'",
     '本單元的目的是讓會員培養並練習個人化策略，藉此運用人際網絡建立關係。\n本演講目的是讓會員分享有關他或她的人際網絡經驗。'),
    ('8307', 'Negotiate the Best Outcome', "5'-7'",
     '本單元目的是讓會員學習在協調時能夠使用的不同類型談判方式及溝通策略。\n本演講的目的是讓會員分享他或她曾經歷過，或未來面對協調時的部分層面。'),
    ('8308', 'Persuasive Speaking', "5'-7'",
     '本單元的目的是要讓會員了解說服型演講的不同類型，並在例會發表一篇說服演講。'),
    ('8309', 'Planning and Implementing', '',
     '本單元目的為讓會員練習制定計畫並實現計畫目標。\n本演講的目的是讓會員分享他或她在計畫與執行小規模專案時，經歷的某些層面。'),
    ('8310', 'Prepare for an Interview', "5'-7'",
     '本單元的目的是讓會員練習在面試或面談過程中如何恰如其分地呈現自己的所需技巧。'),
    ('8312', 'Present a Proposal', "5'-7'",
     '本單元目的為讓會員練習制定並發表企劃案。'),
    ('8313', 'Reaching Consensus', '',
     '本單元目的是讓會員與團體合作，練習如何針對任何議題達成共識。\n任務選項 2：本演講的目的是讓會員討論他或她帶領非 Toastmasters 團體達成共識的經驗。'),
    ('8314', 'Successful Collaboration', "5'-7'",
     '本單元的目的是向會員介紹或幫助會員檢視在合作團隊中工作的策略。\n本演講目的是讓會員分享他或她練習與小規模團隊合作的部分層面經驗。'),
    ('8315', 'Understanding Conflict Resolution', "5'-7'",
     '本單元目的是要培養或強化會員對解決衝突步驟與策略的理解。\n本演講目的是讓會員分享他或她學習及／或化解衝突經驗的部分層面。'),
    ('8316', 'Understanding Emotional Intelligence', "5'-7'",
     '本單元的目的是要讓會員了解他或她的情緒如何影響人際關係。同時將幫助會員辨別自身情緒如何受他人情緒影響。\n此演講的目的是讓會員分享他或她透過日誌記錄情緒的經驗，或與他人互動時覺察的情緒。'),
    ('8317', 'Understanding Vocal Variety', "5'-7'",
     '本單元目的是讓會員練習運用抑揚頓挫來強化演講效果。'),
    ('8318', 'Using Descriptive Language', "5'-7'",
     '本單元目的主要是讓會員練習運用語彙撰寫演講，並強化演講帶給觀眾的興趣與影響力。'),
    ('8319', 'Using Presentation Software', "5'-7'",
     '本單元目的是要向會員介紹或回顧製作與使用投影片來輔助或強化演講的基本簡報軟體使用策略。\n本演講的目的，是讓會員展現他或她對如何使用簡報軟體的理解，當中包括製作投影片與在演講中運用科技等技能。'),
    ('8320', 'Engage Your Audience with Humor', "5'-7'",
     '本單元的目的是讓會員決定自己展現幽默的風格，並且把這種風格應用在具有特定核心訊息的演講中。'),
    ('8400', 'Building a Social Media Presence', "5'-7'",
     '本單元的目的是讓會員運用對社群媒體的認識，來提高既有的或新建的社群媒體能見度。\n本演講的目的是讓會員分享他或她提高或強化社群媒體能見度的部分層面經驗。'),
    ('8401', 'Communicate Change', "5'-7'",
     '本單元的目的在於讓會員練習如何向團體或组織有效傳達改變訊息的技能。\n本演講目的是讓會員練習談論和傳達改變內容。'),
    ('8402', 'Create a Podcast', '',
     '本單元目的是向會員介紹製播與發表 Podcast 的必要技巧。\n本演講的目的是要讓會員介紹他或她的 Podcast 並發表 Podcast 的一個片段。'),
    ('8403', 'Improvement Through Positive Coaching', "5'-7'",
     '本單元目的是協助會員培養並運用教練技能，會員可教練 1 名分會會員或非 Toastmasters 人士，幫助他或她得到進步。\n本演講目的是讓會員分享有關他或她的教練經驗。'),
    ('8404', 'Leading in Difficult Situations', '',
     '本單元目的是讓會員練習對已定案的計畫進行不預期改變的調整策略。'),
    ('8405', 'Leading Your Team', "5'-7'",
     '本單元目的是讓會員領導小型團隊來完成一項專案。\n本演講的目的是讓會員分享他或她領導團隊經驗的部分層面。'),
    ('8406', 'Manage Change', "5'-7'",
     '本單元目的是要讓會員練習制定掌理改變的計畫。\n本演講的目的是讓會員分享掌理改變計畫的部分層面。'),
    ('8407', 'Manage Online Meetings', "20'-25'",
     '本單元目的是讓會員練習主持線上會議或領導線上研討會。'),
    ('8408', 'Manage Projects Successfully', '',
     '本單元目的是讓會員練習制定計畫、建立團隊，並在團隊協助下完成專案。\n第一篇演講的目的是讓會員針對他或她的專案發表一篇簡短的概要介紹。\n第二篇演講的目的是讓會員分享他或她管理專案經驗的部分層面。'),
    ('8409', 'Managing a Difficult Audience', "12'-15'",
     '本單元目的是讓會員練習在 Toastmasters 分會以外的場合發表演講時，應對觀眾挑戰所需的技能。'),
    ('8411', 'Motivate Others', "5'-7'",
     '本單元的目的是要讓會員練習在完成專案的過程中，激勵團隊成員的所需技能。\n本演講目的是讓會員分享有關他或她透過完成專案激勵團隊成員經驗的部份層面。'),
    ('8412', 'Public Relations Strategies', "5'-7'",
     '本單元目的是要讓會員練習為任何組織或在任何情況下，有效運用公關策略的技巧。\n本演講目的是讓會員分享有關他或她制定或運用公關策略的部分層面。'),
    ('8413', 'Question-and-Answer Session', "15'-20'",
     '本單元目的是要讓會員學習並練習如何順利進行問答時間。\n本演講的目的是讓會員練習發表資訊型演講，並在演講後主持一場組織有序的問答時間。會員必須負責管理時間，確保演講和問答時間都有充足的時間進行。'),
    ('8414', 'Write a Compelling Blog', "2'-3'",
     '本單元目的是讓會員回顧或介紹經營部落格與撰寫文章所需的技巧。\n本演講的目的是讓會員分享有關他或她經營部落格經驗的部分層面。'),
    ('8415', 'The Power of Humor in an Impromptu Speech', "2'-3'",
     '本單元旨在引導會員制定一套發表即席演講的方法，同時練習在演講過程中適時修改預先準備的故事。'),
    ('8501', 'Develop Your Vision', "5'-7'",
     '本單元目的是讓會員為自身的個人生涯、職場生活或組織團隊規劃一個細緻描繪的願景。\n第一篇演講的目的是讓會員分享他或她心中願景的部分層面。\n第二篇演講的目的是讓會員分享他或她為了實現願景所制定計畫的部分層面。'),
    ('8502', 'Ethical Leadership', "20'-40'",
     '本單元目的是要讓會員對自身的道德框架建立明確的暸解，並提供機會讓他人瞭解並討論會員的組織或社群中的道德標準。'),
    ('8503', 'High Performance Leadership', "5'-7'",
     '本單元目的是讓會員運用領導力和計畫知識來制定專案計畫、組成指導委員會，並在團隊協助下執行計畫。\n第一篇演講的目的是讓會員介紹他或她的計畫和願景。\n第二篇演講的目的是讓會員分享他或她完成專案經驗的部分層面。'),
    ('8504', 'Lead in Any Situation', "8'-10'",
     '本單元目的是讓會員應用必要技能，以成功領導志工組織或其他類型的組織。\n本演講目的是讓會員分享他或她擔任領導者經驗的部分層面，及／或接受 360° 全面評估的影響。'),
    ('8505', 'Leading in Your Volunteer Organization', "5'-7'",
     '本單元目的是讓會員應用必要技能，以成功領導志工組織。\n本演講目的是讓會員分享他或她在志工組織擔任幹部經驗的部分層面。'),
    ('8506', 'Lessons Learned', "5'-7'",
     '本單元目的是讓會員學習在進行或專案完成後，於學習心得會議期間應用的必要技能。\n本演講目的是讓會員分享他或她領導經驗的部分層面，及學習心得會議帶來的影響。'),
    ('8507', 'Manage Successful Events', "5'-7'",
     '本單元目的是讓會員練習規劃、組織、領導與舉辦活動。\n本演講目的是讓會員分享他或她規劃、組織、領導與舉辦活動的經驗。'),
    ('8508', 'Moderate a Panel Discussion', "20'-40'",
     '本單元目的是讓會員運用身為公開演講者與領導者的技能，來順利進行並主持小組專題討論。'),
    ('8509', 'Prepare to Speak Professionally', "18'-22'",
     '本單元目的是讓會員練習撰寫並發表較長的演講。'),
    ('8510', 'Reflect on Your Path', "10'-12'",
     '本單元目的是讓會員回顧完成整個學習途徑這一路上的成長。\n本演講的目的是讓會員分享在完成學習途徑的過程中，他或她所得到成長的某些層面。'),
    ('8511', 'Team Building', '',
     '本單元目的是讓會員練習營造具凝聚力團隊及舉辦活動的必要技能。\n第一篇演講的目的是讓會員介紹他或她計畫舉行且主持的團隊營造活動。\n第二篇演講的目的是讓會員分享他或她營造團隊與主持團隊營造活動經驗的部分層面。'),
    ('8512', 'Deliver Your Message with Humor', "18'-22'",
     '本單元的目的是要讓會員練習構思並發表一篇較長的幽默演講。'),
]


def upgrade() -> None:
    bind = op.get_bind()
    for _code, name, duration, objectives in SEED:
        bind.execute(sa.text("UPDATE pathway_projects SET objectives = :o "
                             "WHERE name_en = :n AND objectives = ''"), {"o": objectives, "n": name})
        if duration:
            bind.execute(sa.text("UPDATE pathway_projects SET duration = :d "
                                 "WHERE name_en = :n AND duration = ''"), {"d": duration, "n": name})


def downgrade() -> None:
    bind = op.get_bind()
    for _code, name, _duration, objectives in SEED:
        bind.execute(sa.text("UPDATE pathway_projects SET objectives = '' "
                             "WHERE name_en = :n AND objectives = :o"), {"o": objectives, "n": name})

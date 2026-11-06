"""The Google Sheet role-plan parser (the MCP import's port of lib/rolesSheet.js).

Pure functions — no database.
"""
from datetime import date

import pytest


@pytest.fixture(scope="module")
def index():
    import api.index as index
    return index


TODAY = date(2026, 11, 5)

# 生橋's layout: blank date label, no years, English role names, `--` for "nobody".
LIFE_BRIDGE = (
    ',07/11,8/22,11/14,12/12\n'
    'Meeting No.,,240,243,245\n'
    'Toastmasters of the Day,林鈞仁,Phoenix Hu,Tienmou,\n'
    'Ah Counter,胡廣琪,--,Amy Lee,\n'
    'Speaker #2,--,Johnson Liu,Richard Lo,\n'
    'Individual Evaluator #1,張珊郡,Jason Lee,,\n'
    "Evaluator's Evaluator,,,Kevin Lin,\n"
    'Meeting Theme,出國Go abroad,"長大後才發現……\nThings We Discover",,聖誕活動\n'
    '備註,颱風放假,,,\n'
)


def test_life_bridge_layout(index):
    out = index._parse_roles_sheet(LIFE_BRIDGE, {"PM"}, TODAY)
    assert list(out) == ["2026-07-11", "2026-08-22", "2026-11-14", "2026-12-12"]
    assert out["2026-07-11"] == {"tme": "林鈞仁", "ahCounter": "胡廣琪", "evaluator1": "張珊郡",
                                 "meetingTheme": "出國Go abroad"}
    assert out["2026-08-22"] == {"meetingNo": "240", "tme": "Phoenix Hu", "speech2": "Johnson Liu",
                                 "evaluator1": "Jason Lee",
                                 "meetingTheme": "長大後才發現……\nThings We Discover"}
    assert out["2026-11-14"]["evalEvaluator1"] == "Kevin Lin"
    assert out["2026-12-12"] == {"meetingNo": "245", "meetingTheme": "聖誕活動"}


def test_yearless_dates_roll_into_next_year(index):
    assert index._sheet_row_dates(["11/28", "12/12", "01/09", "06/26"], TODAY) == \
        ["2026-11-28", "2026-12-12", "2027-01-09", "2027-06-26"]
    # A season planned ahead: the first date takes the year nearest today.
    assert index._sheet_row_dates(["07/10", "01/08"], date(2027, 6, 1)) == ["2027-07-10", "2028-01-08"]


def test_chill_hi_high_layout_unchanged(index):
    csv = '會議時間,2026/07/03,2026/07/17\n總主持人,Leah Kao 高莉雅,NA\n會議主題,夏天,\n'
    assert index._parse_roles_sheet(csv, set(), TODAY) == {
        "2026-07-03": {"tme": "Leah Kao 高莉雅", "meetingTheme": "夏天"}, "2026-07-17": {}}


def test_no_date_row(index):
    with pytest.raises(index.HTTPException) as e:
        index._parse_roles_sheet("Timer,Amy,Ben\n", set(), TODAY)
    assert "日期列" in e.value.detail


CUSTOMS = [{"id": "rws", "zh": "工作坊", "en": "Workshop"},
           {"id": "resp", "zh": "ESP 個別講評", "en": "Individual Evaluator-ESP"}]


def test_custom_roles_match_by_zh_or_en(index):
    csv = (',11/28\n'
           'workshop,Amy Lee\n'                       # en, case-insensitive
           'Individual Evaluator - ESP,Ben Wu\n'      # `-` and spacing don't matter
           '工作坊,\n'
           'Timer,Cathy\n'
           '備註,颱風\n')
    unknown = []
    out = index._parse_roles_sheet(csv, set(), TODAY, customs=CUSTOMS, unknown=unknown)
    assert out == {"2026-11-28": {"custom_rws": "Amy Lee", "custom_resp": "Ben Wu", "timer": "Cathy"}}
    assert unknown == ["備註"]


def test_custom_roles_never_shadow_builtin(index):
    customs = [{"id": "rt", "zh": "計時員", "en": "Timer"}]
    out = index._parse_roles_sheet(',11/28\nTimer,Cathy\n計時員,Dan\n', set(), TODAY, customs=customs)
    assert out["2026-11-28"] == {"timer": "Dan"}


def test_without_customs_rows_are_unknown(index):
    unknown = []
    out = index._parse_roles_sheet(',11/28\nWorkshop,Amy\nESP,\n', set(), TODAY, unknown=unknown)
    assert out == {"2026-11-28": {}}
    assert unknown == ["Workshop"]          # an empty row isn't worth reporting


def test_custom_role_list_drops_blank_names(index):
    settings = {"custom_roles": [{"id": "a", "zh": " 工作坊 ", "en": "Workshop"},
                                 {"id": "b", "zh": "  ", "en": "X"}, "junk"]}
    assert index._club_custom_role_list(settings) == [{"id": "a", "zh": "工作坊", "en": "Workshop"}]


def test_questions_and_footer_rows(index):
    csv = (',11/28\n'
           'Theme Question,"Why travel?\n為什麼旅行？"\n'
           '即席題目,最難忘的旅程\n'
           'Announcements,下次改在 3 樓\n'
           'The BEST ON,Best Speaker: Amy\n'
           '來賓,Ben、Cathy\n')
    assert index._parse_roles_sheet(csv, set(), TODAY)["2026-11-28"] == {
        "themeQuestion": "Why travel?\n為什麼旅行？", "tableTopicsQuestion": "最難忘的旅程",
        "announcement": "下次改在 3 樓", "lastBest": "Best Speaker: Amy", "guests": "Ben、Cathy"}


def test_footer_fields_are_agenda_text_fields(index):
    for k in ("themeQuestion", "tableTopicsQuestion", "announcement", "lastBest", "guests"):
        assert k in index._AGENDA_TEXT_FIELDS
    assert "{{公告}}" in index._AGENDA_TEXT_FIELDS["announcement"]


def test_suggested_duration_rule(index):
    sd = index._suggested_duration
    assert sd("", "", "4'-6'") == "4'-6'"              # blank → suggestion
    assert sd("5'-7'", "", "4'-6'") == "4'-6'"         # the default counts as blank
    assert sd("6'-8'", "", "4'-6'") is None            # a length someone typed stays
    assert sd("4'-6'", "4'-6'", "18'-22'") == "18'-22'"  # an auto-filled one follows the project
    assert sd("4'-6'", "4'-6'", "") == "5'-7'"         # …back to the default when there's none
    assert sd("5'-7'", "", "") is None


def test_clean_text_block_keeps_lines(index):
    assert index._clean_text_block("  a   b \r\n\n c ") == "a b\nc"

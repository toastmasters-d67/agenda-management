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

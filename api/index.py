import json
import os
import re
import time
import uuid
import bcrypt
import jwt
import psycopg2
import psycopg2.errors
import psycopg2.extras
import psycopg2.pool
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Depends, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
from typing import Any, Dict, List, Optional

load_dotenv()

# psycopg2 不支援 channel_binding 參數，移除後再連線
_raw_url = os.getenv("DATABASE_URL", "")
DATABASE_URL = re.sub(r"[&?]channel_binding=[^&]*", "", _raw_url)
JWT_SECRET = os.getenv("JWT_SECRET", "please-change-this-secret")
INVITE_CODE = os.getenv("INVITE_CODE", "")
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_HOURS = 24

R2_ACCOUNT_ID        = os.getenv("R2_ACCOUNT_ID", "")
R2_ACCESS_KEY_ID     = os.getenv("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = os.getenv("R2_SECRET_ACCESS_KEY", "")
R2_BUCKET_NAME       = os.getenv("R2_BUCKET_NAME", "")
R2_PUBLIC_URL        = os.getenv("R2_PUBLIC_URL", "").rstrip("/")


def _r2():
    import boto3
    if not all([R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME]):
        raise HTTPException(status_code=503, detail="R2 未設定，請聯絡管理員")
    return boto3.client(
        "s3",
        endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name="auto",
    )

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


_pool: Optional[psycopg2.pool.SimpleConnectionPool] = None


def _get_pool() -> psycopg2.pool.SimpleConnectionPool:
    global _pool
    if _pool is None or _pool.closed:
        _pool = psycopg2.pool.SimpleConnectionPool(1, 5, DATABASE_URL)
    return _pool


@contextmanager
def get_db():
    conn = _get_pool().getconn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        _get_pool().putconn(conn)


security = HTTPBearer()


# ------------------------------------------------------------------ models
class LoginRequest(BaseModel):
    username: str
    password: str


class RegisterRequest(BaseModel):
    username: str
    password: str
    name_en: str
    name_zh: str
    club_id: Optional[int] = None


class AgendaSaveRequest(BaseModel):
    data: Dict[str, Any]
    club_id: Optional[int] = None


class ClubRequest(BaseModel):
    name: str
    name_zh: Optional[str] = None
    name_en: Optional[str] = None
    charter_no: Optional[str] = None
    founded_date: Optional[str] = None
    fee: Optional[str] = None
    logo_url: Optional[str] = None
    fb_qr_url: Optional[str] = None
    line_qr_url: Optional[str] = None
    template_key: Optional[str] = None
    settings: Optional[Dict[str, Any]] = None


class UserCreateRequest(BaseModel):
    username: str
    password: str
    name_en: str
    name_zh: str
    role: str = "club_member"
    club_id: Optional[int] = None
    level: str = "TM"


class UserUpdateRequest(BaseModel):
    role: Optional[str] = None
    club_id: Optional[int] = None
    level: Optional[str] = None
    name_en: Optional[str] = None
    name_zh: Optional[str] = None


class BulkMemberItem(BaseModel):
    name_zh: str
    name_en: str
    level: str = "TM"


class BulkMemberRequest(BaseModel):
    members: List[BulkMemberItem]
    club_id: Optional[int] = None
    default_password: str = "Toastmasters1"


class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str


class ResetPasswordRequest(BaseModel):
    new_password: str


class PresignRequest(BaseModel):
    filename: str
    content_type: str
    meeting_date: Optional[str] = None
    meeting_no: Optional[str] = None
    club_id: Optional[int] = None


# ------------------------------------------------------------------ helpers
def make_token(username: str) -> str:
    payload = {
        "sub": username,
        "exp": datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRE_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> str:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return payload["sub"]
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token 已過期，請重新登入")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="無效的 Token")


def parse_jsonb(val) -> dict:
    if isinstance(val, str):
        return json.loads(val)
    return val or {}


# ------------------------------------------------------------------ permission dependencies
def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    """Decode token and fetch user's role + club_id from DB."""
    username = decode_token(credentials.credentials)
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT username, role, club_id, must_change_pw, status FROM users WHERE username = %s",
                (username,),
            )
            row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="使用者不存在")
    if row[4] == "pending":
        raise HTTPException(status_code=403, detail="帳號尚待審核，請聯絡分會管理員")
    return {"username": row[0], "role": row[1], "club_id": row[2], "must_change_pw": row[3]}


def require_system_admin(user: dict = Depends(get_current_user)) -> dict:
    if user["role"] != "system_admin":
        raise HTTPException(status_code=403, detail="需要系統管理員權限")
    return user


def require_club_admin_or_above(user: dict = Depends(get_current_user)) -> dict:
    if user["role"] not in ("system_admin", "club_admin"):
        raise HTTPException(status_code=403, detail="需要分會管理員以上權限")
    return user


# ------------------------------------------------------------------ auth
@app.post("/api/auth/login")
def login(req: LoginRequest):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT password_hash, role, club_id, must_change_pw, status FROM users WHERE username = %s",
                (req.username,),
            )
            row = cur.fetchone()
    if not row or not bcrypt.checkpw(req.password.encode(), row[0].encode()):
        raise HTTPException(status_code=401, detail="帳號或密碼錯誤")
    if row[4] == "pending":
        raise HTTPException(status_code=403, detail="帳號尚待審核，請等待分會管理員批准後再登入")
    return {
        "token":          make_token(req.username),
        "username":       req.username,
        "role":           row[1],
        "club_id":        row[2],
        "must_change_pw": row[3],
    }


@app.post("/api/auth/register")
def register(req: RegisterRequest):
    if len(req.username) < 3:
        raise HTTPException(status_code=400, detail="帳號至少需要 3 個字元")
    if len(req.password) < 6:
        raise HTTPException(status_code=400, detail="密碼至少需要 6 個字元")
    if not req.name_en.strip():
        raise HTTPException(status_code=400, detail="請輸入英文姓名")
    if not req.name_zh.strip():
        raise HTTPException(status_code=400, detail="請輸入中文姓名")
    password_hash = bcrypt.hashpw(req.password.encode(), bcrypt.gensalt()).decode()
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO users (username, password_hash, name_en, name_zh, role, club_id, status)"
                    " VALUES (%s, %s, %s, %s, 'club_member', %s, 'pending')",
                    (req.username, password_hash,
                     req.name_en.strip(), req.name_zh.strip(),
                     req.club_id),
                )
    except psycopg2.errors.UniqueViolation:
        raise HTTPException(status_code=400, detail="帳號已存在")
    return {
        "ok":      True,
        "pending": True,
        "message": "帳號已提交審核，請等待分會管理員批准後再登入",
    }


@app.get("/api/auth/verify")
def verify(user: dict = Depends(get_current_user)):
    return {
        "username":       user["username"],
        "role":           user["role"],
        "club_id":        user["club_id"],
        "must_change_pw": user["must_change_pw"],
    }


@app.put("/api/auth/change-password")
def change_password(req: ChangePasswordRequest, user: dict = Depends(get_current_user)):
    """Allow any logged-in user to change their own password."""
    if len(req.new_password) < 6:
        raise HTTPException(status_code=400, detail="新密碼至少需要 6 個字元")
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT password_hash FROM users WHERE username = %s",
                (user["username"],),
            )
            row = cur.fetchone()
    if not row or not bcrypt.checkpw(req.old_password.encode(), row[0].encode()):
        raise HTTPException(status_code=400, detail="目前密碼錯誤")
    new_hash = bcrypt.hashpw(req.new_password.encode(), bcrypt.gensalt()).decode()
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE users SET password_hash=%s, must_change_pw=false WHERE username=%s",
                (new_hash, user["username"]),
            )
    return {"ok": True}


# ------------------------------------------------------------------ agenda
@app.get("/api/agendas")
def list_agendas(
    date:      str = None,
    date_from: str = None,
    date_to:   str = None,
    page:      int = 1,
    limit:     int = 10,
    club_id:   Optional[int] = Query(default=None),
    full:      int = 0,
    order:     str = None,
    user:      dict = Depends(get_current_user),
):
    """List agendas.

    `full=1`   → each item also carries its whole `data` JSONB, so a caller that
                 needs several agendas at once (e.g. the role-planning matrix)
                 does not have to issue one GET per agenda.
    `order=date` → sort by meeting_date instead of updated_at, for callers that
                 present a chronological window of meetings.
    `order=date_asc` → same, but oldest-first — for callers that need "the next
                 meeting after X" via date_from + limit=1.
    `date_from` / `date_to` → inclusive meeting_date range. Agendas with no
                 meeting_date are excluded once either bound is given, since they
                 cannot be placed on a timeline.
    """
    import math
    offset = (page - 1) * limit
    with get_db() as conn:
        with conn.cursor() as cur:
            where  = "WHERE 1=1"
            params: list = []
            if date:
                where += " AND meeting_date = %s"
                params.append(date)
            if date_from:
                where += " AND meeting_date >= %s"
                params.append(date_from)
            if date_to:
                where += " AND meeting_date <= %s"
                params.append(date_to)
            if user["role"] != "system_admin":
                # Non-system_admin only sees their own club's agendas
                where += " AND club_id = %s"
                params.append(user["club_id"])
            elif club_id is not None:
                # system_admin with club filter
                where += " AND club_id = %s"
                params.append(club_id)
            cur.execute(f"SELECT COUNT(*) FROM agendas {where}", params)
            total = cur.fetchone()[0]
            order_by = (
                "meeting_date DESC NULLS LAST, id DESC" if order == "date"
                else "meeting_date ASC NULLS LAST, id ASC" if order == "date_asc"
                else "updated_at DESC"
            )
            cur.execute(
                f"SELECT a.id, a.data, a.updated_at, a.club_id, c.name"
                f" FROM agendas a LEFT JOIN clubs c ON c.id = a.club_id {where}"
                f" ORDER BY {order_by} LIMIT %s OFFSET %s",
                params + [limit, offset],
            )
            rows = cur.fetchall()
    items = []
    for r in rows:
        d = parse_jsonb(r[1])
        item = {
            "id":           r[0],
            "meetingDate":  d.get("meetingDate", ""),
            "meetingNo":    d.get("meetingNo", ""),
            "meetingTheme": d.get("meetingTheme", ""),
            "updatedAt":    r[2].isoformat() if r[2] else "",
            "clubId":       r[3],
            "clubName":     r[4],
        }
        if full:
            item["data"] = d
        items.append(item)
    return {
        "items": items,
        "total": total,
        "page":  page,
        "pages": math.ceil(total / limit) if total else 1,
    }


@app.post("/api/agendas")
def create_agenda(req: AgendaSaveRequest, user: dict = Depends(require_club_admin_or_above)):
    meeting_date = req.data.get("meetingDate") or None
    # club_admin: forced to their own club; system_admin: uses provided club_id
    club_id = user["club_id"] if user["role"] == "club_admin" else req.club_id
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO agendas (username, data, meeting_date, club_id)"
                " VALUES (%s, %s::jsonb, %s, %s) RETURNING id",
                (user["username"], json.dumps(req.data), meeting_date, club_id),
            )
            new_id = cur.fetchone()[0]
    return {"id": new_id}


@app.put("/api/agendas/{agenda_id}")
def update_agenda(
    agenda_id: int,
    req: AgendaSaveRequest,
    user: dict = Depends(require_club_admin_or_above),
):
    meeting_date = req.data.get("meetingDate") or None
    with get_db() as conn:
        with conn.cursor() as cur:
            if user["role"] == "system_admin":
                cur.execute(
                    "UPDATE agendas SET data=%s::jsonb, meeting_date=%s, updated_at=NOW()"
                    " WHERE id=%s",
                    (json.dumps(req.data), meeting_date, agenda_id),
                )
            else:
                cur.execute(
                    "UPDATE agendas SET data=%s::jsonb, meeting_date=%s, updated_at=NOW()"
                    " WHERE id=%s AND club_id=%s",
                    (json.dumps(req.data), meeting_date, agenda_id, user["club_id"]),
                )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="找不到此議程或無權限修改")
    return {"ok": True}


@app.get("/api/agendas/{agenda_id}")
def get_agenda(agenda_id: int, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT data, club_id FROM agendas WHERE id = %s", (agenda_id,))
            row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="找不到此議程")
    if user["role"] != "system_admin" and row[1] != user["club_id"]:
        raise HTTPException(status_code=403, detail="無權限存取此議程")
    result = parse_jsonb(row[0])
    result["_clubId"] = row[1]   # consumed by the editor to restore the club picker
    return result


@app.delete("/api/agendas/{agenda_id}")
def delete_agenda(agenda_id: int, user: dict = Depends(require_club_admin_or_above)):
    with get_db() as conn:
        with conn.cursor() as cur:
            if user["role"] == "system_admin":
                cur.execute("DELETE FROM agendas WHERE id=%s", (agenda_id,))
            else:
                cur.execute(
                    "DELETE FROM agendas WHERE id=%s AND club_id=%s",
                    (agenda_id, user["club_id"]),
                )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="找不到此議程或無權限刪除")
    return {"ok": True}


# ------------------------------------------------------------------ clubs

# Branding/template columns returned to the frontend and used for agenda rendering.
_CLUB_COLS = (
    "id, name, name_zh, name_en, charter_no, founded_date, fee,"
    " logo_url, fb_qr_url, line_qr_url, template_key, settings"
)


def _club_row_to_dict(r):
    return {
        "id": r[0],
        "name": r[1],
        "name_zh": r[2],
        "name_en": r[3],
        "charter_no": r[4],
        "founded_date": r[5],
        "fee": r[6],
        "logo_url": r[7],
        "fb_qr_url": r[8],
        "line_qr_url": r[9],
        "template_key": r[10] or "standard",
        "settings": r[11] or {},
    }


@app.get("/api/clubs")
def list_clubs():
    """Public endpoint — club info is not sensitive; register form uses id/name,
    agenda generator uses the branding/template fields."""
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(f"SELECT {_CLUB_COLS} FROM clubs ORDER BY id")
            rows = cur.fetchall()
    return [_club_row_to_dict(r) for r in rows]


@app.post("/api/clubs")
def create_club(req: ClubRequest, user: dict = Depends(require_system_admin)):
    if not req.name.strip():
        raise HTTPException(status_code=400, detail="分會名稱不得為空")
    settings_json = json.dumps(req.settings) if req.settings is not None else "{}"
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO clubs"
                    " (name, name_zh, name_en, charter_no, founded_date, fee,"
                    "  logo_url, fb_qr_url, line_qr_url, template_key, settings)"
                    " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb) RETURNING id",
                    (
                        req.name.strip(), req.name_zh, req.name_en, req.charter_no,
                        req.founded_date, req.fee,
                        req.logo_url, req.fb_qr_url, req.line_qr_url,
                        req.template_key or "standard", settings_json,
                    ),
                )
                new_id = cur.fetchone()[0]
    except psycopg2.errors.UniqueViolation:
        raise HTTPException(status_code=400, detail="分會名稱已存在")
    return {"id": new_id}


@app.put("/api/clubs/{club_id}")
def update_club(club_id: int, req: ClubRequest, user: dict = Depends(require_system_admin)):
    if not req.name.strip():
        raise HTTPException(status_code=400, detail="分會名稱不得為空")
    settings_json = json.dumps(req.settings) if req.settings is not None else "{}"
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE clubs SET"
                    " name=%s, name_zh=%s, name_en=%s, charter_no=%s, founded_date=%s, fee=%s,"
                    " logo_url=%s, fb_qr_url=%s, line_qr_url=%s,"
                    " template_key=%s, settings=%s::jsonb"
                    " WHERE id=%s",
                    (
                        req.name.strip(), req.name_zh, req.name_en, req.charter_no,
                        req.founded_date, req.fee,
                        req.logo_url, req.fb_qr_url, req.line_qr_url,
                        req.template_key or "standard", settings_json, club_id,
                    ),
                )
                if cur.rowcount == 0:
                    raise HTTPException(status_code=404, detail="找不到此分會")
    except psycopg2.errors.UniqueViolation:
        raise HTTPException(status_code=400, detail="分會名稱已存在")
    return {"ok": True}


@app.delete("/api/clubs/{club_id}")
def delete_club(club_id: int, user: dict = Depends(require_system_admin)):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM clubs WHERE id=%s", (club_id,))
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="找不到此分會")
    return {"ok": True}


# ------------------------------------------------------------------ users
@app.post("/api/users")
def create_user(req: UserCreateRequest, user: dict = Depends(require_club_admin_or_above)):
    """club_admin or system_admin can create users directly (no invite code required)."""
    if len(req.username) < 3:
        raise HTTPException(status_code=400, detail="帳號至少需要 3 個字元")
    if len(req.password) < 6:
        raise HTTPException(status_code=400, detail="密碼至少需要 6 個字元")
    if not req.name_en.strip():
        raise HTTPException(status_code=400, detail="請輸入英文姓名")
    if not req.name_zh.strip():
        raise HTTPException(status_code=400, detail="請輸入中文姓名")
    if user["role"] == "club_admin":
        # club_admin: forced to their own club, role fixed to club_member
        role    = "club_member"
        club_id = user["club_id"]
    else:
        valid_roles = ("system_admin", "club_admin", "club_member")
        if req.role not in valid_roles:
            raise HTTPException(status_code=400, detail="無效的角色")
        role    = req.role
        club_id = req.club_id
    password_hash = bcrypt.hashpw(req.password.encode(), bcrypt.gensalt()).decode()
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO users (username, password_hash, name_en, name_zh, role, club_id, level, must_change_pw)"
                    " VALUES (%s, %s, %s, %s, %s, %s, %s, true)",
                    (req.username.strip(), password_hash,
                     req.name_en.strip(), req.name_zh.strip(),
                     role, club_id,
                     req.level.strip() or "TM"),
                )
    except psycopg2.errors.UniqueViolation:
        raise HTTPException(status_code=400, detail="帳號已存在")
    return {"ok": True}


@app.post("/api/users/bulk")
def create_users_bulk(req: BulkMemberRequest, user: dict = Depends(require_club_admin_or_above)):
    """Bulk-create club_member accounts; usernames are auto-generated from name_en."""
    club_id = user["club_id"] if user["role"] == "club_admin" else req.club_id
    if not club_id:
        raise HTTPException(status_code=400, detail="請先選擇分會")
    default_pw = (req.default_password or "Toastmasters1").strip()
    if len(default_pw) < 6:
        raise HTTPException(status_code=400, detail="預設密碼至少需要 6 個字元")
    password_hash = bcrypt.hashpw(default_pw.encode(), bcrypt.gensalt()).decode()

    results = []
    with get_db() as conn:
        with conn.cursor() as cur:
            for m in req.members:
                name_zh = m.name_zh.strip()
                name_en = m.name_en.strip()
                level   = m.level.strip() or "TM"
                if not name_zh or not name_en:
                    results.append({"nameZh": name_zh or name_en or "?", "ok": False, "error": "姓名不完整"})
                    continue
                # Auto-generate unique username from name_en
                base = re.sub(r"[^a-z0-9]", "", name_en.lower())
                if len(base) < 3:
                    base = base + re.sub(r"[^a-z]", "", name_zh.lower())
                base = (base or "member")[:20]
                username = base
                cur.execute("SELECT 1 FROM users WHERE username = %s", (username,))
                i = 2
                while cur.fetchone():
                    username = f"{base}{i}"
                    cur.execute("SELECT 1 FROM users WHERE username = %s", (username,))
                    i += 1
                cur.execute(
                    "INSERT INTO users (username, password_hash, name_en, name_zh, role, club_id, level, must_change_pw)"
                    " VALUES (%s, %s, %s, %s, 'club_member', %s, %s, true)",
                    (username, password_hash, name_en, name_zh, club_id, level),
                )
                results.append({"nameZh": name_zh, "nameEn": name_en, "username": username, "ok": True})
    return {"results": results, "defaultPassword": default_pw}


@app.get("/api/users")
def list_users(
    club_id: Optional[int] = Query(default=None),
    user: dict = Depends(get_current_user),
):
    """
    system_admin  → all users (no param), or filtered by ?club_id=X for member view
    club_admin    → users in their club (club_id param ignored)
    club_member   → users in their club (read-only, club_id param ignored)
    """
    with get_db() as conn:
        with conn.cursor() as cur:
            if user["role"] == "system_admin":
                if club_id is not None:
                    cur.execute("""
                        SELECT u.username, u.name_en, u.name_zh, u.role, u.club_id,
                               c.name, u.level, u.created_at, u.status
                        FROM users u
                        LEFT JOIN clubs c ON c.id = u.club_id
                        WHERE u.club_id = %s
                        ORDER BY u.status, u.created_at
                    """, (club_id,))
                else:
                    cur.execute("""
                        SELECT u.username, u.name_en, u.name_zh, u.role, u.club_id,
                               c.name, u.level, u.created_at, u.status
                        FROM users u
                        LEFT JOIN clubs c ON c.id = u.club_id
                        ORDER BY u.status, u.created_at
                    """)
            else:
                cur.execute("""
                    SELECT u.username, u.name_en, u.name_zh, u.role, u.club_id,
                           c.name, u.level, u.created_at, u.status
                    FROM users u
                    LEFT JOIN clubs c ON c.id = u.club_id
                    WHERE u.club_id = %s
                    ORDER BY u.status, u.created_at
                """, (user["club_id"],))
            rows = cur.fetchall()
    return [{
        "username":  r[0],
        "nameEn":    r[1],
        "nameZh":    r[2],
        "role":      r[3],
        "clubId":    r[4],
        "clubName":  r[5],
        "level":     r[6],
        "createdAt": r[7].isoformat() if r[7] else "",
        "status":    r[8],
    } for r in rows]


@app.put("/api/users/{username}")
def update_user(username: str, req: UserUpdateRequest, user: dict = Depends(get_current_user)):
    if user["role"] == "club_member":
        raise HTTPException(status_code=403, detail="權限不足")

    if user["role"] == "club_admin":
        # club_admin: only update name / level for users in their own club
        name_en = (req.name_en or "").strip()
        name_zh = (req.name_zh or "").strip()
        level   = (req.level   or "TM").strip()
        if not name_en or not name_zh:
            raise HTTPException(status_code=400, detail="請提供中英文姓名")
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE users SET name_en=%s, name_zh=%s, level=%s"
                    " WHERE username=%s AND club_id=%s",
                    (name_en, name_zh, level, username, user["club_id"]),
                )
                if cur.rowcount == 0:
                    raise HTTPException(status_code=404, detail="找不到此用戶或無權限修改")
        return {"ok": True}

    # system_admin: partial update — only update fields that were explicitly provided
    if username == "admin" and req.role is not None and req.role != "system_admin":
        raise HTTPException(status_code=400, detail="admin 帳號的角色不可變更")
    valid_roles = ("system_admin", "club_admin", "club_member")
    if req.role is not None and req.role not in valid_roles:
        raise HTTPException(status_code=400, detail=f"無效的角色，請使用：{', '.join(valid_roles)}")

    # Detect which fields were explicitly provided (handles club_id=null for unassign)
    try:
        in_fields = req.model_fields_set          # Pydantic v2
    except AttributeError:
        in_fields = req.__fields_set__             # Pydantic v1

    set_clauses: list = []
    values:      list = []
    if req.role is not None:
        set_clauses.append("role = %s");    values.append(req.role)
    if "club_id" in in_fields:              # allow explicit null to unassign club
        set_clauses.append("club_id = %s"); values.append(req.club_id)
    if req.level is not None:
        set_clauses.append("level = %s");   values.append(req.level.strip() or "TM")
    if req.name_en is not None:
        set_clauses.append("name_en = %s"); values.append(req.name_en.strip())
    if req.name_zh is not None:
        set_clauses.append("name_zh = %s"); values.append(req.name_zh.strip())

    if not set_clauses:
        return {"ok": True}  # nothing to update

    values.append(username)
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE users SET {', '.join(set_clauses)} WHERE username=%s",
                values,
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="找不到此使用者")
    return {"ok": True}


@app.put("/api/users/{username}/reset-password")
def reset_password(username: str, req: ResetPasswordRequest, user: dict = Depends(require_club_admin_or_above)):
    """system_admin/club_admin sets a new temporary password for another user.
    Mirrors create_user's must_change_pw=true so the affected user is forced
    through the existing self-service change-password flow on next login."""
    if len(req.new_password) < 6:
        raise HTTPException(status_code=400, detail="新密碼至少需要 6 個字元")
    new_hash = bcrypt.hashpw(req.new_password.encode(), bcrypt.gensalt()).decode()
    with get_db() as conn:
        with conn.cursor() as cur:
            if user["role"] == "club_admin":
                # club_admin 只能重設同分會一般會員的密碼，不可動其他管理員帳號
                cur.execute(
                    """UPDATE users SET password_hash=%s, must_change_pw=true
                       WHERE username=%s AND club_id=%s AND role='club_member'""",
                    (new_hash, username, user["club_id"]),
                )
            else:
                cur.execute(
                    "UPDATE users SET password_hash=%s, must_change_pw=true WHERE username=%s",
                    (new_hash, username),
                )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="找不到此使用者或無權限重設密碼")
    return {"ok": True}


@app.put("/api/users/{username}/approve")
def approve_user(username: str, user: dict = Depends(require_club_admin_or_above)):
    """Approve a pending self-registration: set status = 'active'."""
    with get_db() as conn:
        with conn.cursor() as cur:
            if user["role"] == "club_admin":
                cur.execute(
                    "UPDATE users SET status='active'"
                    " WHERE username=%s AND club_id=%s AND status='pending'",
                    (username, user["club_id"]),
                )
            else:  # system_admin
                cur.execute(
                    "UPDATE users SET status='active' WHERE username=%s AND status='pending'",
                    (username,),
                )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="找不到此待審核用戶或無權限")
    return {"ok": True}


@app.delete("/api/users/{username}/reject")
def reject_user(username: str, user: dict = Depends(require_club_admin_or_above)):
    """Reject a pending self-registration by deleting the pending account."""
    with get_db() as conn:
        with conn.cursor() as cur:
            if user["role"] == "club_admin":
                cur.execute(
                    "DELETE FROM users WHERE username=%s AND club_id=%s AND status='pending'",
                    (username, user["club_id"]),
                )
            else:  # system_admin
                cur.execute(
                    "DELETE FROM users WHERE username=%s AND status='pending'",
                    (username,),
                )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="找不到此待審核用戶或無權限")
    return {"ok": True}


@app.delete("/api/users/{username}")
def delete_user(username: str, user: dict = Depends(require_club_admin_or_above)):
    if username == "admin":
        raise HTTPException(status_code=400, detail="admin 帳號不可刪除")
    with get_db() as conn:
        with conn.cursor() as cur:
            if user["role"] == "club_admin":
                # club_admin 只能刪除同分會的一般會員，不可刪除其他管理員
                cur.execute(
                    """DELETE FROM users
                       WHERE username=%s
                         AND club_id=%s
                         AND role='club_member'""",
                    (username, user["club_id"]),
                )
            else:
                cur.execute("DELETE FROM users WHERE username=%s", (username,))
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="找不到此使用者或無權限刪除")
    return {"ok": True}


# ------------------------------------------------------------------ upload
@app.post("/api/upload/presign")
def presign_upload(req: PresignRequest, user: dict = Depends(require_club_admin_or_above)):
    ext = req.filename.rsplit(".", 1)[-1].lower() if "." in req.filename else "jpg"
    tw_tz = timezone(timedelta(hours=8))
    ts = datetime.now(tw_tz).strftime("%H%M%S")
    # Files for a known club are filed under media/clubs/{id}/; otherwise flat media/.
    base = f"media/clubs/{req.club_id}" if req.club_id else "media"
    if req.meeting_date and req.meeting_no:
        key = f"{base}/{req.meeting_date}_No{req.meeting_no}_{ts}.{ext}"
    elif req.meeting_date:
        key = f"{base}/{req.meeting_date}_{ts}.{ext}"
    else:
        key = f"{base}/{ts}_{uuid.uuid4()}.{ext}"
    client = _r2()
    upload_url = client.generate_presigned_url(
        "put_object",
        Params={"Bucket": R2_BUCKET_NAME, "Key": key, "ContentType": req.content_type},
        ExpiresIn=300,
    )
    public_url = f"{R2_PUBLIC_URL}/{key}"
    return {"uploadUrl": upload_url, "publicUrl": public_url}


# ------------------------------------------------------------------ image proxy
@app.get("/api/image-proxy")
def image_proxy(
    url: str = Query(...),
    user: dict = Depends(get_current_user),
):
    prefix = R2_PUBLIC_URL + "/"
    if not R2_PUBLIC_URL or not url.startswith(prefix):
        raise HTTPException(status_code=400, detail="Invalid image URL")
    key = url[len(prefix):]
    client = _r2()
    try:
        obj = client.get_object(Bucket=R2_BUCKET_NAME, Key=key)
    except Exception:
        raise HTTPException(status_code=404, detail="Image not found")
    data = obj["Body"].read()
    content_type = obj.get("ContentType", "image/jpeg")
    return Response(content=data, media_type=content_type, headers={"Cache-Control": "max-age=3600"})


# ------------------------------------------------------------------ roles sheet
# Server-side fetch of a club's Google Sheet role plan. The URL is *not* taken
# from the request — it is read from clubs.settings.roles_sheet_url (edited in
# the 版型 modal on /club) — so this endpoint cannot be pointed at an arbitrary
# host, and the browser never has to deal with Google's CORS rules.
_GS_ID_RE  = re.compile(r"/spreadsheets/d/([a-zA-Z0-9-_]+)")
_GS_GID_RE = re.compile(r"[#&?]gid=([0-9]+)")


def _sheet_csv_url(url: str) -> str:
    """Turn any Google Sheets link into its CSV export URL for the pinned tab."""
    if not url:
        raise HTTPException(status_code=400, detail="這個分會尚未設定 Google Sheet 網址")
    m = _GS_ID_RE.search(url)
    if not m or "docs.google.com" not in url:
        raise HTTPException(status_code=400, detail="網址格式不正確，請貼上 Google Sheet 的連結")
    gid = _GS_GID_RE.search(url)
    # No #gid= in the link means the first tab — which is rarely the roles tab,
    # so ask for an explicit one rather than silently importing the wrong sheet.
    if not gid:
        raise HTTPException(
            status_code=400,
            detail="網址缺少分頁編號（#gid=…），請在該分頁上複製網址列的完整連結",
        )
    return (
        f"https://docs.google.com/spreadsheets/d/{m.group(1)}"
        f"/export?format=csv&gid={gid.group(1)}"
    )


@app.get("/api/clubs/{club_id}/roles-sheet")
def fetch_roles_sheet(club_id: int, user: dict = Depends(require_club_admin_or_above)):
    if user["role"] != "system_admin" and user["club_id"] != club_id:
        raise HTTPException(status_code=403, detail="無權存取其他分會的資料")

    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT settings FROM clubs WHERE id=%s", (club_id,))
            row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="找不到此分會")

    settings = parse_jsonb(row[0])
    csv_url = _sheet_csv_url((settings.get("roles_sheet_url") or "").strip())

    import urllib.error
    import urllib.request
    req = urllib.request.Request(csv_url, headers={"User-Agent": "EntrepreneurAgenda/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            # Google answers a private sheet with a 302 to an HTML sign-in page
            # rather than a 4xx, so check what actually came back.
            if "text/csv" not in res.headers.get("Content-Type", ""):
                raise HTTPException(
                    status_code=400,
                    detail="無法讀取試算表，請將共用設定改為「知道連結的任何人可檢視」",
                )
            body = res.read(4 * 1024 * 1024)
    except HTTPException:
        raise
    except urllib.error.HTTPError as e:
        detail = "找不到這個分頁（gid），請確認網址" if e.code == 404 else f"讀取試算表失敗（{e.code}）"
        raise HTTPException(status_code=400, detail=detail)
    except Exception:
        raise HTTPException(status_code=502, detail="連線 Google Sheet 失敗，請稍後再試")

    return {"csv": body.decode("utf-8-sig", errors="replace"), "sourceUrl": csv_url}


# ------------------------------------------------------------------ pathways
# The Pathways catalog behind the agenda editor's and role matrix's dropdowns
# (tables from migration 0013). Everyone signed in reads it; only a system
# admin changes it, and always as a whole — the 「Pathways 路徑管理」page edits
# a draft of the full catalog and PUTs it back, so a save can never leave a
# path pointing at a project that another half-finished save removed.

_PATHWAY_CODE_RE = re.compile(r"^[A-Z]{2,4}$")
_PATHWAY_LEVELS = ("1", "2", "3", "4", "5")


class PathwayProjectItem(BaseModel):
    id: Optional[int] = None    # absent = new project
    en: str
    zh: str = ""


class PathwayItem(BaseModel):
    code: str
    en: str
    zh: str = ""
    legacy: bool = False
    required: Dict[str, List[str]] = {}   # level → project English names, in order


class PathwayCatalogRequest(BaseModel):
    projects: List[PathwayProjectItem]
    paths: List[PathwayItem]
    electives: Dict[str, List[str]] = {}  # level → project English names, in order


def _load_pathway_catalog(cur) -> dict:
    cur.execute("SELECT id, name_en, name_zh FROM pathway_projects ORDER BY sort_order, id")
    projects = [{"id": r[0], "en": r[1], "zh": r[2]} for r in cur.fetchall()]

    cur.execute("SELECT code, name_en, name_zh, legacy FROM pathways ORDER BY sort_order, code")
    paths = [{"code": r[0], "en": r[1], "zh": r[2], "legacy": r[3], "required": {}}
             for r in cur.fetchall()]
    by_code = {p["code"]: p for p in paths}

    cur.execute("""
        SELECT r.pathway_code, r.level, p.name_en
        FROM pathway_required r JOIN pathway_projects p ON p.id = r.project_id
        ORDER BY r.pathway_code, r.level, r.sort_order
    """)
    for code, level, name in cur.fetchall():
        by_code[code]["required"].setdefault(str(level), []).append(name)

    cur.execute("""
        SELECT e.level, p.name_en
        FROM pathway_electives e JOIN pathway_projects p ON p.id = e.project_id
        ORDER BY e.level, e.sort_order
    """)
    electives: Dict[str, List[str]] = {}
    for level, name in cur.fetchall():
        electives.setdefault(str(level), []).append(name)

    return {"projects": projects, "paths": paths, "electives": electives}


def _clean_name(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


@app.get("/api/pathways")
def get_pathways(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        with conn.cursor() as cur:
            return _load_pathway_catalog(cur)


@app.put("/api/pathways")
def put_pathways(req: PathwayCatalogRequest, user: dict = Depends(require_system_admin)):
    # ---- validate the whole payload before touching anything
    projects = []
    seen = set()
    for p in req.projects:
        en, zh = _clean_name(p.en), _clean_name(p.zh)
        if not en:
            raise HTTPException(status_code=400, detail="專案的英文名稱不可空白")
        if en.lower() in seen:
            raise HTTPException(status_code=400, detail=f"專案名稱重複：{en}")
        seen.add(en.lower())
        projects.append({"id": p.id, "en": en, "zh": zh})
    known = {p["en"] for p in projects}

    def level_lists(raw: Dict[str, List[str]], where: str) -> Dict[int, List[str]]:
        out = {}
        for level, names in raw.items():
            if level not in _PATHWAY_LEVELS:
                raise HTTPException(status_code=400, detail=f"{where}：等級必須是 1～5")
            clean = []
            for n in names:
                n = _clean_name(n)
                if n not in known:
                    raise HTTPException(status_code=400, detail=f"{where}：找不到專案「{n}」")
                if n not in clean:
                    clean.append(n)
            out[int(level)] = clean
        return out

    paths = []
    codes = set()
    for p in req.paths:
        code = _clean_name(p.code).upper()
        if not _PATHWAY_CODE_RE.match(code):
            raise HTTPException(status_code=400, detail=f"路徑代碼「{p.code}」須為 2～4 個英文字母")
        if code in codes:
            raise HTTPException(status_code=400, detail=f"路徑代碼重複：{code}")
        codes.add(code)
        en = _clean_name(p.en)
        if not en:
            raise HTTPException(status_code=400, detail=f"{code} 的英文名稱不可空白")
        paths.append({"code": code, "en": en, "zh": _clean_name(p.zh), "legacy": p.legacy,
                      "required": level_lists(p.required, code)})
    electives = level_lists(req.electives, "選修清單")

    renamed_agendas = 0
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id, name_en, name_zh FROM pathway_projects FOR UPDATE")
            existing = {r[0]: (r[1], r[2]) for r in cur.fetchall()}
            for p in projects:
                if p["id"] is not None and p["id"] not in existing:
                    raise HTTPException(status_code=409, detail="目錄已被其他人修改，請重新載入後再編輯")

            # Old stored value → new English name, for every renamed project,
            # so agendas that pointed at the old name keep resolving.
            renames = {}
            for p in projects:
                if p["id"] is None:
                    continue
                old_en, old_zh = existing[p["id"]]
                if old_en != p["en"]:
                    renames[old_en] = p["en"]
                if old_zh and old_zh != p["zh"]:
                    renames[old_zh] = p["en"]

            # Every write below is one statement per table (execute_values),
            # not one per row: the API and the DB can be far apart (Vercel's
            # default region vs. Neon in Singapore), and ~240 round trips ran a
            # save past the function time limit.
            batch = lambda sql, rows, **kw: psycopg2.extras.execute_values(cur, sql, rows, page_size=10000, **kw)

            # ---- projects: delete gone, park kept names (renames/swaps would
            # trip the UNIQUE mid-way), then write final names and insert new ones.
            keep = [p["id"] for p in projects if p["id"] is not None]
            cur.execute("DELETE FROM pathway_projects WHERE NOT (id = ANY(%s))", (keep or [0],))
            cur.execute("UPDATE pathway_projects SET name_en = '#parked#' || id WHERE id = ANY(%s)", (keep or [0],))
            ids = {p["en"]: p["id"] for p in projects if p["id"] is not None}
            kept = [(p["id"], p["en"], p["zh"], order) for order, p in enumerate(projects) if p["id"] is not None]
            added = [(p["en"], p["zh"], order) for order, p in enumerate(projects) if p["id"] is None]
            if kept:
                batch("UPDATE pathway_projects AS p SET name_en = v.en, name_zh = v.zh, sort_order = v.o, updated_at = NOW()"
                      " FROM (VALUES %s) AS v(id, en, zh, o) WHERE p.id = v.id",
                      kept, template="(%s::int, %s::text, %s::text, %s::int)")
            if added:
                rows = batch("INSERT INTO pathway_projects (name_en, name_zh, sort_order) VALUES %s RETURNING id, name_en",
                             added, fetch=True)
                ids.update({en: pid for pid, en in rows})

            # ---- paths and their level lists: replaced wholesale
            cur.execute("DELETE FROM pathway_required")
            cur.execute("DELETE FROM pathway_electives")
            cur.execute("DELETE FROM pathways WHERE NOT (code = ANY(%s))", (list(codes) or [""],))
            if paths:
                batch("INSERT INTO pathways (code, name_en, name_zh, legacy, sort_order) VALUES %s"
                      " ON CONFLICT (code) DO UPDATE SET name_en=EXCLUDED.name_en, name_zh=EXCLUDED.name_zh,"
                      " legacy=EXCLUDED.legacy, sort_order=EXCLUDED.sort_order, updated_at=NOW()",
                      [(p["code"], p["en"], p["zh"], p["legacy"], order) for order, p in enumerate(paths)])
            required = [(p["code"], level, ids[n], j)
                        for p in paths for level, names in p["required"].items() for j, n in enumerate(names)]
            if required:
                batch("INSERT INTO pathway_required (pathway_code, level, project_id, sort_order) VALUES %s", required)
            elective_rows = [(level, ids[n], j) for level, names in electives.items() for j, n in enumerate(names)]
            if elective_rows:
                batch("INSERT INTO pathway_electives (level, project_id, sort_order) VALUES %s", elective_rows)

            # ---- follow renames into saved agendas (all clubs — the catalog is global)
            if renames:
                cur.execute("""
                    SELECT id, data FROM agendas
                    WHERE jsonb_typeof(data->'speeches') = 'array'
                      AND EXISTS (SELECT 1 FROM jsonb_array_elements(data->'speeches') s
                                  WHERE s->>'pathwayProject' = ANY(%s))
                """, (list(renames),))
                updates = []
                for agenda_id, data in cur.fetchall():
                    data = parse_jsonb(data)
                    for sp in data["speeches"]:
                        if isinstance(sp, dict) and sp.get("pathwayProject") in renames:
                            sp["pathwayProject"] = renames[sp["pathwayProject"]]
                    updates.append((agenda_id, json.dumps(data)))
                if updates:
                    batch("UPDATE agendas AS a SET data = v.data::jsonb FROM (VALUES %s) AS v(id, data) WHERE a.id = v.id",
                          updates, template="(%s::int, %s::text)")
                renamed_agendas = len(updates)

            catalog = _load_pathway_catalog(cur)

    return {**catalog, "renamedAgendas": renamed_agendas}


# ------------------------------------------------------------------ social posts
# Draft storage for the 社群發文 feature: one row per post, holding the shared
# body plus a per-platform variant and the image URLs. Publishing to Facebook /
# Instagram / Threads lives further down in the META section and reads exactly
# this shape — a post is stored the same way whether it is ever published or
# only copied out by hand.

SOCIAL_PLATFORMS = ("facebook", "instagram", "threads")

# Only what the copywriter needs to know. The UI keeps its own copy of these
# (lib/socialPlatforms.js) for the character counters and preview cards.
_PLATFORM_BRIEF = {
    "facebook":  "Facebook 粉絲專頁：連結可點，字數寬鬆，語氣完整、資訊齊全，hashtag 最多 2-3 個。",
    "instagram": "Instagram：貼文一定要配圖；內文連結不可點，需要時請寫「報名連結在個人簡介」；"
                 "開頭第一行要抓住注意力，段落簡短，結尾放 5-10 個相關 hashtag；上限 2200 字。",
    "threads":   "Threads：上限 500 字，口語、像在跟朋友說話，最多 1-2 個 hashtag，不要條列式。",
}

_STATUSES = ("draft", "ready", "posted")

# What each kind is for, in the copywriter's own terms. The differences are not
# cosmetic: a promo asks the reader to turn up, a recap tells someone who did
# not what they missed, and the tense, the call to action and which facts
# matter all follow from that.
_KIND_BRIEF = {
    "promo": (
        "例會宣傳。目的是邀請人來參加下一場例會，讀者多半還不是會員。"
        "務必自然地寫進日期、時間、地址與入場費——這四件事缺一則讀者無法赴約，"
        "但不要寫成條列的活動公告，要讓它們融進邀請的語氣裡。"
        "結尾給一個明確、低壓力的行動（歡迎直接來、可以先私訊詢問）。"
    ),
    "recap": (
        "例會回顧。目的是記錄剛結束的那場例會，讀者是會員與關注分會的人。"
        "用過去式寫當天實際發生的事——誰上台、講了什麼、現場的氣氛與收穫。"
        "不需要重複地址與費用；若資料裡有下一場的時間，結尾可以順帶一提。"
        "重點是真實的細節，不是把議程重講一遍。"
    ),
    "other": (
        "一般貼文，可能是特殊活動、重要事項佈達或分會公告。"
        "以使用者的補充指示為主要依據，例會資料只在相關時引用。"
        "先把要傳達的事情講清楚，再談語氣。"
    ),
}


def _social_scope(user: dict, club_id: Optional[int]) -> Optional[int]:
    """Resolve which club a request may act on, mirroring the agendas rules."""
    if user["role"] == "system_admin":
        return club_id
    if club_id is not None and club_id != user["club_id"]:
        raise HTTPException(status_code=403, detail="無權存取其他分會的資料")
    return user["club_id"]


def _social_row(r):
    return {
        "id": r[0], "clubId": r[1], "agendaId": r[2],
        "title": r[3], "status": r[4], "body": r[5],
        "variants": r[6] or {}, "images": r[7] or [],
        "createdAt": r[8].isoformat() if r[8] else "",
        "updatedAt": r[9].isoformat() if r[9] else "",
        "published": r[10] or {},
        "kind": r[11] or "other",
    }


_SOCIAL_COLS = ("id, club_id, agenda_id, title, status, body, variants, images,"
                " created_at, updated_at, published, kind")

# What the post is for. Drives the copywriter's brief, which facts are
# required, and which image template applies.
_POST_KINDS = ("promo", "recap", "other")


class SocialPostRequest(BaseModel):
    club_id:   Optional[int] = None
    agenda_id: Optional[int] = None
    kind:      str = "other"
    title:     str = ""
    status:    str = "draft"
    body:      str = ""
    variants:  Dict[str, Any] = {}
    images:    List[Any] = []


class SocialGenerateRequest(BaseModel):
    club_id:   Optional[int] = None
    agenda_id: Optional[int] = None
    brief:     str = ""              # free-text steer from the user
    platforms: List[str] = []
    provider:  str = "anthropic"     # whose account writes it — see COPY_WRITERS
    model:     str = ""              # one of COPY_MODELS[provider]; blank = cheapest
    kind:      str = "other"         # see _KIND_BRIEF


@app.get("/api/social-posts")
def list_social_posts(
    club_id: Optional[int] = Query(default=None),
    user: dict = Depends(get_current_user),
):
    cid = _social_scope(user, club_id)
    with get_db() as conn:
        with conn.cursor() as cur:
            if cid is None:
                # Only a system_admin reaches here (no club filter chosen).
                cur.execute(f"SELECT {_SOCIAL_COLS} FROM social_posts"
                            " ORDER BY created_at DESC LIMIT 200")
            else:
                cur.execute(f"SELECT {_SOCIAL_COLS} FROM social_posts WHERE club_id=%s"
                            " ORDER BY created_at DESC LIMIT 200", (cid,))
            rows = cur.fetchall()
    return [_social_row(r) for r in rows]


@app.post("/api/social-posts")
def create_social_post(req: SocialPostRequest,
                       user: dict = Depends(require_club_admin_or_above)):
    cid = _social_scope(user, req.club_id)
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO social_posts"
                " (club_id, agenda_id, kind, title, status, body, variants, images)"
                " VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb) RETURNING id",
                (cid, req.agenda_id, _kind_of(req), req.title[:200], req.status,
                 req.body, json.dumps(req.variants), json.dumps(req.images)),
            )
            new_id = cur.fetchone()[0]
    return {"id": new_id}


def _load_social_post(cur, post_id: int, user: dict):
    cur.execute(f"SELECT {_SOCIAL_COLS} FROM social_posts WHERE id=%s", (post_id,))
    row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="找不到這則貼文")
    if user["role"] != "system_admin" and row[1] != user["club_id"]:
        raise HTTPException(status_code=403, detail="無權存取其他分會的資料")
    return row


@app.get("/api/social-posts/{post_id}")
def get_social_post(post_id: int, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        with conn.cursor() as cur:
            return _social_row(_load_social_post(cur, post_id, user))


@app.put("/api/social-posts/{post_id}")
def update_social_post(post_id: int, req: SocialPostRequest,
                       user: dict = Depends(require_club_admin_or_above)):
    if req.status not in _STATUSES:
        raise HTTPException(status_code=400, detail="狀態不正確")
    with get_db() as conn:
        with conn.cursor() as cur:
            _load_social_post(cur, post_id, user)   # 404 / 403 before writing
            cur.execute(
                "UPDATE social_posts SET agenda_id=%s, kind=%s, title=%s, status=%s,"
                " body=%s, variants=%s::jsonb, images=%s::jsonb, updated_at=NOW()"
                " WHERE id=%s",
                (req.agenda_id, _kind_of(req), req.title[:200], req.status, req.body,
                 json.dumps(req.variants), json.dumps(req.images), post_id),
            )
    return {"ok": True}


@app.delete("/api/social-posts/{post_id}")
def delete_social_post(post_id: int, user: dict = Depends(require_club_admin_or_above)):
    with get_db() as conn:
        with conn.cursor() as cur:
            _load_social_post(cur, post_id, user)
            cur.execute("DELETE FROM social_posts WHERE id=%s", (post_id,))
    return {"ok": True}


def _kind_of(req) -> str:
    k = getattr(req, "kind", None) or "other"
    return k if k in _POST_KINDS else "other"


_LABEL_RE = re.compile(r"^\s*(venue|地點|地址|場地)\s*[:：]\s*", re.I)


def _strip_label(v: str) -> str:
    return _LABEL_RE.sub("", v or "").strip()


def _meeting_fields(cur, agenda_id: int, user: dict) -> dict:
    """
    The handful of facts a post is written around, from wherever they live.

    Date, time and venue are per meeting and live on the agenda; the door fee
    is a club-level fact. Two of these were previously unreachable: the agenda
    stores the address under `venueInfo`, and `venue` — which this read — is
    never set, so the address silently never reached the copywriter; and the
    club's fee was not fetched at all.
    """
    cur.execute("SELECT a.data, a.club_id, c.name, c.name_zh, c.fee, c.settings,"
                " c.logo_url, c.name_en"
                " FROM agendas a LEFT JOIN clubs c ON c.id = a.club_id"
                " WHERE a.id=%s", (agenda_id,))
    row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="找不到這場議程")
    if user["role"] != "system_admin" and row[1] != user["club_id"]:
        raise HTTPException(status_code=403, detail="無權存取其他分會的資料")

    d = parse_jsonb(row[0])
    st = parse_jsonb(row[5])

    def pick(*vals):
        for v in vals:
            if isinstance(v, str) and v.strip():
                return v.strip()
        return ""

    return {
        "clubName":   pick(row[3], row[2]),
        "clubNameEn": pick(row[7], row[2]),
        "date":       pick(d.get("meetingDate")),
        "time":       pick(d.get("timeRange"), st.get("timeRange")),
        # The agenda's own line wins: it is the one someone checked for this
        # meeting. The club setting is the standing address behind it. The
        # stored text often carries its own "Venue:" label, which reads fine in
        # an agenda and wrong once a template draws it as an address.
        "venue":      _strip_label(pick(d.get("venueInfo"), d.get("venue"),
                                        st.get("venue"))),
        "transit":    pick(st.get("transit")),
        "fee":        pick(row[4], st.get("membershipFee")),
        "theme":      pick(d.get("meetingTheme")),
        "meetingNo":  pick(str(d.get("meetingNo") or "")),
        # themeImgUrl is deliberately NOT here: it belongs to the agenda sheet,
        # and a post's artwork is chosen for the post.
        "logo":       pick(row[6]),
        "agenda":     d,
    }


# Which facts a kind cannot be written without. A promo missing any of them is
# an invitation nobody can act on, so it is refused rather than half-written.
_KIND_REQUIRED = {
    "promo": (("date", "日期"), ("venue", "地址"), ("fee", "入場費")),
}


def _meeting_brief(cur, agenda_id: int, user: dict) -> str:
    """Flatten one agenda into the few lines a copywriter actually needs."""
    f = _meeting_fields(cur, agenda_id, user)
    d = f["agenda"]

    lines = [f"分會：{f['clubName']}"]
    for key, label in (("date", "日期"), ("time", "時間"), ("meetingNo", "場次"),
                       ("theme", "主題"), ("venue", "地點"),
                       ("transit", "交通"), ("fee", "入場費")):
        if f.get(key):
            lines.append(f"{label}：{f[key]}")

    for i, sp in enumerate(d.get("speeches") or [], start=1):
        if not isinstance(sp, dict):
            continue
        bits = [b for b in (sp.get("speaker"), sp.get("title"), sp.get("pathwayProject")) if b]
        if bits:
            lines.append(f"演講{i}：{' / '.join(bits)}")

    vs = d.get("varietySession") or {}
    if vs.get("enabled") and vs.get("host"):
        lines.append(f"暖場活動主持人：{vs['host']}")
    for key, label in (("tme", "總主持人"), ("tableTopicsMaster", "即席問答主持人")):
        if d.get(key):
            lines.append(f"{label}：{d[key]}")
    return "\n".join(lines)


# Two ways to write the same thing. Both are handed the identical system
# prompt, user text and JSON schema, and both must return the parsed dict — the
# endpoint below does not care which one ran. Keeping them as separate
# functions (rather than branching inside one) is what stops the Anthropic and
# OpenAI call shapes from bleeding into each other as either SDK moves on.

def _copy_via_anthropic(api_key: str, system: str, user_text: str, schema: dict,
                       model: dict) -> dict:
    try:
        import anthropic
    except ImportError:
        raise HTTPException(status_code=503, detail="伺服器缺少 anthropic 套件，請聯絡管理員")

    client = anthropic.Anthropic(api_key=api_key)
    kwargs = {
        "model": model["id"],
        "max_tokens": 16000,
        "system": system,
        "messages": [{"role": "user", "content": user_text}],
        "output_config": {"format": {"type": "json_schema", "schema": schema}},
    }
    if model.get("thinking"):
        kwargs["thinking"] = {"type": "adaptive"}
        # `medium` rather than the default `high`: this is a short creative
        # write-up behind a browser request, and the extra latency of a deeper
        # pass costs more here than it buys.
        kwargs["output_config"]["effort"] = "medium"
    try:
        response = client.messages.create(**kwargs)
    except anthropic.RateLimitError:
        raise HTTPException(status_code=429, detail="Claude 忙碌中，請稍後再試")
    except anthropic.APIStatusError as e:
        raise HTTPException(status_code=502,
                            detail=f"Claude 回應異常（{model['id']}，{e.status_code}）")
    except anthropic.APIConnectionError:
        raise HTTPException(status_code=502, detail="無法連線至 Claude，請稍後再試")

    if response.stop_reason == "refusal":
        raise HTTPException(status_code=400,
                            detail="Claude 拒絕產生這則內容，請調整補充指示後再試")

    text = next((b.text for b in response.content if b.type == "text"), "")
    return _parse_copy_json(text)


# Model ids move faster than this file does, so the choice is an env var with a
# widely-available default. A wrong id surfaces as OpenAI's own error rather
# than as something invented here.
# Which models a club may pick, listed cheapest first so the choice can be
# scanned by price. The preselected one is marked `default` rather than being
# whichever happens to sort first — display order and the default answer
# different questions, and tying them together means one cannot change without
# silently changing the other. Prices are per million tokens and are a guide
# for the UI, not something this code bills against; check the provider for
# the live rate.
#
# `thinking` records a per-model call difference rather than a preference:
# Claude Opus 5.5 and Sonnet 5.5 take adaptive thinking and an effort level,
# while Haiku 4.5 rejects both — sending them to it is a 400. Keeping the flag
# beside the id is what stops picking a model from producing an invalid
# request.
COPY_MODELS = {
    "anthropic": [
        {"id": "claude-haiku-4-5",  "label": "Haiku 4.5",  "note": "最省",
         "price": "US$1 / $5", "thinking": False},
        {"id": "claude-sonnet-5-5", "label": "Sonnet 5.5", "note": "均衡",
         "price": "US$2 / $10", "thinking": True},
        {"id": "claude-opus-5-5",   "label": "Opus 5.5",   "note": "最強",
         "price": "US$4 / $20", "thinking": True, "default": True},
    ],
    "openai": [
        {"id": "gpt-6-luna",  "label": "GPT-6 Luna",  "note": "最省",
         "price": "US$0.10 / $0.50", "default": True},
        {"id": "gpt-6.1-sol", "label": "GPT-6.1 Sol", "note": "均衡",
         "price": "US$2 / $10"},
        {"id": "gpt-6-astra", "label": "GPT-6 Astra", "note": "最強",
         "price": "US$10 / $50"},
    ],
}

# Image generation is OpenAI-only — Anthropic's API has no image output.
IMAGE_MODELS = [
    {"id": "gpt-image-1-mini",       "label": "GPT-Image 1 mini", "note": "最省",
     "price": "輸出 US$8 /百萬 token", "default": True},
    {"id": "gpt-image-2.5-flare",    "label": "GPT-Image 2.5 Flare", "note": "快",
     "price": "輸出 US$30 /百萬 token"},
    {"id": "gpt-image-2.5-sunburst", "label": "GPT-Image 2.5 Sunburst", "note": "最強",
     "price": "輸出 US$30 /百萬 token"},
]

# `auto` lets the model choose, which also means it chooses what you pay —
# roughly a 15x spread on gpt-image-1. The default is the cheapest rung
# instead, so the bill is a decision rather than a surprise.
IMAGE_QUALITIES = ("low", "medium", "high", "auto")


def _default_model(models: list) -> dict:
    return next((m for m in models if m.get("default")), models[0])


def _copy_model(provider: str, wanted: str) -> dict:
    allowed = COPY_MODELS.get(provider) or COPY_MODELS["anthropic"]
    for m in allowed:
        if m["id"] == wanted:
            return m
    return _default_model(allowed)


def _copy_via_openai(api_key: str, system: str, user_text: str, schema: dict,
                    model: dict) -> dict:
    try:
        from openai import OpenAI
    except ImportError:
        raise HTTPException(status_code=503, detail="伺服器缺少 openai 套件，請聯絡管理員")

    try:
        response = OpenAI(api_key=api_key).chat.completions.create(
            model=model["id"],
            messages=[{"role": "system", "content": system},
                      {"role": "user", "content": user_text}],
            response_format={
                "type": "json_schema",
                "json_schema": {"name": "social_copy", "strict": True, "schema": schema},
            },
        )
    except Exception as e:
        detail = getattr(e, "message", None) or str(e)
        raise HTTPException(status_code=502, detail=f"OpenAI 產生文案失敗：{detail}"[:400])

    choice = (response.choices or [None])[0]
    if choice is None or not getattr(choice.message, "content", None):
        raise HTTPException(status_code=502, detail="OpenAI 沒有回傳文案")
    return _parse_copy_json(choice.message.content)


def _parse_copy_json(text: str) -> dict:
    try:
        return json.loads(text)
    except ValueError:
        raise HTTPException(status_code=502, detail="AI 回傳的格式無法解析，請再試一次")


COPY_WRITERS = {"anthropic": _copy_via_anthropic, "openai": _copy_via_openai}


@app.get("/api/ai-models")
def list_ai_models(user: dict = Depends(get_current_user)):
    """The pickable models, so the browser and the server cannot disagree."""
    return {"copy": COPY_MODELS, "image": IMAGE_MODELS,
            "imageQualities": list(IMAGE_QUALITIES),
            "imageSizes": list(_IMAGE_SIZES)}


@app.get("/api/meeting-fields")
def get_meeting_fields(agenda_id: int = Query(...),
                       user: dict = Depends(get_current_user)):
    """
    The facts a post is built around — for the image templates, which compose
    them as real text rather than asking an image model to draw them.

    Same source as the copywriter's brief, so the picture and the caption can
    never disagree about when or where the meeting is.
    """
    with get_db() as conn:
        with conn.cursor() as cur:
            f = _meeting_fields(cur, agenda_id, user)
    f.pop("agenda", None)          # the raw agenda is not the caller's business
    return f


@app.post("/api/social-posts/generate")
def generate_social_copy(req: SocialGenerateRequest,
                         user: dict = Depends(require_club_admin_or_above)):
    provider = req.provider if req.provider in COPY_WRITERS else "anthropic"

    # The caller's own connected account is what pays. Anthropic additionally
    # falls back to the server-wide key, so a club that has connected nothing
    # still works out of the box; OpenAI has no such fallback by design — there
    # is no server OpenAI account to spend.
    api_key = _load_api_key(user["username"], provider)
    if not api_key and provider == "anthropic":
        api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        label = "Anthropic" if provider == "anthropic" else "OpenAI"
        raise HTTPException(
            status_code=400,
            detail=f"你還沒有連接 {label} 帳號，請先在「AI 帳號」設定金鑰",
        )

    platforms = [p for p in req.platforms if p in SOCIAL_PLATFORMS] or list(SOCIAL_PLATFORMS)
    _social_scope(user, req.club_id)   # permission check only

    kind = req.kind if req.kind in _POST_KINDS else "other"

    context = ""
    if req.agenda_id:
        with get_db() as conn:
            with conn.cursor() as cur:
                fields = _meeting_fields(cur, req.agenda_id, user)
                context = _meeting_brief(cur, req.agenda_id, user)
        # A promo without the date, address or fee is an invitation nobody can
        # act on. Refusing here names the missing field and where to fill it;
        # generating anyway produces copy that looks finished and is not.
        missing = [label for key, label in _KIND_REQUIRED.get(kind, ())
                   if not fields.get(key)]
        if missing:
            raise HTTPException(
                status_code=400,
                detail="例會宣傳缺少「" + "、".join(missing) + "」。"
                       "日期與地址在該場議程裡填，入場費在分會設定裡填。",
            )

    if not context and not req.brief.strip():
        raise HTTPException(status_code=400, detail="請先選擇一場例會，或寫幾句想發的內容")

    rules = "\n".join(f"- {_PLATFORM_BRIEF[p]}" for p in platforms)
    system = (
        "你是台灣一個 Toastmasters 國際演講會分會的社群小編。\n"
        f"這一則的用途：{_KIND_BRIEF[kind]}\n"
        "寫作要求：\n"
        "- 一律使用繁體中文（台灣用語），可自然夾雜英文專有名詞。\n"
        "- 語氣真誠、有溫度，像社團成員在分享，不要像廣告文案或新聞稿。\n"
        "- 不要編造任何沒有提供的資訊（時間、地點、講者、費用一律以資料為準）。\n"
        "- 不要使用誇大的行銷字眼，也不要用 emoji 洗版（每則最多 3 個）。\n"
        "先寫一段各平台共用的主文案，再依各平台特性改寫：\n" + rules
    )

    parts = []
    if context:
        parts.append(f"這場例會的資料：\n{context}")
    if req.brief.strip():
        parts.append(f"補充指示：\n{req.brief.strip()}")

    schema = {
        "type": "object",
        "properties": {
            "title": {"type": "string",
                      "description": "這則貼文的內部標題，10 字以內，只給管理者辨識用"},
            "body":  {"type": "string", "description": "各平台共用的主文案"},
            "variants": {
                "type": "object",
                "properties": {p: {"type": "string"} for p in platforms},
                "required": platforms,
                "additionalProperties": False,
            },
        },
        "required": ["title", "body", "variants"],
        "additionalProperties": False,
    }

    data = COPY_WRITERS[provider](api_key, system, "\n\n".join(parts), schema,
                                 _copy_model(provider, req.model))

    return {
        "title": data.get("title", ""),
        "body": data.get("body", ""),
        # Normalised to the stored shape so the client can drop it straight in.
        "variants": {p: {"text": (data.get("variants") or {}).get(p, ""), "enabled": True}
                     for p in platforms},
    }


# ------------------------------------------------------------------ AI credentials
# Users connect their own AI accounts, so their API keys live in the database
# — which means they must be encrypted at rest and must never travel back to
# the browser. Two rules hold everywhere below:
#   1. Nothing writes a key to the DB except through _seal(); nothing reads one
#      except _open(), and _open() is only ever called server-side, seconds
#      before the outbound API call that needs it.
#   2. No endpoint returns a key. The UI gets a masked hint and a boolean.
#
# CREDENTIALS_SECRET_KEY is the master secret. There is no fallback and no
# default: without it, storing a key fails loudly rather than silently landing
# in plaintext. Generate one with `openssl rand -base64 32`.
CREDENTIALS_SECRET_KEY = os.getenv("CREDENTIALS_SECRET_KEY", "")

AI_PROVIDERS = ("openai", "anthropic")


def _fernet():
    try:
        from cryptography.fernet import Fernet
    except ImportError:
        raise HTTPException(status_code=503, detail="伺服器缺少 cryptography 套件，請聯絡管理員")
    if not CREDENTIALS_SECRET_KEY:
        raise HTTPException(
            status_code=503,
            detail="伺服器尚未設定 CREDENTIALS_SECRET_KEY，為了避免金鑰以明文存放，暫時無法儲存",
        )
    import base64
    import hashlib
    # Fernet needs exactly 32 urlsafe-base64 bytes; accept any passphrase and
    # fold it down, so the operator can paste whatever `openssl rand` gave them.
    digest = hashlib.sha256(CREDENTIALS_SECRET_KEY.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def _seal(api_key: str) -> str:
    return _fernet().encrypt(api_key.encode("utf-8")).decode("ascii")


def _open(cipher: str) -> str:
    try:
        return _fernet().decrypt(cipher.encode("ascii")).decode("utf-8")
    except HTTPException:
        raise
    except Exception:
        # Wrong/rotated CREDENTIALS_SECRET_KEY, or a corrupted row.
        raise HTTPException(status_code=400,
                            detail="無法解開已儲存的金鑰，請重新設定一次 API 金鑰")


def _key_hint(api_key: str) -> str:
    tail = api_key[-4:] if len(api_key) >= 4 else ""
    return f"…{tail}"


def _load_api_key(username: str, provider: str) -> Optional[str]:
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT key_cipher FROM user_ai_credentials"
                        " WHERE username=%s AND provider=%s", (username, provider))
            row = cur.fetchone()
    return _open(row[0]) if row else None


class AiCredentialRequest(BaseModel):
    api_key: str


@app.get("/api/me/ai-credentials")
def list_ai_credentials(user: dict = Depends(get_current_user)):
    """Which providers this user has connected — hints only, never the keys."""
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT provider, key_hint, updated_at FROM user_ai_credentials"
                        " WHERE username=%s", (user["username"],))
            rows = cur.fetchall()
    have = {r[0]: {"provider": r[0], "hint": r[1],
                   "updatedAt": r[2].isoformat() if r[2] else ""} for r in rows}

    # Whether a provider still works with no key of your own. Anthropic has a
    # server-wide key to fall back on; OpenAI does not, by design — there is no
    # server OpenAI account to spend. The browser cannot see either, and without
    # being told it cannot tell "not connected but works" from "not connected
    # and will fail" — which are the same label and very different outcomes.
    fallback = {"anthropic": bool(os.getenv("ANTHROPIC_API_KEY")), "openai": False}
    return [
        {**have.get(p, {"provider": p, "hint": "", "updatedAt": ""}),
         "serverFallback": fallback.get(p, False)}
        for p in AI_PROVIDERS
    ]


@app.put("/api/me/ai-credentials/{provider}")
def set_ai_credential(provider: str, req: AiCredentialRequest,
                      user: dict = Depends(get_current_user)):
    if provider not in AI_PROVIDERS:
        raise HTTPException(status_code=400, detail="不支援這個 AI 服務")
    key = req.api_key.strip()
    if not key:
        raise HTTPException(status_code=400, detail="API 金鑰不得為空")

    cipher = _seal(key)      # fails before touching the DB if the secret is unset
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO user_ai_credentials (username, provider, key_cipher, key_hint)"
                " VALUES (%s,%s,%s,%s)"
                " ON CONFLICT (username, provider) DO UPDATE"
                " SET key_cipher=EXCLUDED.key_cipher, key_hint=EXCLUDED.key_hint,"
                "     updated_at=NOW()",
                (user["username"], provider, cipher, _key_hint(key)),
            )
    return {"ok": True, "hint": _key_hint(key)}


@app.delete("/api/me/ai-credentials/{provider}")
def delete_ai_credential(provider: str, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM user_ai_credentials WHERE username=%s AND provider=%s",
                        (user["username"], provider))
    return {"ok": True}


# ------------------------------------------------------------------ AI jobs
# Image generation takes long enough (tens of seconds) that hanging the browser
# on one HTTP response is the wrong shape: close the laptop lid, lose a picture
# OpenAI has already charged for. So the *row* owns the result, not the
# response, and the client polls it:
#
#   POST /api/ai-jobs           → creates a 'queued' row, returns its id at once
#   POST /api/ai-jobs/{id}/run  → claims the row and does the work (fire-and-forget)
#   GET  /api/ai-jobs/{id}      → what the browser polls while it spins
#
# What this does NOT do is move the work off the request. There is no worker
# process on serverless, so /run still has to finish inside the function's
# maxDuration — the win is that the browser is no longer coupled to it, a
# dropped connection no longer loses the result, and the user can keep editing
# meanwhile. `updated_at` is what lets a poller call a job dead when its
# invocation was killed mid-flight, instead of spinning forever.

_JOB_KINDS = ("image",)
_IMAGE_SIZES = ("1024x1024", "1024x1536", "1536x1024")
_JOB_STALE_SECONDS = 300
_JOB_COLS = "id, kind, status, result, error, created_at, updated_at"


class AiJobRequest(BaseModel):
    kind:    str = "image"
    club_id: Optional[int] = None
    params:  Dict[str, Any] = {}


def _job_row(r):
    return {
        "id": r[0], "kind": r[1], "status": r[2],
        "result": r[3], "error": r[4],
        "createdAt": r[5].isoformat() if r[5] else "",
        "updatedAt": r[6].isoformat() if r[6] else "",
    }


def _generate_image(username: str, club_id: Optional[int], params: dict) -> dict:
    """One OpenAI image, uploaded to R2. Returns the stored-image shape."""
    prompt = str(params.get("prompt") or "").strip()
    size = params.get("size") or "1024x1024"
    if not prompt:
        raise HTTPException(status_code=400, detail="請先描述想要的圖片內容")
    if size not in _IMAGE_SIZES:
        raise HTTPException(status_code=400, detail="不支援這個圖片尺寸")

    model = next((m["id"] for m in IMAGE_MODELS if m["id"] == params.get("model")),
                 _default_model(IMAGE_MODELS)["id"])
    quality = params.get("quality") if params.get("quality") in IMAGE_QUALITIES \
        else IMAGE_QUALITIES[0]

    api_key = _load_api_key(username, "openai")
    if not api_key:
        raise HTTPException(status_code=400,
                            detail="你還沒有連接 OpenAI 帳號，請先在「AI 帳號」設定金鑰")
    try:
        from openai import OpenAI
    except ImportError:
        raise HTTPException(status_code=503, detail="伺服器缺少 openai 套件，請聯絡管理員")

    try:
        call = {"model": model, "prompt": prompt, "size": size, "n": 1}
        # `auto` is the API's own default; sending it explicitly is the same
        # request, so it is left off rather than risking a model that does not
        # accept the parameter at all.
        if quality != "auto":
            call["quality"] = quality
        result = OpenAI(api_key=api_key).images.generate(**call)
    except Exception as e:
        # Surface OpenAI's own wording — it is what tells the user their key is
        # wrong, their quota is spent, or their org is not verified for this
        # model (a common first-run blocker on gpt-image-1).
        detail = getattr(e, "message", None) or str(e)
        raise HTTPException(status_code=502,
                            detail=f"OpenAI 生圖失敗（{model} / {quality}）：{detail}"[:400])

    item = (result.data or [None])[0]
    if item is None:
        raise HTTPException(status_code=502, detail="OpenAI 沒有回傳圖片")

    import base64
    if getattr(item, "b64_json", None):
        raw = base64.b64decode(item.b64_json)
    elif getattr(item, "url", None):
        import urllib.request
        with urllib.request.urlopen(item.url, timeout=60) as res:
            raw = res.read(16 * 1024 * 1024)
    else:
        raise HTTPException(status_code=502, detail="OpenAI 回傳的圖片格式無法讀取")

    # Straight into R2: Instagram and Threads can only publish an image the
    # platform itself can fetch over HTTP, so a post's images have to live at a
    # public URL anyway, and publishing gets that for free.
    base = f"media/clubs/{club_id}/social" if club_id else "media/social"
    key = f"{base}/{uuid.uuid4()}.png"
    try:
        _r2().put_object(Bucket=R2_BUCKET_NAME, Key=key, Body=raw, ContentType="image/png")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=502, detail="圖片產生成功，但上傳雲端失敗")

    return {"url": f"{R2_PUBLIC_URL}/{key}", "name": "AI 生成圖片", "type": "image"}


_JOB_RUNNERS = {"image": _generate_image}


@app.post("/api/ai-jobs")
def create_ai_job(req: AiJobRequest, user: dict = Depends(require_club_admin_or_above)):
    if req.kind not in _JOB_KINDS:
        raise HTTPException(status_code=400, detail="不支援這種工作")
    cid = _social_scope(user, req.club_id)
    job_id = uuid.uuid4().hex
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO ai_jobs (id, username, club_id, kind, status, params)"
                " VALUES (%s,%s,%s,%s,'queued',%s::jsonb)",
                (job_id, user["username"], cid, req.kind, json.dumps(req.params)),
            )
    return {"id": job_id, "status": "queued"}


@app.post("/api/ai-jobs/{job_id}/run")
def run_ai_job(job_id: str, user: dict = Depends(require_club_admin_or_above)):
    """Claim and execute. Safe to call twice — only the first caller wins."""
    with get_db() as conn:
        with conn.cursor() as cur:
            # Atomic claim: a duplicate fire (double click, a retry) must not
            # buy a second image from OpenAI.
            cur.execute(
                "UPDATE ai_jobs SET status='running', updated_at=NOW()"
                " WHERE id=%s AND username=%s AND status='queued'"
                " RETURNING kind, club_id, params",
                (job_id, user["username"]),
            )
            claimed = cur.fetchone()
            if claimed is None:
                cur.execute(f"SELECT {_JOB_COLS} FROM ai_jobs WHERE id=%s AND username=%s",
                            (job_id, user["username"]))
                row = cur.fetchone()
                if row is None:
                    raise HTTPException(status_code=404, detail="找不到這個工作")
                return _job_row(row)          # already running, or already finished
            kind, club_id, params = claimed[0], claimed[1], parse_jsonb(claimed[2])

    try:
        result = _JOB_RUNNERS[kind](user["username"], club_id, params)
        status, payload, err = "done", json.dumps(result), None
    except HTTPException as e:
        status, payload, err = "error", None, str(e.detail)
    except Exception:
        status, payload, err = "error", None, "產生失敗，請稍後再試"

    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE ai_jobs SET status=%s, result=%s::jsonb, error=%s, updated_at=NOW()"
                " WHERE id=%s",
                (status, payload, err, job_id),
            )
            cur.execute(f"SELECT {_JOB_COLS} FROM ai_jobs WHERE id=%s", (job_id,))
            return _job_row(cur.fetchone())


@app.get("/api/ai-jobs/{job_id}")
def get_ai_job(job_id: str, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(f"SELECT {_JOB_COLS} FROM ai_jobs WHERE id=%s AND username=%s",
                        (job_id, user["username"]))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail="找不到這個工作")

            job = _job_row(row)
            # The invocation doing the work can be killed without ever writing a
            # result. Without this the browser would spin forever.
            if job["status"] == "running" and row[6] is not None:
                age = (datetime.now(timezone.utc) - row[6]).total_seconds()
                if age > _JOB_STALE_SECONDS:
                    cur.execute("UPDATE ai_jobs SET status='error', error=%s,"
                                " updated_at=NOW() WHERE id=%s",
                                ("產生逾時，請再試一次", job_id))
                    job["status"], job["error"] = "error", "產生逾時，請再試一次"
            return job


# ==================================================================
# META (Facebook / Instagram / Threads)
# ==================================================================
# Everything that talks to Meta lives in this one section on purpose: none of
# it can be exercised without a real App, a real review, and real tokens, so
# when it first meets the live API the blast radius should be one file region
# rather than the whole backend. Every failure re-raises Meta's own message
# verbatim — that is what will actually tell you which of the many setup steps
# is missing.
#
# Credentials model, and why it differs from the AI keys:
#   * AI keys are per *user* — a personal account is being billed.
#   * A Page is a *club* asset. The president connects it; the education VP
#     must be able to post to it. So App credentials and access tokens are
#     per club (club_secrets / club_social_accounts).
#
# The App ID / App Secret are per club rather than one global pair because
# App Review is granted per App: a club that registers its own App can post to
# its own Pages in development mode without any review at all, which is the
# only route that does not involve a multi-week approval. A server-wide pair is
# still honoured as a fallback for whoever does get reviewed.

META_GRAPH_VERSION = os.getenv("META_GRAPH_VERSION", "v21.0")
META_GRAPH_HOST    = "https://graph.facebook.com"
THREADS_GRAPH_HOST = "https://graph.threads.net"

# Server-wide fallback App, used only when a club has not registered its own.
META_APP_ID     = os.getenv("META_APP_ID", "")
META_APP_SECRET = os.getenv("META_APP_SECRET", "")

# Threads issues its OWN App ID/Secret under the "Access the Threads API"
# use case. They are different values from the Facebook App's pair, even
# though both live under the same App in the console.
THREADS_APP_ID     = os.getenv("THREADS_APP_ID", "")
THREADS_APP_SECRET = os.getenv("THREADS_APP_SECRET", "")

# What each connection asks Meta for. `pages_manage_posts` and
# `instagram_content_publish` are the two that require App Review before they
# work for anyone who is not a developer/tester on the App.
META_SCOPES = [
    "pages_show_list",
    "pages_read_engagement",
    "pages_manage_posts",
    "instagram_basic",
    "instagram_content_publish",
    "business_management",
]
THREADS_SCOPES = ["threads_basic", "threads_content_publish"]

SOCIAL_ACCOUNT_PLATFORMS = ("facebook", "instagram", "threads")


# ------------------------------------------------------------------ club secrets
def _set_club_secret(club_id: int, name: str, value: str) -> str:
    cipher = _seal(value)          # refuses if CREDENTIALS_SECRET_KEY is unset
    hint = _key_hint(value)
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO club_secrets (club_id, name, value_cipher, hint)"
                " VALUES (%s,%s,%s,%s)"
                " ON CONFLICT (club_id, name) DO UPDATE"
                " SET value_cipher=EXCLUDED.value_cipher, hint=EXCLUDED.hint,"
                "     updated_at=NOW()",
                (club_id, name, cipher, hint),
            )
    return hint


def _get_club_secret(club_id: int, name: str) -> Optional[str]:
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT value_cipher FROM club_secrets"
                        " WHERE club_id=%s AND name=%s", (club_id, name))
            row = cur.fetchone()
    return _open(row[0]) if row else None


def _club_secret_hint(club_id: int, name: str) -> str:
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT hint FROM club_secrets WHERE club_id=%s AND name=%s",
                        (club_id, name))
            row = cur.fetchone()
    return row[0] if row else ""


def _app_pair(club_id: Optional[int], settings_key: str, secret_name: str,
              env_id: str, env_secret: str, label: str) -> tuple:
    """(app_id, app_secret) for this club, falling back to the server-wide pair."""
    app_id = ""
    if club_id is not None:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT settings FROM clubs WHERE id=%s", (club_id,))
                row = cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="找不到此分會")
        app_id = (parse_jsonb(row[0]).get(settings_key) or "").strip()

    secret = _get_club_secret(club_id, secret_name) if club_id is not None else None
    if not app_id or not secret:
        app_id, secret = app_id or env_id, secret or env_secret
    if not app_id or not secret:
        raise HTTPException(
            status_code=400,
            detail=f"這個分會還沒有填 {label} App ID / App Secret，請先到分會設定填寫",
        )
    return app_id, secret


def _meta_app(club_id: Optional[int]) -> tuple:
    return _app_pair(club_id, "meta_app_id", "meta_app_secret",
                     META_APP_ID, META_APP_SECRET, "Meta")


def _threads_app(club_id: Optional[int]) -> tuple:
    """
    The Threads pair, which is NOT the Facebook App's pair.

    Deliberately no fallback to the Meta credentials: sending the Facebook
    App ID to threads.net/oauth/authorize comes back not as "wrong app" but
    as "Authorization Failed: No app ID was sent with the request" — an error
    that sends you hunting for a missing parameter which is in fact present.
    Failing here, naming the field, is the cheaper failure.
    """
    return _app_pair(club_id, "threads_app_id", "threads_app_secret",
                     THREADS_APP_ID, THREADS_APP_SECRET, "Threads")


# ------------------------------------------------------------------ graph calls
def _graph(url: str, params: dict = None, method: str = "GET") -> dict:
    """One Graph API call. Meta's own error text is what comes back on failure."""
    import urllib.error
    import urllib.parse
    import urllib.request

    payload = urllib.parse.urlencode({k: v for k, v in (params or {}).items()
                                      if v is not None})
    if method == "GET":
        req = urllib.request.Request(f"{url}?{payload}" if payload else url)
    else:
        req = urllib.request.Request(url, data=payload.encode("utf-8"), method=method)

    try:
        with urllib.request.urlopen(req, timeout=45) as res:
            return json.loads(res.read(8 * 1024 * 1024).decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            err = (json.loads(e.read().decode("utf-8")).get("error") or {})
            msg = err.get("message") or f"HTTP {e.code}"
            # The code/subcode pair is the searchable half of a Meta error.
            # The prose alone is not enough to act on: "The requested
            # resource does not exist" is returned for several unrelated
            # causes, and without the code there is no way to tell which.
            tags = [str(err[k]) for k in ("code", "error_subcode") if err.get(k)]
            if tags:
                msg = f"{msg} [{'/'.join(tags)}]"
        except Exception:
            msg = f"HTTP {e.code}"
        raise HTTPException(status_code=502, detail=f"Meta 回應錯誤：{msg}"[:400])
    except Exception:
        raise HTTPException(status_code=502, detail="無法連線至 Meta，請稍後再試")


def _fb(path: str, params: dict = None, method: str = "GET") -> dict:
    return _graph(f"{META_GRAPH_HOST}/{META_GRAPH_VERSION}/{path}", params, method)


def _th(path: str, params: dict = None, method: str = "GET") -> dict:
    return _graph(f"{THREADS_GRAPH_HOST}/{path}", params, method)


# ------------------------------------------------------------------ accounts
def _save_social_account(club_id: int, platform: str, account_id: str,
                         account_name: str, token: str, expires_in: Optional[int]):
    expires_at = None
    if expires_in:
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=int(expires_in))
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO club_social_accounts"
                " (club_id, platform, account_id, account_name, token_cipher, expires_at)"
                " VALUES (%s,%s,%s,%s,%s,%s)"
                " ON CONFLICT (club_id, platform) DO UPDATE"
                " SET account_id=EXCLUDED.account_id, account_name=EXCLUDED.account_name,"
                "     token_cipher=EXCLUDED.token_cipher, expires_at=EXCLUDED.expires_at,"
                "     updated_at=NOW()",
                (club_id, platform, account_id, account_name, _seal(token), expires_at),
            )


def _load_social_account(club_id: int, platform: str) -> Optional[dict]:
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT account_id, account_name, token_cipher, expires_at"
                        " FROM club_social_accounts WHERE club_id=%s AND platform=%s",
                        (club_id, platform))
            row = cur.fetchone()
    if row is None:
        return None
    return {"accountId": row[0], "accountName": row[1],
            "token": _open(row[2]), "expiresAt": row[3]}


class ClubSocialConfigRequest(BaseModel):
    meta_app_id:        Optional[str] = None
    meta_app_secret:    Optional[str] = None   # write-only; never returned
    threads_app_id:     Optional[str] = None
    threads_app_secret: Optional[str] = None   # write-only; never returned


@app.get("/api/clubs/{club_id}/social-config")
def get_club_social_config(club_id: int, user: dict = Depends(require_club_admin_or_above)):
    """Setup state for the club settings screen. No secrets, no tokens."""
    _social_scope(user, club_id)
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT settings FROM clubs WHERE id=%s", (club_id,))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail="找不到此分會")
            cur.execute("SELECT platform, account_name, expires_at FROM club_social_accounts"
                        " WHERE club_id=%s", (club_id,))
            accounts = cur.fetchall()

    settings = parse_jsonb(row[0])
    connected = {a[0]: {"platform": a[0], "accountName": a[1],
                        "expiresAt": a[2].isoformat() if a[2] else ""} for a in accounts}
    return {
        "metaAppId": settings.get("meta_app_id") or "",
        "metaAppSecretHint": _club_secret_hint(club_id, "meta_app_secret"),
        "serverFallback": bool(META_APP_ID and META_APP_SECRET),
        "threadsAppId": settings.get("threads_app_id") or "",
        "threadsAppSecretHint": _club_secret_hint(club_id, "threads_app_secret"),
        "threadsServerFallback": bool(THREADS_APP_ID and THREADS_APP_SECRET),
        "accounts": [connected.get(p, {"platform": p, "accountName": "", "expiresAt": ""})
                     for p in SOCIAL_ACCOUNT_PLATFORMS],
    }


@app.put("/api/clubs/{club_id}/social-config")
def set_club_social_config(club_id: int, req: ClubSocialConfigRequest,
                           user: dict = Depends(require_club_admin_or_above)):
    _social_scope(user, club_id)
    updates = {}
    if req.meta_app_id is not None:
        updates["meta_app_id"] = req.meta_app_id.strip()
    if req.threads_app_id is not None:
        updates["threads_app_id"] = req.threads_app_id.strip()
    if updates:
        with get_db() as conn:
            with conn.cursor() as cur:
                # Merge into settings rather than replacing: other keys
                # (roles_sheet_url, template fields) live in the same JSONB.
                cur.execute(
                    "UPDATE clubs SET settings = COALESCE(settings, '{}'::jsonb)"
                    " || %s::jsonb WHERE id=%s",
                    (json.dumps(updates), club_id),
                )
                if cur.rowcount == 0:
                    raise HTTPException(status_code=404, detail="找不到此分會")
    if req.meta_app_secret:
        _set_club_secret(club_id, "meta_app_secret", req.meta_app_secret.strip())
    if req.threads_app_secret:
        _set_club_secret(club_id, "threads_app_secret", req.threads_app_secret.strip())
    return {"ok": True}


@app.delete("/api/clubs/{club_id}/social-accounts/{platform}")
def disconnect_social_account(club_id: int, platform: str,
                              user: dict = Depends(require_club_admin_or_above)):
    _social_scope(user, club_id)
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM club_social_accounts WHERE club_id=%s AND platform=%s",
                        (club_id, platform))
    return {"ok": True}


# ------------------------------------------------------------------ oauth
@app.get("/api/clubs/{club_id}/meta/oauth-url")
def meta_oauth_url(club_id: int, redirect_uri: str = Query(...),
                   provider: str = Query(default="facebook"),
                   user: dict = Depends(require_club_admin_or_above)):
    """
    The URL to send the browser to. `redirect_uri` must match one of the
    App's Valid OAuth Redirect URIs exactly, so the caller supplies it (the
    frontend knows its own origin; the API does not).
    """
    _social_scope(user, club_id)
    app_id, _ = (_threads_app if provider == "threads" else _meta_app)(club_id)
    import urllib.parse

    # `state` carries the club through the round trip so the callback knows
    # which club it is completing, and guards against a stray callback.
    state = f"{club_id}:{uuid.uuid4().hex}"
    if provider == "threads":
        # Threads is a separate authorisation surface from the Facebook Login
        # dialog, with its own host and scopes.
        qs = urllib.parse.urlencode({
            "client_id": app_id, "redirect_uri": redirect_uri,
            "scope": ",".join(THREADS_SCOPES), "response_type": "code", "state": state,
        })
        return {"url": f"https://threads.net/oauth/authorize?{qs}", "state": state}

    qs = urllib.parse.urlencode({
        "client_id": app_id, "redirect_uri": redirect_uri,
        "scope": ",".join(META_SCOPES), "response_type": "code", "state": state,
    })
    return {"url": f"https://www.facebook.com/{META_GRAPH_VERSION}/dialog/oauth?{qs}",
            "state": state}


class MetaConnectRequest(BaseModel):
    code:         str
    redirect_uri: str
    provider:     str = "facebook"


@app.post("/api/clubs/{club_id}/meta/connect")
def meta_connect(club_id: int, req: MetaConnectRequest,
                 user: dict = Depends(require_club_admin_or_above)):
    """
    Finish the OAuth round trip: short-lived code → long-lived token.

    For Facebook this stores nothing yet — it returns the Pages the user
    manages so they can pick one (a person often administers several). Threads
    has no such fan-out, so it connects in one step.
    """
    _social_scope(user, club_id)
    app_id, app_secret = (_threads_app if req.provider == "threads"
                          else _meta_app)(club_id)

    if req.provider == "threads":
        short = _th("oauth/access_token", {
            "client_id": app_id, "client_secret": app_secret,
            "grant_type": "authorization_code",
            "redirect_uri": req.redirect_uri, "code": req.code,
        }, method="POST")
        token = short.get("access_token")
        user_id = str(short.get("user_id") or "")
        if not token:
            raise HTTPException(status_code=502, detail="Threads 沒有回傳 access token")

        # Short-lived tokens last about an hour; exchange for the 60-day one.
        long = _th("access_token", {
            "grant_type": "th_exchange_token",
            "client_secret": app_secret, "access_token": token,
        })
        token = long.get("access_token", token)

        me = _th(f"{user_id}", {"fields": "username", "access_token": token}) if user_id else {}
        _save_social_account(club_id, "threads", user_id,
                             me.get("username", "Threads"), token,
                             long.get("expires_in"))
        return {"connected": ["threads"]}

    short = _fb("oauth/access_token", {
        "client_id": app_id, "client_secret": app_secret,
        "redirect_uri": req.redirect_uri, "code": req.code,
    })
    token = short.get("access_token")
    if not token:
        raise HTTPException(status_code=502, detail="Meta 沒有回傳 access token")

    long = _fb("oauth/access_token", {
        "grant_type": "fb_exchange_token",
        "client_id": app_id, "client_secret": app_secret, "fb_exchange_token": token,
    })
    user_token = long.get("access_token", token)

    # The user token is parked server-side until a Page is chosen. Page tokens
    # are long-lived credentials, so they are fetched at selection time and go
    # straight into the encrypted store — they never travel to the browser.
    _set_club_secret(club_id, "meta_user_token", user_token)

    pages = _fb("me/accounts", {
        "fields": "id,name,instagram_business_account{id,username}",
        "access_token": user_token,
    })
    return {"pages": [
        {
            "id": p.get("id"),
            "name": p.get("name", ""),
            "instagram": (p.get("instagram_business_account") or {}).get("id", ""),
            "instagramName": (p.get("instagram_business_account") or {}).get("username", ""),
        }
        for p in (pages.get("data") or [])
    ]}


class MetaSelectPageRequest(BaseModel):
    page_id: str


@app.post("/api/clubs/{club_id}/meta/select-page")
def meta_select_page(club_id: int, req: MetaSelectPageRequest,
                     user: dict = Depends(require_club_admin_or_above)):
    """
    Commit the chosen Page (and its linked Instagram account, if any).

    Only the Page *id* comes from the browser. The token is fetched here with
    the user token parked during /meta/connect, so a long-lived Page credential
    never leaves the server — and a caller cannot smuggle in a token for a Page
    they do not actually administer.
    """
    _social_scope(user, club_id)
    if not req.page_id:
        raise HTTPException(status_code=400, detail="缺少粉專資訊")

    user_token = _get_club_secret(club_id, "meta_user_token")
    if not user_token:
        raise HTTPException(status_code=400, detail="授權已失效，請重新連接一次")

    page = _fb(req.page_id, {
        "fields": "id,name,access_token,instagram_business_account{id,username}",
        "access_token": user_token,
    })
    page_token = page.get("access_token")
    if not page_token:
        raise HTTPException(status_code=403, detail="你沒有這個粉專的管理權限")

    # Page tokens derived from a long-lived user token do not themselves
    # expire, so no expires_in is recorded here.
    _save_social_account(club_id, "facebook", page["id"], page.get("name", ""),
                         page_token, None)
    connected = ["facebook"]

    ig = page.get("instagram_business_account") or {}
    if ig.get("id"):
        # Instagram publishing is authorised by the *Page* token.
        _save_social_account(club_id, "instagram", ig["id"],
                             ig.get("username") or "Instagram", page_token, None)
        connected.append("instagram")
    return {"connected": connected}


# ------------------------------------------------------------------ publishing
# Three different shapes for "post this":
#   Facebook  — /feed for text, /photos for one image, unpublished photo ids
#               stitched onto /feed for several, /videos for a video. A Page
#               post is a video OR photos, never both.
#   Instagram — always two steps (create a container, then publish it), and it
#               refuses to post without media. Several items means a carousel:
#               a container per child, then a CAROUSEL parent. A lone video is
#               a REELS container, not a VIDEO one.
#   Threads   — same two-step container/publish idea as Instagram, on its own
#               host, but text-only is allowed. Carousels take the same shape
#               as Instagram's.
#
# All three take the file as a URL Meta fetches for itself; none of them accept
# bytes. That is why generated and uploaded files go to R2 first.
#
# Videos add a wait that images do not have: the container is accepted
# immediately but is not publishable until Meta finishes transcoding it.

# The JSONB column is still called `images` although it now holds videos too.
# Renaming it would cost a migration and buy nothing that the per-item `type`
# does not already say; `_media_kind` is the single place that decides.
_VIDEO_EXTS = (".mp4", ".mov", ".m4v", ".webm")

# How long a publish job may spend waiting for Meta to transcode. This is a
# budget for the WHOLE job, not per platform: three platforms each waiting
# their own full share would run past vercel.json's maxDuration and be killed
# mid-flight, losing the record of what had already gone out. Set below that
# ceiling on purpose, so running out produces our own message instead.
_MEDIA_READY_BUDGET  = 40      # seconds
_MEDIA_POLL_INTERVAL = 3


def _media_kind(item) -> str:
    """'image' or 'video' for one attachment."""
    url = ""
    if isinstance(item, dict):
        if item.get("type") in ("image", "video"):
            return item["type"]          # what the uploader recorded
        url = item.get("url") or ""
    else:
        url = item or ""
    # Rows written before uploads recorded a type, and AI images, have none.
    return "video" if url.split("?", 1)[0].lower().endswith(_VIDEO_EXTS) else "image"


def _media_list(raw) -> list:
    return [{"url": i["url"], "kind": _media_kind(i)}
            for i in (raw or []) if isinstance(i, dict) and i.get("url")]


def _await_ready(read_state, container_id: str, what: str, deadline: float):
    """
    Block until Meta has finished processing a container.

    Called before every publish, and for every carousel child. Nothing Meta
    hands back is publishable the instant it is created — not videos, not
    images, not the CAROUSEL parent — and the errors for acting too early name
    neither the container nor the reason.
    """
    while True:
        state, err = read_state(container_id)
        if state in ("FINISHED", "PUBLISHED"):
            return
        if state in ("ERROR", "EXPIRED"):
            raise HTTPException(status_code=502,
                                detail=f"{what} 影片處理失敗：{err or state}")
        if time.monotonic() >= deadline:
            raise HTTPException(
                status_code=504,
                detail=f"{what} 的影片還在轉檔，等了 {_MEDIA_READY_BUDGET} 秒仍未完成。"
                       "影片較長時這是正常的，稍後重發一次即可——這則並未發布，"
                       "不會變成兩則。")
        time.sleep(_MEDIA_POLL_INTERVAL)


def _ig_state(token: str):
    def read(cid):
        r = _fb(cid, {"fields": "status_code,status", "access_token": token})
        return r.get("status_code") or "", r.get("status") or ""
    return read


def _th_state(token: str):
    def read(cid):
        r = _th(cid, {"fields": "status,error_message", "access_token": token})
        return r.get("status") or "", r.get("error_message") or ""
    return read


def _require_account(club_id: int, platform: str) -> dict:
    account = _load_social_account(club_id, platform)
    if account is None:
        raise HTTPException(status_code=400,
                            detail=f"這個分會還沒有連接 {platform}，請先到分會設定完成授權")
    if account["expiresAt"] and account["expiresAt"] < datetime.now(timezone.utc):
        raise HTTPException(status_code=400,
                            detail=f"{platform} 的授權已過期，請重新連接")
    return account


def _publish_facebook(account: dict, text: str, media: list, deadline: float) -> dict:
    page, token = account["accountId"], account["token"]
    videos = [m["url"] for m in media if m["kind"] == "video"]
    photos = [m["url"] for m in media if m["kind"] == "image"]

    if videos:
        # A Page post is a video or photos, never both, and /videos takes one
        # file. Splitting into two posts changes what gets published, so it is
        # the writer's call — refuse rather than silently drop the rest.
        if len(videos) > 1 or photos:
            raise HTTPException(
                status_code=400,
                detail="Facebook 一則貼文只能放一支影片，且不能同時放圖片，請分成兩則發布")
        # Facebook transcodes after accepting, and the post appears when it is
        # done. Nothing to wait for here, unlike Instagram and Threads.
        res = _fb(f"{page}/videos",
                  {"file_url": videos[0], "description": text, "access_token": token},
                  method="POST")
    elif not photos:
        res = _fb(f"{page}/feed", {"message": text, "access_token": token}, method="POST")
    elif len(photos) == 1:
        res = _fb(f"{page}/photos",
                  {"url": photos[0], "caption": text, "access_token": token}, method="POST")
    else:
        # Upload each photo unpublished, then attach them all to one feed post.
        media_ids = [
            _fb(f"{page}/photos",
                {"url": url, "published": "false", "access_token": token},
                method="POST").get("id")
            for url in photos
        ]
        params = {"message": text, "access_token": token}
        for i, mid in enumerate(m for m in media_ids if m):
            params[f"attached_media[{i}]"] = json.dumps({"media_fbid": mid})
        res = _fb(f"{page}/feed", params, method="POST")

    post_id = res.get("post_id") or res.get("id") or ""
    return {"id": post_id,
            "url": f"https://www.facebook.com/{post_id}" if post_id else ""}


# Carousel sizes the platforms enforce themselves. Checked here so the message
# names the limit instead of relaying a Meta error about `children`.
_IG_CAROUSEL_MAX = 10
_TH_CAROUSEL_MAX = 20


def _publish_instagram(account: dict, text: str, media: list, deadline: float) -> dict:
    ig, token = account["accountId"], account["token"]
    if not media:
        raise HTTPException(status_code=400, detail="Instagram 貼文一定要有圖片或影片")
    if len(media) > _IG_CAROUSEL_MAX:
        raise HTTPException(status_code=400,
                            detail=f"Instagram 輪播最多 {_IG_CAROUSEL_MAX} 個項目")
    wait = _ig_state(token)

    if len(media) == 1:
        one = media[0]
        if one["kind"] == "video":
            # A single video is a Reel. Instagram has no one-video feed post
            # any more — asking for VIDEO here gets it filed as a Reel anyway.
            container = _fb(f"{ig}/media", {
                "media_type": "REELS", "video_url": one["url"],
                "caption": text, "access_token": token}, method="POST")
        else:
            container = _fb(f"{ig}/media", {
                "image_url": one["url"], "caption": text,
                "access_token": token}, method="POST")
    else:
        children = []
        for m in media:
            child = {"is_carousel_item": "true", "access_token": token}
            if m["kind"] == "video":
                child.update({"media_type": "VIDEO", "video_url": m["url"]})
            else:
                child["image_url"] = m["url"]
            cid = _fb(f"{ig}/media", child, method="POST").get("id")
            if not cid:
                raise HTTPException(status_code=502, detail="Instagram 沒有建立輪播項目")
            children.append((cid, m["kind"]))
        # Every child, not only the videos. A freshly created child id is not
        # usable by the parent straight away — see the note in _publish_threads.
        for cid, _kind in children:
            _await_ready(wait, cid, "Instagram", deadline)
        container = _fb(f"{ig}/media", {
            "media_type": "CAROUSEL",
            "children": ",".join(c for c, _ in children),
            "caption": text, "access_token": token,
        }, method="POST")

    creation_id = container.get("id")
    if not creation_id:
        raise HTTPException(status_code=502, detail="Instagram 沒有建立貼文容器")
    _await_ready(wait, creation_id, "Instagram", deadline)

    res = _fb(f"{ig}/media_publish",
              {"creation_id": creation_id, "access_token": token}, method="POST")
    media_id = res.get("id", "")
    permalink = ""
    if media_id:
        # Cosmetic only, and the post is already public — see the same guard
        # in _publish_threads for why this must not raise.
        try:
            permalink = _fb(media_id, {"fields": "permalink",
                                       "access_token": token}).get("permalink", "")
        except HTTPException:
            permalink = ""
    return {"id": media_id, "url": permalink}


def _publish_threads(account: dict, text: str, media: list, deadline: float) -> dict:
    th, token = account["accountId"], account["token"]
    if len(media) > _TH_CAROUSEL_MAX:
        raise HTTPException(status_code=400,
                            detail=f"Threads 輪播最多 {_TH_CAROUSEL_MAX} 個項目")
    wait = _th_state(token)

    def step(label, *args, **kwargs):
        """Publishing is several calls; the error must say which one broke."""
        try:
            return _th(*args, **kwargs)
        except HTTPException as e:
            raise HTTPException(status_code=e.status_code,
                                detail=f"{label}：{e.detail}")

    def item(m, carousel):
        p = {"access_token": token}
        if carousel:
            p["is_carousel_item"] = "true"
        else:
            p["text"] = text
        if m["kind"] == "video":
            p.update({"media_type": "VIDEO", "video_url": m["url"]})
        else:
            p.update({"media_type": "IMAGE", "image_url": m["url"]})
        return p

    if not media:
        container = step("建立貼文容器", f"{th}/threads",
                         {"media_type": "TEXT", "text": text, "access_token": token},
                         method="POST")
    elif len(media) == 1:
        container = step("建立貼文容器", f"{th}/threads",
                         item(media[0], carousel=False), method="POST")
    else:
        children = []
        for m in media:
            cid = step("建立輪播項目", f"{th}/threads",
                       item(m, carousel=True), method="POST").get("id")
            if not cid:
                raise HTTPException(status_code=502, detail="Threads 沒有建立輪播項目")
            children.append((cid, m["kind"]))
        # Every child, not only the videos. An image child is NOT ready the
        # moment it is created — one was observed reporting IN_PROGRESS on the
        # first read and FINISHED on the next — and handing the parent a child
        # that is not yet FINISHED fails as "Invalid parameter [100/4279004]",
        # which names neither the child nor the reason.
        for cid, _kind in children:
            _await_ready(wait, cid, "Threads", deadline)
        container = step("建立輪播容器", f"{th}/threads", {
            "media_type": "CAROUSEL",
            "children": ",".join(c for c, _ in children),
            "text": text, "access_token": token,
        }, method="POST")

    creation_id = container.get("id")
    if not creation_id:
        raise HTTPException(status_code=502, detail="Threads 沒有建立貼文容器")
    # Unconditionally, not just for video. A CAROUSEL parent reports
    # IN_PROGRESS the moment it is created and FINISHED about two seconds
    # later; publishing it in between fails as "The requested resource does
    # not exist [24/4279009]". A text container is ready at once, so the extra
    # read costs one round trip and removes a whole class of this bug.
    _await_ready(wait, creation_id, "Threads", deadline)

    res = step("發布容器", f"{th}/threads_publish",
               {"creation_id": creation_id, "access_token": token}, method="POST")
    post_id = res.get("id", "")
    permalink = ""
    if post_id:
        # Cosmetic: the post is already public by now. Letting a failed
        # permalink lookup raise would report a successful post as failed
        # and invite the user to publish it a second time.
        try:
            permalink = _th(post_id, {"fields": "permalink",
                                      "access_token": token}).get("permalink", "")
        except HTTPException:
            permalink = ""
    return {"id": post_id, "url": permalink}

_PUBLISHERS = {
    "facebook":  _publish_facebook,
    "instagram": _publish_instagram,
    "threads":   _publish_threads,
}


def _run_publish_job(username: str, club_id: Optional[int], params: dict) -> dict:
    """
    Publish one post to the platforms named in `params`.

    Runs as an ai_jobs job because it is several sequential Graph calls per
    platform — the browser polls it exactly like image generation does.
    Per-platform outcomes are collected rather than aborting the whole run:
    Instagram failing is no reason to un-post Facebook.
    """
    post_id   = params.get("post_id")
    platforms = [p for p in (params.get("platforms") or []) if p in _PUBLISHERS]
    if not post_id or not platforms:
        raise HTTPException(status_code=400, detail="沒有指定要發布的貼文或平台")

    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT club_id, body, variants, images, published"
                        " FROM social_posts WHERE id=%s", (post_id,))
            row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="找不到這則貼文")

    # The job was authorised against `club_id`, but `post_id` arrived in the
    # job's params and has been trusted by nothing so far. Without this a club
    # admin could aim a job at another club's post and publish it with that
    # club's tokens. `club_id is None` only happens for a system_admin who did
    # not pick a club.
    if club_id is not None and row[0] != club_id:
        raise HTTPException(status_code=403, detail="無權發布其他分會的貼文")

    club     = row[0]
    variants = row[2] or {}
    media    = _media_list(row[3])
    published = dict(row[4] or {})

    # One transcoding budget for the whole job. Per-platform budgets would add
    # up past the function's maxDuration and get the invocation killed, which
    # loses the record of whatever had already gone out.
    deadline = time.monotonic() + _MEDIA_READY_BUDGET

    results = {}
    for platform in platforms:
        variant = variants.get(platform) or {}
        text = (variant.get("text") or row[1] or "").strip()
        try:
            if not text:
                raise HTTPException(status_code=400, detail="文案是空的")
            account = _require_account(club, platform)
            out = _PUBLISHERS[platform](account, text, media, deadline)
            out["at"] = datetime.now(timezone.utc).isoformat()
            results[platform] = {"ok": True, **out}
            published[platform] = out
        except HTTPException as e:
            results[platform] = {"ok": False, "error": str(e.detail)}
        except Exception:
            results[platform] = {"ok": False, "error": "發布失敗，請稍後再試"}

    any_ok = any(r.get("ok") for r in results.values())
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE social_posts SET published=%s::jsonb,"
                " status=CASE WHEN %s THEN 'posted' ELSE status END, updated_at=NOW()"
                " WHERE id=%s",
                (json.dumps(published), any_ok, post_id),
            )
    return {"results": results}


# Registered here rather than at the dict's definition so the whole Meta
# surface stays in one place.
_JOB_KINDS = _JOB_KINDS + ("publish",)
_JOB_RUNNERS["publish"] = _run_publish_job

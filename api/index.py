import json
import os
import re
import uuid
import bcrypt
import jwt
import psycopg2
import psycopg2.errors
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


class PresignRequest(BaseModel):
    filename: str
    content_type: str
    meeting_date: Optional[str] = None
    meeting_no: Optional[str] = None


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
    date:    str = None,
    page:    int = 1,
    limit:   int = 10,
    club_id: Optional[int] = Query(default=None),
    user:    dict = Depends(get_current_user),
):
    import math
    offset = (page - 1) * limit
    with get_db() as conn:
        with conn.cursor() as cur:
            where  = "WHERE 1=1"
            params: list = []
            if date:
                where += " AND meeting_date = %s"
                params.append(date)
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
            cur.execute(
                f"SELECT id, data, updated_at FROM agendas {where}"
                f" ORDER BY updated_at DESC LIMIT %s OFFSET %s",
                params + [limit, offset],
            )
            rows = cur.fetchall()
    items = []
    for r in rows:
        d = parse_jsonb(r[1])
        items.append({
            "id":           r[0],
            "meetingDate":  d.get("meetingDate", ""),
            "meetingNo":    d.get("meetingNo", ""),
            "meetingTheme": d.get("meetingTheme", ""),
            "updatedAt":    r[2].isoformat() if r[2] else "",
        })
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
@app.get("/api/clubs")
def list_clubs():
    """Public endpoint — club names are not sensitive and are needed on the register form."""
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id, name FROM clubs ORDER BY id")
            rows = cur.fetchall()
    return [{"id": r[0], "name": r[1]} for r in rows]


@app.post("/api/clubs")
def create_club(req: ClubRequest, user: dict = Depends(require_system_admin)):
    if not req.name.strip():
        raise HTTPException(status_code=400, detail="分會名稱不得為空")
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("INSERT INTO clubs (name) VALUES (%s) RETURNING id", (req.name.strip(),))
                new_id = cur.fetchone()[0]
    except psycopg2.errors.UniqueViolation:
        raise HTTPException(status_code=400, detail="分會名稱已存在")
    return {"id": new_id}


@app.put("/api/clubs/{club_id}")
def update_club(club_id: int, req: ClubRequest, user: dict = Depends(require_system_admin)):
    if not req.name.strip():
        raise HTTPException(status_code=400, detail="分會名稱不得為空")
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("UPDATE clubs SET name=%s WHERE id=%s", (req.name.strip(), club_id))
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
    if req.meeting_date and req.meeting_no:
        key = f"media/{req.meeting_date}_No{req.meeting_no}_{ts}.{ext}"
    elif req.meeting_date:
        key = f"media/{req.meeting_date}_{ts}.{ext}"
    else:
        key = f"media/{ts}_{uuid.uuid4()}.{ext}"
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


# ------------------------------------------------------------------ local dev static serving
if not os.getenv("VERCEL"):
    import pathlib
    from fastapi.staticfiles import StaticFiles
    from fastapi.responses import FileResponse as _FileResponse

    _root = pathlib.Path(__file__).parent.parent

    @app.get("/login")
    def page_login(): return _FileResponse(_root / "login.html")

    @app.get("/home")
    def page_home(): return _FileResponse(_root / "home.html")

    @app.get("/index")
    def page_index_html(): return _FileResponse(_root / "index.html")

    @app.get("/member")
    def page_member(): return _FileResponse(_root / "member.html")

    @app.get("/club")
    def page_club(): return _FileResponse(_root / "club.html")

    @app.get("/admin")
    def page_admin(): return _FileResponse(_root / "admin.html")

    @app.get("/change-password")
    def page_change_password(): return _FileResponse(_root / "change-password.html")

    app.mount("/", StaticFiles(directory=str(_root)), name="static")

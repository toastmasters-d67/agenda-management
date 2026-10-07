import hmac
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
from fastapi import FastAPI, HTTPException, Depends, Query, Request
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


# Threaded: on a long-running uvicorn, sync endpoints run concurrently in
# FastAPI's threadpool, and SimpleConnectionPool is not thread-safe.
_pool: Optional[psycopg2.pool.ThreadedConnectionPool] = None
_DB_POOL_MAX = int(os.getenv("DB_POOL_MAX", "10"))


def _get_pool() -> psycopg2.pool.ThreadedConnectionPool:
    global _pool
    if _pool is None or _pool.closed:
        _pool = psycopg2.pool.ThreadedConnectionPool(1, _DB_POOL_MAX, DATABASE_URL)
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
    email: Optional[str] = None   # "" clears it


class BulkMemberItem(BaseModel):
    name_zh: str
    name_en: str
    level: str = "TM"


class BulkMemberRequest(BaseModel):
    members: List[BulkMemberItem]
    club_id: Optional[int] = None
    default_password: str = "Toastmasters1"


class ChangePasswordRequest(BaseModel):
    old_password: str = ""      # not needed when the account has no password yet
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
def _check_password(password: str, password_hash: str) -> bool:
    """
    An empty hash means the account has no password (created through Microsoft
    sign-up) — nothing matches it. bcrypt would raise on it rather than say no.
    """
    if not password_hash:
        return False
    return bcrypt.checkpw(password.encode(), password_hash.encode())


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


# ------------------------------------------------------------------ club memberships
# A member can belong to several clubs, with a role in each (club_memberships).
# A request acts in ONE of them — the "current club", picked with the club
# switcher (web: the `active_club` cookie, forwarded by /svc as X-Active-Club;
# MCP: switch_club) — and `user["club_id"]` / `user["role"]` are that club and
# the role there. So every permission check written against "the user's club
# and role" keeps working unchanged, and simply applies to the current club.
#
# `users.club_id` / `users.role` hold the PRIMARY club and the role there: the
# club a session starts in. _ensure_membership() and _sync_primary() keep the
# two tables in step; nothing else writes club_memberships.

ACTIVE_CLUB_HEADER = "x-active-club"


def _memberships(cur, username: str) -> dict:
    """{club_id: role} for every club the user belongs to, in club-id order."""
    cur.execute("SELECT club_id, role FROM club_memberships WHERE username=%s ORDER BY club_id",
                (username,))
    return dict(cur.fetchall())


def _acting_as(role: str, primary: Optional[int], ms: dict, wanted) -> tuple:
    """
    (role, club_id) a request acts as. A system_admin is a system_admin
    everywhere; anyone else gets the wanted club only if they belong to it —
    the header is a preference, never a grant — else their primary club.
    """
    if role == "system_admin":
        return role, primary
    try:
        wanted = int(wanted) if wanted not in (None, "") else None
    except (TypeError, ValueError):
        wanted = None
    for cid in (wanted, primary):
        if cid in ms:
            return ms[cid], cid
    if ms:
        cid = next(iter(ms))
        return ms[cid], cid
    return role, primary


def _ensure_membership(cur, username: str):
    """
    Mirror users.club_id / users.role into club_memberships. Called after
    anything that sets them (registration, creation, approval, a system
    admin's edit), so the primary club is always also a membership.
    """
    cur.execute("SELECT role, club_id FROM users WHERE username=%s", (username,))
    row = cur.fetchone()
    if not row or row[1] is None:
        return
    role, cid = row
    if role == "system_admin":
        # Their power is global; the row only places them on the club roster.
        cur.execute("INSERT INTO club_memberships (username, club_id, role)"
                    " VALUES (%s, %s, 'club_admin') ON CONFLICT DO NOTHING", (username, cid))
    else:
        cur.execute("INSERT INTO club_memberships (username, club_id, role) VALUES (%s, %s, %s)"
                    " ON CONFLICT (username, club_id) DO UPDATE SET role = EXCLUDED.role",
                    (username, cid, role if role in ("club_admin", "club_member") else "club_member"))


def _sync_primary(cur, username: str):
    """
    After memberships change: keep users.club_id on a club they still belong
    to (else their first one, else none), and users.role on their role there.
    """
    cur.execute("SELECT role, club_id FROM users WHERE username=%s", (username,))
    row = cur.fetchone()
    if not row:
        return
    role, primary = row
    ms = _memberships(cur, username)
    if primary not in ms:
        primary = next(iter(ms), None)
    if role != "system_admin":
        role = ms.get(primary, "club_member")
    cur.execute("UPDATE users SET club_id=%s, role=%s WHERE username=%s", (primary, role, username))


# ------------------------------------------------------------------ permission dependencies
def get_current_user(request: Request,
                     credentials: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    """Decode the token; resolve the club this request acts in, and the role there."""
    username = decode_token(credentials.credentials)
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT username, role, club_id, must_change_pw, status FROM users WHERE username = %s",
                (username,),
            )
            row = cur.fetchone()
            ms = _memberships(cur, username) if row else {}
    if not row:
        raise HTTPException(status_code=401, detail="使用者不存在")
    if row[4] == "pending":
        raise HTTPException(status_code=403, detail="帳號尚待審核，請聯絡管理員")
    role, club_id = _acting_as(row[1], row[2], ms, request.headers.get(ACTIVE_CLUB_HEADER))
    return {"username": row[0], "role": role, "club_id": club_id, "must_change_pw": row[3],
            "memberships": ms}


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
    if not row or not _check_password(req.password, row[0]):
        raise HTTPException(status_code=401, detail="帳號或密碼錯誤")
    if row[4] == "pending":
        raise HTTPException(status_code=403, detail="帳號尚待審核，請等待管理員批准後再登入")
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
    # The club is optional: it routes the request to that club's admins, and a
    # club-less request goes to system admins (who assign club + role on
    # approval). A fresh deployment has no clubs yet, so it cannot be required.
    password_hash = bcrypt.hashpw(req.password.encode(), bcrypt.gensalt()).decode()
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                _check_register_club(cur, req.club_id)
                cur.execute(
                    "INSERT INTO users (username, password_hash, name_en, name_zh, role, club_id, status)"
                    " VALUES (%s, %s, %s, %s, 'club_member', %s, 'pending')",
                    (req.username, password_hash,
                     req.name_en.strip(), req.name_zh.strip(),
                     req.club_id),
                )
                _ensure_membership(cur, req.username)
    except psycopg2.errors.UniqueViolation:
        raise HTTPException(status_code=400, detail="帳號已存在")
    return {
        "ok":      True,
        "pending": True,
        "message": _pending_message(req.club_id),
    }


def _check_register_club(cur, club_id: Optional[int]) -> None:
    if club_id is None:
        return
    cur.execute("SELECT 1 FROM clubs WHERE id=%s", (club_id,))
    if not cur.fetchone():
        raise HTTPException(status_code=400, detail="找不到這個分會，請重新選擇")


def _pending_message(club_id: Optional[int]) -> str:
    approver = "分會管理員" if club_id else "系統管理員"
    return f"帳號已提交審核，請等待{approver}批准後再登入"


@app.get("/api/auth/verify")
def verify(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT password_hash <> '' FROM users WHERE username=%s",
                        (user["username"],))
            has_password = cur.fetchone()[0]
            cur.execute("SELECT id, name FROM clubs WHERE id = ANY(%s)",
                        (list(user["memberships"]),))
            names = dict(cur.fetchall())
    return {
        "username":       user["username"],
        # role / club_id are for the CURRENT club (see _acting_as).
        "role":           user["role"],
        "club_id":        user["club_id"],
        "must_change_pw": user["must_change_pw"],
        "has_password":   has_password,
        # Every club the user belongs to, for the club switcher.
        "memberships":    [{"clubId": cid, "clubName": names.get(cid, ""), "role": r}
                           for cid, r in user["memberships"].items()],
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
    # An account created through Microsoft has no password to confirm; this is
    # how it gets its first one (it is already authenticated by the token).
    if not row or (row[0] and not _check_password(req.old_password, row[0])):
        raise HTTPException(status_code=400, detail="目前密碼錯誤")
    new_hash = bcrypt.hashpw(req.new_password.encode(), bcrypt.gensalt()).decode()
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE users SET password_hash=%s, must_change_pw=false WHERE username=%s",
                (new_hash, user["username"]),
            )
    return {"ok": True}


# ------------------------------------------------------------------ sign in with Microsoft
# OpenID Connect against the multi-tenant `common` endpoint, so any Microsoft
# account works — work/school or personal. The browser side (state, PKCE
# verifier, nonce, the cookie that holds them) lives in the Next.js routes
# under app/svc/auth/microsoft/; this half exchanges the code with the client
# secret, validates the id_token, and decides which account it is.
#
# How an id_token becomes an account, in order:
#   1. users.ms_sub matches        → that account. The only rule after the first time.
#   2. a VERIFIED email matches an
#      account not yet bound       → bind it (ms_sub), then as 1.
#   3. nothing matches             → a sign-up ticket: the user picks a club and
#                                    a pending account is created for approval.
#
# "Verified" is the whole security argument for 2. With `common`, anyone can
# create their own tenant and put any address on a user in it, and the email
# claim will carry it — the "nOAuth" account-takeover pattern. So an address is
# trusted only when Microsoft vouches for it: a personal Microsoft account
# (whose email Microsoft itself verified), or a work account whose tenant has
# proven it owns the address's domain (the `xms_edov` claim, which has to be
# enabled as an optional claim on the app registration). Anything else can
# still sign in, but only into an account it was explicitly linked to from
# the settings page while signed in with a password.

MS_CLIENT_ID     = os.getenv("MS_CLIENT_ID", "")
MS_CLIENT_SECRET = os.getenv("MS_CLIENT_SECRET", "")
MS_AUTHORITY     = "https://login.microsoftonline.com/common"
MS_SCOPE         = "openid profile email"
MS_SIGNUP_TTL    = timedelta(minutes=30)
# The tenant every personal Microsoft account (outlook.com, hotmail.com…) signs
# in through. Its email claims are verified by Microsoft.
MS_CONSUMER_TID  = "9188040d-6c67-4c5b-b112-36a304b66dad"

_ms_jwks_client = None


def _ms_enabled() -> bool:
    return bool(MS_CLIENT_ID and MS_CLIENT_SECRET)


def _ms_signing_key(id_token: str):
    global _ms_jwks_client
    if _ms_jwks_client is None:
        _ms_jwks_client = jwt.PyJWKClient(f"{MS_AUTHORITY}/discovery/v2.0/keys",
                                          cache_keys=True)
    return _ms_jwks_client.get_signing_key_from_jwt(id_token).key


def _ms_verify_id_token(id_token: str, nonce: str) -> dict:
    try:
        claims = jwt.decode(id_token, _ms_signing_key(id_token), algorithms=["RS256"],
                            audience=MS_CLIENT_ID, options={"require": ["exp", "iat", "sub"]})
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=400, detail="Microsoft 回傳的身分驗證無效")
    # `common` signs for every tenant, so the issuer cannot be a fixed string;
    # it must name the very tenant the token says it is from.
    tid = claims.get("tid") or ""
    if claims.get("iss") != f"https://login.microsoftonline.com/{tid}/v2.0":
        raise HTTPException(status_code=400, detail="Microsoft 身分驗證的簽發者不符")
    if not nonce or not hmac.compare_digest(str(claims.get("nonce") or ""), nonce):
        raise HTTPException(status_code=400, detail="登入流程已失效，請重新登入")
    return claims


def _ms_exchange_code(code: str, code_verifier: str, redirect_uri: str, nonce: str) -> dict:
    """Code → validated id_token claims."""
    import urllib.error
    import urllib.parse
    import urllib.request
    data = urllib.parse.urlencode({
        "client_id": MS_CLIENT_ID, "client_secret": MS_CLIENT_SECRET,
        "grant_type": "authorization_code", "code": code,
        "redirect_uri": redirect_uri, "code_verifier": code_verifier, "scope": MS_SCOPE,
    }).encode()
    req = urllib.request.Request(f"{MS_AUTHORITY}/oauth2/v2.0/token", data=data,
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            body = json.loads(res.read())
    except urllib.error.HTTPError as e:
        try:
            desc = json.loads(e.read()).get("error_description", "")
        except Exception:
            desc = ""
        # Keep the AADSTS code and sentence; drop the trace / correlation ids.
        desc = desc.splitlines()[0].split(" Trace ID")[0] if desc else ""
        raise HTTPException(status_code=400,
                            detail="Microsoft 登入失敗" + (f"：{desc}" if desc else ""))
    except Exception:
        raise HTTPException(status_code=502, detail="無法連線到 Microsoft")
    if not body.get("id_token"):
        raise HTTPException(status_code=400, detail="Microsoft 沒有回傳身分資訊")
    return _ms_verify_id_token(body["id_token"], nonce)


def _ms_email_verified(claims: dict) -> Optional[str]:
    """The claim's email if Microsoft vouches for it, else None. See the note above."""
    email = (claims.get("email") or "").strip().lower()
    if not email or not _EMAIL_RE.match(email):
        return None
    if claims.get("tid") == MS_CONSUMER_TID:
        return email
    if claims.get("xms_edov") in (True, 1, "1", "true", "True"):
        return email
    return None


def _login_payload(username: str) -> dict:
    """The same body POST /api/auth/login returns."""
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT role, club_id, must_change_pw FROM users WHERE username=%s",
                        (username,))
            row = cur.fetchone()
    return {"result": "login", "token": make_token(username), "username": username,
            "role": row[0], "club_id": row[1], "must_change_pw": row[2]}


@app.get("/api/auth/microsoft/config")
def ms_config():
    """Whether the login page should offer the Microsoft button."""
    return {"enabled": _ms_enabled()}


@app.get("/api/auth/microsoft/authorize-url")
def ms_authorize_url(redirect_uri: str = Query(...), state: str = Query(...),
                     nonce: str = Query(...), code_challenge: str = Query(...)):
    """
    Built here so the client id lives in one place (this server's env). The
    Next.js route generated state / nonce / verifier and keeps them in a cookie.
    Microsoft itself checks redirect_uri against the app registration.
    """
    import urllib.parse
    if not _ms_enabled():
        raise HTTPException(status_code=503, detail="伺服器尚未設定 Microsoft 登入")
    q = urllib.parse.urlencode({
        "client_id": MS_CLIENT_ID, "response_type": "code", "response_mode": "query",
        "redirect_uri": redirect_uri, "scope": MS_SCOPE, "state": state, "nonce": nonce,
        "code_challenge": code_challenge, "code_challenge_method": "S256",
        "prompt": "select_account",
    })
    return {"url": f"{MS_AUTHORITY}/oauth2/v2.0/authorize?{q}"}


class MsCallbackRequest(BaseModel):
    code:          str
    code_verifier: str
    nonce:         str
    redirect_uri:  str
    mode:          str = "login"     # "login" | "link"


@app.post("/api/auth/microsoft/callback")
def ms_callback(req: MsCallbackRequest, request: Request):
    """
    Returns one of:
      {"result": "login", "token", ...}  — signed in (same shape as /api/auth/login)
      {"result": "pending"}              — account exists but awaits approval
      {"result": "signup", "ticket", "name", "email"}  — no account yet
      {"result": "linked"}               — mode=link: bound to the signed-in user
    """
    if not _ms_enabled():
        raise HTTPException(status_code=503, detail="伺服器尚未設定 Microsoft 登入")
    claims = _ms_exchange_code(req.code, req.code_verifier, req.redirect_uri, req.nonce)
    sub = claims["sub"]
    email = _ms_email_verified(claims)

    if req.mode == "link":
        # Explicit linking from the settings page, by someone already signed in
        # — the path for a Microsoft account whose email cannot be verified, or
        # that differs from the one on file.
        auth = request.headers.get("authorization") or ""
        if not auth.lower().startswith("bearer "):
            raise HTTPException(status_code=401, detail="請先登入再連結 Microsoft 帳號")
        username = decode_token(auth[7:].strip())
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT username FROM users WHERE ms_sub=%s", (sub,))
                owner = cur.fetchone()
                if owner and owner[0] != username:
                    raise HTTPException(status_code=409,
                                        detail="這個 Microsoft 帳號已經連結到另一個使用者")
                cur.execute("UPDATE users SET ms_sub=%s WHERE username=%s", (sub, username))
                # Fill in a missing email from a verified claim, if no one has it.
                if email:
                    cur.execute(
                        "UPDATE users SET email=%s WHERE username=%s AND email IS NULL"
                        " AND NOT EXISTS (SELECT 1 FROM users WHERE lower(email)=%s)",
                        (email, username, email))
        return {"result": "linked"}

    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT username, status FROM users WHERE ms_sub=%s", (sub,))
            row = cur.fetchone()
            if row is None and email:
                cur.execute("SELECT username, status, ms_sub FROM users WHERE lower(email)=%s",
                            (email,))
                hit = cur.fetchone()
                if hit and hit[2]:
                    raise HTTPException(
                        status_code=409,
                        detail="這個 Email 的帳號已經連結了另一個 Microsoft 帳號，請改用那個帳號登入")
                if hit:
                    cur.execute("UPDATE users SET ms_sub=%s WHERE username=%s", (sub, hit[0]))
                    row = hit[:2]
            elif row is None:
                # An unverified address that is on file is not proof of anything,
                # but it is a strong hint the person has an account: say so,
                # rather than walking them into a duplicate sign-up.
                claimed = (claims.get("email") or "").strip().lower()
                if claimed:
                    cur.execute("SELECT 1 FROM users WHERE lower(email)=%s", (claimed,))
                    if cur.fetchone():
                        raise HTTPException(
                            status_code=409,
                            detail="無法確認這個 Microsoft 帳號的 Email。若你已有帳號，"
                                   "請先用帳號密碼登入，再到「設定」連結 Microsoft 帳號")

    if row is not None:
        if row[1] == "pending":
            return {"result": "pending"}
        return _login_payload(row[0])

    now = datetime.now(timezone.utc)
    ticket = jwt.encode({"typ": "ms_signup", "sub": sub, "email": email or "",
                         "name": claims.get("name") or "", "iat": now,
                         "exp": now + MS_SIGNUP_TTL}, JWT_SECRET, algorithm=JWT_ALGORITHM)
    return {"result": "signup", "ticket": ticket,
            "name": claims.get("name") or "", "email": email or ""}


class MsRegisterRequest(BaseModel):
    ticket:  str
    name_en: str
    name_zh: str
    club_id: Optional[int] = None


@app.post("/api/auth/microsoft/register")
def ms_register(req: MsRegisterRequest):
    """
    Finish a Microsoft sign-up: a pending account, no password, bound to the
    Microsoft identity in the ticket. Approval works exactly like the
    password self-registration.
    """
    try:
        t = jwt.decode(req.ticket, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=400, detail="註冊連結已失效，請重新用 Microsoft 登入")
    if t.get("typ") != "ms_signup":
        raise HTTPException(status_code=400, detail="註冊連結無效")
    name_en, name_zh = req.name_en.strip(), req.name_zh.strip()
    if not name_en:
        raise HTTPException(status_code=400, detail="請輸入英文姓名")
    if not name_zh:
        raise HTTPException(status_code=400, detail="請輸入中文姓名")
    # Club is optional, as in register(): a club-less request is reviewed by
    # system admins, who assign the club and role on approval.
    email = t.get("email") or None

    # Username from the email's local part, or the English name; made unique
    # the same way the bulk import does.
    base = re.sub(r"[^a-z0-9]", "", (email or "").split("@")[0].lower()) \
        or re.sub(r"[^a-z0-9]", "", name_en.lower())
    base = (base if len(base) >= 3 else (base + "member"))[:20]
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                _check_register_club(cur, req.club_id)
                cur.execute("SELECT 1 FROM users WHERE ms_sub=%s", (t["sub"],))
                if cur.fetchone():
                    raise HTTPException(status_code=400,
                                        detail="這個 Microsoft 帳號已經申請過了，請等待審核")
                username, i = base, 2
                cur.execute("SELECT 1 FROM users WHERE username=%s", (username,))
                while cur.fetchone():
                    username = f"{base}{i}"
                    i += 1
                    cur.execute("SELECT 1 FROM users WHERE username=%s", (username,))
                cur.execute(
                    "INSERT INTO users (username, password_hash, name_en, name_zh, role,"
                    " club_id, status, email, ms_sub)"
                    " VALUES (%s, '', %s, %s, 'club_member', %s, 'pending', %s, %s)",
                    (username, name_en, name_zh, req.club_id, email, t["sub"]))
                _ensure_membership(cur, username)
    except psycopg2.errors.UniqueViolation:
        raise HTTPException(status_code=400, detail="這個 Email 已有帳號，請先用帳號密碼登入後在「設定」連結")
    return {"ok": True, "pending": True, "username": username,
            "message": _pending_message(req.club_id)}


# ------------------------------------------------------------------ my profile
class MyRoleItem(BaseModel):
    club_id: int
    role:    str


class ProfileUpdateRequest(BaseModel):
    name_en: str
    name_zh: str
    level:   Optional[str] = None
    email:   Optional[str] = None               # "" clears it; managers only
    roles:   Optional[List[MyRoleItem]] = None  # own role in own clubs


def _manages_something(cur, username: str) -> bool:
    """A system admin, or a club admin in at least one club."""
    cur.execute("SELECT role = 'system_admin' OR EXISTS (SELECT 1 FROM club_memberships m"
                " WHERE m.username = u.username AND m.role = 'club_admin')"
                " FROM users u WHERE u.username=%s", (username,))
    row = cur.fetchone()
    return bool(row and row[0])


@app.get("/api/me")
def get_my_profile(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT u.username, u.name_zh, u.name_en, u.email, u.level,"
                " u.ms_sub IS NOT NULL, u.password_hash <> ''"
                " FROM users u WHERE u.username=%s",
                (user["username"],))
            r = cur.fetchone()
            cur.execute("SELECT m.club_id, c.name, m.role FROM club_memberships m"
                        " JOIN clubs c ON c.id = m.club_id WHERE m.username=%s"
                        " ORDER BY lower(c.name)", (user["username"],))
            ms = [{"clubId": x[0], "clubName": x[1], "role": x[2]} for x in cur.fetchall()]
            cur.execute("SELECT name FROM clubs WHERE id=%s", (user["club_id"],))
            club_name = (cur.fetchone() or [""])[0]
            can_email = _manages_something(cur, user["username"])
    # role / club are the CURRENT club's; `memberships` lists all of them.
    return {"username": r[0], "nameZh": r[1] or "", "nameEn": r[2] or "",
            "email": r[3] or "", "level": r[4] or "", "role": user["role"],
            "clubId": user["club_id"], "clubName": club_name or "",
            "memberships": ms, "canEditEmail": can_email,
            "microsoftLinked": r[5], "hasPassword": r[6],
            "microsoftEnabled": _ms_enabled()}


@app.put("/api/me")
def update_my_profile(req: ProfileUpdateRequest, user: dict = Depends(get_current_user)):
    """
    Your own profile. Anyone: name, education level, and stepping down in a
    club you belong to (club_admin -> club_member only; promotion, and the
    system-admin role, are granted by admins). Email only for managers (a
    system admin, or a club admin somewhere): it is what a first Microsoft
    sign-in matches on, so a member who could set any address could take
    over someone else's sign-in. Which clubs you belong to stays with admins.
    """
    name_en, name_zh = req.name_en.strip(), req.name_zh.strip()
    if not name_en or not name_zh:
        raise HTTPException(status_code=400, detail="請提供中英文姓名")
    for item in req.roles or []:
        if item.role not in ("club_admin", "club_member"):
            raise HTTPException(status_code=400, detail="角色只能是「一般會員」或「分會管理員」")
    me = user["username"]
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("UPDATE users SET name_en=%s, name_zh=%s WHERE username=%s",
                            (name_en[:100], name_zh[:100], me))
                if req.level is not None:
                    cur.execute("UPDATE users SET level=%s WHERE username=%s",
                                ((req.level.strip() or "TM")[:20], me))
                if req.email is not None:
                    if not _manages_something(cur, me):
                        raise HTTPException(status_code=403,
                                            detail="Email 需由管理員修改，請聯絡分會管理員")
                    cur.execute("UPDATE users SET email=%s WHERE username=%s",
                                (_normalize_email(req.email), me))
                if req.roles:
                    mine = _memberships(cur, me)
                    for item in req.roles:
                        if item.club_id not in mine:
                            raise HTTPException(status_code=403, detail="只能修改自己所屬分會的角色")
                        if item.role == "club_admin" and mine[item.club_id] != "club_admin":
                            raise HTTPException(status_code=403,
                                                detail="不能把自己升為分會管理員，請聯絡分會管理員")
                        cur.execute("UPDATE club_memberships SET role=%s"
                                    " WHERE username=%s AND club_id=%s",
                                    (item.role, me, item.club_id))
                    _sync_primary(cur, me)
    except psycopg2.errors.UniqueViolation:
        raise HTTPException(status_code=400, detail="此 Email 已被其他帳號使用")
    return {"ok": True}


@app.delete("/api/me/microsoft")
def unlink_my_microsoft(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT password_hash <> '' FROM users WHERE username=%s",
                        (user["username"],))
            if not cur.fetchone()[0]:
                # Unlinking would leave no way to sign in at all.
                raise HTTPException(status_code=400,
                                    detail="你的帳號還沒有密碼，請先設定密碼再解除連結")
            cur.execute("UPDATE users SET ms_sub=NULL WHERE username=%s", (user["username"],))
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
            # Alphabetical: every club picker in the app is filled from this
            # list, in this order.
            cur.execute(f"SELECT {_CLUB_COLS} FROM clubs ORDER BY lower(name), id")
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
                _ensure_membership(cur, req.username.strip())
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
                _ensure_membership(cur, username)
                results.append({"nameZh": name_zh, "nameEn": name_en, "username": username, "ok": True})
    return {"results": results, "defaultPassword": default_pw}


@app.get("/api/users")
def list_users(
    club_id: Optional[int] = Query(default=None),
    user: dict = Depends(get_current_user),
):
    """
    One row per person.

    A club view — a club admin's or member's current club, or a system admin's
    ?club_id= — lists that club's members, with `role` being the role IN THAT
    CLUB. A system admin's unfiltered view lists everyone with their primary
    club and role. Either way each row carries all of the person's
    memberships, so a multi-club member's other clubs are visible.
    """
    scope = club_id if user["role"] == "system_admin" else user["club_id"]
    if scope is None and user["role"] != "system_admin":
        return []
    cols = ("u.username, u.name_en, u.name_zh, u.role, u.club_id, u.level,"
            " u.created_at, u.status, u.email, u.ms_sub IS NOT NULL")
    with get_db() as conn:
        with conn.cursor() as cur:
            if scope is not None:
                cur.execute(f"SELECT {cols}, m.role FROM club_memberships m"
                            " JOIN users u ON u.username = m.username"
                            " WHERE m.club_id = %s ORDER BY u.status, u.created_at", (scope,))
            else:
                cur.execute(f"SELECT {cols}, NULL FROM users u ORDER BY u.status, u.created_at")
            rows = cur.fetchall()
            cur.execute("SELECT m.username, m.club_id, c.name, m.role FROM club_memberships m"
                        " JOIN clubs c ON c.id = m.club_id"
                        " WHERE m.username = ANY(%s) ORDER BY lower(c.name)",
                        ([r[0] for r in rows],))
            by_user: dict = {}
            names: dict = {}
            for un, cid, cname, mrole in cur.fetchall():
                by_user.setdefault(un, []).append({"clubId": cid, "clubName": cname, "role": mrole})
                names[cid] = cname
            if scope is not None and scope not in names:
                cur.execute("SELECT name FROM clubs WHERE id=%s", (scope,))
                names[scope] = (cur.fetchone() or [""])[0]

    def row_out(r):
        cid = scope if scope is not None else r[4]
        return {
            "username":  r[0],
            "nameEn":    r[1],
            "nameZh":    r[2],
            # A system admin is one everywhere; anyone else: their role here.
            "role":      "system_admin" if r[3] == "system_admin" else (r[10] or r[3]),
            "clubId":    cid,
            "clubName":  names.get(cid, "") if cid is not None else "",
            "level":     r[5],
            "createdAt": r[6].isoformat() if r[6] else "",
            "status":    r[7],
            "email":     r[8] or "",
            "microsoftLinked": r[9],
            "memberships": by_user.get(r[0], []),
        }
    return [row_out(r) for r in rows]


_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _normalize_email(raw: Optional[str]) -> Optional[str]:
    """'' → None (cleared); otherwise trimmed and lowercased, or 400."""
    email = (raw or "").strip().lower()
    if not email:
        return None
    if len(email) > 254 or not _EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="Email 格式不正確")
    return email


@app.put("/api/users/{username}")
def update_user(username: str, req: UserUpdateRequest, user: dict = Depends(get_current_user)):
    if user["role"] == "club_member":
        raise HTTPException(status_code=403, detail="權限不足")

    try:
        return _update_user(username, req, user)
    except psycopg2.errors.UniqueViolation:
        raise HTTPException(status_code=400, detail="此 Email 已被其他帳號使用")


def _update_user(username: str, req: UserUpdateRequest, user: dict):
    # Email is admin-set on purpose (members cannot edit their own): it is what
    # a first Microsoft sign-in matches on, so letting anyone claim any address
    # would let them squat on someone else's sign-in.
    if user["role"] == "club_admin":
        # club_admin: members of their current club — themselves included —
        # name / level / email, and their role IN THIS CLUB (club_member ⇄
        # club_admin). Never a system admin's role, never another club's.
        name_en = (req.name_en or "").strip()
        name_zh = (req.name_zh or "").strip()
        level   = (req.level   or "TM").strip()
        if not name_en or not name_zh:
            raise HTTPException(status_code=400, detail="請提供中英文姓名")
        if req.role is not None and req.role not in ("club_admin", "club_member"):
            raise HTTPException(status_code=400, detail="分會管理員只能設定「一般會員」或「分會管理員」")
        set_email = req.email is not None
        email = _normalize_email(req.email) if set_email else None
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT u.role FROM club_memberships m JOIN users u USING (username)"
                            " WHERE m.username=%s AND m.club_id=%s", (username, user["club_id"]))
                target = cur.fetchone()
                if target is None:
                    raise HTTPException(status_code=404, detail="找不到此用戶或無權限修改")
                cur.execute(
                    "UPDATE users SET name_en=%s, name_zh=%s, level=%s,"
                    " email=CASE WHEN %s THEN %s ELSE email END WHERE username=%s",
                    (name_en, name_zh, level, set_email, email, username),
                )
                if req.role is not None:
                    if target[0] == "system_admin":
                        raise HTTPException(status_code=400, detail="系統管理員的角色不能在這裡修改")
                    cur.execute("UPDATE club_memberships SET role=%s WHERE username=%s AND club_id=%s",
                                (req.role, username, user["club_id"]))
                    _sync_primary(cur, username)
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
    if req.email is not None:
        set_clauses.append("email = %s");   values.append(_normalize_email(req.email))

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
            # role / club_id here mean the PRIMARY club and the role there.
            # Other memberships are managed with PUT /users/{u}/memberships.
            if req.role is not None or "club_id" in in_fields:
                _ensure_membership(cur, username)
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
                # club_admin 只能重設「目前分會」一般會員的密碼，不可動其他管理員帳號
                cur.execute(
                    """UPDATE users SET password_hash=%s, must_change_pw=true
                       WHERE username=%s AND role <> 'system_admin'
                         AND EXISTS (SELECT 1 FROM club_memberships m
                                     WHERE m.username = users.username AND m.club_id = %s
                                       AND m.role = 'club_member')""",
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


class ApproveRequest(BaseModel):
    role:    Optional[str] = None
    club_id: Optional[int] = None


@app.put("/api/users/{username}/approve")
def approve_user(username: str, req: Optional[ApproveRequest] = None,
                 user: dict = Depends(require_club_admin_or_above)):
    """
    Approve a pending self-registration: set status = 'active'.

    club_admin approves as-is (club_member in their own club; the body is
    ignored). system_admin may send {role, club_id} to assign them in the
    same step — that is how a club-less registration gets placed. Fields
    left out of the body keep what the registrant chose.
    """
    with get_db() as conn:
        with conn.cursor() as cur:
            if user["role"] == "club_admin":
                cur.execute(
                    "UPDATE users SET status='active'"
                    " WHERE username=%s AND status='pending'"
                    " AND EXISTS (SELECT 1 FROM club_memberships m"
                    "             WHERE m.username = users.username AND m.club_id = %s)",
                    (username, user["club_id"]),
                )
                approved = cur.rowcount
            else:  # system_admin
                cur.execute(
                    "SELECT role, club_id FROM users WHERE username=%s AND status='pending'",
                    (username,),
                )
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=404, detail="找不到此待審核用戶或無權限")
                fields = (getattr(req, "model_fields_set", None)       # Pydantic v2
                          or getattr(req, "__fields_set__", set())) if req else set()
                role    = req.role if req and req.role is not None else row[0]
                club_id = req.club_id if "club_id" in fields else row[1]
                if role not in ("system_admin", "club_admin", "club_member"):
                    raise HTTPException(status_code=400, detail="無效的角色")
                # A club_admin's every permission is scoped by club_id.
                if role == "club_admin" and club_id is None:
                    raise HTTPException(status_code=400, detail="分會管理員必須指定所屬分會")
                if club_id is not None:
                    cur.execute("SELECT 1 FROM clubs WHERE id=%s", (club_id,))
                    if not cur.fetchone():
                        raise HTTPException(status_code=400, detail="找不到這個分會，請重新選擇")
                cur.execute(
                    "UPDATE users SET status='active', role=%s, club_id=%s"
                    " WHERE username=%s AND status='pending'",
                    (role, club_id, username),
                )
                approved = cur.rowcount
                if approved:
                    # The club assigned here replaces the one asked for at
                    # registration, rather than adding to it.
                    cur.execute("DELETE FROM club_memberships WHERE username=%s"
                                " AND club_id IS DISTINCT FROM %s", (username, club_id))
                    _ensure_membership(cur, username)
            if not approved:
                raise HTTPException(status_code=404, detail="找不到此待審核用戶或無權限")
    return {"ok": True}


@app.delete("/api/users/{username}/reject")
def reject_user(username: str, user: dict = Depends(require_club_admin_or_above)):
    """Reject a pending self-registration by deleting the pending account."""
    with get_db() as conn:
        with conn.cursor() as cur:
            if user["role"] == "club_admin":
                cur.execute(
                    "DELETE FROM users WHERE username=%s AND status='pending'"
                    " AND EXISTS (SELECT 1 FROM club_memberships m"
                    "             WHERE m.username = users.username AND m.club_id = %s)",
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
                # A club admin removes someone from THEIR club — only an
                # ordinary member, never themselves. The account itself goes
                # only if that was the person's last club; someone who also
                # belongs elsewhere keeps their account and other clubs.
                if username == user["username"]:
                    raise HTTPException(status_code=400, detail="不能把自己移出分會")
                cur.execute(
                    "DELETE FROM club_memberships m USING users u"
                    " WHERE m.username = u.username AND m.username=%s AND m.club_id=%s"
                    "   AND m.role='club_member' AND u.role <> 'system_admin'",
                    (username, user["club_id"]),
                )
                if cur.rowcount == 0:
                    raise HTTPException(status_code=404, detail="找不到此使用者或無權限移除")
                if _memberships(cur, username):
                    _sync_primary(cur, username)
                    return {"ok": True, "removed": "membership"}
                cur.execute("DELETE FROM users WHERE username=%s", (username,))
                return {"ok": True, "removed": "account"}
            cur.execute("DELETE FROM users WHERE username=%s", (username,))
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="找不到此使用者或無權限刪除")
    return {"ok": True, "removed": "account"}


class AddMemberRequest(BaseModel):
    who:  str                      # username or email of an existing account
    role: str = "club_member"


@app.post("/api/clubs/{club_id}/members")
def add_club_member(club_id: int, req: AddMemberRequest,
                    user: dict = Depends(require_club_admin_or_above)):
    """
    Add an EXISTING account to a club — how a member of one club joins
    another. A system admin may add to any club; a club admin only to their
    current club, and only as a member or club admin there. The person's
    other clubs are untouched.
    """
    if user["role"] != "system_admin" and club_id != user["club_id"]:
        raise HTTPException(status_code=403, detail="只能把會員加進你目前操作的分會")
    if req.role not in ("club_admin", "club_member"):
        raise HTTPException(status_code=400, detail="角色只能是「一般會員」或「分會管理員」")
    who = (req.who or "").strip()
    if not who:
        raise HTTPException(status_code=400, detail="請輸入帳號或 Email")
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM clubs WHERE id=%s", (club_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="找不到此分會")
            cur.execute("SELECT username, status, name_zh, name_en FROM users"
                        " WHERE username=%s OR (email IS NOT NULL AND email=lower(%s))"
                        " ORDER BY (username=%s) DESC",
                        (who, who, who))
            found = cur.fetchall()
            if not found:
                raise HTTPException(status_code=404, detail="找不到這個帳號或 Email，對方需要先有帳號")
            username, status, name_zh, name_en = found[0]
            if status == "pending":
                raise HTTPException(status_code=400, detail="這個帳號還在審核中，請先完成審核")
            cur.execute("INSERT INTO club_memberships (username, club_id, role) VALUES (%s, %s, %s)"
                        " ON CONFLICT DO NOTHING", (username, club_id, req.role))
            if cur.rowcount == 0:
                raise HTTPException(status_code=400, detail="這位已經是這個分會的會員")
            _sync_primary(cur, username)      # gives a club-less account its first club
    return {"ok": True, "username": username, "nameZh": name_zh, "nameEn": name_en}


class MembershipItem(BaseModel):
    club_id: int
    role:    str = "club_member"


class MembershipsRequest(BaseModel):
    memberships: List[MembershipItem]


@app.put("/api/users/{username}/memberships")
def set_memberships(username: str, req: MembershipsRequest,
                    user: dict = Depends(require_system_admin)):
    """A system admin sets every club a person belongs to, and the role in each."""
    wanted = {}
    for m in req.memberships:
        if m.role not in ("club_admin", "club_member"):
            raise HTTPException(status_code=400, detail="角色只能是「一般會員」或「分會管理員」")
        wanted[m.club_id] = m.role
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM users WHERE username=%s", (username,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="找不到此使用者")
            if wanted:
                cur.execute("SELECT id FROM clubs WHERE id = ANY(%s)", (list(wanted),))
                missing = set(wanted) - {r[0] for r in cur.fetchall()}
                if missing:
                    raise HTTPException(status_code=400, detail="找不到部分分會，請重新整理後再試")
            cur.execute("DELETE FROM club_memberships WHERE username=%s AND NOT (club_id = ANY(%s))",
                        (username, list(wanted)))
            for cid, role in wanted.items():
                cur.execute("INSERT INTO club_memberships (username, club_id, role) VALUES (%s, %s, %s)"
                            " ON CONFLICT (username, club_id) DO UPDATE SET role = EXCLUDED.role",
                            (username, cid, role))
            _sync_primary(cur, username)
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
        # One club at a time: a club you belong to but are not acting in has
        # to be switched to first, so it is your role THERE that applies.
        if club_id in (user.get("memberships") or {}):
            raise HTTPException(status_code=403,
                                detail="這是你所屬的另一個分會，請先切換到該分會再操作"
                                       "（網站：側邊欄的分會切換；AI 助理：switch_club）")
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
    api_key = _load_api_key(user["username"], provider, _social_scope(user, req.club_id))
    if not api_key and provider == "anthropic":
        api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        label = "Anthropic" if provider == "anthropic" else "OpenAI"
        raise HTTPException(
            status_code=400,
            detail=f"沒有可用的 {label} 帳號。請在「AI 帳號」填自己的金鑰，"
                   "或由分會幹部設定一組分會共用的。",
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


# A club's shared AI key lives in club_secrets under this name. That table is
# already a name/value store for the Meta credentials and encrypts with the
# same Fernet master key, so a shared AI account costs no migration.
def _club_ai_name(provider: str) -> str:
    return f"ai_{provider}"


def _load_api_key(username: str, provider: str,
                  club_id: Optional[int] = None) -> Optional[str]:
    """
    Whose account pays, in order: yours, then the club's, then the server's.

    Personal first is the point of allowing both. An officer who connects a
    key has said they want their own account billed, and a club key appearing
    later must not quietly take that over. The club key is the floor, so a new
    officer can write a post on their first day without registering with
    Anthropic — which for a committee that turns over every 1 July is the
    difference between a tool people use and one they re-provision each year.
    """
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT key_cipher FROM user_ai_credentials"
                        " WHERE username=%s AND provider=%s", (username, provider))
            row = cur.fetchone()
    if row:
        return _open(row[0])
    if club_id is not None:
        return _get_club_secret(club_id, _club_ai_name(provider))
    return None


def _club_ai_hints(club_id: Optional[int]) -> dict:
    if club_id is None:
        return {}
    return {p: _club_secret_hint(club_id, _club_ai_name(p)) for p in AI_PROVIDERS}


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
    club = _club_ai_hints(user.get("club_id"))
    return [
        {**have.get(p, {"provider": p, "hint": "", "updatedAt": ""}),
         "serverFallback": fallback.get(p, False),
         # What this person falls back to with no key of their own. Without it
         # the UI shows one "未連接" for three very different outcomes.
         "clubHint": club.get(p, "")}
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


@app.get("/api/clubs/{club_id}/ai-credentials")
def list_club_ai_credentials(club_id: int,
                             user: dict = Depends(require_club_admin_or_above)):
    """The club's shared AI accounts — masked hints only, never the keys."""
    _social_scope(user, club_id)
    return [{"provider": p, "hint": _club_secret_hint(club_id, _club_ai_name(p))}
            for p in AI_PROVIDERS]


@app.put("/api/clubs/{club_id}/ai-credentials/{provider}")
def set_club_ai_credential(club_id: int, provider: str, req: AiCredentialRequest,
                           user: dict = Depends(require_club_admin_or_above)):
    if provider not in AI_PROVIDERS:
        raise HTTPException(status_code=400, detail="不支援這個 AI 服務")
    key = req.api_key.strip()
    if not key:
        raise HTTPException(status_code=400, detail="請貼上 API 金鑰")
    # Everyone in the club spends this one, so it is the club's call to set it,
    # not any member's.
    hint = _set_club_secret(club_id, _club_ai_name(provider), key)
    return {"provider": provider, "hint": hint}


@app.delete("/api/clubs/{club_id}/ai-credentials/{provider}")
def drop_club_ai_credential(club_id: int, provider: str,
                            user: dict = Depends(require_club_admin_or_above)):
    _social_scope(user, club_id)
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM club_secrets WHERE club_id=%s AND name=%s",
                        (club_id, _club_ai_name(provider)))
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

    api_key = _load_api_key(username, "openai", club_id)
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail="沒有可用的 OpenAI 帳號。請在「AI 帳號」填自己的金鑰，"
                   "或由分會幹部設定一組分會共用的。")
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


# ==================================================================
# MCP — OAUTH 2.1 RESOURCE SERVER
# ==================================================================
# This app can be driven by an MCP client (Claude and friends), which means it
# has to act as an OAuth 2.1 resource server: tokens come from the
# authorization half below, and every MCP request carries one.
#
# The scopes exist to make one particular thing a user decision rather than a
# line of code: publishing is public and cannot be taken back, so `publish` is
# offered on the consent screen but arrives UNTICKED — a person has to turn it
# on by hand. It is advertised (scopes_supported, the 401 challenge) like the
# others: a scope a client never hears of is one it never asks for, and then
# the consent screen never gets to put the question at all.
#
# A scope never widens what a person may do. It narrows what a token may do on
# their behalf — the role checks (`require_club_admin_or_above`, `_social_scope`)
# still run underneath, unchanged.

# Signed separately from JWT_SECRET on purpose: a login cookie and a
# machine-to-machine token have different lifetimes and blast radii, and
# sharing one key means a leak of either compromises both.
MCP_TOKEN_SECRET = os.getenv("MCP_TOKEN_SECRET", "")
MCP_ACCESS_TTL   = timedelta(hours=1)
MCP_REFRESH_TTL  = timedelta(days=60)
MCP_CODE_TTL     = timedelta(minutes=5)

MCP_SCOPES = {
    "posts:read":    "讀取分會、例會議程與貼文，並匯出議程 PDF／JPG",
    "posts:write":   "建立與修改貼文草稿、加入或移除貼文圖片",
    "agendas:write": "建立與修改議程、安排角色（含從角色試算表帶入）",
    "clubs:write":   "修改分會設定與圖片（名稱、版型、地點、QR code；限系統管理員）",
    "ai:generate":   "用你的 AI 帳號產生文案與圖片（會消耗你的 API 額度）",
    "publish":       "代表分會公開發文到 Facebook／Instagram／Threads",
}
# What a client gets when it asks for nothing in particular. `publish` is
# absent: it is only ever granted by someone ticking it.
MCP_DEFAULT_SCOPES = ("posts:read", "posts:write", "agendas:write", "clubs:write",
                      "ai:generate")

def _public_origin(request: Request) -> str:
    """
    The origin a client actually reached us on.

    Taken from the forwarded headers rather than hardcoded: the canonical
    resource URI has to match what the client sends in `resource`, and that is
    whatever host they typed — production, a preview deployment, or localhost.

    The forwarded headers are trustworthy on Vercel, which overwrites them.
    Elsewhere PUBLIC_BASE_URL pins it and the headers are not consulted at
    all: on the Docker deployment the /svc proxy reaches us as
    http://api:8001, and the app lives under a sub-path
    (https://host/club-management). MCP_PUBLIC_ORIGIN is an older name for
    the same setting.
    """
    pinned = (os.getenv("PUBLIC_BASE_URL") or os.getenv("MCP_PUBLIC_ORIGIN") or "").rstrip("/")
    if pinned:
        return pinned
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme or "https"
    return f"{proto}://{host}"


def _mcp_resource(request: Request) -> str:
    """The canonical URI of this MCP server (RFC 8707 resource indicator)."""
    return f"{_public_origin(request)}/api/mcp"


def _prm_url(request: Request) -> str:
    return f"{_public_origin(request)}/.well-known/oauth-protected-resource"


def _mcp_secret() -> str:
    if not MCP_TOKEN_SECRET:
        raise HTTPException(
            status_code=503,
            detail="伺服器尚未設定 MCP_TOKEN_SECRET，無法簽發或驗證 MCP token",
        )
    return MCP_TOKEN_SECRET


def _mint_access_token(username: str, client_id: str, scope: str,
                       resource: str, grant: str) -> tuple:
    """
    `grant` is the `grant_id` of the authorization this access token descends
    from. It ties a self-contained JWT back to a row that can be revoked —
    without it, revoking a grant would leave its access tokens working until
    expiry. It stays fixed while the refresh token under it rotates, and it is
    not a credential: knowing it lets nobody mint or refresh anything.
    """
    now = datetime.now(timezone.utc)
    payload = {
        "sub": username,
        "aud": resource,          # audience binding — see _verify_access_token
        "iss": resource.rsplit("/api/mcp", 1)[0],
        "client_id": client_id,
        "grant": grant,
        "scope": scope,
        "iat": now,
        "exp": now + MCP_ACCESS_TTL,
        "jti": uuid.uuid4().hex,
    }
    token = jwt.encode(payload, _mcp_secret(), algorithm=JWT_ALGORITHM)
    return token, int(MCP_ACCESS_TTL.total_seconds())


def _unauthorized(request: Request, scope: str = "", error: str = ""):
    """401 that tells the client where to go, as RFC 6750/9728 require."""
    parts = [f'Bearer resource_metadata="{_prm_url(request)}"']
    if scope:
        parts.append(f'scope="{scope}"')
    if error:
        parts.append(f'error="{error}"')
    return HTTPException(status_code=401, detail="需要授權",
                         headers={"WWW-Authenticate": ", ".join(parts)})


def _verify_access_token(request: Request, token: str) -> dict:
    resource = _mcp_resource(request)
    try:
        claims = jwt.decode(token, _mcp_secret(), algorithms=[JWT_ALGORITHM],
                            audience=resource)
    except jwt.ExpiredSignatureError:
        raise _unauthorized(request, error="invalid_token")
    except jwt.InvalidAudienceError:
        # The token was issued for somebody else's server. Accepting it is the
        # confused-deputy hole the spec calls out, so this is a hard no.
        raise _unauthorized(request, error="invalid_token")
    except jwt.InvalidTokenError:
        raise _unauthorized(request, error="invalid_token")
    return claims


def mcp_caller(request: Request) -> dict:
    """
    Who is calling, and what this token is allowed to do on their behalf.

    Returns the same shape `get_current_user` does, plus `scopes`, so the
    existing role checks can be reused verbatim rather than reimplemented.
    """
    auth = request.headers.get("authorization") or ""
    if not auth.lower().startswith("bearer "):
        raise _unauthorized(request, scope=" ".join(MCP_SCOPES))
    claims = _verify_access_token(request, auth[7:].strip())

    # The grant has to still be live, checked on every call. This is what makes
    # revocation immediate: an access token outlives nothing it came from. A
    # token without a `grant` claim predates this check and is refused, which
    # just sends the client through a refresh.
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT u.username, u.role, u.club_id, u.status, t.active_club_id"
                " FROM users u JOIN oauth_refresh_tokens t"
                "   ON t.grant_id=%s AND t.username=u.username"
                "  AND t.revoked_at IS NULL"
                "  AND (t.expires_at IS NULL OR t.expires_at > NOW())"
                " WHERE u.username=%s",
                (claims.get("grant") or "", claims.get("sub")))
            row = cur.fetchone()
            ms = _memberships(cur, row[0]) if row else {}
    if not row or row[3] == "pending":
        raise _unauthorized(request, error="invalid_token")
    # The club this grant acts in: the one switch_club picked, if the person
    # still belongs to it, else their primary club — same rule as the web.
    role, club_id = _acting_as(row[1], row[2], ms, row[4])

    return {"username": row[0], "role": role, "club_id": club_id, "memberships": ms,
            "scopes": set((claims.get("scope") or "").split()),
            "client_id": claims.get("client_id", ""),
            "grant": claims.get("grant") or "",
            # Tools that call back into this deployment (export_agenda) need
            # to know where it is; handlers do not otherwise see the request.
            "origin": _public_origin(request)}


def require_scope(caller: dict, scope: str, request: Request):
    """
    403 + a challenge for step-up authorization (RFC 6750 §3.1).

    The challenge names what the token already has *plus* what is missing.
    Clients re-authorize with exactly the scope in the challenge, so naming
    only the missing one would trade the old token for one that can publish
    but no longer read.
    """
    if scope in caller["scopes"]:
        return
    want = [s for s in MCP_SCOPES if s in caller["scopes"] or s == scope]
    raise HTTPException(
        status_code=403,
        detail=f"這個授權沒有包含「{MCP_SCOPES.get(scope, scope)}」",
        headers={"WWW-Authenticate":
                 f'Bearer error="insufficient_scope", scope="{" ".join(want)}", '
                 f'resource_metadata="{_prm_url(request)}"'},
    )


@app.get("/.well-known/oauth-protected-resource")
@app.get("/.well-known/oauth-protected-resource/api/mcp")
def protected_resource_metadata(request: Request):
    """
    RFC 9728. The first thing an MCP client fetches, before it has a token —
    so this endpoint must stay unauthenticated, and middleware.js excludes
    /.well-known for that reason.

    `scopes_supported` lists every scope, `publish` included — see the note
    at the top of this section on why hiding it defeated its own purpose.
    """
    origin = _public_origin(request)
    return {
        "resource": f"{origin}/api/mcp",
        "authorization_servers": [origin],
        "scopes_supported": list(MCP_SCOPES),
        "bearer_methods_supported": ["header"],
    }


# ------------------------------------------------------------------ AS: clients
# Client ID Metadata Documents: the client_id *is* an HTTPS URL, and the
# document it points at says who the client is and where it may be redirected.
# Chosen over Dynamic Client Registration because DCR is deprecated in the MCP
# spec and needs a registration table and endpoint this app would then own.

_CIMD_MAX_BYTES = 64 * 1024
_CIMD_TIMEOUT   = 8


def _host_is_internal(host: str) -> bool:
    """
    Whether any address `host` resolves to is one we must not fetch from.

    Checked on the resolved addresses rather than the spelling, so a public
    name pointing at 10.0.0.5 — or a decimal/IPv6 spelling of 127.0.0.1 — is
    caught too. An unresolvable host counts as internal: refusing it costs
    nothing, since the fetch would fail anyway.
    """
    import ipaddress
    import socket
    if not host or host.lower() == "localhost":
        return True
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except OSError:
        return True
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%", 1)[0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            return True
    return False


def _fetch_client_metadata(client_id: str) -> dict:
    """
    Resolve a CIMD client_id, or refuse.

    This fetches a URL supplied by whoever started the authorization request,
    which is an SSRF primitive if left open. Hence: https only, a path
    component required, internal addresses refused after DNS resolution,
    redirects not followed (a public URL answering 302 → 169.254.169.254 is
    the classic way round a host check), a byte cap, and a timeout.
    """
    import urllib.error
    import urllib.parse
    import urllib.request

    if client_id.startswith(_DCR_PREFIX):
        return _dcr_client_metadata(client_id)

    u = urllib.parse.urlparse(client_id)
    if u.scheme != "https" or not u.netloc or u.path in ("", "/"):
        raise HTTPException(status_code=400,
                            detail="client_id 必須是帶路徑的 https 網址")
    if _host_is_internal(u.hostname or ""):
        raise HTTPException(status_code=400, detail="client_id 指向內部位址")

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        # A CIMD document lives at the URL that is its own id (the client_id
        # check below would reject a moved one anyway), so a redirect is never
        # legitimate here — and following one would skip the host check.
        def redirect_request(self, *a, **kw):
            return None

    try:
        # A User-Agent is required in practice: Claude's document sits behind
        # Cloudflare, which answers urllib's default ("Python-urllib/3.x")
        # with a 403 challenge.
        req = urllib.request.Request(client_id, headers={
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (compatible; entrepreneur-agenda-mcp/1.0)",
        })
        opener = urllib.request.build_opener(_NoRedirect)
        with opener.open(req, timeout=_CIMD_TIMEOUT) as res:
            raw = res.read(_CIMD_MAX_BYTES + 1)
    except urllib.error.HTTPError as e:
        raise HTTPException(status_code=400,
                            detail=f"無法讀取 client_id 的中繼資料（HTTP {e.code}）")
    except Exception:
        raise HTTPException(status_code=400, detail="無法讀取 client_id 的中繼資料（連線失敗）")
    if len(raw) > _CIMD_MAX_BYTES:
        raise HTTPException(status_code=400, detail="client_id 的中繼資料過大")

    try:
        meta = json.loads(raw.decode("utf-8"))
    except Exception:
        raise HTTPException(status_code=400, detail="client_id 的中繼資料不是有效的 JSON")

    # The document must claim the exact URL it was fetched from, or anyone
    # could host a document impersonating another client.
    if meta.get("client_id") != client_id:
        raise HTTPException(status_code=400, detail="中繼資料裡的 client_id 與網址不符")
    if not isinstance(meta.get("redirect_uris"), list) or not meta["redirect_uris"]:
        raise HTTPException(status_code=400, detail="中繼資料缺少 redirect_uris")
    if not meta.get("client_name"):
        raise HTTPException(status_code=400, detail="中繼資料缺少 client_name")
    return meta


# Dynamic Client Registration (RFC 7591), for clients that predate CIMD —
# Claude Desktop's connectors among them. The current MCP revision deprecates
# DCR, but a server that refuses it simply cannot be added by those clients.
#
# Stateless: the client_id *is* the registration — the redirect URIs and name,
# signed with MCP_TOKEN_SECRET. Nothing to store, nothing to clean up, and a
# client_id cannot be edited to add a redirect URI without breaking the
# signature. The cost is that a registration cannot be deleted, which matters
# little for public clients: what can be revoked is a user's grant.
#
# Anyone may register (that is what DCR is), with any name. The consent screen
# therefore shows where the code will be sent, not just the self-chosen name.

_DCR_PREFIX = "dcr:"


def _host_of(url: str) -> str:
    import urllib.parse
    try:
        return urllib.parse.urlparse(url).netloc or url
    except Exception:
        return url


def _client_host(client_id: str) -> str:
    """Something a person can recognise: the CIMD URL's host, or for a DCR
    client (whose id is a long signed blob) the host it redirects to."""
    if client_id.startswith(_DCR_PREFIX):
        try:
            uris = _dcr_client_metadata(client_id)["redirect_uris"]
            return _host_of(uris[0]) if uris else "MCP 客戶端"
        except HTTPException:
            return "MCP 客戶端"
    return _host_of(client_id)


def _redirect_registered(uri: str, registered: list) -> bool:
    """
    Whether `uri` is one of the client's redirect URIs.

    Exact match, except that a loopback http URI matches regardless of port
    (RFC 8252 §7.3). A desktop or CLI client opens whatever port is free at
    login time, so the port it registered with is rarely the one it is
    listening on now — Codex's login fails without this. The loopback names
    are also treated as one: clients register "localhost" and then listen on
    127.0.0.1 (or the reverse), and either way the code never leaves the
    machine the person is sitting at.
    """
    import urllib.parse
    if uri in registered:
        return True
    u = urllib.parse.urlparse(uri)
    if u.scheme != "http" or u.hostname not in ("localhost", "127.0.0.1", "::1"):
        return False
    for r in registered:
        v = urllib.parse.urlparse(r) if isinstance(r, str) else None
        if (v and v.scheme == "http"
                and v.hostname in ("localhost", "127.0.0.1", "::1")
                and v.path == u.path and v.query == u.query):
            return True
    return False


def _dcr_redirect_ok(uri: str) -> bool:
    import urllib.parse
    if not isinstance(uri, str) or len(uri) > 2000 or "#" in uri:
        return False
    u = urllib.parse.urlparse(uri)
    if u.scheme == "https" and u.netloc:
        return True
    # Native clients (CLIs, desktop apps) receive the code on a loopback port.
    return u.scheme == "http" and u.hostname in ("localhost", "127.0.0.1", "::1")


def _dcr_client_metadata(client_id: str) -> dict:
    try:
        meta = jwt.decode(client_id[len(_DCR_PREFIX):], _mcp_secret(),
                          algorithms=[JWT_ALGORITHM])
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=400, detail="client_id 無效")
    if meta.get("typ") != "dcr":
        raise HTTPException(status_code=400, detail="client_id 無效")
    return {"client_id": client_id, "client_name": meta.get("client_name") or "MCP 客戶端",
            "redirect_uris": meta.get("redirect_uris") or [],
            "client_uri": meta.get("client_uri") or ""}


@app.post("/api/oauth/register")
async def oauth_register(request: Request):
    def err(code, desc):
        return Response(content=json.dumps({"error": code, "error_description": desc},
                                           ensure_ascii=False),
                        status_code=400, media_type="application/json")
    try:
        body = json.loads(await request.body() or b"{}")
    except Exception:
        return err("invalid_client_metadata", "請求內容不是有效的 JSON")
    uris = body.get("redirect_uris")
    if not isinstance(uris, list) or not uris or len(uris) > 10:
        return err("invalid_redirect_uri", "需要 1 到 10 個 redirect_uris")
    if not all(_dcr_redirect_ok(u) for u in uris):
        return err("invalid_redirect_uri", "redirect_uri 必須是 https，或 localhost 的 http")
    name = str(body.get("client_name") or "")[:200]
    client_uri = str(body.get("client_uri") or "")[:500]

    now = int(time.time())
    token = jwt.encode({"typ": "dcr", "redirect_uris": uris, "client_name": name,
                        "client_uri": client_uri, "iat": now},
                       _mcp_secret(), algorithm=JWT_ALGORITHM)
    out = {
        "client_id": _DCR_PREFIX + token,
        "client_id_issued_at": now,
        "redirect_uris": uris,
        "client_name": name,
        # Public client: PKCE is the proof, there is no secret to issue.
        "token_endpoint_auth_method": "none",
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
    }
    if client_uri:
        out["client_uri"] = client_uri
    return Response(content=json.dumps(out, ensure_ascii=False), status_code=201,
                    media_type="application/json", headers={"Cache-Control": "no-store"})


# ------------------------------------------------------------------ AS: discovery
@app.get("/.well-known/oauth-authorization-server")
def authorization_server_metadata(request: Request):
    """RFC 8414. Unauthenticated, like the protected-resource document."""
    origin = _public_origin(request)
    return {
        "issuer": origin,
        "authorization_endpoint": f"{origin}/oauth/authorize",
        "token_endpoint": f"{origin}/api/oauth/token",
        "revocation_endpoint": f"{origin}/api/oauth/revoke",
        "registration_endpoint": f"{origin}/api/oauth/register",
        "revocation_endpoint_auth_methods_supported": ["none"],
        "scopes_supported": list(MCP_SCOPES),
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        # OAuth 2.1: PKCE is required, and plain is not a method we accept.
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
        # Not advertised: some clients host their CIMD document behind bot
        # protection that answers our server's fetch with 403 (ChatGPT was
        # reported failing this way), and the failure cannot be fixed from
        # here. Without the flag clients fall back to DCR above, which needs no
        # fetch. A client that sends a URL client_id anyway is still served.
        "client_id_metadata_document_supported": False,
        "authorization_response_iss_parameter_supported": True,
    }


# ------------------------------------------------------------------ AS: authorize
def _check_authorize(request: Request, client_id: str, redirect_uri: str,
                     code_challenge: str, code_challenge_method: str,
                     resource: str, scope: str) -> tuple:
    """Returns (client metadata, granted scopes, canonical resource)."""
    if code_challenge_method != "S256" or not code_challenge:
        raise HTTPException(status_code=400, detail="需要 PKCE（S256）")
    # RFC 8707: the token must be minted for the server the client named, and
    # that has to be this one. A client that names none (several OAuth
    # libraries predate resource indicators) gets this one — the only resource
    # this server issues tokens for, so there is nothing to confuse it with.
    resource = resource or _mcp_resource(request)
    if resource.rstrip("/") != _mcp_resource(request):
        raise HTTPException(status_code=400, detail="resource 與本伺服器不符")
    resource = _mcp_resource(request)

    meta = _fetch_client_metadata(client_id)
    if not _redirect_registered(redirect_uri, meta["redirect_uris"]):
        # Both values are the client's own, public by nature, and the only way
        # to tell which side has it wrong.
        raise HTTPException(
            status_code=400,
            detail=f"redirect_uri 不在這個 client 的允許清單中（收到 {redirect_uri}，"
                   f"允許 {'、'.join(map(str, meta['redirect_uris'][:5]))}）")

    asked = (scope or "").split()
    wanted = [x for x in asked if x in MCP_SCOPES]
    # Generic OIDC-flavoured scopes some clients add by habit. Not ours, but
    # not a reason to fail either; anything else unrecognised is.
    harmless = {"openid", "profile", "email", "offline_access"}
    if asked and not wanted and any(x not in harmless for x in asked):
        raise HTTPException(status_code=400,
                            detail="請求的 scope 都不是本伺服器提供的："
                                   + " ".join(asked))
    return meta, (wanted or list(MCP_DEFAULT_SCOPES)), resource


class AuthorizeRequest(BaseModel):
    client_id:             str
    redirect_uri:          str
    code_challenge:        str
    code_challenge_method: str = "S256"
    resource:              str = ""
    scope:                 str = ""
    state:                 str = ""


@app.get("/api/oauth/authorize-info")
def authorize_info(request: Request,
                   client_id: str = Query(...), redirect_uri: str = Query(...),
                   code_challenge: str = Query(...), resource: str = Query(default=""),
                   code_challenge_method: str = Query(default="S256"),
                   scope: str = Query(default=""),
                   user: dict = Depends(get_current_user)):
    """What the consent screen needs to show. Validates before anything is drawn."""
    meta, wanted, _ = _check_authorize(request, client_id, redirect_uri, code_challenge,
                                       code_challenge_method, resource, scope)
    return {
        "clientName": meta["client_name"],
        "clientUri":  meta.get("client_uri", ""),
        # Where the code goes. The name is whatever the client says it is (with
        # DCR, anyone can register as "Claude"); the redirect host is not.
        "redirectHost": _host_of(redirect_uri),
        "username":   user["username"],
        "role":       user["role"],
        "scopes":     [{"key": k, "label": MCP_SCOPES[k],
                        "sensitive": k == "publish"} for k in wanted],
    }


@app.post("/api/oauth/authorize")
def authorize_grant(request: Request, req: AuthorizeRequest,
                    user: dict = Depends(get_current_user)):
    """
    The user pressed Allow. Mint a code and hand back where to send them.

    Only the hash is stored, and the redirect is returned rather than issued
    as a 302 so the consent page can navigate itself.
    """
    meta, wanted, resource = _check_authorize(
        request, req.client_id, req.redirect_uri, req.code_challenge,
        req.code_challenge_method, req.resource, req.scope)
    import hashlib
    import urllib.parse
    code = uuid.uuid4().hex + uuid.uuid4().hex
    code_hash = hashlib.sha256(code.encode()).hexdigest()
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO oauth_codes (code_hash, client_id, client_name, username,"
                " redirect_uri, code_challenge, resource, scope, expires_at)"
                " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (code_hash, req.client_id, str(meta["client_name"])[:200],
                 user["username"], req.redirect_uri,
                 req.code_challenge, resource, " ".join(wanted),
                 datetime.now(timezone.utc) + MCP_CODE_TTL),
            )
    params = {"code": code, "iss": _public_origin(request)}
    if req.state:
        params["state"] = req.state
    sep = "&" if "?" in req.redirect_uri else "?"
    return {"redirect": f"{req.redirect_uri}{sep}{urllib.parse.urlencode(params)}"}


# ------------------------------------------------------------------ AS: token
def _token_error(code: str, desc: str):
    # OAuth error bodies are a defined shape; FastAPI's {"detail": ...} is not
    # one a client will understand.
    return Response(content=json.dumps({"error": code, "error_description": desc}),
                    status_code=400, media_type="application/json")


def _issue_refresh(username: str, client_id: str, client_name: str, scope: str,
                   resource: str) -> tuple:
    """
    Start a grant. Returns (refresh_token, grant_id).

    The grant_id is fixed for the grant's life; the refresh token under it is
    replaced on every use (see the refresh branch of oauth_token).
    """
    import hashlib
    token = uuid.uuid4().hex + uuid.uuid4().hex
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    grant_id = uuid.uuid4().hex
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO oauth_refresh_tokens (token_hash, grant_id, client_id,"
                " client_name, username, scope, resource, expires_at)"
                " VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                (token_hash, grant_id, client_id, client_name, username,
                 scope, resource, datetime.now(timezone.utc) + MCP_REFRESH_TTL),
            )
    return token, grant_id


@app.post("/api/oauth/token")
async def oauth_token(request: Request):
    """
    Code → token, and refresh → token.

    Reads form-encoded input because that is what OAuth clients send; this is
    the one endpoint in the app that is not JSON.
    """
    import hashlib
    import base64
    form = await request.form()
    grant = form.get("grant_type")

    if grant == "authorization_code":
        code = form.get("code") or ""
        verifier = form.get("code_verifier") or ""
        client_id = form.get("client_id") or ""
        redirect_uri = form.get("redirect_uri") or ""
        if not (code and verifier and client_id):
            return _token_error("invalid_request", "缺少必要參數")

        # Deleting and returning in one statement is what makes a code
        # single-use: a replay finds nothing, even if it arrives concurrently.
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM oauth_codes WHERE code_hash=%s"
                    " RETURNING client_id, username, redirect_uri, code_challenge,"
                    " resource, scope, expires_at, client_name",
                    (hashlib.sha256(code.encode()).hexdigest(),),
                )
                row = cur.fetchone()
        if row is None:
            return _token_error("invalid_grant", "授權碼無效或已使用")
        if row[6] < datetime.now(timezone.utc):
            return _token_error("invalid_grant", "授權碼已過期")
        if not hmac.compare_digest(row[0], client_id):
            return _token_error("invalid_grant", "client_id 與授權碼不符")
        if not hmac.compare_digest(row[2], redirect_uri):
            return _token_error("invalid_grant", "redirect_uri 與授權碼不符")

        digest = hashlib.sha256(verifier.encode("ascii")).digest()
        expected = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
        if not hmac.compare_digest(expected, row[3]):
            return _token_error("invalid_grant", "PKCE 驗證失敗")

        username, resource, scope, client_name = row[1], row[4], row[5], row[7]
        grant_id = refresh = None   # minted below, after the account check

    elif grant == "refresh_token":
        rt = form.get("refresh_token") or ""
        client_id = form.get("client_id") or ""
        old_hash = hashlib.sha256(rt.encode()).hexdigest()
        # Rotation (OAuth 2.1 §4.3.1, required for public clients): the token
        # presented is retired and a new one takes its place. Done as a single
        # UPDATE on the old hash so two concurrent uses cannot both succeed.
        # The expiry slides with it — a grant in regular use stays alive; one
        # left idle for MCP_REFRESH_TTL does not.
        refresh = uuid.uuid4().hex + uuid.uuid4().hex
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE oauth_refresh_tokens SET token_hash=%s, prev_token_hash=%s,"
                    " last_used_at=NOW(), expires_at=%s"
                    " WHERE token_hash=%s AND revoked_at IS NULL"
                    " AND (expires_at IS NULL OR expires_at > NOW())"
                    " AND (%s='' OR client_id=%s)"
                    " RETURNING grant_id, client_id, username, scope, resource",
                    (hashlib.sha256(refresh.encode()).hexdigest(), old_hash,
                     datetime.now(timezone.utc) + MCP_REFRESH_TTL,
                     old_hash, client_id, client_id),
                )
                row = cur.fetchone()
                if row is None:
                    # A token that was already rotated away, presented again:
                    # someone besides the client holds it. Which copy is the
                    # thief's cannot be told, so the whole grant goes.
                    cur.execute(
                        "UPDATE oauth_refresh_tokens SET revoked_at=NOW()"
                        " WHERE prev_token_hash=%s AND revoked_at IS NULL", (old_hash,))
        if row is None:
            return _token_error("invalid_grant", "refresh token 無效、已過期或已撤銷")
        grant_id, client_id, username, scope, resource = row
    else:
        return _token_error("unsupported_grant_type", "只支援 authorization_code 與 refresh_token")

    # The account may have been suspended or deleted since the grant.
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT status FROM users WHERE username=%s", (username,))
            u = cur.fetchone()
    if not u or u[0] == "pending":
        return _token_error("invalid_grant", "帳號已停用")

    if grant == "authorization_code":
        refresh, grant_id = _issue_refresh(username, client_id, client_name,
                                           scope, resource)
    access, ttl = _mint_access_token(username, client_id, scope, resource, grant_id)
    body = {"access_token": access, "token_type": "Bearer",
            "expires_in": ttl, "scope": scope}
    if refresh:
        body["refresh_token"] = refresh
    return Response(content=json.dumps(body), media_type="application/json",
                    headers={"Cache-Control": "no-store"})


# ------------------------------------------------------------------ AS: revocation
def _revoke_grant(grant_id: str, username: Optional[str] = None) -> bool:
    """Mark one grant revoked. Returns whether a live grant was found."""
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE oauth_refresh_tokens SET revoked_at=NOW()"
                " WHERE grant_id=%s AND revoked_at IS NULL"
                " AND (%s::text IS NULL OR username=%s)",
                (grant_id, username, username))
            return cur.rowcount > 0


@app.post("/api/oauth/revoke")
async def oauth_revoke(request: Request):
    """
    RFC 7009, for a client signing itself out.

    Takes either token. A refresh token is looked up by hash; an access token
    is decoded and its `grant` claim followed — revoking the grant either way,
    since an access token on its own cannot be revoked (it is a JWT).

    Always 200, whether or not anything matched: the spec says so, and a
    different answer would let a caller probe which tokens exist.
    """
    import hashlib
    form = await request.form()
    token = form.get("token") or ""
    client_id = form.get("client_id") or ""

    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT client_id, grant_id FROM oauth_refresh_tokens"
                        " WHERE token_hash=%s",
                        (hashlib.sha256(token.encode()).hexdigest(),))
            row = cur.fetchone()
    grant_id = row[1] if row else ""
    if row is None:
        try:
            claims = jwt.decode(token, _mcp_secret(), algorithms=[JWT_ALGORITHM],
                                audience=_mcp_resource(request))
            grant_id = claims.get("grant") or ""
            row = (claims.get("client_id", ""),)
        except jwt.InvalidTokenError:
            row = None

    # A public client authenticates only by naming itself; when it does, it may
    # only revoke its own tokens.
    if row is not None and (not client_id or hmac.compare_digest(row[0], client_id)):
        _revoke_grant(grant_id)
    return Response(status_code=200, headers={"Cache-Control": "no-store"})


# ------------------------------------------------------------------ AS: my grants
# The user-facing half of revocation: "which apps can act as me, and cut one
# off". Scoped to the caller's own grants only — an officer who leaves is cut
# off by deleting or suspending the account, which already kills every grant
# (FK cascade / the status check in mcp_caller).

@app.get("/api/me/oauth-grants")
def list_my_grants(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT grant_id, client_id, client_name, scope, created_at,"
                " last_used_at, expires_at FROM oauth_refresh_tokens"
                " WHERE username=%s AND revoked_at IS NULL"
                " AND (expires_at IS NULL OR expires_at > NOW())"
                " ORDER BY created_at DESC",
                (user["username"],))
            rows = cur.fetchall()
    iso = lambda d: d.isoformat() if d else None
    return [{
        "id": r[0],
        "clientId": r[1],
        "clientHost": _client_host(r[1]),
        "clientName": r[2] or "",
        "scopes": [{"key": s, "label": MCP_SCOPES.get(s, s),
                    "sensitive": s == "publish"} for s in (r[3] or "").split()],
        "createdAt": iso(r[4]),
        "lastUsedAt": iso(r[5]),
        "expiresAt": iso(r[6]),
    } for r in rows]


@app.delete("/api/me/oauth-grants/{grant_id}")
def revoke_my_grant(grant_id: str, user: dict = Depends(get_current_user)):
    if not _revoke_grant(grant_id, user["username"]):
        raise HTTPException(status_code=404, detail="找不到這個授權，可能已經撤銷或過期")
    return {"ok": True}


@app.delete("/api/me/oauth-grants")
def revoke_all_my_grants(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE oauth_refresh_tokens SET revoked_at=NOW()"
                        " WHERE username=%s AND revoked_at IS NULL",
                        (user["username"],))
            n = cur.rowcount
    return {"ok": True, "revoked": n}


# ==================================================================
# MCP — THE ENDPOINT AND ITS TOOLS
# ==================================================================
# Streamable HTTP, in its current shape: one POST endpoint, no sessions, no
# initialize handshake. Every request carries its own protocol version and
# capabilities in `_meta`, so nothing is remembered between calls — which is
# exactly what a serverless function can offer.
#
# Tools are thin wrappers over the same helpers the web UI uses. That is the
# whole safety argument: there is no second code path with its own idea of who
# may do what. `_social_scope` and the role checks run underneath every tool,
# and the OAuth scope only ever narrows what the token may ask for.

MCP_PROTOCOL_VERSIONS = ("2026-07-28",)
# Earlier revisions, still spoken by shipping clients (Claude Desktop among
# them): an `initialize` handshake, then the version in the
# MCP-Protocol-Version header. Served statelessly — no Mcp-Session-Id is ever
# issued, which those revisions allow — so the same serverless shape works.
MCP_LEGACY_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26")
MCP_SERVER_INFO = {"name": "entrepreneur-agenda", "version": "1.0.0"}


def _rpc_error(req_id, code, message, status=200, data=None):
    err = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    body = {"jsonrpc": "2.0", "error": err}
    if req_id is not None:
        body["id"] = req_id
    return Response(content=json.dumps(body, ensure_ascii=False),
                    status_code=status, media_type="application/json")


def _rpc_ok(req_id, result, legacy: bool = False):
    if not legacy:
        result = {"resultType": "complete", **result}
        result.setdefault("_meta", {})["io.modelcontextprotocol/serverInfo"] = MCP_SERVER_INFO
    return Response(
        content=json.dumps({"jsonrpc": "2.0", "id": req_id, "result": result},
                           ensure_ascii=False),
        media_type="application/json")


def _tool_text(text: str, structured=None, is_error: bool = False) -> dict:
    """
    A tool result.

    Failures a model can act on come back here with isError, not as JSON-RPC
    errors: the spec reserves protocol errors for malformed requests, and a
    model cannot correct itself from one.
    """
    out = {"content": [{"type": "text", "text": text}], "isError": is_error}
    if structured is not None:
        out["structuredContent"] = structured
    return out


# ------------------------------------------------------------------ tool bodies
def _officer_only(caller: dict):
    if caller["role"] not in ("system_admin", "club_admin"):
        raise HTTPException(status_code=403, detail="需要分會管理員以上權限")


def _club_label(name, name_zh, name_en):
    """Every name a person might call the club by, so a model can match any."""
    names = [n for n in (name_zh, name, name_en) if n]
    return " / ".join(dict.fromkeys(names)) or "（未命名）"


def _club_labels(cur) -> dict:
    cur.execute("SELECT id, name, name_zh, name_en FROM clubs")
    return {r[0]: _club_label(r[1], r[2], r[3]) for r in cur.fetchall()}


def _tool_list_clubs(caller, args):
    # A system admin sees every club; anyone else the clubs they belong to,
    # with their role in each and which one this grant is acting in.
    with get_db() as conn:
        with conn.cursor() as cur:
            labels = _club_labels(cur)
    ms = caller.get("memberships") or {}
    if caller["role"] != "system_admin":
        labels = {k: v for k, v in labels.items() if k in ms}
    items = [{"clubId": k, "name": labels[k],
              **({"role": ms[k], "current": k == caller["club_id"]}
                 if caller["role"] != "system_admin" else {})}
             for k in sorted(labels, key=lambda k: labels[k].lower())]
    lines = [f"club_id={i['clubId']} · {i['name']}"
             + (f"｜{_ROLE_NAMES.get(i['role'], i['role'])}" if "role" in i else "")
             + ("（目前操作中）" if i.get("current") else "")
             for i in items] or ["（沒有分會）"]
    if caller["role"] == "system_admin":
        lines.append("\n你是系統管理員：其他工具不帶 club_id 時會混合所有分會，"
                     "請帶上要操作的分會的 club_id。")
    elif len(items) > 1:
        lines.append("\n你屬於多個分會，一次操作一個；要換分會請用 switch_club。")
    return _tool_text("\n".join(lines), {"clubs": items})


def _tool_switch_club(caller, args):
    """
    The web's club switcher, for an MCP grant: which of the caller's clubs
    this grant acts in from now on, and so the role it acts with.
    """
    cid = int(args["club_id"])
    if caller["role"] == "system_admin":
        return _tool_text("系統管理員可以在各工具直接帶 club_id 操作任何分會，不需要切換。",
                          is_error=True)
    ms = caller.get("memberships") or {}
    with get_db() as conn:
        with conn.cursor() as cur:
            labels = _club_labels(cur)
            if cid not in ms:
                mine = "、".join(f"{labels.get(k, k)}（club_id={k}）" for k in ms) or "沒有"
                return _tool_text(f"你不是這個分會的會員。你所屬的分會：{mine}", is_error=True)
            cur.execute("UPDATE oauth_refresh_tokens SET active_club_id=%s WHERE grant_id=%s",
                        (cid, caller.get("grant") or ""))
    return _tool_text(f"已切換到「{labels.get(cid, cid)}」，你在這個分會的角色是"
                      f"{_ROLE_NAMES.get(ms[cid], ms[cid])}。之後的操作都會在這個分會進行。",
                      {"clubId": cid, "role": ms[cid]})


def _tool_list_meetings(caller, args):
    cid = _social_scope(caller, args.get("club_id"))
    limit = min(int(args.get("limit") or 10), 50)
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, data->>'meetingDate', data->>'meetingNo',"
                " data->>'meetingTheme', club_id FROM agendas"
                " WHERE (%s::int IS NULL OR club_id=%s)"
                " ORDER BY data->>'meetingDate' DESC NULLS LAST LIMIT %s",
                (cid, cid, limit))
            rows = cur.fetchall()
            labels = _club_labels(cur)
    # The club rides on every row: for a system admin with no club_id this
    # list spans clubs, and unlabelled it reads as if it were all one club.
    items = [{"agendaId": r[0], "date": r[1] or "", "meetingNo": r[2] or "",
              "theme": r[3] or "", "clubId": r[4], "club": labels.get(r[4], "")}
             for r in rows]
    lines = [f"{i['date']} 第{i['meetingNo']}次 · {i['theme']}"
             f"（agendaId={i['agendaId']}，{i['club']}，club_id={i['clubId']}）"
             for i in items] or ["（沒有例會）"]
    return _tool_text("\n".join(lines), {"meetings": items})


def _tool_get_meeting(caller, args):
    with get_db() as conn:
        with conn.cursor() as cur:
            f = _meeting_fields(cur, int(args["agenda_id"]), caller)
    f.pop("agenda", None)
    missing = [lb for k, lb in _KIND_REQUIRED["promo"] if not f.get(k)]
    text = "\n".join(f"{k}: {v}" for k, v in f.items() if v)
    if missing:
        text += "\n\n⚠️ 作為例會宣傳還缺：" + "、".join(missing)
    return _tool_text(text, {**f, "missingForPromo": missing})


def _tool_list_posts(caller, args):
    cid = _social_scope(caller, args.get("club_id"))
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(f"SELECT {_SOCIAL_COLS} FROM social_posts"
                        " WHERE (%s::int IS NULL OR club_id=%s)"
                        " ORDER BY created_at DESC LIMIT 50", (cid, cid))
            rows = [_social_row(r) for r in cur.fetchall()]
            labels = _club_labels(cur)
    items = [{"id": r["id"], "title": r["title"], "kind": r["kind"],
              "status": r["status"], "agendaId": r["agendaId"],
              "clubId": r["clubId"], "club": labels.get(r["clubId"], ""),
              "images": len(r["images"]), "published": sorted(r["published"])}
             for r in rows]
    lines = [f"#{i['id']} [{i['kind']}/{i['status']}] {i['title'] or '(無標題)'}"
             f" · {i['club']} · 圖 {i['images']}"
             + (f" · 已發布 {'、'.join(i['published'])}" if i["published"] else "")
             for i in items] or ["（沒有貼文）"]
    return _tool_text("\n".join(lines), {"posts": items})


def _tool_get_post(caller, args):
    with get_db() as conn:
        with conn.cursor() as cur:
            row = _social_row(_load_social_post(cur, int(args["post_id"]), caller))
    return _tool_text(json.dumps(row, ensure_ascii=False, indent=1), row)


def _tool_create_post(caller, args):
    _officer_only(caller)
    cid = _social_scope(caller, args.get("club_id"))
    kind = args.get("kind") if args.get("kind") in _POST_KINDS else "promo"
    # One empty slot per platform, the shape the browser creates a post with
    # (app/social/page.js). Code downstream fills slots that exist.
    variants = {p: {"text": "", "enabled": True} for p in SOCIAL_PLATFORMS}
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO social_posts (club_id, agenda_id, kind, title, status,"
                " body, variants, images) VALUES (%s,%s,%s,%s,'draft',%s,%s::jsonb,"
                "'[]'::jsonb) RETURNING id",
                (cid, args.get("agenda_id"), kind, (args.get("title") or "")[:200],
                 args.get("body") or "", json.dumps(variants)))
            new_id = cur.fetchone()[0]
    return _tool_text(f"已建立草稿 #{new_id}（{kind}）", {"postId": new_id, "kind": kind})


def _tool_update_post(caller, args):
    _officer_only(caller)
    post_id = int(args["post_id"])
    with get_db() as conn:
        with conn.cursor() as cur:
            row = _social_row(_load_social_post(cur, post_id, caller))
            variants = row["variants"]
            for k, v in (args.get("variants") or {}).items():
                if k in SOCIAL_PLATFORMS:
                    variants[k] = {"text": v if isinstance(v, str) else v.get("text", ""),
                                   "enabled": True}
            # A key sent as null means "not changing it", same as leaving it
            # out — models send nulls for optional fields routinely.
            def given(k, current):
                return current if args.get(k) is None else args[k]
            cur.execute(
                "UPDATE social_posts SET title=%s, body=%s, kind=%s, status=%s,"
                " agenda_id=%s, variants=%s::jsonb, updated_at=NOW() WHERE id=%s",
                (str(given("title", row["title"]) or "")[:200],
                 str(given("body", row["body"]) or ""),
                 args.get("kind") if args.get("kind") in _POST_KINDS else row["kind"],
                 args.get("status") if args.get("status") in _STATUSES else row["status"],
                 given("agenda_id", row["agendaId"]),
                 json.dumps(variants), post_id))
    return _tool_text(f"已更新貼文 #{post_id}", {"postId": post_id})


def _tool_generate_copy(caller, args):
    _officer_only(caller)
    post_id = int(args["post_id"])
    with get_db() as conn:
        with conn.cursor() as cur:
            row = _social_row(_load_social_post(cur, post_id, caller))
    req = SocialGenerateRequest(
        club_id=row["clubId"], agenda_id=row["agendaId"], kind=row["kind"],
        brief=args.get("brief") or "",
        platforms=[p for p in (args.get("platforms") or []) if p in SOCIAL_PLATFORMS],
        provider=args.get("provider") or "anthropic",
        model=args.get("model") or "")
    out = generate_social_copy(req, caller)      # same path the browser takes

    with get_db() as conn:
        with conn.cursor() as cur:
            variants = row["variants"]
            # Every platform that came back is kept, slot or no slot — a post
            # whose variants are missing a platform would otherwise drop that
            # platform's copy and quietly publish the generic body instead.
            for k, v in (out.get("variants") or {}).items():
                if k in SOCIAL_PLATFORMS:
                    variants[k] = {"text": v.get("text", ""),
                                   "enabled": v.get("enabled", True)}
            cur.execute("UPDATE social_posts SET title=COALESCE(NULLIF(title,''),%s),"
                        " body=%s, variants=%s::jsonb, updated_at=NOW() WHERE id=%s",
                        (out.get("title", ""), out.get("body", ""),
                         json.dumps(variants), post_id))
    return _tool_text(
        f"已為貼文 #{post_id} 產生文案並存檔。\n\n主文案：\n{out.get('body','')}",
        {"postId": post_id, "title": out.get("title", ""),
         "body": out.get("body", ""), "variants": out.get("variants", {})})


def _tool_publish_post(caller, args):
    _officer_only(caller)
    post_id = int(args["post_id"])
    platforms = [p for p in (args.get("platforms") or []) if p in _PUBLISHERS]
    if not platforms:
        return _tool_text("請指定至少一個平台（facebook / instagram / threads）",
                          is_error=True)
    with get_db() as conn:
        with conn.cursor() as cur:
            row = _social_row(_load_social_post(cur, post_id, caller))
    cid = _social_scope(caller, row["clubId"])

    # A model retries; a person says "post it again" meaning the one that
    # failed. Neither should put a second public copy on a platform that
    # already has one, so those are skipped unless asked for by name.
    done = [p for p in platforms if p in row["published"]]
    if done and not args.get("republish"):
        platforms = [p for p in platforms if p not in done]
        if not platforms:
            return _tool_text(
                "這則貼文已經發布到 " + "、".join(done) + "，沒有重複發布。"
                "若確定要再發一次（會出現第二則公開貼文），請帶 republish: true。",
                {"skipped": done}, is_error=True)
    out = _run_publish_job(caller["username"], cid,
                           {"post_id": post_id, "platforms": platforms})
    results = out.get("results", {})
    if done and not args.get("republish"):
        results.update({p: {"ok": True, "skipped": True,
                            "url": (row["published"].get(p) or {}).get("url", "")}
                        for p in done})
    lines = [f"{p}: " + ("先前已發布，略過 " + (r.get("url") or "") if r.get("skipped")
                         else "已發布 " + (r.get("url") or "") if r.get("ok")
                         else "失敗 — " + (r.get("error") or ""))
             for p, r in results.items()]
    return _tool_text("\n".join(lines), {"results": results},
                      is_error=not any(r.get("ok") for r in results.values()))


# ------------------------------------------------------------------ agendas
# The schema the editor writes (app/agenda/page.js collectData) and the roles
# matrix reads and writes (app/roles/page.js). A tool sets only the fields it
# is given and leaves the rest of `data` alone, so whatever else the editor
# stores — signals, time overrides, theme image — survives an MCP edit.

_AGENDA_TEXT_FIELDS = {
    "meetingDate":         "例會日期，YYYY-MM-DD",
    "meetingNo":           "場次編號",
    "meetingTheme":        "例會主題",
    "themeQuestion":       "主題題目（Chill Hi High 版型）",
    "timeRange":           "例會時間，例如 19:10 ~ 21:00",
    "venueInfo":           "地點，可多行",
    "receptionHost":       "報到接待",
    "callingToOrder":      "宣布例會開始",
    "welcomeTME":          "會長致歡迎詞",
    "tme":                 "總主持人",
    "timer":               "計時員",
    "timerAssistant":      "計時員幫手（Chill Hi High 版型）",
    "ahCounter":           "贅語記錄員",
    "boardWriter":         "板書（Chill Hi High 版型）",
    "photographer":        "攝影（Chill Hi High 版型）",
    "voteCounter":         "計票員（China 版型）",
    "tableTopicsMaster":   "即席問答主持人",
    "tableTopicsQuestion": "即席問答題目",
    "wordOfTheDay":        "每日一字（China 版型）",
    "quizHost":            "問答遊戲主持（China 版型）",
    "generalEvaluator":    "總講評",
    "langEvaluator":       "語言講評",
    "awardsPresenter":     "贈感謝狀",
    "sharingFeedback":     "會後分享 & 來賓回饋",
}
_SPEECH_KEYS = ("speaker", "title", "duration", "speechLang",
                "pathwayCode", "pathwayLevel", "pathwayProject")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _blank_speech() -> dict:
    """The shape app/agenda/page.js and app/roles/page.js both create."""
    return {"title": "", "speaker": "", "duration": "5'-7'", "speechLang": "en",
            "pathwayCode": "", "pathwayLevel": "", "pathwayProject": ""}


def _merge_slots(current, given, blank):
    """Index-wise merge: an entry given as null leaves that slot as it was."""
    out = list(current) if isinstance(current, list) else []
    for i, v in enumerate(given):
        while len(out) <= i:
            out.append(blank())
        if v is not None:
            out[i] = v
    return out


def _apply_agenda_fields(data: dict, fields: dict) -> list:
    """Merge MCP-supplied fields into `data`. Returns the keys it changed."""
    lists = ("speeches", "evaluators", "evalEvaluators", "varietySession", "lang")
    unknown = [k for k in fields if k not in _AGENDA_TEXT_FIELDS and k not in lists]
    if unknown:
        raise HTTPException(status_code=400, detail="不認得的議程欄位：" + "、".join(unknown))

    touched = []
    for k, v in fields.items():
        if v is None:
            continue
        if k in _AGENDA_TEXT_FIELDS:
            v = str(v)
            if k == "meetingDate" and not _DATE_RE.match(v):
                raise HTTPException(status_code=400, detail="meetingDate 格式要是 YYYY-MM-DD")
            data[k] = v
        elif k == "lang":
            if v not in ("zh", "en"):
                raise HTTPException(status_code=400, detail="lang 只能是 zh 或 en")
            data[k] = v
        elif k == "speeches":
            if not isinstance(v, list):
                raise HTTPException(status_code=400, detail="speeches 要是陣列")
            cur = data.get("speeches") if isinstance(data.get("speeches"), list) else []
            merged = _merge_slots(cur, [None] * len(v), _blank_speech)
            for i, item in enumerate(v):
                if item is None:
                    continue
                if not isinstance(item, dict):
                    raise HTTPException(status_code=400, detail="speeches 的每一項要是物件")
                for sk, sv in item.items():
                    if sk in _SPEECH_KEYS and sv is not None:
                        merged[i][sk] = str(sv)
            data["speeches"] = merged
        elif k in ("evaluators", "evalEvaluators"):
            if not isinstance(v, list):
                raise HTTPException(status_code=400, detail=f"{k} 要是陣列")
            data[k] = _merge_slots(data.get(k), [None if x is None else str(x) for x in v],
                                   lambda: "")
        elif k == "varietySession":
            if not isinstance(v, dict):
                raise HTTPException(status_code=400, detail="varietySession 要是物件")
            vs = dict(data.get("varietySession") or {"enabled": False, "duration": 15, "host": ""})
            if v.get("enabled") is not None:
                vs["enabled"] = bool(v["enabled"])
            if v.get("duration") is not None:
                vs["duration"] = int(v["duration"])
            if v.get("host") is not None:
                vs["host"] = str(v["host"])
            data[k] = vs
        touched.append(k)
    return touched


def _trim_slots(data: dict, args: dict) -> list:
    """`speech_count` / `evaluator_count`: the one way to remove a slot."""
    touched = []
    for arg, key, blank in (("speech_count", "speeches", _blank_speech),
                            ("evaluator_count", "evaluators", lambda: "")):
        n = args.get(arg)
        if n is None:
            continue
        n = max(0, min(int(n), 10))
        cur = data.get(key) if isinstance(data.get(key), list) else []
        data[key] = (cur + [blank() for _ in range(n)])[:n]
        touched.append(key)
    return touched


# --- the club's Google Sheet role plan --------------------------------------
# A port of lib/rolesSheet.js + the import half of app/roles/page.js, so an
# MCP import lands exactly what the 角色 page's 匯入 would. Kept as a port
# rather than shared code because the two run in different languages; the
# tables below are copied verbatim and must change together with those files.

_SHEET_DATE_ROW = "會議時間"
_SHEET_PERSON_ROWS = {
    "總主持人": "tme", "計時員": "timer", "計時員幫手": "timerAssistant",
    "贅字/笑聲記錄員": "ahCounter", "白板記錄員": "boardWriter", "攝影師": "photographer",
    "暖場活動主持人": "varietyHost", "即席問答主持人": "tableTopicsMaster",
    "總講評員": "generalEvaluator", "語言/幽默講評員": "langEvaluator",
    "講評員講評": "evalEvaluator1",
}
_SHEET_META_ROWS = {"會議編號": "meetingNo", "會議主題": "meetingTheme", "主題題目": "themeQuestion"}
_SHEET_IGNORED_ROWS = {"特別單元", "無法參加的成員"}
_SHEET_INDEXED_ROWS = [
    (re.compile(r"^演講者\s*(\d+)$"),     "speech{}",          True),
    (re.compile(r"^個別講評員\s*(\d+)$"), "evaluator{}",       True),
    (re.compile(r"^講評員講評\s*(\d+)$"), "evalEvaluator{}",   True),
    (re.compile(r"^標題\s*(\d+)$"),       "speech{}_title",    False),
    (re.compile(r"^單元號\s*(\d+)$"),     "speech{}_pathway",  False),
    (re.compile(r"^單元\s*(\d+)$"),       "speech{}_project",  False),
]
_SHEET_BLANKS = {"na", "n/a", "-", "—", "–", "tbd", "待定", "未定", "?", "？"}
# Roles only some templates have (ROLE_GROUPS / META_FIELDS `templates`). On
# any other template the 角色 page locks the row, and the import skips it.
_ROLE_TEMPLATES = {
    "callingToOrder": {"standard", "compact", "entrepreneur", "china"},
    "timerAssistant": {"chillhihigh"}, "boardWriter": {"chillhihigh"},
    "photographer": {"chillhihigh"}, "voteCounter": {"china"},
    "varietyHost": {"standard", "compact", "entrepreneur", "chillhihigh"},
    "wordOfTheDay": {"china"}, "quizHost": {"china"},
}
_SPEECH_SUBFIELDS = {"title": "title", "pwcode": "pathwayCode",
                     "pwlevel": "pathwayLevel", "project": "pathwayProject"}
_SLOT_RE = re.compile(r"^(speech|evaluator|evalEvaluator)(\d+)(?:_(title|pwcode|pwlevel|project))?$")


def _sheet_clean(v) -> str:
    return re.sub(r"\s+", " ", str(v or "")).strip()


def _sheet_iso_date(raw: str) -> str:
    m = re.match(r"^(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})$", _sheet_clean(raw))
    return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}" if m else ""


def _sheet_is_person(rid: str) -> bool:
    return rid not in _SHEET_META_ROWS.values() and \
        not re.search(r"_(title|pwcode|pwlevel|project)$", rid)


def _parse_roles_sheet(csv_text: str, pathway_codes: set) -> dict:
    """CSV → {iso date: {role id: value}}, as parseRolesSheet does."""
    import csv
    import io
    grid = list(csv.reader(io.StringIO(csv_text.lstrip("﻿"))))
    date_row = next((r for r in grid if r and _sheet_clean(r[0]) == _SHEET_DATE_ROW), None)
    if date_row is None:
        raise HTTPException(status_code=400,
                            detail=f"試算表找不到「{_SHEET_DATE_ROW}」這一列，請確認分頁與欄位格式")
    cols = {c: _sheet_iso_date(v) for c, v in enumerate(date_row) if c and _sheet_iso_date(v)}
    out = {d: {} for d in cols.values()}

    for row in grid:
        label = _sheet_clean(row[0]) if row else ""
        if not label or label == _SHEET_DATE_ROW or label in _SHEET_IGNORED_ROWS:
            continue
        rid = _SHEET_PERSON_ROWS.get(label) or _SHEET_META_ROWS.get(label)
        person = _sheet_is_person(rid) if rid else False
        if not rid:
            for rx, fmt, is_person in _SHEET_INDEXED_ROWS:
                m = rx.match(label)
                if m:
                    rid, person = fmt.format(m.group(1)), is_person
                    break
        if not rid:
            continue
        for c, date in cols.items():
            raw = _sheet_clean(row[c]) if c < len(row) else ""
            if not raw or (person and raw.lower() in _SHEET_BLANKS):
                continue
            if rid.endswith("_pathway"):
                # One cell (`PM 4-1`) feeds two fields, as splitPathway does.
                m = re.match(r"^([A-Za-z]{2,4})\b[\s-]*(.*)$", raw)
                code, level = ("", raw)
                if m and m.group(1).upper() in pathway_codes:
                    code, level = m.group(1).upper(), _sheet_clean(m.group(2))
                base = rid[: -len("_pathway")]
                if code:
                    out[date][f"{base}_pwcode"] = code
                if level:
                    out[date][f"{base}_pwlevel"] = level
            else:
                out[date][rid] = raw
    return out


def _role_get(data: dict, rid: str) -> str:
    m = _SLOT_RE.match(rid)
    if m:
        kind, idx, sub = m.group(1), int(m.group(2)) - 1, m.group(3)
        if kind == "speech":
            sp = (data.get("speeches") or [])[idx:idx + 1]
            return (sp[0] or {}).get(_SPEECH_SUBFIELDS[sub] if sub else "speaker", "") if sp else ""
        lst = data.get(kind + "s") or []
        return lst[idx] if idx < len(lst) else ""
    if rid == "varietyHost":
        return (data.get("varietySession") or {}).get("host", "")
    return data.get(rid) or ""


def _role_set(data: dict, rid: str, value: str):
    """roleSet in app/roles/page.js — including its slot growth."""
    m = _SLOT_RE.match(rid)
    if m:
        kind, idx, sub = m.group(1), int(m.group(2)) - 1, m.group(3)
        if kind == "speech":
            data["speeches"] = _merge_slots(data.get("speeches"), [None] * (idx + 1), _blank_speech)
            data["speeches"][idx][_SPEECH_SUBFIELDS[sub] if sub else "speaker"] = value
        else:
            key = kind + "s"
            data[key] = _merge_slots(data.get(key), [None] * (idx + 1), lambda: "")
            data[key][idx] = value
    elif rid == "varietyHost":
        vs = dict(data.get("varietySession") or {"enabled": False, "duration": 15, "host": ""})
        vs["host"] = value
        if value:
            vs["enabled"] = True
        data["varietySession"] = vs
    else:
        data[rid] = value


def _role_label(rid: str) -> str:
    """`tme` → 總主持人, `speech2_title` → 第 2 篇演講的講題 — for messages."""
    m = _SLOT_RE.match(rid)
    if m:
        noun = {"speech": "演講者", "evaluator": "個別講評員", "evalEvaluator": "講評員講評"}[m.group(1)]
        sub = {"title": "講題", "pwcode": "學習路徑", "pwlevel": "等級", "project": "專案"}
        return f"{noun} #{m.group(2)}" + (f" {sub[m.group(3)]}" if m.group(3) else "")
    if rid == "varietyHost":
        return "多元單元主持人"
    return _AGENDA_TEXT_FIELDS.get(rid, rid).split("，")[0].split("（")[0]


def _resolve_member(raw: str, roster, lang: str):
    """
    resolveMemberName in lib/rolesSheet.js: a name in any of the forms people
    write it (`Leah Kao 高莉雅`, `高莉雅`, `Leah Kao, DTM`) → the roster's
    canonical `Name, LEVEL` in the agenda's language. Returns (value, matched);
    a name not on the roster — a guest — is kept as written.
    """
    v = _sheet_clean(raw)
    key = v.lower()
    eq = lambda s: _sheet_clean(s).lower() == key
    for en, zh, level in roster:
        if (eq(en) or eq(zh) or eq(f"{en} {zh}") or eq(f"{zh} {en}")
                or (level and (eq(f"{en}, {level}") or eq(f"{zh}, {level}")))):
            name = (zh if lang == "zh" else en) or en or zh or ""
            return (f"{name}, {level}" if level else name), True
    return v, False


def _club_role_context(club_id: int) -> dict:
    """What placing a role on this club's agendas depends on."""
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT code FROM pathways")
            codes = {r[0].upper() for r in cur.fetchall()}
            cur.execute("SELECT template_key FROM clubs WHERE id=%s", (club_id,))
            tmpl = ((cur.fetchone() or [None])[0]) or "compact"
            cur.execute("SELECT u.name_en, u.name_zh, u.level FROM club_memberships m"
                        " JOIN users u ON u.username = m.username WHERE m.club_id=%s", (club_id,))
            roster = cur.fetchall()
    return {"codes": codes, "template": tmpl, "roster": roster}


def _apply_role_values(data: dict, values: dict, ctx: dict, overwrite: bool) -> dict:
    """
    Put {role id: value} onto one agenda's data, the way the 角色 page does:
    roles the club's template lacks are skipped, person cells are resolved
    against the roster, and — without `overwrite` — a cell already holding a
    different value is left alone and reported. That last rule is the
    distinction the page's import preview draws between filling a blank and
    undoing someone's edit.
    """
    lang = "zh" if data.get("lang") == "zh" else "en"
    out = {"applied": 0, "kept": [], "unmatched": [], "locked": []}
    for rid, raw in values.items():
        allow = _ROLE_TEMPLATES.get(rid)
        if allow and ctx["template"] not in allow:
            out["locked"].append(_role_label(rid))
            continue
        value = str(raw or "")
        if value and _sheet_is_person(rid):
            value, hit = _resolve_member(value, ctx["roster"], lang)
            if not hit:
                out["unmatched"].append(value)
        before = str(_role_get(data, rid) or "")
        if before == value:
            continue
        if before and not overwrite:
            out["kept"].append(f"{_role_label(rid)}：保留「{before}」（新的是「{value}」）")
            continue
        _role_set(data, rid, value)
        out["applied"] += 1
    return out


def _role_report(r: dict, what: str, overwrite_hint: str) -> list:
    lines = [f"{what} {r['applied']} 個欄位"]
    if r["kept"]:
        lines.append(f"已有內容、沒有覆蓋（要覆蓋請帶 {overwrite_hint}: true）：\n  "
                     + "\n  ".join(r["kept"]))
    if r["unmatched"]:
        lines.append("不在會員名單、照原文填入：" + "、".join(dict.fromkeys(r["unmatched"])))
    if r["locked"]:
        lines.append("這個分會的版型沒有、略過：" + "、".join(dict.fromkeys(r["locked"])))
    return lines


def _sheet_values(caller: dict, club_id: int, ctx: dict) -> dict:
    """The club's role sheet as {iso date: {role id: value}}."""
    csv_text = fetch_roles_sheet(club_id, caller)["csv"]    # raises with the reason
    return _parse_roles_sheet(csv_text, ctx["codes"])


def _import_sheet_roles(caller: dict, club_id: int, data: dict, overwrite: bool) -> list:
    """Fill one agenda from the sheet column for its date. Returns report lines."""
    date = data.get("meetingDate") or ""
    if not date:
        return ["沒有例會日期，無法對應試算表的欄位"]
    ctx = _club_role_context(club_id)
    values = _sheet_values(caller, club_id, ctx).get(date)
    if values is None:
        return [f"角色試算表裡沒有 {date} 這一欄，角色沒有匯入"]
    return _role_report(_apply_role_values(data, values, ctx, overwrite),
                        "從角色試算表匯入", "overwrite_roles")


def _agenda_for(cur, agenda_id: int, caller: dict):
    cur.execute("SELECT data, club_id FROM agendas WHERE id=%s", (agenda_id,))
    row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="找不到這份議程")
    if caller["role"] != "system_admin" and row[1] != caller["club_id"]:
        raise HTTPException(status_code=403, detail="無權存取其他分會的資料")
    return parse_jsonb(row[0]), row[1]


def _agenda_summary(agenda_id: int, data: dict) -> str:
    sp = [s.get("speaker") or "（未定）" for s in (data.get("speeches") or [])]
    return (f"議程 #{agenda_id}：{data.get('meetingDate', '')} 第{data.get('meetingNo', '')}次"
            f"「{data.get('meetingTheme', '')}」｜總主持 {data.get('tme') or '（未定）'}"
            f"｜演講 {'、'.join(sp) or '無'}")


def _tool_get_agenda(caller, args):
    with get_db() as conn:
        with conn.cursor() as cur:
            data, cid = _agenda_for(cur, int(args["agenda_id"]), caller)
    return _tool_text(json.dumps(data, ensure_ascii=False, indent=1),
                      {"agendaId": int(args["agenda_id"]), "clubId": cid, "data": data})


def _tool_create_agenda(caller, args):
    _officer_only(caller)
    cid = _social_scope(caller, args.get("club_id"))
    if cid is None:
        return _tool_text("系統管理員建立議程時請指定 club_id（用 list_clubs 查）", is_error=True)
    fields = dict(args.get("fields") or {})
    date = fields.get("meetingDate")
    if not date:
        return _tool_text("請在 fields 裡給 meetingDate（YYYY-MM-DD）", is_error=True)

    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM agendas WHERE club_id=%s AND meeting_date=%s",
                        (cid, date))
            dup = cur.fetchone()
            # Time and venue rarely change between meetings: take them from the
            # club's latest agenda, then its standing settings — what the
            # editor's own new-agenda defaults would show.
            cur.execute("SELECT data FROM agendas WHERE club_id=%s"
                        " ORDER BY meeting_date DESC NULLS LAST, id DESC LIMIT 1", (cid,))
            prev = parse_jsonb((cur.fetchone() or [None])[0])
            cur.execute("SELECT settings FROM clubs WHERE id=%s", (cid,))
            st = parse_jsonb((cur.fetchone() or [None])[0])
    if dup and not args.get("allow_duplicate"):
        return _tool_text(f"這個分會 {date} 已經有議程 #{dup[0]}。要修改請用 update_agenda；"
                          "確定要另建一份請帶 allow_duplicate: true。",
                          {"existingAgendaId": dup[0]}, is_error=True)

    data = {
        "meetingDate": date,
        "timeRange": prev.get("timeRange") or st.get("timeRange") or "",
        "venueInfo": prev.get("venueInfo") or st.get("venue") or "",
        "speeches": [_blank_speech() for _ in range(3)],
        "evaluators": ["", "", ""],
        "evalEvaluators": [],
    }
    if prev.get("lang"):
        data["lang"] = prev["lang"]
    _apply_agenda_fields(data, fields)
    _trim_slots(data, args)
    notes = _import_sheet_roles(caller, cid, data, overwrite=bool(args.get("overwrite_roles"))) \
        if args.get("import_roles") else []

    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO agendas (username, data, meeting_date, club_id)"
                " VALUES (%s, %s::jsonb, %s, %s) RETURNING id",
                (caller["username"], json.dumps(data), data["meetingDate"], cid))
            new_id = cur.fetchone()[0]
    return _tool_text("\n".join([f"已建立{_agenda_summary(new_id, data)}"] + notes),
                      {"agendaId": new_id, "clubId": cid})


def _tool_update_agenda(caller, args):
    _officer_only(caller)
    aid = int(args["agenda_id"])
    with get_db() as conn:
        with conn.cursor() as cur:
            data, cid = _agenda_for(cur, aid, caller)
    touched = _apply_agenda_fields(data, args.get("fields") or {}) + _trim_slots(data, args)
    notes = _import_sheet_roles(caller, cid, data, overwrite=bool(args.get("overwrite_roles"))) \
        if args.get("import_roles") else []
    if not touched and not args.get("import_roles"):
        return _tool_text("沒有要修改的欄位", is_error=True)

    # The sheet fetch above is a network call; the row is re-read nowhere in
    # between, so the write is a plain replace — the same last-writer-wins the
    # editor's own 儲存 has.
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE agendas SET data=%s::jsonb, meeting_date=%s, updated_at=NOW()"
                        " WHERE id=%s", (json.dumps(data), data.get("meetingDate") or None, aid))
    return _tool_text("\n".join([f"已更新{_agenda_summary(aid, data)}"] + notes),
                      {"agendaId": aid, "changed": touched})


def _render_origin(caller: dict) -> str:
    """
    Where app/svc/agenda-export lives. Production uses its stable domain
    rather than the request's Host — the call carries a login token, so it
    goes only to a host this deployment names itself.
    """
    if os.getenv("AGENDA_RENDER_URL"):
        return os.getenv("AGENDA_RENDER_URL").rstrip("/")
    prod = os.getenv("VERCEL_PROJECT_PRODUCTION_URL")
    if os.getenv("VERCEL_ENV") == "production" and prod:
        return f"https://{prod}"
    return caller["origin"]


_EXPORT_MAX_PAGES = 4


def _tool_export_agenda(caller, args):
    import urllib.error
    import urllib.request
    aid = int(args["agenda_id"])
    formats = [f for f in (args.get("formats") or ["pdf", "jpg"]) if f in ("pdf", "jpg")]
    if not formats:
        return _tool_text("formats 要包含 pdf 或 jpg", is_error=True)
    with get_db() as conn:
        with conn.cursor() as cur:
            data, cid = _agenda_for(cur, aid, caller)

    # Unguessable names: these URLs are public (the bucket serves anyone who
    # has the link), like every other image this app publishes.
    stem = f"Agenda_{data.get('meetingDate') or 'agenda'}_No{data.get('meetingNo') or ''}"
    base = f"media/clubs/{cid}/agendas/{uuid.uuid4().hex[:12]}/{stem}"
    client = _r2()

    def presign(key, ctype):
        return client.generate_presigned_url(
            "put_object", Params={"Bucket": R2_BUCKET_NAME, "Key": key, "ContentType": ctype},
            ExpiresIn=300)

    keys = {"pdf": f"{base}.pdf",
            "jpg": [f"{base}_p{i + 1}.jpg" for i in range(_EXPORT_MAX_PAGES)]}
    uploads = {}
    if "pdf" in formats:
        uploads["pdf"] = presign(keys["pdf"], "application/pdf")
    if "jpg" in formats:
        uploads["jpg"] = [presign(k, "image/jpeg") for k in keys["jpg"]]

    # A five-minute login token for this one render: the page is opened as the
    # caller, so it can show only what they could open themselves.
    token = jwt.encode({"sub": caller["username"],
                        "exp": datetime.now(timezone.utc) + timedelta(minutes=5)},
                       JWT_SECRET, algorithm=JWT_ALGORITHM)
    req = urllib.request.Request(
        f"{_render_origin(caller)}/svc/agenda-export",
        # clubId: the page is opened acting in the agenda's club (the caller
        # was just checked to have access there via _agenda_for).
        data=json.dumps({"token": token, "agendaId": aid, "clubId": cid, "formats": formats,
                         "uploads": uploads}).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=55) as res:
            out = json.loads(res.read())
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read()).get("detail")
        except Exception:
            detail = None
        return _tool_text(detail or f"議程輸出失敗（HTTP {e.code}）", is_error=True)
    except Exception:
        return _tool_text("議程輸出逾時或連線失敗，請稍後再試", is_error=True)

    files = []
    if out.get("pdf"):
        files.append({"format": "pdf", "url": f"{R2_PUBLIC_URL}/{keys['pdf']}"})
    for i in range(int(out.get("jpgPages") or 0)):
        files.append({"format": "jpg", "page": i + 1,
                      "url": f"{R2_PUBLIC_URL}/{keys['jpg'][i]}"})
    lines = [f"{f['format'].upper()}{'（第 %d 頁）' % f['page'] if 'page' in f else ''}：{f['url']}"
             for f in files]
    return _tool_text("議程檔案（任何拿到連結的人都能開啟）：\n" + "\n".join(lines),
                      {"agendaId": aid, "files": files})


# ------------------------------------------------------------------ post images
_IMAGE_MAX_BYTES = 15 * 1024 * 1024
_IMAGE_EXT = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"}


def _sniff_image(raw: bytes) -> str:
    if raw[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    if raw[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return ""


def _download_image(url: str) -> bytes:
    """
    Fetch an image a client points us at. Same SSRF rules as the CIMD fetch,
    except that redirects are followed — file hosts (ChatGPT's among them)
    hand out a link that redirects to blob storage — with every hop's host
    checked again, so a redirect cannot walk us into the internal network.
    """
    import urllib.error
    import urllib.parse
    import urllib.request

    class _Manual(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **kw):
            return None

    opener = urllib.request.build_opener(_Manual)
    for _ in range(4):
        u = urllib.parse.urlparse(url)
        if u.scheme != "https" or _host_is_internal(u.hostname or ""):
            raise HTTPException(status_code=400, detail="圖片網址必須是公開的 https 網址")
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (compatible; entrepreneur-agenda-mcp/1.0)"})
        try:
            with opener.open(req, timeout=20) as res:
                raw = res.read(_IMAGE_MAX_BYTES + 1)
            break
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308) and e.headers.get("Location"):
                url = urllib.parse.urljoin(url, e.headers["Location"])
                continue
            raise HTTPException(status_code=400, detail=f"下載圖片失敗（HTTP {e.code}）")
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(status_code=400, detail="下載圖片失敗（連線失敗）")
    else:
        raise HTTPException(status_code=400, detail="圖片網址轉址次數過多")
    if len(raw) > _IMAGE_MAX_BYTES:
        raise HTTPException(status_code=400, detail="圖片超過 15 MB")
    return raw


def _attach_post_image(post_row: dict, item: dict) -> int:
    """Append one stored image to a post. Returns its 1-based position."""
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE social_posts SET images = COALESCE(images,'[]'::jsonb) || %s::jsonb,"
                        " updated_at=NOW() WHERE id=%s"
                        " RETURNING jsonb_array_length(images)",
                        (json.dumps([item]), post_row["id"]))
            return cur.fetchone()[0]


def _tool_add_post_image(caller, args):
    import base64
    _officer_only(caller)
    post_id = int(args["post_id"])
    with get_db() as conn:
        with conn.cursor() as cur:
            row = _social_row(_load_social_post(cur, post_id, caller))

    # Three ways in, whichever the client can manage: a ChatGPT file
    # parameter ({download_url}), any public URL, or the bytes themselves.
    f = args.get("image") if isinstance(args.get("image"), dict) else {}
    url = f.get("download_url") or args.get("image_url")
    if url:
        raw = _download_image(str(url))
    elif args.get("image_base64"):
        b64 = str(args["image_base64"])
        try:
            raw = base64.b64decode(b64[b64.find(",") + 1:] if b64.startswith("data:") else b64,
                                   validate=False)
        except Exception:
            return _tool_text("image_base64 不是有效的 base64", is_error=True)
        if len(raw) > _IMAGE_MAX_BYTES:
            return _tool_text("圖片超過 15 MB", is_error=True)
    else:
        return _tool_text("請提供 image（檔案）、image_url 或 image_base64 其中一個", is_error=True)

    ctype = _sniff_image(raw)
    if not ctype:
        return _tool_text("這不是支援的圖片格式（JPG、PNG、WebP、GIF）", is_error=True)

    cid = row["clubId"]
    base = f"media/clubs/{cid}/social" if cid else "media/social"
    key = f"{base}/{uuid.uuid4()}.{_IMAGE_EXT[ctype]}"
    try:
        _r2().put_object(Bucket=R2_BUCKET_NAME, Key=key, Body=raw, ContentType=ctype)
    except Exception:
        return _tool_text("圖片上傳雲端失敗，請稍後再試", is_error=True)
    item = {"url": f"{R2_PUBLIC_URL}/{key}", "type": "image",
            "name": str(args.get("name") or f.get("name") or "MCP 上傳圖片")[:200]}
    n = _attach_post_image(row, item)
    note = "" if ctype == "image/jpeg" else \
        "（提醒：Instagram 只接受 JPG，這張若要發 IG 可能會失敗）"
    return _tool_text(f"已加到貼文 #{post_id}，目前第 {n} 張{note}：{item['url']}",
                      {"postId": post_id, "position": n, "image": item})


def _tool_remove_post_image(caller, args):
    _officer_only(caller)
    post_id, pos = int(args["post_id"]), int(args["position"])
    with get_db() as conn:
        with conn.cursor() as cur:
            row = _social_row(_load_social_post(cur, post_id, caller))
            imgs = list(row["images"])
            if not 1 <= pos <= len(imgs):
                return _tool_text(f"貼文 #{post_id} 只有 {len(imgs)} 張圖", is_error=True)
            gone = imgs.pop(pos - 1)
            cur.execute("UPDATE social_posts SET images=%s::jsonb, updated_at=NOW() WHERE id=%s",
                        (json.dumps(imgs), post_id))
    return _tool_text(f"已從貼文 #{post_id} 移除第 {pos} 張圖（剩 {len(imgs)} 張）",
                      {"postId": post_id, "removed": gone, "remaining": len(imgs)})


def _tool_generate_post_image(caller, args):
    _officer_only(caller)
    post_id = int(args["post_id"])
    with get_db() as conn:
        with conn.cursor() as cur:
            row = _social_row(_load_social_post(cur, post_id, caller))
    # The same generator the 生圖 button uses, billed to the same account.
    item = _generate_image(caller["username"], row["clubId"], {
        "prompt": args.get("prompt") or "",
        "size": args.get("size") or "1024x1024",
        "quality": args.get("quality"),
        "model": args.get("model"),
    })
    n = _attach_post_image(row, item)
    return _tool_text(f"已產生圖片並加到貼文 #{post_id}，目前第 {n} 張：{item['url']}",
                      {"postId": post_id, "position": n, "image": item})


# ------------------------------------------------------------------ roles (角色安排)
# The 角色安排 page is a view over agendas.data — there is no separate role
# store — so these tools read and write the same fields, with the same role
# ids (app/roles/page.js ROLE_GROUPS) and the same rules as the page.

_ROLE_IDS_DOC = (
    "角色 id：receptionHost 報到接待、callingToOrder 宣布例會開始、welcomeTME 會長致歡迎詞、"
    "tme 總主持人、timer 計時員、timerAssistant 計時員幫手、ahCounter 贅語記錄員、"
    "boardWriter 板書、photographer 攝影、voteCounter 計票員、varietyHost 多元單元主持人、"
    "tableTopicsMaster 即席問答主持人、wordOfTheDay 每日一字、quizHost 問答遊戲主持、"
    "langEvaluator 語言講評、generalEvaluator 總講評、awardsPresenter 贈感謝狀、"
    "sharingFeedback 會後分享、meetingNo 場次、meetingTheme 主題、themeQuestion 主題題目；"
    "第 N 篇演講：speechN（演講者）、speechN_title、speechN_pwcode、speechN_pwlevel、"
    "speechN_project；evaluatorN 第 N 位個別講評員；evalEvaluatorN 講評員講評")

# Rows of the matrix, in the page's order, for get_roles' summary.
_ROLE_ROWS = ("receptionHost", "callingToOrder", "welcomeTME", "tme", "timer",
              "timerAssistant", "ahCounter", "boardWriter", "photographer", "voteCounter",
              "varietyHost", "tableTopicsMaster", "wordOfTheDay", "quizHost",
              "langEvaluator", "generalEvaluator", "awardsPresenter", "sharingFeedback")


def _meeting_roles(data: dict, template: str) -> dict:
    """Every filled role on one agenda as {role id: value}, slots expanded."""
    out = {}
    for rid in _ROLE_ROWS:
        allow = _ROLE_TEMPLATES.get(rid)
        if allow and template not in allow:
            continue
        v = _role_get(data, rid)
        if v:
            out[rid] = v
    for i, sp in enumerate(data.get("speeches") or []):
        for sub, field in (("", "speaker"), ("_title", "title"),
                           ("_pwcode", "pathwayCode"), ("_pwlevel", "pathwayLevel"),
                           ("_project", "pathwayProject")):
            if (sp or {}).get(field):
                out[f"speech{i + 1}{sub}"] = sp[field]
    for key, pre in (("evaluators", "evaluator"), ("evalEvaluators", "evalEvaluator")):
        for i, v in enumerate(data.get(key) or []):
            if v:
                out[f"{pre}{i + 1}"] = v
    return out


def _tool_get_roles(caller, args):
    cid = _social_scope(caller, args.get("club_id"))
    if cid is None:
        return _tool_text("系統管理員請指定 club_id（用 list_clubs 查）", is_error=True)
    date_from = args.get("date_from") or datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d")
    date_to = args.get("date_to")
    limit = min(int(args.get("limit") or 8), 30)
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT template_key FROM clubs WHERE id=%s", (cid,))
            tmpl = ((cur.fetchone() or [None])[0]) or "compact"
            cur.execute(
                "SELECT id, meeting_date, data FROM agendas WHERE club_id=%s"
                " AND meeting_date >= %s AND (%s::date IS NULL OR meeting_date <= %s)"
                " ORDER BY meeting_date LIMIT %s",
                (cid, date_from, date_to, date_to, limit))
            rows = cur.fetchall()
    meetings = []
    lines = []
    for aid, date, raw in rows:
        data = parse_jsonb(raw)
        roles = _meeting_roles(data, tmpl)
        meetings.append({"agendaId": aid, "date": str(date), "meetingNo": data.get("meetingNo", ""),
                         "theme": data.get("meetingTheme", ""), "roles": roles})
        filled = "、".join(f"{_role_label(k)}={v}" for k, v in roles.items()) or "（尚未安排）"
        lines.append(f"{date} 第{data.get('meetingNo', '')}次（agendaId={aid}）：{filled}")
    return _tool_text("\n".join(lines) or f"{date_from} 之後沒有議程",
                      {"clubId": cid, "template": tmpl, "meetings": meetings})


def _tool_assign_roles(caller, args):
    _officer_only(caller)
    aid = int(args["agenda_id"])
    roles = args.get("roles") or {}
    if not isinstance(roles, dict) or not roles:
        return _tool_text("roles 要是 {角色 id: 人名} 的物件", is_error=True)
    # Role cells and the matrix's column-header fields only — a date or venue
    # changed here would skip update_agenda's handling of them.
    bad = [k for k in roles if not (k in _ROLE_ROWS or k in _SHEET_META_ROWS.values()
                                    or _SLOT_RE.match(k))]
    if bad:
        return _tool_text("不認得的角色 id：" + "、".join(bad) + "。" + _ROLE_IDS_DOC, is_error=True)
    with get_db() as conn:
        with conn.cursor() as cur:
            data, cid = _agenda_for(cur, aid, caller)
    report = _apply_role_values(data, {k: ("" if v is None else str(v)) for k, v in roles.items()},
                                _club_role_context(cid), overwrite=args.get("overwrite", True))
    if report["applied"]:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("UPDATE agendas SET data=%s::jsonb, updated_at=NOW() WHERE id=%s",
                            (json.dumps(data), aid))
    return _tool_text("\n".join([_agenda_summary(aid, data)]
                                + _role_report(report, "已安排", "overwrite")),
                      {"agendaId": aid, "applied": report["applied"],
                       "unmatched": report["unmatched"], "skipped": report["locked"]})


def _tool_import_roles_sheet(caller, args):
    """The 角色 page's 從 Google Sheet 匯入, for a whole date range at once."""
    _officer_only(caller)
    cid = _social_scope(caller, args.get("club_id"))
    if cid is None:
        return _tool_text("系統管理員請指定 club_id（用 list_clubs 查）", is_error=True)
    ctx = _club_role_context(cid)
    sheet = _sheet_values(caller, cid, ctx)
    lo, hi = args.get("date_from") or "", args.get("date_to") or "9999-12-31"
    dates = sorted(d for d in sheet if lo <= d <= hi)
    if not dates:
        return _tool_text("試算表在這個日期範圍沒有任何例會欄", is_error=True)

    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id, meeting_date, data FROM agendas"
                        " WHERE club_id=%s AND meeting_date = ANY(%s::date[])", (cid, dates))
            existing = {str(r[1]): (r[0], parse_jsonb(r[2])) for r in cur.fetchall()}

    overwrite = bool(args.get("overwrite"))
    lines, changed, created, skipped_new = [], [], 0, []
    for d in dates:
        values = sheet[d]
        if d in existing:
            aid, data = existing[d]
        elif not any(k not in _SHEET_META_ROWS.values() for k in values):
            # Columns holding only the season's pre-filled 會議編號 are empty
            # slots, not planned meetings — the page's importer skips them too.
            continue
        elif args.get("create_missing"):
            aid, data = None, {"meetingDate": d}
        else:
            skipped_new.append(d)
            continue
        report = _apply_role_values(data, values, ctx, overwrite)
        if aid is None or report["applied"]:
            changed.append((aid, d, data))
        tag = "新建" if aid is None else f"#{aid}"
        line = f"{d}（{tag}）：填入 {report['applied']} 個欄位"
        if report["kept"]:
            line += f"，{len(report['kept'])} 個已有內容沒覆蓋"
        if report["unmatched"]:
            line += "，不在名單：" + "、".join(dict.fromkeys(report["unmatched"]))
        lines.append(line)

    with get_db() as conn:
        with conn.cursor() as cur:
            for aid, d, data in changed:
                if aid is None:
                    cur.execute("INSERT INTO agendas (username, data, meeting_date, club_id)"
                                " VALUES (%s, %s::jsonb, %s, %s)",
                                (caller["username"], json.dumps(data), d, cid))
                    created += 1
                else:
                    cur.execute("UPDATE agendas SET data=%s::jsonb, updated_at=NOW()"
                                " WHERE id=%s", (json.dumps(data), aid))
    if skipped_new:
        lines.append("系統裡還沒有議程、沒有建立（要建立請帶 create_missing: true）："
                     + "、".join(skipped_new))
    if not overwrite and any("沒覆蓋" in l for l in lines):
        lines.append("要以試算表為準覆蓋已填的角色，請帶 overwrite: true")
    return _tool_text("\n".join([f"已更新 {len(changed) - created} 份、新建 {created} 份議程"]
                                + lines),
                      {"clubId": cid, "updated": len(changed) - created, "created": created})


def _tool_list_members(caller, args):
    """The roster role names should be written from — names only."""
    cid = _social_scope(caller, args.get("club_id"))
    if cid is None:
        return _tool_text("系統管理員請指定 club_id（用 list_clubs 查）", is_error=True)
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT u.name_en, u.name_zh, u.level,"
                        " CASE WHEN u.role = 'system_admin' THEN u.role ELSE m.role END"
                        " FROM club_memberships m JOIN users u ON u.username = m.username"
                        " WHERE m.club_id=%s AND u.status <> 'pending'"
                        " ORDER BY u.name_en", (cid,))
            rows = cur.fetchall()
    items = [{"nameEn": r[0] or "", "nameZh": r[1] or "", "level": r[2] or "",
              "role": r[3]} for r in rows]
    lines = [f"{i['nameEn']} {i['nameZh']}" + (f", {i['level']}" if i["level"] else "")
             for i in items] or ["（沒有會員）"]
    return _tool_text("\n".join(lines), {"clubId": cid, "members": items})


# ------------------------------------------------------------------ clubs (分會管理)
# Same rule as PUT /api/clubs/{id}: system admins only. What can be edited is
# what the 分會管理 page edits — the club's own columns plus the template
# fields each template declares (lib/agendaTemplates.js `settings` manifests).
# Other keys in clubs.settings (the Meta / Threads app ids) belong to other
# screens and are neither shown nor writable here.

_CLUB_COLUMNS = {
    "name": "分會名稱（必填、不可重複）", "name_zh": "中文名稱", "name_en": "英文名稱",
    "charter_no": "章程編號 / Club No.", "founded_date": "成立日", "fee": "入場費",
    "template_key": "議程版型：standard、compact、chillhihigh、china、entrepreneur",
}
_CLUB_IMAGE_COLUMNS = {"logo_url": "Logo", "fb_qr_url": "Facebook QR", "line_qr_url": "LINE QR"}
_CLUB_SETTINGS = {
    "timeRange": "預設時間（議程可覆寫）", "venue": "預設地點（議程可覆寫）",
    "scheduleZh": "會議日期行（中文）", "scheduleEn": "會議日期行（English）",
    "scheduleText": "會議時間（China）", "slogan": "標語", "transit": "交通",
    "closingLine": "結尾句", "upcomingMeetings": "近期例會", "specialEvent": "特別活動",
    "membershipFee": "入會費用", "admissionFeeText": "入場費文字（China）",
    "contactEmail": "聯絡 Email", "officerTeamYear": "幹部任期年度",
    "officerTeam": "幹部名單（每行：職稱|Lead|Deputy）",
    "upcomingEvents": "近期活動（每行：日期|活動）",
    "roles_sheet_url": "角色表 Google Sheet 網址（需含 #gid=）",
}
_CLUB_IMAGE_SETTINGS = {
    "ig_qr_url": "Instagram QR", "threads_qr_url": "Threads QR",
    "evoting_qr_url": "E-Voting QR", "membership_qr_url": "入會登記 QR",
    "page2_hero_url": "第二頁 圖1（我們是誰）", "page2_img2_url": "第二頁 圖2（招生／入會流程）",
}
_TEMPLATE_KEYS = ("standard", "compact", "chillhihigh", "china", "entrepreneur")


def _system_admin_only(caller: dict):
    if caller["role"] != "system_admin":
        raise HTTPException(status_code=403, detail="分會設定只有系統管理員可以修改")


def _club_view(cur, club_id: int) -> dict:
    cur.execute(f"SELECT {_CLUB_COLS} FROM clubs WHERE id=%s", (club_id,))
    row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="找不到此分會")
    c = _club_row_to_dict(row)
    st = c.pop("settings") or {}
    visible = {**_CLUB_SETTINGS, **_CLUB_IMAGE_SETTINGS}
    c["settings"] = {k: v for k, v in st.items() if k in visible}
    return c


def _tool_get_club(caller, args):
    cid = _social_scope(caller, args.get("club_id"))
    if cid is None:
        return _tool_text("系統管理員請指定 club_id（用 list_clubs 查）", is_error=True)
    with get_db() as conn:
        with conn.cursor() as cur:
            c = _club_view(cur, cid)
    return _tool_text(json.dumps(c, ensure_ascii=False, indent=1, default=str), c)


def _club_write(cur, club_id, columns: dict, settings: dict):
    """Partial update: given columns replace, settings merge (null deletes)."""
    if columns:
        sets = ", ".join(f"{k}=%s" for k in columns)
        cur.execute(f"UPDATE clubs SET {sets} WHERE id=%s", (*columns.values(), club_id))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="找不到此分會")
    if settings:
        drop = [k for k, v in settings.items() if v is None]
        keep = {k: v for k, v in settings.items() if v is not None}
        cur.execute("UPDATE clubs SET settings = (COALESCE(settings,'{}'::jsonb) - %s::text[])"
                    " || %s::jsonb WHERE id=%s", (drop, json.dumps(keep), club_id))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="找不到此分會")


def _club_changes(args: dict):
    cols = {k: v for k, v in (args.get("fields") or {}).items()}
    sets = dict(args.get("settings") or {})
    bad = [k for k in cols if k not in _CLUB_COLUMNS and k not in _CLUB_IMAGE_COLUMNS] + \
          [k for k in sets if k not in _CLUB_SETTINGS and k not in _CLUB_IMAGE_SETTINGS]
    if bad:
        raise HTTPException(status_code=400, detail="不能修改的欄位：" + "、".join(bad))
    if "name" in cols and not str(cols["name"] or "").strip():
        raise HTTPException(status_code=400, detail="分會名稱不得為空")
    if cols.get("template_key") is not None and cols["template_key"] not in _TEMPLATE_KEYS:
        raise HTTPException(status_code=400, detail="template_key 只能是 " + "、".join(_TEMPLATE_KEYS))
    cols = {k: (None if v is None else str(v).strip() if k == "name" else str(v))
            for k, v in cols.items()}
    return cols, {k: (None if v is None else str(v)) for k, v in sets.items()}


def _tool_update_club(caller, args):
    _system_admin_only(caller)
    cid = int(args["club_id"])
    cols, sets = _club_changes(args)
    if not cols and not sets:
        return _tool_text("沒有要修改的欄位", is_error=True)
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                _club_write(cur, cid, cols, sets)
                c = _club_view(cur, cid)
    except psycopg2.errors.UniqueViolation:
        return _tool_text("分會名稱已存在", is_error=True)
    return _tool_text(f"已更新分會 #{cid}：" + "、".join(list(cols) + list(sets)), c)


def _tool_create_club(caller, args):
    _system_admin_only(caller)
    cols, sets = _club_changes(args)
    if not (cols.get("name") or "").strip():
        return _tool_text("請在 fields 裡給 name", is_error=True)
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("INSERT INTO clubs (name, template_key, settings)"
                            " VALUES (%s, %s, '{}'::jsonb) RETURNING id",
                            (cols.pop("name"), cols.pop("template_key", None) or "standard"))
                cid = cur.fetchone()[0]
                _club_write(cur, cid, cols, sets)
                c = _club_view(cur, cid)
    except psycopg2.errors.UniqueViolation:
        return _tool_text("分會名稱已存在", is_error=True)
    return _tool_text(f"已建立分會 #{cid}「{c['name']}」", c)


def _image_from_args(args: dict) -> tuple:
    """(bytes, content type) from image / image_url / image_base64 — or raise."""
    import base64
    f = args.get("image") if isinstance(args.get("image"), dict) else {}
    url = f.get("download_url") or args.get("image_url")
    if url:
        raw = _download_image(str(url))
    elif args.get("image_base64"):
        b64 = str(args["image_base64"])
        try:
            raw = base64.b64decode(b64[b64.find(",") + 1:] if b64.startswith("data:") else b64)
        except Exception:
            raise HTTPException(status_code=400, detail="image_base64 不是有效的 base64")
        if len(raw) > _IMAGE_MAX_BYTES:
            raise HTTPException(status_code=400, detail="圖片超過 15 MB")
    else:
        raise HTTPException(status_code=400,
                            detail="請提供 image（檔案）、image_url 或 image_base64 其中一個")
    ctype = _sniff_image(raw)
    if not ctype:
        raise HTTPException(status_code=400, detail="這不是支援的圖片格式（JPG、PNG、WebP、GIF）")
    return raw, ctype


def _store_image(raw: bytes, ctype: str, prefix: str) -> str:
    key = f"{prefix}/{uuid.uuid4().hex}.{_IMAGE_EXT[ctype]}"
    try:
        _r2().put_object(Bucket=R2_BUCKET_NAME, Key=key, Body=raw, ContentType=ctype)
    except Exception:
        raise HTTPException(status_code=502, detail="圖片上傳雲端失敗，請稍後再試")
    return f"{R2_PUBLIC_URL}/{key}"


def _tool_set_club_image(caller, args):
    _system_admin_only(caller)
    cid, slot = int(args["club_id"]), args.get("slot") or ""
    if slot not in _CLUB_IMAGE_COLUMNS and slot not in _CLUB_IMAGE_SETTINGS:
        return _tool_text("slot 只能是 " + "、".join(list(_CLUB_IMAGE_COLUMNS)
                                                     + list(_CLUB_IMAGE_SETTINGS)), is_error=True)
    raw, ctype = _image_from_args(args)
    url = _store_image(raw, ctype, f"media/clubs/{cid}")
    with get_db() as conn:
        with conn.cursor() as cur:
            if slot in _CLUB_IMAGE_COLUMNS:
                _club_write(cur, cid, {slot: url}, {})
            else:
                _club_write(cur, cid, {}, {slot: url})
    label = _CLUB_IMAGE_COLUMNS.get(slot) or _CLUB_IMAGE_SETTINGS[slot]
    return _tool_text(f"已更新分會 #{cid} 的「{label}」：{url}",
                      {"clubId": cid, "slot": slot, "url": url})


# ------------------------------------------------------------------ agenda theme image
# The per-meeting picture beside the header — `themeImgUrl` in agendas.data,
# set by the editor's 主題圖片 upload. Only these templates draw it; on any
# other a picture would be stored and never seen (and, generated, paid for).
_THEME_IMG_TEMPLATES = {"standard", "entrepreneur"}


def _theme_target(caller, agenda_id: int):
    """(data, club id) for an agenda whose template shows a theme image."""
    _officer_only(caller)
    with get_db() as conn:
        with conn.cursor() as cur:
            data, cid = _agenda_for(cur, agenda_id, caller)
            cur.execute("SELECT template_key FROM clubs WHERE id=%s", (cid,))
            tmpl = ((cur.fetchone() or [None])[0]) or "standard"
    if tmpl not in _THEME_IMG_TEMPLATES:
        raise HTTPException(status_code=400,
                            detail=f"這個分會的版型（{tmpl}）沒有每場的主題圖，只有 "
                                   + "、".join(sorted(_THEME_IMG_TEMPLATES)) + " 版型會顯示")
    return data, cid


def _save_theme(agenda_id: int, data: dict, url: str):
    data["themeImgUrl"] = url
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE agendas SET data=%s::jsonb, updated_at=NOW() WHERE id=%s",
                        (json.dumps(data), agenda_id))


def _tool_set_agenda_theme_image(caller, args):
    aid = int(args["agenda_id"])
    data, cid = _theme_target(caller, aid)
    if args.get("clear"):
        data.pop("themeImgUrl", None)
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("UPDATE agendas SET data=%s::jsonb, updated_at=NOW() WHERE id=%s",
                            (json.dumps(data), aid))
        return _tool_text(f"已移除議程 #{aid} 的主題圖", {"agendaId": aid})
    raw, ctype = _image_from_args(args)
    url = _store_image(raw, ctype, f"media/clubs/{cid}/agendas")
    _save_theme(aid, data, url)
    return _tool_text(f"已設定議程 #{aid} 的主題圖：{url}", {"agendaId": aid, "url": url})


def _tool_generate_agenda_theme_image(caller, args):
    aid = int(args["agenda_id"])
    data, cid = _theme_target(caller, aid)          # checked before anything is paid for
    theme = data.get("meetingTheme") or ""
    prompt = args.get("prompt") or (
        f"Toastmasters 演講會例會的主題插圖，主題是「{theme}」。溫暖、活潑的扁平插畫風格，"
        "不要任何文字。" if theme else "")
    if not prompt:
        return _tool_text("這份議程沒有主題，請提供 prompt 描述想要的圖", is_error=True)
    item = _generate_image(caller["username"], cid, {
        "prompt": prompt, "size": args.get("size") or "1024x1024",
        "quality": args.get("quality"), "model": args.get("model")})
    _save_theme(aid, data, item["url"])
    return _tool_text(f"已產生並設定議程 #{aid} 的主題圖：{item['url']}",
                      {"agendaId": aid, "url": item["url"], "prompt": prompt})


# ------------------------------------------------------------------ delete post
# Removes the post from this system — draft or already published alike, as
# DELETE /api/social-posts/{id} does for the web page. What publish_post put
# on Facebook / Instagram / Threads is not touched; this app does not manage
# posts once they are on the platforms.

def _tool_delete_post(caller, args):
    _officer_only(caller)
    post_id = int(args["post_id"])
    with get_db() as conn:
        with conn.cursor() as cur:
            row = _social_row(_load_social_post(cur, post_id, caller))
            cur.execute("DELETE FROM social_posts WHERE id=%s", (post_id,))
    live = sorted(row["published"])
    note = f"（已發布到 {'、'.join(live)} 的貼文不受影響，仍在社群上）" if live else ""
    return _tool_text(f"已刪除貼文 #{post_id}「{row['title'] or '無標題'}」{note}",
                      {"postId": post_id})


# ------------------------------------------------------------------ whoami
_ROLE_NAMES = {"system_admin": "系統管理員", "club_admin": "分會管理員", "club_member": "一般會員"}


def _tool_whoami(caller, args):
    """
    Who this token acts as, and what it may do — read live, like every call:
    the role and club come from the users row now, not from when the grant
    was made, so this is also how to see a role change take effect.
    """
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT u.name_en, u.name_zh, u.level, c.name, c.name_zh"
                        " FROM users u LEFT JOIN clubs c ON c.id = %s"
                        " WHERE u.username=%s", (caller["club_id"], caller["username"]))
            u = cur.fetchone() or (None,) * 5
            labels = _club_labels(cur)
            cur.execute("SELECT client_name, created_at, expires_at FROM oauth_refresh_tokens"
                        " WHERE grant_id=%s", (caller.get("grant") or "",))
            gr = cur.fetchone() or (None, None, None)
    club = _club_label(u[3], u[4], None) if u[3] or u[4] else ""
    scopes = [s for s in MCP_SCOPES if s in caller["scopes"]]
    iso = lambda d: d.isoformat() if d else ""
    info = {
        "username": caller["username"],
        "nameEn": u[0] or "", "nameZh": u[1] or "", "level": u[2] or "",
        "role": caller["role"], "roleName": _ROLE_NAMES.get(caller["role"], caller["role"]),
        "clubId": caller["club_id"], "club": club,
        "memberships": [{"clubId": cid, "club": labels.get(cid, ""), "role": r,
                         "current": cid == caller["club_id"]}
                        for cid, r in (caller.get("memberships") or {}).items()],
        "scopes": [{"key": s, "label": MCP_SCOPES[s]} for s in scopes],
        "missingScopes": [s for s in MCP_SCOPES if s not in caller["scopes"]],
        "client": gr[0] or "", "grantedAt": iso(gr[1]), "grantExpiresAt": iso(gr[2]),
    }
    name = " ".join(x for x in (info["nameEn"], info["nameZh"]) if x)
    lines = [
        f"帳號：{info['username']}" + (f"（{name}{', ' + info['level'] if info['level'] else ''}）" if name else ""),
        f"角色：{info['roleName']}" + ("（可操作所有分會）" if caller["role"] == "system_admin"
                                      else f"｜分會：{club or '未設定'}（club_id={caller['club_id']}）"),
        *([f"所屬分會：" + "、".join(
            f"{m['club']}（{_ROLE_NAMES.get(m['role'], m['role'])}）" + ("← 目前" if m["current"] else "")
            for m in info["memberships"]) + "。要換分會操作請用 switch_club"]
          if len(info["memberships"]) > 1 else []),
        f"客戶端：{info['client'] or '未知'}，授權於 {info['grantedAt'][:10] or '?'}",
        "這個授權可以：" + "、".join(MCP_SCOPES[s] for s in scopes),
    ]
    if info["missingScopes"]:
        lines.append("沒有授權：" + "、".join(MCP_SCOPES[s] for s in info["missingScopes"])
                     + "（要用的話需重新授權）")
    lines.append("實際能做的事仍以帳號角色為準：授權只會限縮、不會超過你在網站上的權限。")
    return _tool_text("\n".join(lines), info)


# ------------------------------------------------------------------ delete agenda
def _tool_delete_agenda(caller, args):
    """
    DELETE /api/agendas/{id}, with the same rule: an officer, own club only.
    Posts bound to the agenda survive — the FK is ON DELETE SET NULL — but a
    promo post loses the date/venue/fee it would generate copy from, so the
    answer says which ones were unbound.
    """
    _officer_only(caller)
    aid = int(args["agenda_id"])
    with get_db() as conn:
        with conn.cursor() as cur:
            data, cid = _agenda_for(cur, aid, caller)       # 404 / 403 first
            cur.execute("SELECT id, title FROM social_posts WHERE agenda_id=%s", (aid,))
            posts = cur.fetchall()
            cur.execute("DELETE FROM agendas WHERE id=%s", (aid,))
    text = f"已刪除議程 #{aid}：{data.get('meetingDate', '')} 第{data.get('meetingNo', '')}次" \
           f"「{data.get('meetingTheme', '')}」"
    if posts:
        text += "\n這些貼文原本綁定這場例會，已改為未綁定（貼文本身保留）：" + "、".join(
            f"#{p[0]}{('「' + p[1] + '」') if p[1] else ''}" for p in posts)
    return _tool_text(text, {"agendaId": aid, "clubId": cid,
                             "unboundPosts": [p[0] for p in posts]})


# ------------------------------------------------------------------ catalogue
# Spelled out because a system admin's omitted club_id silently means "every
# club", and a model that does not know that reads the mix as one club.
_CLUB_ID_DOC = ("分會 id，從 list_clubs 取得。一般使用者可省略（固定是自己的分會）；"
                "系統管理員省略時會混合所有分會的資料，請務必指定")

_SPEECH_SCHEMA = {
    "type": ["object", "null"], "additionalProperties": False,
    "description": "一篇演講；null 表示這個位置不變",
    "properties": {
        "speaker":        {"type": "string", "description": "演講者"},
        "title":          {"type": "string", "description": "講題"},
        "duration":       {"type": "string", "description": "時間，例如 5'-7'"},
        "speechLang":     {"type": "string", "enum": ["en", "zh"]},
        "pathwayCode":    {"type": "string", "description": "學習路徑代碼，例如 PM、DL"},
        "pathwayLevel":   {"type": "string", "description": "等級，例如 L3"},
        "pathwayProject": {"type": "string", "description": "專案名稱（Pathways 目錄上的英文名稱）"},
    },
}
_AGENDA_FIELDS_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "description": "議程欄位；只會寫入有給的欄位。人名照會員名單的寫法最好（例如 Leah Kao, DTM）",
    "properties": {
        **{k: {"type": "string", "description": d} for k, d in _AGENDA_TEXT_FIELDS.items()},
        "lang": {"type": "string", "enum": ["zh", "en"],
                 "description": "議程語言（影響試算表匯入時人名用中文或英文）"},
        "speeches": {"type": "array", "items": _SPEECH_SCHEMA,
                     "description": "指定演講，依序合併"},
        "evaluators": {"type": "array", "items": {"type": ["string", "null"]},
                       "description": "個別講評員，依序對應演講"},
        "evalEvaluators": {"type": "array", "items": {"type": ["string", "null"]},
                           "description": "講評員講評"},
        "varietySession": {"type": "object", "additionalProperties": False,
                           "description": "多元單元",
                           "properties": {"enabled": {"type": "boolean"},
                                          "duration": {"type": "integer", "description": "分鐘"},
                                          "host": {"type": "string"}}},
    },
}

# `annotations` are hints a client uses to decide what to confirm with the
# person first (ChatGPT asks before any tool not marked readOnlyHint). They
# are advice to the client, never a permission — scopes and role checks are.
MCP_TOOLS = [
    {
        "name": "whoami", "scope": None, "title": "我是誰",
        "description": "回傳目前操作 MCP 的身分：帳號、姓名、角色、所屬分會，以及這個授權允許與缺少的權限。"
                       "不確定能做什麼、或使用者問「我是誰」時用這支。",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "annotations": {"readOnlyHint": True, "openWorldHint": False},
        "handler": _tool_whoami,
    },
    {
        "name": "list_clubs", "scope": "posts:read", "title": "列出分會",
        "description": "列出可以操作的分會與 club_id。使用者用名稱指稱分會時（中文名、英文名或簡稱），"
                       "先用這支找到 club_id，再傳給其他工具。一般使用者只會看到自己的分會。",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "annotations": {"readOnlyHint": True, "openWorldHint": False},
        "handler": _tool_list_clubs,
    },
    {
        "name": "switch_club", "scope": None, "title": "切換分會",
        "description": "屬於多個分會的使用者，切換之後要操作的分會（等同網站側邊欄的分會切換）。"
                       "之後的工具都在這個分會、以你在這個分會的角色執行。系統管理員不需要切換。",
        "inputSchema": {"type": "object", "properties": {
            "club_id": {"type": "integer", "description": "要切換到的分會，從 list_clubs 取得"},
        }, "required": ["club_id"], "additionalProperties": False},
        "annotations": {"readOnlyHint": False, "destructiveHint": False,
                        "idempotentHint": True, "openWorldHint": False},
        "handler": _tool_switch_club,
    },
    {
        "name": "list_meetings", "scope": "posts:read", "title": "列出例會",
        "description": "列出分會的例會（議程），最近的在前。回傳 agendaId，其他工具用它指定例會。",
        "inputSchema": {"type": "object", "properties": {
            "club_id": {"type": "integer", "description": _CLUB_ID_DOC},
            "limit": {"type": "integer", "description": "最多幾筆，預設 10，上限 50"},
        }, "additionalProperties": False},
        "annotations": {"readOnlyHint": True, "openWorldHint": False},
        "handler": _tool_list_meetings,
    },
    {
        "name": "get_meeting", "scope": "posts:read", "title": "取得例會資訊",
        "description": "取得一場例會的日期、時間、地址、入場費與主題——例會宣傳貼文需要的全部事實。"
                       "若缺少宣傳必填的欄位會一併指出。",
        "inputSchema": {"type": "object", "properties": {
            "agenda_id": {"type": "integer", "description": "例會 id，來自 list_meetings"},
        }, "required": ["agenda_id"], "additionalProperties": False},
        "annotations": {"readOnlyHint": True, "openWorldHint": False},
        "handler": _tool_get_meeting,
    },
    {
        "name": "list_posts", "scope": "posts:read", "title": "列出貼文草稿",
        "description": "列出分會的社群貼文草稿與已發布貼文。",
        "inputSchema": {"type": "object", "properties": {
            "club_id": {"type": "integer", "description": _CLUB_ID_DOC},
        }, "additionalProperties": False},
        "annotations": {"readOnlyHint": True, "openWorldHint": False},
        "handler": _tool_list_posts,
    },
    {
        "name": "get_post", "scope": "posts:read", "title": "取得貼文",
        "description": "取得一則貼文的完整內容：主文案、各平台版本、圖片、已發布到哪些平台。",
        "inputSchema": {"type": "object", "properties": {
            "post_id": {"type": "integer"},
        }, "required": ["post_id"], "additionalProperties": False},
        "annotations": {"readOnlyHint": True, "openWorldHint": False},
        "handler": _tool_get_post,
    },
    {
        "name": "create_post", "scope": "posts:write", "title": "建立貼文草稿",
        "description": "建立一則貼文草稿。kind 為 promo（例會宣傳）、recap（例會回顧）或 other。"
                       "宣傳類請一併綁定 agenda_id，否則產生文案時會因為缺少日期地址費用而被擋下。",
        "inputSchema": {"type": "object", "properties": {
            "title": {"type": "string", "description": "內部標題，只給管理者辨識"},
            "kind": {"type": "string", "enum": ["promo", "recap", "other"]},
            "agenda_id": {"type": "integer"},
            "body": {"type": "string", "description": "主文案；留空稍後用 generate_copy 產生"},
            "club_id": {"type": "integer", "description": _CLUB_ID_DOC},
        }, "additionalProperties": False},
        "annotations": {"readOnlyHint": False, "destructiveHint": False,
                        "idempotentHint": False, "openWorldHint": False},
        "handler": _tool_create_post,
    },
    {
        "name": "update_post", "scope": "posts:write", "title": "修改貼文草稿",
        "description": "修改貼文的標題、主文案、用途、狀態、綁定例會，或各平台的文案版本。",
        "inputSchema": {"type": "object", "properties": {
            "post_id": {"type": "integer"},
            "title": {"type": "string"},
            "body": {"type": "string"},
            "kind": {"type": "string", "enum": ["promo", "recap", "other"]},
            "status": {"type": "string", "enum": ["draft", "ready", "posted"]},
            "agenda_id": {"type": "integer"},
            "variants": {"type": "object",
                         "description": "各平台文案，例如 {\"threads\": \"...\"}"},
        }, "required": ["post_id"], "additionalProperties": False},
        "annotations": {"readOnlyHint": False, "destructiveHint": True,
                        "idempotentHint": True, "openWorldHint": False},
        "handler": _tool_update_post,
    },
    {
        "name": "generate_copy", "scope": "ai:generate", "title": "AI 產生文案",
        "description": "用 AI 依貼文用途與綁定例會的資料產生文案，並直接存進該則貼文。"
                       "⚠️ 這會消耗呼叫者自己（或分會共用）的 AI 帳號額度。",
        "inputSchema": {"type": "object", "properties": {
            "post_id": {"type": "integer"},
            "brief": {"type": "string", "description": "補充指示，例如想強調什麼"},
            "platforms": {"type": "array", "items": {"type": "string"},
                          "description": "要產生哪些平台，預設全部"},
            "provider": {"type": "string", "enum": ["anthropic", "openai"]},
            "model": {"type": "string", "description": "留空用預設模型"},
        }, "required": ["post_id"], "additionalProperties": False},
        "annotations": {"readOnlyHint": False, "destructiveHint": True,
                        "idempotentHint": False, "openWorldHint": True},
        "handler": _tool_generate_copy,
    },
    {
        "name": "publish_post", "scope": "publish", "title": "發布貼文",
        "description": "把貼文發布到指定的社群平台。⚠️ 這是公開的，而且發出去無法透過這個系統收回；"
                       "Instagram 一定要有圖片。發布前請先用 get_post 確認內容，並取得使用者同意。"
                       "已發布過的平台會自動略過。需要「發布」授權，沒有的話客戶端會請使用者補授權。",
        "inputSchema": {"type": "object", "properties": {
            "post_id": {"type": "integer"},
            "platforms": {"type": "array", "items": {
                "type": "string", "enum": ["facebook", "instagram", "threads"]}},
            "republish": {"type": "boolean",
                          "description": "已發布過的平台預設會略過；設 true 才會再發一則新的公開貼文"},
        }, "required": ["post_id", "platforms"], "additionalProperties": False},
        "annotations": {"readOnlyHint": False, "destructiveHint": True,
                        "idempotentHint": False, "openWorldHint": True},
        "handler": _tool_publish_post,
    },

    # ---- agendas
    {
        "name": "get_agenda", "scope": "posts:read", "title": "取得議程",
        "description": "取得一份議程的完整內容（所有角色、演講、講評員等），修改前先用這支看現況。",
        "inputSchema": {"type": "object", "properties": {
            "agenda_id": {"type": "integer", "description": "議程 id，來自 list_meetings"},
        }, "required": ["agenda_id"], "additionalProperties": False},
        "annotations": {"readOnlyHint": True, "openWorldHint": False},
        "handler": _tool_get_agenda,
    },
    {
        "name": "create_agenda", "scope": "agendas:write", "title": "建立議程",
        "description": "建立一場例會的議程。時間與地點預設沿用該分會上一份議程。"
                       "可帶 import_roles: true 從分會設定的 Google Sheet 角色規劃表帶入那一天的角色。"
                       "同一天已有議程時會拒絕並回傳既有的 id。",
        "inputSchema": {"type": "object", "properties": {
            "club_id": {"type": "integer", "description": _CLUB_ID_DOC},
            "fields": _AGENDA_FIELDS_SCHEMA,
            "import_roles": {"type": "boolean", "description": "從角色試算表帶入這一天的角色"},
            "overwrite_roles": {"type": "boolean",
                                "description": "試算表與 fields 衝突時以試算表為準（預設保留 fields）"},
            "speech_count": {"type": "integer", "description": "演講篇數（預設 3）"},
            "evaluator_count": {"type": "integer", "description": "個別講評員人數（預設 3）"},
            "allow_duplicate": {"type": "boolean", "description": "同一天已有議程仍要另建一份"},
        }, "required": ["fields"], "additionalProperties": False},
        "annotations": {"readOnlyHint": False, "destructiveHint": False,
                        "idempotentHint": False, "openWorldHint": False},
        "handler": _tool_create_agenda,
    },
    {
        "name": "update_agenda", "scope": "agendas:write", "title": "修改議程",
        "description": "修改議程的欄位，只會改有給的欄位。speeches／evaluators 依位置合併："
                       "要改第 2 篇演講者就傳 [null, {\"speaker\": \"…\"}]。"
                       "要刪減篇數用 speech_count／evaluator_count。"
                       "import_roles: true 會從角色試算表補上空白的角色（overwrite_roles 才會覆蓋已填的）。",
        "inputSchema": {"type": "object", "properties": {
            "agenda_id": {"type": "integer"},
            "fields": _AGENDA_FIELDS_SCHEMA,
            "import_roles": {"type": "boolean", "description": "從角色試算表帶入這一天的角色"},
            "overwrite_roles": {"type": "boolean", "description": "試算表的值覆蓋已填的角色"},
            "speech_count": {"type": "integer", "description": "把演講篇數設為這個數字（多的刪掉）"},
            "evaluator_count": {"type": "integer", "description": "把個別講評員人數設為這個數字"},
        }, "required": ["agenda_id"], "additionalProperties": False},
        "annotations": {"readOnlyHint": False, "destructiveHint": True,
                        "idempotentHint": True, "openWorldHint": False},
        "handler": _tool_update_agenda,
    },
    {
        "name": "delete_agenda", "scope": "agendas:write", "title": "刪除議程",
        "description": "刪除一份議程（無法復原，刪除前請先跟使用者確認是哪一份）。"
                       "與網頁相同：分會管理員以上、只能刪自己分會的。綁定這場的貼文會保留，但改為未綁定。",
        "inputSchema": {"type": "object", "properties": {
            "agenda_id": {"type": "integer", "description": "議程 id，來自 list_meetings"},
        }, "required": ["agenda_id"], "additionalProperties": False},
        "annotations": {"readOnlyHint": False, "destructiveHint": True,
                        "idempotentHint": True, "openWorldHint": False},
        "handler": _tool_delete_agenda,
    },
    {
        "name": "export_agenda", "scope": "posts:read", "title": "下載議程 PDF／JPG",
        "description": "把議程輸出成 PDF 和／或 JPG（與網頁「下載」按鈕相同的檔案），回傳下載連結。"
                       "多頁版型的 JPG 每頁一張。約需 10～30 秒。連結是公開的，拿到的人都能開。",
        "inputSchema": {"type": "object", "properties": {
            "agenda_id": {"type": "integer"},
            "formats": {"type": "array", "items": {"type": "string", "enum": ["pdf", "jpg"]},
                        "description": "預設兩種都要"},
        }, "required": ["agenda_id"], "additionalProperties": False},
        "annotations": {"readOnlyHint": True, "openWorldHint": False},
        "handler": _tool_export_agenda,
    },

    # ---- post images
    {
        "name": "add_post_image", "scope": "posts:write", "title": "加入貼文圖片",
        "description": "把一張圖片加到貼文的圖片清單最後面。用你（AI）自己產生或使用者提供的圖："
                       "給 image（檔案）、image_url（公開 https 網址）或 image_base64 其中一個。"
                       "Instagram 只接受 JPG。",
        "inputSchema": {"type": "object", "properties": {
            "post_id": {"type": "integer"},
            "image": {"type": "object", "description": "圖片檔案（支援檔案參數的客戶端使用）",
                      "properties": {"download_url": {"type": "string"},
                                     "file_id": {"type": "string"},
                                     "name": {"type": "string"}}},
            "image_url": {"type": "string", "description": "公開可下載的 https 圖片網址"},
            "image_base64": {"type": "string", "description": "圖片內容的 base64（可含 data: 前綴）"},
            "name": {"type": "string", "description": "圖片名稱，給管理者辨識"},
        }, "required": ["post_id"], "additionalProperties": False},
        # ChatGPT passes a file the user attached or the model made as
        # {download_url, file_id} when a parameter is declared like this.
        "_meta": {"openai/fileParams": ["image"]},
        "annotations": {"readOnlyHint": False, "destructiveHint": False,
                        "idempotentHint": False, "openWorldHint": True},
        "handler": _tool_add_post_image,
    },
    {
        "name": "remove_post_image", "scope": "posts:write", "title": "移除貼文圖片",
        "description": "從貼文移除一張圖片。position 是 get_post 圖片清單裡的順序，從 1 開始。",
        "inputSchema": {"type": "object", "properties": {
            "post_id": {"type": "integer"},
            "position": {"type": "integer", "description": "第幾張，從 1 開始"},
        }, "required": ["post_id", "position"], "additionalProperties": False},
        "annotations": {"readOnlyHint": False, "destructiveHint": True,
                        "idempotentHint": False, "openWorldHint": False},
        "handler": _tool_remove_post_image,
    },
    {
        "name": "generate_post_image", "scope": "ai:generate", "title": "AI 產生貼文圖片",
        "description": "用平台的 OpenAI 生圖（與網頁「生圖」相同）並加到貼文。"
                       "⚠️ 會消耗呼叫者自己（或分會共用）的 OpenAI 額度。約需 10～40 秒。",
        "inputSchema": {"type": "object", "properties": {
            "post_id": {"type": "integer"},
            "prompt": {"type": "string", "description": "圖片描述"},
            "size": {"type": "string", "enum": list(_IMAGE_SIZES), "description": "預設 1024x1024"},
            "quality": {"type": "string", "enum": list(IMAGE_QUALITIES),
                        "description": "預設 low（最省）"},
            "model": {"type": "string", "enum": [m["id"] for m in IMAGE_MODELS],
                      "description": "留空用預設（最省）的模型"},
        }, "required": ["post_id", "prompt"], "additionalProperties": False},
        "annotations": {"readOnlyHint": False, "destructiveHint": False,
                        "idempotentHint": False, "openWorldHint": True},
        "handler": _tool_generate_post_image,
    },

    # ---- agenda theme image
    {
        "name": "set_agenda_theme_image", "scope": "agendas:write", "title": "設定議程主題圖",
        "description": "把一張圖設成議程的主題圖（議程表頁首旁的插圖）。用你（AI）自己產生或使用者提供的圖："
                       "給 image（檔案）、image_url 或 image_base64 其中一個；clear: true 移除主題圖。"
                       "只有 standard、entrepreneur 版型會顯示主題圖，其他版型會被拒絕。",
        "inputSchema": {"type": "object", "properties": {
            "agenda_id": {"type": "integer"},
            "image": {"type": "object", "description": "圖片檔案（支援檔案參數的客戶端使用）",
                      "properties": {"download_url": {"type": "string"},
                                     "file_id": {"type": "string"}}},
            "image_url": {"type": "string", "description": "公開可下載的 https 圖片網址"},
            "image_base64": {"type": "string", "description": "圖片內容的 base64"},
            "clear": {"type": "boolean", "description": "移除這場的主題圖"},
        }, "required": ["agenda_id"], "additionalProperties": False},
        "_meta": {"openai/fileParams": ["image"]},
        "annotations": {"readOnlyHint": False, "destructiveHint": True,
                        "idempotentHint": True, "openWorldHint": True},
        "handler": _tool_set_agenda_theme_image,
    },
    {
        "name": "generate_agenda_theme_image", "scope": "ai:generate", "title": "AI 產生議程主題圖",
        "description": "用平台的 OpenAI 生成議程主題圖並直接套用。沒給 prompt 時依例會主題產生。"
                       "⚠️ 會消耗呼叫者自己（或分會共用）的 OpenAI 額度；版型不顯示主題圖時會先拒絕、不會花錢。",
        "inputSchema": {"type": "object", "properties": {
            "agenda_id": {"type": "integer"},
            "prompt": {"type": "string", "description": "圖片描述；留空依例會主題自動產生"},
            "size": {"type": "string", "enum": list(_IMAGE_SIZES)},
            "quality": {"type": "string", "enum": list(IMAGE_QUALITIES), "description": "預設 low（最省）"},
            "model": {"type": "string", "enum": [m["id"] for m in IMAGE_MODELS]},
        }, "required": ["agenda_id"], "additionalProperties": False},
        "annotations": {"readOnlyHint": False, "destructiveHint": True,
                        "idempotentHint": False, "openWorldHint": True},
        "handler": _tool_generate_agenda_theme_image,
    },

    # ---- roles (角色安排)
    {
        "name": "get_roles", "scope": "posts:read", "title": "查看角色安排",
        "description": "角色安排表：列出分會接下來（或指定日期範圍）每場例會已安排的角色。",
        "inputSchema": {"type": "object", "properties": {
            "club_id": {"type": "integer", "description": _CLUB_ID_DOC},
            "date_from": {"type": "string", "description": "YYYY-MM-DD，預設今天"},
            "date_to": {"type": "string", "description": "YYYY-MM-DD"},
            "limit": {"type": "integer", "description": "最多幾場，預設 8，上限 30"},
        }, "additionalProperties": False},
        "annotations": {"readOnlyHint": True, "openWorldHint": False},
        "handler": _tool_get_roles,
    },
    {
        "name": "assign_roles", "scope": "agendas:write", "title": "安排角色",
        "description": "為一場例會安排角色，例如 {\"tme\": \"高莉雅\", \"speech1\": \"Bob Lin\"}。"
                       "人名會比對會員名單，自動改成名單上的寫法；給空字串表示清空。"
                       "版型沒有的角色會略過。" + _ROLE_IDS_DOC,
        "inputSchema": {"type": "object", "properties": {
            "agenda_id": {"type": "integer"},
            "roles": {"type": "object", "additionalProperties": {"type": ["string", "null"]},
                      "description": "{角色 id: 人名或內容}"},
            "overwrite": {"type": "boolean", "description": "已有人時是否覆蓋，預設 true"},
        }, "required": ["agenda_id", "roles"], "additionalProperties": False},
        "annotations": {"readOnlyHint": False, "destructiveHint": True,
                        "idempotentHint": True, "openWorldHint": False},
        "handler": _tool_assign_roles,
    },
    {
        "name": "import_roles_sheet", "scope": "agendas:write", "title": "從角色試算表匯入整季",
        "description": "把分會 Google Sheet 角色規劃表的內容匯入每一場議程（等同角色安排頁的「從 Google Sheet 匯入」）。"
                       "預設只補空白欄位、不建立新議程；overwrite 以試算表覆蓋、create_missing 為試算表有但系統沒有的場次建立議程。",
        "inputSchema": {"type": "object", "properties": {
            "club_id": {"type": "integer", "description": _CLUB_ID_DOC},
            "date_from": {"type": "string", "description": "YYYY-MM-DD，只匯入這天之後"},
            "date_to": {"type": "string", "description": "YYYY-MM-DD，只匯入這天之前"},
            "overwrite": {"type": "boolean", "description": "試算表的值覆蓋已填的角色"},
            "create_missing": {"type": "boolean", "description": "為系統還沒有的場次建立議程"},
        }, "additionalProperties": False},
        "annotations": {"readOnlyHint": False, "destructiveHint": True,
                        "idempotentHint": True, "openWorldHint": True},
        "handler": _tool_import_roles_sheet,
    },
    {
        "name": "list_members", "scope": "posts:read", "title": "列出會員",
        "description": "分會會員名單（中英文名與教育等級），安排角色時用來對照正確的人名。",
        "inputSchema": {"type": "object", "properties": {
            "club_id": {"type": "integer", "description": _CLUB_ID_DOC},
        }, "additionalProperties": False},
        "annotations": {"readOnlyHint": True, "openWorldHint": False},
        "handler": _tool_list_members,
    },

    # ---- clubs (分會管理)
    {
        "name": "get_club", "scope": "posts:read", "title": "取得分會設定",
        "description": "分會的名稱、版型、地點、時間、QR code 等議程用設定。",
        "inputSchema": {"type": "object", "properties": {
            "club_id": {"type": "integer", "description": _CLUB_ID_DOC},
        }, "additionalProperties": False},
        "annotations": {"readOnlyHint": True, "openWorldHint": False},
        "handler": _tool_get_club,
    },
    {
        "name": "update_club", "scope": "clubs:write", "title": "修改分會設定",
        "description": "修改分會設定，只會改有給的欄位；settings 裡的值給 null 表示刪除。限系統管理員。"
                       "圖片（Logo、QR code、第二頁圖片）請用 set_club_image。",
        "inputSchema": {"type": "object", "properties": {
            "club_id": {"type": "integer"},
            "fields": {"type": "object", "additionalProperties": False,
                       "properties": {k: {"type": ["string", "null"], "description": d}
                                      for k, d in _CLUB_COLUMNS.items()}},
            "settings": {"type": "object", "additionalProperties": False,
                         "properties": {k: {"type": ["string", "null"], "description": d}
                                        for k, d in _CLUB_SETTINGS.items()}},
        }, "required": ["club_id"], "additionalProperties": False},
        "annotations": {"readOnlyHint": False, "destructiveHint": True,
                        "idempotentHint": True, "openWorldHint": False},
        "handler": _tool_update_club,
    },
    {
        "name": "create_club", "scope": "clubs:write", "title": "建立分會",
        "description": "建立新分會（fields.name 必填）。限系統管理員。",
        "inputSchema": {"type": "object", "properties": {
            "fields": {"type": "object", "additionalProperties": False,
                       "properties": {k: {"type": ["string", "null"], "description": d}
                                      for k, d in _CLUB_COLUMNS.items()}},
            "settings": {"type": "object", "additionalProperties": False,
                         "properties": {k: {"type": ["string", "null"], "description": d}
                                        for k, d in _CLUB_SETTINGS.items()}},
        }, "required": ["fields"], "additionalProperties": False},
        "annotations": {"readOnlyHint": False, "destructiveHint": False,
                        "idempotentHint": False, "openWorldHint": False},
        "handler": _tool_create_club,
    },
    {
        "name": "set_club_image", "scope": "clubs:write", "title": "設定分會圖片",
        "description": "更換分會的 Logo、QR code 或議程第二頁圖片。給 image（檔案）、image_url 或 image_base64 其中一個。限系統管理員。",
        "inputSchema": {"type": "object", "properties": {
            "club_id": {"type": "integer"},
            "slot": {"type": "string",
                     "enum": list(_CLUB_IMAGE_COLUMNS) + list(_CLUB_IMAGE_SETTINGS),
                     "description": "、".join(f"{k}={v}" for k, v in
                                              {**_CLUB_IMAGE_COLUMNS, **_CLUB_IMAGE_SETTINGS}.items())},
            "image": {"type": "object", "description": "圖片檔案（支援檔案參數的客戶端使用）",
                      "properties": {"download_url": {"type": "string"},
                                     "file_id": {"type": "string"}}},
            "image_url": {"type": "string"},
            "image_base64": {"type": "string"},
        }, "required": ["club_id", "slot"], "additionalProperties": False},
        "_meta": {"openai/fileParams": ["image"]},
        "annotations": {"readOnlyHint": False, "destructiveHint": True,
                        "idempotentHint": True, "openWorldHint": True},
        "handler": _tool_set_club_image,
    },
    {
        "name": "delete_post", "scope": "posts:write", "title": "刪除貼文",
        "description": "從系統刪除一則貼文（草稿或已發布的都可以），無法復原，刪除前請先跟使用者確認。"
                       "只刪系統裡的紀錄，已經發到 Facebook／Instagram／Threads 上的貼文不受影響。",
        "inputSchema": {"type": "object", "properties": {
            "post_id": {"type": "integer"},
        }, "required": ["post_id"], "additionalProperties": False},
        "annotations": {"readOnlyHint": False, "destructiveHint": True,
                        "idempotentHint": True, "openWorldHint": False},
        "handler": _tool_delete_post,
    },
]


# ------------------------------------------------------------------ catalogue page
# What the /mcp help page shows: the endpoint to paste into a client, the
# scopes on the consent screen, and every tool with what it takes to use it.
# Served from MCP_TOOLS itself so the page cannot drift from the server.
#
# `_TOOL_MIN_ROLE` is documentation of the gates in the handlers
# (_officer_only, _system_admin_only), not a gate of its own — the handlers
# stay the only enforcement. Tools not listed need club_admin or above.
_TOOL_MIN_ROLE = {
    **{n: "club_member" for n in (
        "whoami", "switch_club", "list_clubs", "get_club", "list_members", "list_meetings",
        "get_meeting", "get_agenda", "export_agenda", "get_roles",
        "list_posts", "get_post")},
    **{n: "system_admin" for n in ("update_club", "create_club", "set_club_image")},
}
# What the help page says about each tool. The `description` in MCP_TOOLS is
# written for the model (ids, argument shapes, when to call it); people need
# a sentence. A tool missing here falls back to its description's first one.
_TOOL_SUMMARY = {
    "whoami": "查看你的帳號、角色、所屬分會，以及這次授權可以做哪些事。",
    "list_clubs": "列出分會。一般使用者看到自己所屬的分會與在各分會的角色。",
    "switch_club": "屬於多個分會時，切換之後要操作的分會。",
    "get_club": "查看分會的名稱、版型、地點、時間、QR code 等設定。",
    "update_club": "修改分會設定，例如預設地點、時間、標語。",
    "create_club": "建立新分會。",
    "set_club_image": "更換分會 Logo、各種 QR code、議程第二頁圖片。",
    "list_meetings": "列出分會的例會，最近的在前。",
    "get_meeting": "查看一場例會的日期、時間、地點、入場費與主題，並指出做宣傳還缺什麼。",
    "get_agenda": "查看一份議程的完整內容（所有角色、演講、講評員）。",
    "create_agenda": "建立議程；時間地點沿用上一場，可以從 Google Sheet 帶入角色。",
    "update_agenda": "修改議程，只改你指定的欄位。",
    "delete_agenda": "刪除議程；綁定這場的貼文會保留。",
    "export_agenda": "把議程輸出成 PDF 與 JPG，取得下載連結（與網頁「下載」相同）。",
    "set_agenda_theme_image": "把一張圖設成議程主題圖（standard、entrepreneur 版型）。",
    "generate_agenda_theme_image": "依例會主題用 AI 產生主題圖並套用，會用到 OpenAI 額度。",
    "get_roles": "查看接下來幾場例會的角色安排。",
    "assign_roles": "為一場例會安排角色，人名會自動對照會員名單。",
    "import_roles_sheet": "從分會的 Google Sheet 角色規劃表一次匯入整季。",
    "list_members": "列出會員的中英文名與等級，安排角色時對照用。",
    "list_posts": "列出社群貼文（草稿與已發布）。",
    "get_post": "查看一則貼文的文案、各平台版本、圖片與發布紀錄。",
    "create_post": "建立貼文草稿，可以綁定一場例會。",
    "update_post": "修改貼文的標題、文案、狀態或各平台版本。",
    "delete_post": "從系統刪除貼文；已發到社群上的不受影響。",
    "generate_copy": "用 AI 依例會資料產生文案並存進貼文，會用到 AI 額度。",
    "add_post_image": "把圖片加進貼文（AI 助理做的圖、圖片網址或檔案）。",
    "remove_post_image": "從貼文移除一張圖片。",
    "generate_post_image": "用 AI 產生圖片並加進貼文，會用到 OpenAI 額度。",
    "publish_post": "發布到 Facebook、Instagram、Threads。公開且無法透過本系統收回。",
}
_TOOL_GROUPS = (
    ("身分", ("whoami", "switch_club")),
    ("分會", ("list_clubs", "get_club", "update_club", "create_club", "set_club_image")),
    ("議程", ("list_meetings", "get_meeting", "get_agenda", "create_agenda", "update_agenda",
              "delete_agenda", "export_agenda", "set_agenda_theme_image",
              "generate_agenda_theme_image")),
    ("角色安排", ("get_roles", "assign_roles", "import_roles_sheet", "list_members")),
    ("社群貼文", ("list_posts", "get_post", "create_post", "update_post", "delete_post",
                  "generate_copy", "add_post_image", "remove_post_image",
                  "generate_post_image", "publish_post")),
)


@app.get("/api/mcp/catalog")
def mcp_catalog(request: Request, user: dict = Depends(get_current_user)):
    by_name = {t["name"]: t for t in MCP_TOOLS}
    placed = {n for _, names in _TOOL_GROUPS for n in names}
    groups = list(_TOOL_GROUPS)
    rest = tuple(t["name"] for t in MCP_TOOLS if t["name"] not in placed)
    if rest:
        groups.append(("其他", rest))     # a new tool shows up even before it is filed

    def tool(t):
        return {
            "name": t["name"], "title": t.get("title") or t["name"],
            "description": _TOOL_SUMMARY.get(t["name"])
                           or t["description"].split("。")[0] + "。",
            "scope": t["scope"], "scopeLabel": MCP_SCOPES.get(t["scope"], "") if t["scope"] else "",
            "minRole": _TOOL_MIN_ROLE.get(t["name"], "club_admin"),
            "readOnly": bool((t.get("annotations") or {}).get("readOnlyHint")),
        }

    return {
        "endpoint": _mcp_resource(request),
        "scopes": [{"key": k, "label": v, "default": k in MCP_DEFAULT_SCOPES}
                   for k, v in MCP_SCOPES.items()],
        "groups": [{"name": g, "tools": [tool(by_name[n]) for n in names if n in by_name]}
                   for g, names in groups],
        "role": user["role"],
    }


# ------------------------------------------------------------------ the endpoint
@app.post("/api/mcp")
async def mcp_endpoint(request: Request):
    try:
        body = json.loads(await request.body() or b"{}")
    except Exception:
        return _rpc_error(None, -32700, "Parse error", status=400)

    if not isinstance(body, dict):
        return _rpc_error(None, -32600, "不支援批次請求", status=400)
    req_id = body.get("id")
    method = body.get("method") or ""
    params = body.get("params") or {}
    meta = params.get("_meta") or {}

    # Authorization comes before any protocol check. An unauthenticated client
    # — or a connector's "check this server" probe — learns how to sign in
    # only from a 401 with the challenge; answering its first request with a
    # 400 about protocol fields leaves it with nowhere to go.
    caller = mcp_caller(request)      # raises 401 with the right challenge

    version = meta.get("io.modelcontextprotocol/protocolVersion")
    legacy = not version
    if legacy:
        # --- earlier revisions: initialize handshake, version in a header ---
        if method == "initialize":
            asked = params.get("protocolVersion")
            return _rpc_ok(req_id, {
                "protocolVersion": asked if asked in MCP_LEGACY_VERSIONS
                                   else MCP_LEGACY_VERSIONS[0],
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": MCP_SERVER_INFO,
            }, legacy=True)
        # Absent header means 2025-03-26, per that revision.
        hdr_version = request.headers.get("mcp-protocol-version") or "2025-03-26"
        if hdr_version not in MCP_LEGACY_VERSIONS:
            return _rpc_error(req_id, -32602, "不支援這個協定版本", status=400,
                              data={"supported": list(MCP_PROTOCOL_VERSIONS
                                                      + MCP_LEGACY_VERSIONS)})
        if req_id is None:
            # A notification (notifications/initialized and friends): accepted,
            # nothing to answer.
            return Response(status_code=202)
        if method == "ping":
            return _rpc_ok(req_id, {}, legacy=True)
    else:
        # --- current revision: per-request fields in _meta ------------------
        if "io.modelcontextprotocol/clientCapabilities" not in meta:
            return _rpc_error(req_id, -32602,
                              "缺少 _meta 的 clientCapabilities", status=400)
        if version not in MCP_PROTOCOL_VERSIONS:
            return _rpc_error(req_id, -32022, "不支援這個協定版本", status=400,
                              data={"supported": list(MCP_PROTOCOL_VERSIONS)})

        # Headers must agree with the body. An intermediary routing on the
        # header and a server acting on the body must never see different
        # things; the spec makes the mismatch an error rather than letting
        # either side guess.
        hdr_version = request.headers.get("mcp-protocol-version")
        if hdr_version != version:
            return _rpc_error(req_id, -32020,
                              "MCP-Protocol-Version 標頭與內容不符", status=400)
        hdr_method = request.headers.get("mcp-method")
        if hdr_method != method:
            return _rpc_error(req_id, -32020, "Mcp-Method 標頭與內容不符", status=400)
        if method in ("tools/call", "resources/read", "prompts/get"):
            want = params.get("name") or params.get("uri") or ""
            if (request.headers.get("mcp-name") or "") != want:
                return _rpc_error(req_id, -32020, "Mcp-Name 標頭與內容不符", status=400)

    # Every tool is listed, whatever the token's scopes. A model only calls
    # tools it can see, so hiding publish_post from a token without `publish`
    # meant the step-up challenge below could never fire and the scope could
    # never be granted. Listed, the call gets a 403 naming the scope, and the
    # client takes the person back to the consent screen to decide.
    if method == "tools/list":
        return _rpc_ok(req_id, {"tools": [
            {k: v for k, v in t.items() if k in
             ("name", "title", "description", "inputSchema", "annotations", "_meta")}
            for t in MCP_TOOLS]}, legacy=legacy)

    if method == "tools/call":
        name = params.get("name")
        tool = next((t for t in MCP_TOOLS if t["name"] == name), None)
        if tool is None:
            return _rpc_error(req_id, -32602, f"沒有這個工具：{name}")
        if tool["scope"] is not None and tool["scope"] not in caller["scopes"]:
            # A scope challenge, not a plain refusal: the client can ask the
            # user to grant it and retry. (scope None: any valid token — only
            # whoami, which reads nothing but the caller's own identity.)
            require_scope(caller, tool["scope"], request)
        try:
            result = tool["handler"](caller, params.get("arguments") or {})
        except HTTPException as e:
            # The app's own refusals are things a model can act on — a missing
            # field, a wrong id, an unconnected platform — so they come back as
            # tool errors rather than protocol errors.
            result = _tool_text(str(e.detail), is_error=True)
        except Exception:
            result = _tool_text("工具執行失敗，請稍後再試", is_error=True)
        return _rpc_ok(req_id, result, legacy=legacy)

    # A JSON-RPC error rides on a 200: the HTTP request itself was fine.
    return _rpc_error(req_id, -32601, f"不支援這個方法：{method}")


@app.get("/api/mcp")
@app.delete("/api/mcp")
def mcp_endpoint_rejects(request: Request):
    """
    No server-initiated stream and no sessions to end, in any revision we
    speak: 405 is the documented answer to both for a stateless server.
    """
    return Response(status_code=405)

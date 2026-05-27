# EntrepreneurAgenda

企業家國際演講會 Club Management 系統，含登入、議程管理、會員管理、分會管理與圖片雲端儲存。

## 專案結構

```
EntrepreneurAgenda/
├── auth.js               # 共用 auth 工具（API_BASE 自動偵測環境、角色輔助函式）
├── login.html            # 登入 / 註冊頁面
├── home.html             # 會務管理首頁（Dashboard 版型）
├── index.html            # 議程表產生器（需登入）
├── member.html           # 會員管理頁面（管理 users 資料表）
├── club.html             # 分會管理頁面
├── admin.html            # 用戶管理頁面（僅 system_admin）
├── change-password.html  # 修改密碼頁面（含首次登入強制改密碼）
├── app.js                # 議程產生器主邏輯
├── style.css             # 議程產生器樣式
├── media/                # 靜態圖片（TM Logo、FB QR、LINE QR）
├── requirements.txt      # Python 套件（Vercel 用）
├── vercel.json           # Vercel 路由設定
├── alembic.ini           # Alembic 設定
├── .env                  # 本地環境變數（不進版控）
├── api/
│   └── index.py         # FastAPI（本地開發 & 正式環境共用）
└── migrations/
    ├── env.py            # Alembic 環境設定（讀取 DATABASE_URL）
    ├── script.py.mako    # Migration 模板
    └── versions/
        ├── 0001_initial_schema.py        # 建立 users / agendas / members
        ├── 0002_seed_admin_user.py       # 初始 admin 帳號
        ├── 0003_add_clubs.py             # 建立 clubs 資料表、members 加 club_id
        ├── 0004_add_roles.py             # users 加 role / club_id、agendas 加 club_id
        ├── 0005_merge_members_to_users.py # users 加 level，廢棄 members 資料表
        ├── 0006_add_must_change_pw.py    # users 加 must_change_pw（首次登入改密）
        └── 0007_add_status.py            # users 加 status（active / pending 審核制）
```

---

## 重大架構變更（v2）

> **members 資料表已廢棄。** 每位 `user` 就是一位 club member，`level` 直接存在 `users` 資料表。

| 舊版 | 新版 |
|------|------|
| `members` 獨立資料表 | 改為 `users.level` 欄位 |
| 自行註冊即可登入 | 自行註冊 → `pending`，需管理員審核 |
| 無首次改密機制 | admin 建立帳號後 `must_change_pw=true`，首次登入強制改密碼 |
| `/api/members` | 由 `/api/users` 取代 |

---

## 權限系統（RBAC）

系統共有三種角色：

| 角色 | 說明 |
|------|------|
| `system_admin` | 最高權限，可 CRUD 所有分會、所有用戶、所有議程 |
| `club_admin` | 可新增 / 編輯 / 刪除**自己分會**的 `club_member`；可審核 / 拒絕自行註冊的 pending 用戶；可 CRUD 自己分會的議程 |
| `club_member` | 僅能閱覽頁面，無法寫入任何資料 |

### 特殊規則

- `admin` 帳號由 migration `0002` 初始化，**不可刪除，不可變更角色**
- 自行註冊的用戶預設 `status = 'pending'`，**無法登入**，需由 `club_admin` 或 `system_admin` 審核通過 (`approve`) 才能登入
- 管理員直接建立（`POST /api/users`）的帳號 `must_change_pw = true`，首次登入後系統強制導向改密碼頁面
- `club_admin` 建立用戶或議程時，`club_id` 自動設為其所屬分會（不可指定其他分會）
- `club_admin` 只能刪除同分會的 `club_member`，不可刪除其他管理員

### 用戶 status 說明

| status | 說明 |
|--------|------|
| `active` | 正常，可登入 |
| `pending` | 自行註冊，等待管理員審核 |

### 前端 UI 規則

`auth.js` 的 `applyRoleUI()` 會依角色隱藏對應元素：

| CSS class | 說明 |
|-----------|------|
| `.write-action` | 寫入操作按鈕（`club_member` 看不到） |
| `.system-admin-only` | 系統管理員操作（僅 `system_admin` 看到） |

---

## 正式部署（Vercel）

### 1. Vercel 環境變數設定

至 **Project → Settings → Environment Variables** 新增：

| Key | Value |
|-----|-------|
| `DATABASE_URL` | Neon PostgreSQL **Pooled** 連線字串（見下方說明） |
| `JWT_SECRET` | 隨機產生的密鑰字串 |
| `R2_ACCOUNT_ID` | Cloudflare 帳號 ID |
| `R2_ACCESS_KEY_ID` | R2 API Token Access Key ID |
| `R2_SECRET_ACCESS_KEY` | R2 API Token Secret |
| `R2_BUCKET_NAME` | R2 Bucket 名稱 |
| `R2_PUBLIC_URL` | R2 Public Development URL（`https://pub-xxx.r2.dev`） |

> ⚠️ `INVITE_CODE` 已移除：自行註冊改為審核制，不再需要邀請碼。

#### DATABASE_URL：使用 Neon Connection Pooler

為降低 serverless 冷啟動時的 DB 連線延遲，請使用 Neon 的 **Pooled connection string**：

1. Neon Dashboard → 選 Project → **Branches** → 點 branch（`main`）
2. Connection string 區塊將 **Connection type** 切換為 **Pooled connection**
3. 複製連線字串（hostname 中含 `-pooler`），貼入 Vercel `DATABASE_URL`

```
# Pooled 連線字串範例（hostname 含 -pooler）
postgresql://user:pass@ep-xxx-pooler.ap-southeast-1.aws.neon.tech/dbname?sslmode=require
```

> `channel_binding` 參數會由程式碼自動移除，不影響連線。

### 2. 部署

Push 到 GitHub，Vercel 自動部署。`/api/*` 的請求透過 `vercel.json` 路由至 `api/index.py`。

> ⚠️ Vercel **不會自動執行 migration**。每次新增 migration 版本後，請手動在正式 DB 執行 `alembic upgrade head`。

### 3. URL 路由規則（vercel.json）

| URL | 對應檔案 | 說明 |
|-----|---------|------|
| `/login` | `login.html` | 登入 / 自行註冊（送出後等待審核） |
| `/home` | `home.html` | 會務 Dashboard |
| `/index` | `index.html` | 議程表產生器 |
| `/member` | `member.html` | 會員管理（管理 users） |
| `/club` | `club.html` | 分會管理 |
| `/admin` | `admin.html` | 用戶管理（system_admin only） |
| `/change-password` | `change-password.html` | 修改密碼 / 首次登入強制改密碼 |

---

## 本地開發（FastAPI）

### 第一次設定

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

### 之後每次啟動

```powershell
.\venv\Scripts\Activate.ps1
uvicorn api.index:app --reload --port 8001
```

後端跑在 `http://localhost:8001`。

| 文件頁面 | 位址 |
|----------|------|
| Swagger UI | http://localhost:8001/docs |
| ReDoc | http://localhost:8001/redoc |

### 本地 .env 設定

```env
DATABASE_URL=postgresql://...
JWT_SECRET=your-secret
R2_ACCOUNT_ID=your-account-id
R2_ACCESS_KEY_ID=your-access-key
R2_SECRET_ACCESS_KEY=your-secret-key
R2_BUCKET_NAME=your-bucket-name
R2_PUBLIC_URL=https://pub-xxx.r2.dev
```

---

## Database Migration（Alembic）

Schema 版本管理使用 **Alembic**。

### 部署新環境 / 第一次初始化

```powershell
.\venv\Scripts\Activate.ps1
alembic upgrade head
```

這個指令會依序執行所有 migration：

1. `0001` — 建立 `users`、`agendas`、`members` 資料表
2. `0002` — 新增預設 `admin` 帳號（密碼見部署文件）
3. `0003` — 建立 `clubs` 資料表；`members` 加 `club_id` 外鍵
4. `0004` — `users` 加 `role`、`club_id`；`agendas` 加 `club_id`；`admin` 升為 `system_admin`
5. `0005` — `users` 加 `level`；廢棄並刪除 `members` 資料表
6. `0006` — `users` 加 `must_change_pw`（admin 建立帳號首次登入強制改密碼）
7. `0007` — `users` 加 `status`（`active` / `pending` 審核制）

### 常用指令

| 指令 | 說明 |
|------|------|
| `alembic history` | 查看所有 migration 版本 |
| `alembic current` | 查看 DB 目前在哪個版本 |
| `alembic upgrade head` | 執行全部尚未套用的 migration |
| `alembic downgrade -1` | 回滾上一個版本 |
| `alembic revision -m "描述"` | 建立新 migration 檔 |

### 新增欄位的流程

```powershell
# 1. 建立新 migration
alembic revision -m "add_avatar_to_users"

# 2. 編輯產生的檔案，填入 upgrade / downgrade
#    migrations/versions/xxxx_add_avatar_to_users.py

# 3. 套用
alembic upgrade head
```

### 測試 Migration（上正式 DB 前）

建議先用獨立的測試 DB 驗證，確認無誤再套用正式環境。

**1. 在 Neon 建立新的測試 Project**
> [console.neon.tech](https://console.neon.tech) → New Project → 取得 Pooled connection string

**2. 暫時替換 `.env` 的 `DATABASE_URL`**
```env
DATABASE_URL=postgresql://user:pass@ep-xxx-pooler.../neondb?sslmode=require
```

**3. 跑 migration 並驗證**
```powershell
.\venv\Scripts\alembic.exe upgrade head
.\venv\Scripts\alembic.exe current   # 應顯示 0007 (head)
```

**4. 確認無誤後，將 `.env` 改回正式 DB，再執行一次**
```powershell
.\venv\Scripts\alembic.exe upgrade head
```

> **Rollback**：若需要回滾，`alembic downgrade -1` 回一版，`alembic downgrade base` 全部清除。
> 正式 DB 執行 downgrade 前請務必備份，`DROP TABLE` 無法復原。

---

## Cloudflare R2 設定

主題圖片透過 R2 儲存，需完成以下設定：

1. 建立 R2 Bucket，開啟 **Public Development URL**
2. 建立 R2 API Token（權限：**Object Read & Write**）
3. 在 Bucket **Settings → CORS Policy** 加入：

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3600
  }
]
```

圖片命名規則：`media/{會議日期}_No{編號}_{時間}.{副檔名}`
（例：`media/2026-05-20_No280_213022.jpg`）

---

## 前端頁面

| 頁面（Vercel URL） | 檔案 | 說明 | 最低權限 |
|--------------------|------|------|----------|
| `/login` | `login.html` | 登入 / 自行註冊（送出後需等待審核） | 無 |
| `/home` | `home.html` | 會務管理 Dashboard，含統計卡片、議程列表 | 任何登入用戶 |
| `/index` | `index.html` | 議程表產生器，即時預覽並可匯出 PDF / JPG | 任何登入用戶 |
| `/member` | `member.html` | 會員管理，新增、編輯、批量匯入、審核、移除會員 | `club_admin`（寫入） |
| `/club` | `club.html` | 分會管理，新增、編輯、刪除分會 | `system_admin`（寫入） |
| `/admin` | `admin.html` | 用戶管理，設定角色與所屬分會 | `system_admin` |
| `/change-password` | `change-password.html` | 修改密碼；admin 建立帳號後首次登入強制跳轉 | 任何登入用戶 |

`auth.js` 會自動偵測環境：
- **本地**（localhost）→ `http://localhost:8001`
- **Vercel**（正式）→ 相對路徑（同網域）

---

## API 端點

### 認證

| 方法 | 路徑 | 說明 | 權限 |
|------|------|------|------|
| POST | `/api/auth/register` | 自行註冊；帳號預設 `status=pending`，**需審核後才能登入** | 無 |
| POST | `/api/auth/login` | 登入，回傳 JWT token（有效期 24 小時）；`pending` 帳號拒絕登入 | 無 |
| GET  | `/api/auth/verify` | 驗證 token，回傳 username / role / club_id / must_change_pw | 已登入 |
| PUT  | `/api/auth/change-password` | 修改自己的密碼；成功後清除 `must_change_pw` 旗標 | 已登入 |

### 議程管理（需 Bearer Token）

| 方法 | 路徑 | 說明 | 權限 |
|------|------|------|------|
| GET    | `/api/agendas` | 取得議程列表（支援 `date`、`page`、`limit`、`club_id`） | 已登入 |
| POST   | `/api/agendas` | 新增議程 | `club_admin` 以上 |
| GET    | `/api/agendas/{id}` | 取得單一議程 | 已登入 |
| PUT    | `/api/agendas/{id}` | 更新議程 | `club_admin` 以上 |
| DELETE | `/api/agendas/{id}` | 刪除議程 | `club_admin` 以上 |

> `club_admin` 只能看到 / 操作自己分會的議程；`system_admin` 可看到全部。

### 分會管理（需 Bearer Token）

| 方法 | 路徑 | 說明 | 權限 |
|------|------|------|------|
| GET    | `/api/clubs` | 取得分會列表（**不需登入**，供註冊表單使用） | 無 |
| POST   | `/api/clubs` | 新增分會 | `system_admin` |
| PUT    | `/api/clubs/{id}` | 更新分會名稱 | `system_admin` |
| DELETE | `/api/clubs/{id}` | 刪除分會 | `system_admin` |

### 用戶 / 會員管理（需 Bearer Token）

> **注意：** `members` 資料表已廢棄，會員資料統一由 `users` 管理。

| 方法 | 路徑 | 說明 | 權限 |
|------|------|------|------|
| GET    | `/api/users` | 取得用戶列表（含 level、status；`?club_id=X` 可篩選） | 已登入 |
| POST   | `/api/users` | 新增單一用戶（直接 `active`，`must_change_pw=true`） | `club_admin` 以上 |
| POST   | `/api/users/bulk` | 批量建立 `club_member`（username 自動從 name_en 產生） | `club_admin` 以上 |
| PUT    | `/api/users/{username}` | 更新用戶資料（club_admin：僅 name / level；system_admin：含 role / club_id） | `club_admin` 以上 |
| PUT    | `/api/users/{username}/approve` | 審核通過 pending 用戶（設 status = 'active'） | `club_admin` 以上 |
| DELETE | `/api/users/{username}/reject` | 拒絕並刪除 pending 用戶 | `club_admin` 以上 |
| DELETE | `/api/users/{username}` | 刪除用戶（`admin` 不可刪；club_admin 只能刪同分會 club_member） | `club_admin` 以上 |

#### 批量建立（`/api/users/bulk`）

```json
{
  "members": [
    { "name_zh": "王小明", "name_en": "Wang Xiaoming", "level": "TM" }
  ],
  "club_id": 1,
  "default_password": "Toastmasters1"
}
```

- `username` 自動從 `name_en` 小寫去除特殊字元產生，重複時加流水號
- 所有帳號建立後 `must_change_pw = true`

### 圖片上傳（需 Bearer Token）

| 方法 | 路徑 | 說明 | 權限 |
|------|------|------|------|
| POST | `/api/upload/presign` | 取得 R2 Presigned URL（前端直傳） | `club_admin` 以上 |
| GET  | `/api/image-proxy` | 代理取得 R2 私有圖片（`?url=...`） | 已登入 |

---

## 資料庫 Schema

```sql
CREATE TABLE clubs (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(100) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE users (
    id             SERIAL PRIMARY KEY,
    username       VARCHAR(50) UNIQUE NOT NULL,
    password_hash  TEXT NOT NULL,
    name_en        VARCHAR(100),
    name_zh        VARCHAR(100),
    role           VARCHAR(20)  NOT NULL DEFAULT 'club_member',
    club_id        INTEGER REFERENCES clubs(id) ON DELETE SET NULL,
    level          VARCHAR(100) NOT NULL DEFAULT 'TM',
    must_change_pw BOOLEAN      NOT NULL DEFAULT false,
    status         VARCHAR(20)  NOT NULL DEFAULT 'active',
    created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE agendas (
    id           SERIAL PRIMARY KEY,
    username     VARCHAR(50) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    data         JSONB NOT NULL,
    meeting_date DATE,
    club_id      INTEGER REFERENCES clubs(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);
```

> `members` 資料表已於 migration `0005` 廢棄並刪除。

議程的 `data` JSONB 欄位包含 `themeImgUrl`，用於儲存 R2 主題圖片的公開網址。

### users 欄位說明

| 欄位 | 說明 |
|------|------|
| `role` | `system_admin` / `club_admin` / `club_member` |
| `level` | TM 等級（`TM`、`ACB`、`DTM` 等），預設 `TM` |
| `must_change_pw` | `true` → 登入後強制導向改密碼頁；admin 建立帳號時自動設為 `true` |
| `status` | `active`（正常）/ `pending`（自行註冊，等待審核） |

### Role 值說明

| role | 說明 |
|------|------|
| `system_admin` | 最高管理員（`admin` 帳號為唯一預設值，不可改、不可刪） |
| `club_admin` | 分會管理員，需指定 `club_id` |
| `club_member` | 一般會員（預設值） |

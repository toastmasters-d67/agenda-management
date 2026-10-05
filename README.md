# EntrepreneurAgenda

企業家國際演講會 Club Management 系統：帳號密碼或 Microsoft 帳號登入、議程產生、角色安排、會員與分會管理、Pathways 目錄、社群發文（AI 文案／生圖、發布到 FB／IG／Threads），以及讓 AI 助理透過 **MCP** 操作系統。

## 架構

| 層 | 技術 | 說明 |
|----|------|------|
| 前端 | **Next.js 15** + React 19（App Router，`app/`） | 每個頁面一個 `app/<route>/page.js`；`middleware.js` 在 edge 驗登入 cookie。`package.json` 的 `overrides` 把 Next 鎖死的 postcss／nanoid 拉到已修補的版本 |
| 前端 → 後端 | `/svc/*` 代理（`app/svc/**`） | 瀏覽器只拿得到 httpOnly 的 `auth_token` cookie，代理在伺服器端把它轉成 `Authorization: Bearer` 送到 FastAPI。前端一律用 `lib/api.js` 的 `apiJson()` |
| 後端 | **FastAPI**（`api/index.py`，單一檔案） | 所有 `/api/*`、OAuth 與 MCP 端點；Vercel 上是 Python serverless function |
| 資料庫 | Neon PostgreSQL，**Alembic** 管 schema | 見「Database Migration」 |
| 檔案 | Cloudflare R2 | 前端拿 presigned URL 直傳 |

## 專案結構

```
EntrepreneurAgenda/
├── app/                      # Next.js 頁面（App Router）
│   ├── layout.js / globals.css
│   ├── login/                # 登入 / 自行註冊 / Microsoft 登入與申請（支援 ?next= 回跳）
│   ├── home/                 # 會務 Dashboard
│   ├── agenda/               # 議程表產生器（公開網址是 /index，見 next.config.mjs）
│   ├── roles/                # 角色安排（多場例會 × 角色矩陣，ROLE_GROUPS / META_FIELDS）
│   ├── social/               # 社群發文
│   ├── member/               # 會員管理
│   ├── club/                 # 分會管理（品牌、版型設定、社群帳號、分會 AI 金鑰）
│   ├── pathways/             # Pathways 目錄管理（system_admin）
│   ├── change-password/      # 修改密碼 / 首次登入強制改密碼
│   ├── oauth/authorize/      # MCP 客戶端的 OAuth 同意畫面
│   ├── settings/             # 每位使用者的設定：個人資料、登入方式、已授權的應用程式
│   └── svc/                  # 同源代理：cookie → Bearer → FastAPI
│       ├── [...path]/route.js
│       └── auth/
│           ├── {login,logout,register}/route.js    # 登入時把 JWT 寫成 httpOnly cookie
│           └── microsoft/{start,callback}/route.js # Microsoft 登入：state / PKCE / nonce cookie、回呼後設 cookie
├── components/Sidebar.js     # 側邊選單
├── lib/
│   ├── api.js                # apiFetch / apiJson（打 /svc/*）
│   ├── auth.js               # 角色輔助函式、applyRoleUI()
│   ├── agendaTemplates.js    # 議程版型引擎（AGENDA_TEMPLATES + 每版型 manifest / 預設素材 / 語言能力）
│   ├── postTemplates.js      # 社群海報版型
│   ├── socialPlatforms.js    # 各平台字數、圖片規則
│   ├── pathways.js           # Pathways 目錄載入與查詢
│   ├── rolesSheet.js         # 角色表 Google Sheet 匯入解析
│   └── memberAutocomplete.js # 會員自動完成（下拉建議 + 可自由輸入）
├── public/media/             # 靜態圖片（各版型預設 logo / QR）
│   ├── toastmasters_logo.png
│   ├── Entrepreneur/  ChillHiHigh/  China/
├── middleware.js             # 未登入導向 /login；/api、/svc、/.well-known 放行
├── next.config.mjs           # 舊 .html 網址轉址、/index → /agenda
├── api/index.py              # FastAPI（本地開發 & 正式環境共用）
├── requirements.txt          # Python 套件
├── package.json              # Node 套件（next / react / jose）
├── vercel.json               # /api/* 與 /.well-known/* 交給 api/index.py
├── alembic.ini
├── .env                      # 本地環境變數（不進版控）
└── migrations/
    ├── env.py                # 讀取 DATABASE_URL
    └── versions/             # 0001 … 0017，見「Database Migration」
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

## 議程版型引擎（分會專屬版型）

每個分會可擁有**自己的品牌**與**獨立的議程版型**。版型與其所有相關設定（欄位、預設素材、語言能力）**集中定義於 `lib/agendaTemplates.js`，是單一事實來源**——新增/調整版型基本上只動這個檔案（＋樣式）。

### 版型物件（`AGENDA_TEMPLATES[key]`）

| 屬性 | 說明 |
|------|------|
| `key` / `label` | 版型代號（對應 `clubs.template_key`）與下拉顯示名稱 |
| `render(data, club, ctx)` | 產出 HTML（回傳字串＝單頁；字串陣列＝多頁） |
| `langToggle` | `false` → 隱藏語言切換並固定 `fixedLang`（見「語言能力」） |
| `fixedLang` / `bilingualNames` | 固定渲染語言；`bilingualNames` 讓成員姓名顯示「English 中文」 |
| `assetDefaults` | 分會未上傳時的預設圖（key 用 `logo_url` / `fb_qr_url`…） |
| `fieldDefaults` | 預設值（如 `timeRange` / `venue`） |
| `settings` | **版型專屬欄位 manifest**（見下） |

輔助函式：`templateAssetDefaults(key)`、`templateFieldDefaults(key)`、`applyTmplVisibility(root, key)`。

### 運作方式

- `app/agenda/page.js` 渲染時 `getActiveClub()` 解析目前分會 → 依 `template_key` 取版型 → `render()` 產出 HTML，外層套 `.tmpl-<key>` class。
  - `system_admin`：版型 / 品牌取自議程上方「所屬分會」下拉（從 `/home` 點「新建議程」會以 `?club_id=` 自動帶入所選分會）。
  - `club_admin` / `club_member`：自動取自己所屬分會。
- 品牌與版型為**即時解析**（不快照進 `agendas.data`）。
  - ✅ 編輯分會品牌後，該分會所有議程自動套用新資料。
  - ⚠️ 變更某分會的 `template_key` 會讓其**既有議程**也改用新版型呈現。
- 未設定欄位的 fallback 鏈：分會設定 → 該版型 `fieldDefaults` / `assetDefaults` → 標準版預設。預設圖集中於 `media/Entrepreneur/`（標準版）與 `media/ChillHiHigh/`（Chill Hi High）。

### 語言能力（依版型）

- `standard` / `compact`：提供中/英切換（設定選單的「語言」）。
- `chillhihigh`：中英混用，**隱藏「語言」切換**、固定渲染語言，且成員姓名顯示「English 中文」。
- `app/agenda/page.js` 於 `updatePreview()` 依版型旗標顯示/隱藏「語言」選單並 pin 語言。

### 版型專屬欄位 manifest（`template.settings`）

每個版型專屬欄位**只在 manifest 宣告一次**，`/club`（`app/club/page.js`）的「版型設定」modal 會據此**動態產生**欄位（含填值與存檔）：

```js
{ key, label, type:'text|textarea|image', store:'column|setting',
  group:'basic|template', section, row, placeholder }
```

- `store`：`column` = 存 `clubs` 頂層欄位（如 `charter_no`）；`setting` = 存 `clubs.settings` JSONB。
- `group`：`basic`（分會管理頁「編輯」視窗）/ `template`（「版型」視窗）。分會列表每列有「編輯」「版型」兩顆按鈕，開啟同一 modal 的兩種檢視。
- 圖片欄位透過既有 `/api/upload/presign` **延後上傳**；未上傳時預覽顯示 `assetDefaults`。
- 存檔採 **merge-based**：以現有分會記錄為基底，只覆寫當前版型 manifest 管的欄位（後端 PUT 為 full-replace，避免洗掉他版型欄位）。

目前 `clubs.settings` 內的鍵：
- 表頭/結尾：`slogan`（標語）、`transit`（交通）、`closingLine`（結尾句）
- 議程資訊：`timeRange`（預設時間；日期仍動態帶入當日）、`venue`（預設地點）、`scheduleZh` / `scheduleEn`（會議日期行，隨語言顯示；標準版 fallback 到 `t('meetingSchedule')`）
- 第二頁宣傳後頁：`upcomingMeetings`、`specialEvent`、`membershipFee`、`ig_qr_url`、`page2_hero_url`、`page2_img2_url`

> `venue` / `timeRange` 為**每場可覆寫的預設值**：`applyDefaultState()` 依「分會設定 → 版型 `fieldDefaults` → 標準版」帶入議程表單，仍可逐場修改。

### 每場欄位（存 `agendas.data`，跨版型相容、optional）

- `boardWriter`、`photographer`、`tableTopicsQuestion`
- `signals`：時間管理綠/黃/紅牌（每類別可手動編輯，預設帶入標準計時規則）
- `speeches[].speechLang`：每篇演講語言（`en` / `zh`）。**Chill Hi High** 依此把對應（同索引）的個別講評員標示為「英語講評員 / 國語講評員」。
- `evalEvaluators[]`：**講評員講評**（Evaluator's Evaluator）——負責講評個別講評員的人。排在**總講評之後**、仍在講評環節內，**可以沒有，最多 3 位**（`MAX_EVAL_EVALUATORS`）。舊議程沒有這個鍵＝沒有這個角色，5 個版型都支援；`evalMins` 的自動值也會把它算進去。
- `timeOverrides`／`durationOverrides`／`durationLabels`：議程表上的時刻與時長覆寫（見下）

---

## 時間與時長：全部可手動覆寫（`/index` ⏱ 時間設定）

議程表上**每一個**時刻與時長都保留自動計算，同時都能逐場手動指定。**空白 = 自動**。

### 各段開始時刻（`timeOverrides`，議程表「時間」欄）

`receptionStart`、`openingStart`、`speechStart`（多元單元）、`preparedSpeechStart`、`photoStart`、`topicsStart`、`evalStart`、`closingStart`、`sharingStart`，另有 `endTime`（推算休息／即席問答彈性時間的目標結束時刻）。

> **釘住某一段後，後面各段會從該時刻往下推算**——所以指定一個時刻是「整場往後挪」，不會出現與後續各列互相矛盾的時間。上游的釘選仍然有效。
> 格式須為 `H:MM` / `HH:MM`，不合格式即忽略並回到自動值。

### 各段時長（`durationOverrides`，議程表「時長」欄）

`receptionMins`、`openingMins`、`speechMins`、`photoMins`、`intermissionMins`、`topicsMins`、`evalMins`、`closingMins`、`sharingMins`。

自動值的算法：

| 欄位 | 自動計算 |
|------|----------|
| `speechMins` | Σ 各篇演講時長上限 + 4′ 換場 + 總主持人串場（`durationSettings.tmeMins`） |
| `evalMins` | （個別講評 + 講評員講評）每位 3′ + 固定報告 12′ + 總講評串場（`durationSettings.geMins`） |
| `topicsMins`／`intermissionMins` | 吸收距離 `endTime` 的剩餘時間（各上限 +10′）；任一邊被手動指定時，另一邊才吸收剩餘 |
| 其他 | 固定預設值（報到 20′、開幕 10′、拍照 5′、結尾 6′、分享 5′） |

### 講評區固定列時長（`durationLabels`）

`個別講評 2'~3'`、`計時員報告 1'`、`贅語報告 1'`、`語言講評 3'~5'`、`總講評 3'~5'`、`講評員講評 2'~3'` 原本寫死在版型裡，現在改為每場可編輯的**顯示字串**（可填區間，不參與加總運算），與 `signals` 同一套模式：載入時 merge 到預設值上，舊議程自動沿用原本字樣。

> 版型端從 `ctx.durationLabels` 取用，並以 `lib/agendaTemplates.js` 的 `DEFAULT_DURATION_LABELS` 作最後防線。`standard` 與 `compact` 已改為資料驅動；`chillhihigh` 的講評列本來就用 `signals` 的綠/黃/紅欄，不受影響。

### 每個欄位旁的「自動: X」與 ⟳

提示顯示的是**該欄自己解除釘選後會變成的值**（上游釘選仍計入），也就是 ⟳ 按下去會還原成的那個值——由 `autoValueFor(key)` 針對單一欄位重算得出，因此提示不會和實際結果矛盾。

> **相容性**：舊版曾把「報到開始」存成 `timeOverrides.openingStart`，而 `openingStart` 現在是「開幕」那一段的獨立釘選。載入時以「有沒有 `receptionStart` 這個鍵」判斷新舊格式，舊資料會遷移到 `receptionStart`，不會被誤讀成新的開幕釘選。

### 多頁版型

版型 `render()` 可回傳 **字串（單頁）或字串陣列（多頁）**。`#agendaPages` 把第 1 頁放進 `#agendaPreview`、其餘頁以 `.extra-page` 兄弟節點呈現；PDF 匯出用 html2pdf 的 `pagebreak: { before: '.extra-page' }` 自動分頁。`chillhihigh` 即回傳 `[議程頁, 宣傳後頁]` 兩頁。

### 依版型顯示表單區塊（統一 `data-tmpl`）

議程表單中版型專屬區塊以 `data-tmpl="<key>"` 標記；`app/agenda/page.js` 的 `applyTemplateFields()` 呼叫共用的 `applyTmplVisibility()` 依目前版型顯示 / 隱藏。（「版型設定」modal 則直接依 manifest 產生欄位，不需此屬性。）

### 新增一個版型

1. 在 `lib/agendaTemplates.js` 的 `AGENDA_TEMPLATES` 新增 entry：`key` / `label` / `render`，視需要加 `langToggle` 等語言旗標、`assetDefaults` / `fieldDefaults`、`settings` manifest。
2. 在 `app/agenda/agenda.css` 以 `.tmpl-<key>` 命名空間撰寫樣式（勿污染其他版型）。

> 「版型設定」modal 欄位、預設值/預設圖、分會版型下拉（`TEMPLATE_OPTIONS`）皆會**自動跟上**——欄位只需在 manifest 宣告一次。

> 內建版型：
> - `standard`（標準版／企業家，**舊版**）
> - `compact`（精簡單欄示範版）
> - `chillhihigh`（雙語幽默版／Chill Hi High：中英混用、內嵌綠/黃/紅時間牌欄、個別講評員依演講語言標示、底部 Meeting Roles 說明；**兩頁**：議程頁 + 宣傳後頁）
> - `china`（CHINA Toastmasters／CHANGE IN ACTION：固定流程表 `CHINA_SCHEDULE`、全英文、附「下一場」角色欄；**兩頁**）
> - `entrepreneur`（企業家版）

#### `standard` 與 `entrepreneur`：分家了，不再共用 render

`entrepreneur` 一開始是 `{ ...AGENDA_TEMPLATES.standard }` 的 spread clone，兩者共用**同一個** `render` 與同一份 `assetDefaults` / `fieldDefaults` / `placeholders` / `settings` 物件參照。現在 `entrepreneur` 是 `AGENDA_TEMPLATES` 裡一個完整獨立的 entry，**自己的 `render()`、自己的預設值常數（`ENTREPRENEUR_*`）、自己的 `settings` manifest**——改企業家版不會動到標準版，反之亦然。

- `entrepreneur` 是**活的**：企業家分會版面要改就改這裡。
- `standard` 是**凍結的**：留著只為了讓 `template_key='standard'` 的舊分會記錄維持原樣，不要再改它。
- 分家當下兩者輸出**完全一致**，所以既有議程不受影響。

**CSS 也拆了。** `agenda.css` 原本這段版面樣式是全域選擇器（`.agenda-table`、`.doc-header`、`.rp-cell` …），兩個版型共用；現在拆成 `.tmpl-standard` 與 `.tmpl-entrepreneur` **兩份各自獨立的完整副本**（各 61 條規則，拆分當下內容相同），跟 `compact` / `chillhihigh` / `china` 一樣收進 `.tmpl-<key>` 命名空間。改其中一份不會影響另一份。

仍然保持全域的只有兩樣，都是刻意的：

| 選擇器 | 為什麼不收進命名空間 |
|--------|------------------|
| `.agenda-page` | 所有版型共用的 A4 紙張外框（尺寸、邊距、字型、陰影），`page.js` 對每個版型都掛這個 class |
| `.tc-g` / `.tc-y` / `.tc-r` | 時間規則的紅黃綠色塊，標準版／企業家版的右側面板與 **CHINA 第二頁**的 Time Control 表格共用 |

---

## 角色安排（`/roles`）

一頁規劃**多場例會**的角色：**每列一個角色、每欄一場例會**，直接在格子裡填人。

### 直接在矩陣裡新增例會

矩陣最右邊有一欄「＋」（沒有寫入權限的人看不到；完全沒有例會時空狀態畫面也有一顆等效的按鈕）：點下去彈出「新增例會」modal（`#addMeetingModal`，樣式比照 `/agenda` 既有的 modal 語彙），只要選日期、按「新增」就會呼叫跟「新建議程」頁一樣的 `POST /api/agendas`（只帶 `meetingDate`，其他欄位留給版型的 fallback 鏈補）。成功後直接把新例會插進目前的 `meetings` 陣列（依日期排序）並關閉 modal，不用整頁重新載入，馬上就能在新的那一欄填角色。新例會即使日期落在目前的日期篩選範圍之外也會顯示——避免建立後「消失」的錯覺；篩選範圍要到下次變更日期或重新整理才會重新套用。

每欄標題右上角也有一個「✕」可以刪除該場例會（同樣需要寫入權限），會先 `confirm()` 一次（若該場有未儲存的變更，訊息裡會多提醒一句），確認後呼叫 `DELETE /api/agendas/{id}`，成功就從 `meetings` 移除、矩陣就地重繪——議程本體跟角色安排是同一筆記錄，這裡刪掉之後 `/agenda` 那邊自然也不存在了，無法復原。

### 沒有另一套資料表

角色安排**不另存**——每一格讀寫的就是該場議程 `agendas.data` 裡**同一個欄位**（`app/agenda/page.js` 的 `collectData()` 那些）。因此：

- ✅ 在此頁排定角色 → 該場議程表**立即**顯示同一個人。
- ✅ 在議程產生器改角色 → 回到此頁重新載入即同步。
- ⚠️ 角色清單（`app/roles/page.js` 的 `ROLE_GROUPS`）是**從議程欄位推導**的。議程若新增角色欄位，記得同步加進 `ROLE_GROUPS`。

### 全站共用同一份角色 schema——不適用的欄位鎖住，不是拿掉

`agendas.data` 的角色欄位是**所有版型共用的同一份 schema**：每個角色（`ROLE_GROUPS` 裡的一筆定義）在每個分會的資料裡都是同一個欄位名，某個版型不需要的角色，該分會的資料裡就是空字串／未填，版型的 `render()` 自然不會讀它、也就不會印出來。

角色安排矩陣**永遠顯示 `ROLE_GROUPS` 全部角色**（不會因為版型不同而整列消失）；只有「目前分會的版型不適用」的角色列會被**鎖住**（`role.locked`，灰階、輸入框 `disabled`，不管有沒有寫入權限都鎖），跟「這場例會剛好沒有這個名額」（`slotNote`，可以直接輸入把名額補上）是兩種不同的視覺語言，不要混淆。

角色定義可加 `templates: string[]`，列出「哪些版型會用到這個角色」（不寫＝所有版型都用得到）：`buildRows()` 依 `activeTemplateKey()` 算出每個角色的 `locked` 旗標。目前有 `templates` 限制的角色：

| 角色 | 適用版型 | 為什麼 |
|------|------|------|
| `callingToOrder` | standard／compact／entrepreneur／china | Chill Hi High 的「致歡迎詞 Opening Remarks」那列讀的是 `welcomeTME`，不再需要這格 |
| `boardWriter`／`photographer` | chillhihigh | 只有 Chill Hi High 議程把板書、攝影列成獨立角色 |
| `timerAssistant` | chillhihigh | Chill Hi High 的例會角色表另外排一位計時員幫手 |
| `voteCounter` | china | CHINA 專屬的計票員（歸在「計時 / 記錄」組） |
| `varietyHost` | standard／compact／entrepreneur／chillhihigh | CHINA 沒有多元單元 |
| `wordOfTheDay`／`quizHost` | china | CHINA 專屬的每日一字、問答遊戲主持（歸在「單元主持」組） |

其餘角色（`receptionHost`、`welcomeTME`、`tme`、`timer`、`ahCounter`、`tableTopicsMaster`、`speeches[i].speaker`、`evaluators[i]`、`langEvaluator`、`generalEvaluator`、`evalEvaluators[i]`、`awardsPresenter`、`sharingFeedback`）沒有 `templates` 限制，5 個版型都共用。

### 角色清單（`ROLE_GROUPS`）

| 分組 | 角色（`agendas.data` 欄位） |
|------|------|
| 會議主持 | `receptionHost`、`callingToOrder`、`welcomeTME`、`tme` |
| 計時 / 記錄 | `timer`、`timerAssistant`、`ahCounter`、`boardWriter`、`photographer`、`voteCounter` |
| 單元主持 | `varietyHost`（＝`varietySession.host`）、`tableTopicsMaster`、`wordOfTheDay`、`quizHost` |
| 指定演講 | `speeches[i].speaker`（動態，至少 3 列） |
| 講評 | `evaluators[i]`（動態，至少 3 列）、`langEvaluator`、`generalEvaluator`、`evalEvaluators[i]`（動態，0～3 列） |
| 結尾 | `awardsPresenter`、`sharingFeedback` |

演講 / 講評的列數取**目前載入場次中的最大值**（最少 3 列）——CHINA 的 3 篇指定演講／3 位個別講評也是走這同一套 `speeches`/`evaluators` 陣列，沒有另外的資料結構。

`evalEvaluators[i]`（講評員講評）排在 `generalEvaluator` **之後**，跟議程表上的順序一致。它是選配角色，所以不設「最少 3 列」的底線，而是顯示「載入場次中的最大值 + 1」列（上限 3）——永遠留一格空的可以往下加，也不會在多數用不到的場次留下 3 排空格。

### CHINA 版型：跟其他版型一樣的固定欄位

CHINA 議程曾經是一份自由格式的逐列清單（`agendaRows`），已經改成跟其他版型相同的固定角色欄位——`lib/agendaTemplates.js` 的 `china` 版型內部有一張不對外匯出的 `CHINA_SCHEDULE`（該分會目前的週會流程表），每一列綁定要讀的欄位（例如 `Timer` 這一列讀 `data.timer`），純粹是 render() 排版用，角色安排矩陣完全不需要知道它的存在，就跟 standard/compact 一樣。

CHINA 議程表右側原本每列都有一欄「下一場負責人」（`assigneeNext`），現在**不再存進資料庫**，改成**列印/預覽議程時即時查詢**：`app/agenda/page.js` 的 `ensureNextMeetingRoles()` 依「分會 + 這場日期」查詢同分會日期最近的下一場例會（`GET /api/agendas?order=date_asc&date_from=<+1天>&limit=1`），把該場的角色欄位整包當作 `ctx.nextMeetingRoles` 傳給 `render()`；查不到（還沒建立下一場）就顯示空白。查詢結果有 cache（只在分會/日期真的改變時才重查），不會每次打字都打 API。議程編輯頁因此不再有「下次 Next Meeting Assignee」的手動輸入欄。

### 欄標題可編輯的每場欄位（`META_FIELDS`）

欄標題的**場次編號**（`meetingNo`）、**例會主題**（`meetingTheme`）、**主題題目**（`themeQuestion`）都可直接編輯，走與角色**完全相同**的 draft / dirty / merge 流程，但刻意**不列入角色列**——因此不算進「已指派」計數（主題不是人），且不套用會員自動完成。

`META_FIELDS` 也吃 `templates` 允許清單，但與角色列相反：**不適用的欄位直接不顯示**（欄標題塞不下一排灰掉的空欄位），由 `activeMetaFields()` 過濾。要再開放其他每場欄位，加一筆即可：

```js
const META_FIELDS = [
  { key: 'meetingNo',     label: '場次編號', placeholder: '場次編號' },
  { key: 'meetingTheme',  label: '例會主題', placeholder: '未設定主題' },
  { key: 'themeQuestion', label: '主題題目', placeholder: '主題題目', templates: ['chillhihigh'] },
];
```

### 從 Google Sheet 匯入（`roles_sheet_url`）

不少分會的年度角色是先在 Google Sheet 上排的。那張表其實是角色矩陣的**轉置**——第一欄是角色名稱、每一欄是一場例會——所以可以整張對進來。

**綁定網址**：分會列表 →「版型」按鈕 → `例會角色匯入（Google Sheet）` 區塊的「角色表網址」。這是版型 manifest（`lib/agendaTemplates.js` 的 `chillhihigh.settings`）裡的一筆 `store: 'setting'` 欄位，因此存進 `clubs.settings.roles_sheet_url`，**不需要 migration**，也自動生出輸入框（同一套 manifest 驅動的 modal）。網址必須帶分頁編號（`#gid=…`）——請在該分頁上直接複製網址列的完整連結，否則抓到的會是第一個分頁。試算表的共用權限要設成「知道連結的任何人可檢視」。

**讀取**：`GET /api/clubs/{id}/roles-sheet`（`club_admin` 以上，且只能讀自己分會）。網址**不從 request 帶**，而是後端自己去 `clubs.settings` 讀出來再轉成 CSV export URL——因此這個端點無法被指向任意主機，瀏覽器也不必處理 Google 的 CORS。私有試算表 Google 會回 302 到登入頁而不是 4xx，所以後端額外檢查回應的 `Content-Type` 是不是 `text/csv`。

**對照**：`lib/rolesSheet.js` 是一支純函式模組（不碰 DOM、不發網路請求），把 CSV 轉成「每場例會一包 `{ 角色 id: 值 }`」，用的就是 `/roles` 既有的角色 id。幾個判斷：

| 試算表 | 對到 | 備註 |
|------|------|------|
| `會議時間` | 欄（`meetingDate`） | 認得 `2026/07/03`、`2026-7-3`、`2026.07.03`；認不出來的整欄略過 |
| `會議編號`／`會議主題`／`主題題目` | `META_FIELDS` | 欄標題欄位，不算角色 |
| `單元號N`（`PM 4-1`） | `speeches[N].pathwayCode` + `pathwayLevel` | 一格拆成兩個欄位；前兩碼要在 PATHWAYS 清單裡才當作路徑代碼。落在演講者底下的「學習路徑／路徑等級」下拉列；`4-1` 這種非 `L1`–`L5` 的等級落在「其他／自訂」文字框 |
| `單元N` | `speeches[N].pathwayProject` | 落在「專案名稱」下拉列；中英文專案名都認得，不在目錄裡的文字落在「其他／自訂」文字框 |
| `標題N` | `speeches[N].title` | 矩陣沒有這一列，以隱藏欄位寫入（預覽會告知數量） |
| `特別單元`／`無法參加的成員` | — | 不是角色欄位，不匯入；預覽會列出原因 |

人名比對：試算表寫的是 `Leah Kao 高莉雅`，而從下拉選單填的格子存的是 MemberAC 的正規形式 `Name, LEVEL`。對得上名冊就換成正規形式（這樣 `displayMember()` 才能雙語呈現），對不上就**原文保留**——來賓、他會會員本來就不在名冊裡。`NA`／`TBD`／`-` 這類佔位字一律視為空白。

**流程**：按工具列的「從 Google Sheet 匯入」（只有寫入權限 + 該分會有設網址時才出現）→ 日期範圍自動撐開到涵蓋整張表 → 預覽 modal → 確認後：

1. 試算表有、資料庫沒有的場次，用跟「＋」欄同一支 `POST /api/agendas` 建立（預設**跳過只有場次編號、沒有任何角色**的空欄位，可勾選一併建立）；
2. 其餘值全部放進 `draft` + `dirty`，也就是**一般的未儲存編輯**（黃底），確認無誤後按「儲存變更」才真的寫入。

預覽把「填入空格」與「**覆蓋既有**」分開算：一格目前已經有人、且與試算表不同時（多半是後來在這頁改過的），會逐格列出「哪場 · 哪個角色 · 舊值 → 新值」，而不是折進總數裡——只給一個數字的話，「補了一個空格」跟「把你剛改的人覆蓋掉」長得一模一樣。其餘會提示的還有：要新增哪幾場、幾格已相同、哪些名字比對不到名冊、哪些列沒匯入。

因此匯入沿用了既有的 merge 存檔：`saveAll()` 會重讀議程、只覆寫動過的欄位，**試算表的空白格一律略過**，表上沒有的角色（`receptionHost`、`welcomeTME`、`awardsPresenter`、`sharingFeedback`）完全不受影響。

### 人選輸入：下拉建議 + 可自由輸入

每格都是 `<input class="member-ac">`，由 `lib/memberAutocomplete.js` 提供下拉建議（↑↓ 選擇、Enter 確認、Esc 關閉），**同時可以直接打字**——來賓、代理人、`TBD` 都填得進去，下拉只是建議，不會限制輸入值。

- 建議名單來自 `/api/users`（僅 `active`），系統管理員依所選分會取用。
- 插入格式為 `姓名, 等級`，依**該場議程自己的 `data.lang`** 決定中文名或英文名（`data-ac-lang`）。

### 存檔是 merge-based

`PUT /api/agendas/{id}` 是 **full-replace**，所以存檔時：**重新讀取該場議程 → 只覆寫此頁真正改過的角色欄位 → 寫回**。這樣即使有人同時在議程產生器編輯同一場，也不會被舊資料覆蓋。（讀回的 `_clubId` 是編輯器用的提示欄位，寫回前會移除。）

### 介面行為

| 行為 | 說明 |
|------|------|
| 未儲存標示 | 改過的格子（含欄標題的例會主題）變黃底；該欄標題出現橘點；上方顯示未儲存項目數 |
| 欄標題欄位 | 場次編號 / 例會主題 / 主題題目平時看起來就是說明文字，hover / focus 才浮出輸入框，改完與角色一起儲存 |
| 已指派計數 | 每欄顯示 `已指派 / 該場角色數` |
| 額外名額 | 某場原本沒有的演講 / 講評名額，格子淡化並以 `＋` 提示：填入並儲存**會為該議程新增一列** |
| 未啟用多元單元 | 該場 `varietySession.enabled` 為 false **且該格仍是空的**時淡化提示；一旦填入主持人，儲存時 `roleSet()` 會**一併把該場的多元單元設為啟用**（否則排了主持人卻不會出現在議程上）。單向：清空主持人**不會**把單元關掉，那仍是議程編輯器的決定 |
| 日期範圍 | 以**例會日期**篩選要顯示的場次（起訖皆含），欄位由左至右由舊到新。預設為今天往前 2 個月 ～ 往後 3 個月——會往回抓，是因為分會最新一場議程往往已經過去，只看「未來」會開在空白畫面。快捷鍵：`←` / `→` 整段平移一個月，另有「近期 / 未來 / 今年 / 全部」。單邊留空即為不限。上限 40 欄，超過時提示縮小範圍（保留最新的場次） |
| 快捷鍵 | `Ctrl/Cmd + S` 儲存全部；有未儲存變更時離開頁面會提示 |
| 權限 | `club_member` 唯讀（欄位 disabled、寫入按鈕隱藏）；`club_admin` 以上可儲存 |

> 例會必須**先有議程**才會出現在此頁。要規劃新的一場，請先用「新建議程」建立該場次。

---

## 社群發文（`/social`）

把一場例會變成 Facebook / Instagram / Threads 的貼文：寫稿、配圖、依平台規則檢查，並直接發布。

LinkedIn 刻意不做——它的發布 API 卡在合作夥伴審核，做出一個按不下去的分頁只會誤導。

### 狀態：哪些真的發出去過

2026-09-11 第一次接上真實的 Meta App。**不要假設沒打勾的那幾行能用。**

| 路徑 | 狀態 |
|---|---|
| Facebook 純文字 | ✅ 實際發布成功 |
| Threads 純文字 | ✅ 實際發布成功 |
| Facebook 圖片（單張／多張）| ⚠️ 已寫完，未驗證 |
| Instagram（全部）| ⚠️ 已寫完，未驗證 |
| Threads 輪播 | ⚠️ 已寫完，未驗證 |
| 影片（三個平台）| ⚠️ 已寫完，未驗證 |
| 貼文分類與文案帶入例會資訊 | ✅ 實際產出過 |
| 海報版型（宣傳直式）| ✅ 實際產出過 |
| 海報版型（方形、回顧）| ⚠️ 已渲染確認，未實際發布 |

所有 Meta 相關的程式碼刻意集中在 `api/index.py` 的單一區塊，**失敗一律原樣透出 Meta 自己的錯誤訊息**，並補上**錯誤碼**與**失敗的步驟名**：

```
建立貼文容器：Meta 回應錯誤：Unsupported post request. Object with ID … [100/33]
```

方括號裡那組 `code/subcode` 才是可以拿去查的東西。只有散文訊息時查不到——「The requested resource does not exist」對應好幾種互不相干的成因。

### 兩條路：送審，或用開發模式

發文權限（`pages_manage_posts`、`instagram_content_publish`、`threads_content_publish`）是**綁在 App 上**送審的，所以有兩種走法：

- **各分會註冊自己的 App** → 在**開發模式**下就能發布到自己的粉專（把幹部加進該 App 的角色即可），**完全不用送審**。對小型分會這是唯一務實的路。
- **全站共用一個 App** → 你送審一次，所有分會只要點授權。

因此 App ID / Secret 是**每個分會各自填**（分會管理 → 社群），伺服器另有一組環境變數當 fallback，兩種都支援。

### 申請 Meta App（開發模式，不用送審）

以下以**開發模式**為準——單一分會自己用不需要送審。走全站共用 App 的路才需要送 App Review。

> Meta 開發者後台的選單名稱改版頻繁。若路徑跟畫面對不上，以畫面為準；不變的骨架是這四樣：**企業型 App、Facebook 登入、重新導向 URI、角色**。

#### 先決條件

- 一個 Facebook **粉絲專頁**（不是個人帳號），而且你是它的管理員
- 要發 IG 的話，還有兩個條件，見步驟 E

#### A. 建立 App

1. [developers.facebook.com](https://developers.facebook.com) → 「我的應用程式」→「建立應用程式」
2. 第一次用要先註冊為開發者（驗證手機／信箱）
3. 類型選 **「企業」（Business）**——只有這型給得到粉專與 IG 的發文權限
4. 填名稱（例如「企業家分會社群發文」）與聯絡信箱

#### B. 取得 App ID / Secret

「應用程式設定」→「基本資料」：**應用程式編號** = App ID，**應用程式密鑰** = App Secret（按「顯示」需再輸一次 FB 密碼）。

#### C. 網域、平台、重新導向 URI ← 三個欄位，兩個頁面

少任何一個都會被擋，而且三者的格式都不一樣。

**C-1「基本資料」頁**

1. 拉到頁面**最下方** →「＋ 新增平台」→ 選**網站** → 網址填 `https://<你的網域>/`
2. 回到頁面**上半部** →「**應用程式網域**」填 `<你的網域>`
3. 儲存變更

**順序不能顛倒**：沒有平台，應用程式網域存不起來。

**C-2「Facebook 登入 → 設定」頁**

「**有效的 OAuth 重新導向 URI**」填 `https://<你的網域>/club`。同一區塊的「用戶端 OAuth 登入」與「網路 OAuth 登入」要開啟。

| 欄位 | 在哪頁 | 格式 |
|---|---|---|
| 應用程式網域 | 基本資料（上半）| `example.vercel.app`（純網域）|
| 網站平台的網址 | 基本資料（最下方）| `https://example.vercel.app/` |
| 有效的 OAuth 重新導向 URI | Facebook 登入 → 設定 | `https://example.vercel.app/club` |

重新導向那一串不要用猜的——分會管理 →「社群」畫面上就印出來給你複製（由 `location.origin` 算出）。

漏掉 C-1 的症狀是授權頁顯示「**這個網址的網域未包含在應用程式的網域中**」。注意它講的是**應用程式網域**，不是重新導向 URI——這兩個是不同欄位，訊息很容易讓人去改錯的那一個。

#### D. 加上發文權限（使用案例）

企業型 App 預設只掛「商家專用 Facebook 登入」，而它**只管登入驗證，不含發文**。不加這步，授權頁會回：

```
Invalid Scopes: pages_manage_posts, instagram_content_publish
```

`Invalid` 不是拼錯，是「這個 App 沒有這個權限」。而且 Meta 會**直接把它丟掉**——就算按了同意，拿到的 token 也發不了文。

左側「**使用案例**」→「＋ 新增使用案例」：

| 使用案例 | 給你 |
|---|---|
| **管理粉絲專頁的所有內容** | `pages_manage_posts` |
| **管理 Instagram 的訊息和內容** | `instagram_content_publish` |
| **存取 Threads API** | `threads_content_publish`（見步驟 F）|

加完之後還要點該使用案例的「**✎ 自訂**」→「**權限**」→ 逐一按「**新增**」。**只把使用案例加進來、沒按權限的「新增」，一樣是 Invalid Scopes。**

核對 IG 的權限名稱剛好是 `instagram_content_publish`。若只提供 `instagram_business_content_publish`，那是 Instagram 原生登入的另一條路，跟本專案「用粉專 token 發 IG」的實作不相容。

開發模式下顯示「標準存取權」就夠了；「進階存取權」才要送審，那是給非 App 成員使用時才需要。

#### E. Instagram：把 IG 連到粉專

App 這邊不用設定，權限跟著粉專走。真正會卡住的是 IG 帳號本身，有兩個條件：

**1. 必須是專業帳號**

IG App → 個人檔案 → ☰ → 設定和隱私 → 帳號類型和工具 → 切換為專業帳號（商業或創作者）。個人帳號不會出現在授權清單裡。

**2. 必須連結到那個粉專** ← 最容易搞混的一步

Meta 有兩種「連結 Instagram」，名字很像，只有一種有用：

| | 連的是什麼 | 我們要的嗎 |
|---|---|---|
| **帳號中心**（Accounts Center）| IG 個人檔案 ↔ FB **個人**檔案 | ❌ 不是 |
| **粉專的「連結的帳號」** | IG **專業帳號** ↔ FB **粉絲專頁** | ✅ 是這個 |

只做了帳號中心那個，`instagram_business_account` 還是空的，程式一樣抓不到——因為程式是從**粉專**取 IG，不是直接取 IG：

```python
_fb("me/accounts", {"fields": "id,name,instagram_business_account{id,username}"})
```

做法（任一條都行）：

- Meta Business Suite → ⚙ 設定 → **Instagram 帳號** → 連結帳號
- 粉專 → 設定 → **連結的帳號** → Instagram
- IG App → 編輯個人檔案 → **粉絲專頁**

連好之後，那個 IG 才會出現在授權時的帳號清單裡。

#### F. Threads：獨立的一套，連 App ID 都不同

Threads 不共用 Facebook 登入。它有自己的授權入口（`threads.net`）、自己的 API host（`graph.threads.net`）、**自己的 App ID / Secret**，以及自己的測試人員名單。介面上因此是另一顆按鈕。

1. 使用案例 →「**存取 Threads API**」→ **✎ 自訂**
2. 拿 **Threads 應用程式編號 / 應用程式密鑰**——**這組跟步驟 B 的 Facebook App ID 不同**
3. 同一頁的「**重新導向回呼網址**」填 `https://<你的網域>/club`。這是 Threads 專屬欄位，跟 C-2 那份是兩回事
4. 「權限和功能」確認 `threads_basic`、`threads_content_publish` 已新增
5. 最下方「**用戶權杖產生器**」→「新增或移除 Threads 測試人員」→ 邀請要發文的 Threads 帳號
6. **那個帳號要自己接受邀請**：Threads → 設定 → 帳號 → **網站權限** → **邀請** → 接受

第 2 步填錯（把 Facebook 的 App ID 填進來）會得到 `Authorization Failed: No app ID was sent with the request`——那句話會讓你去找一個其實存在的參數。

第 6 步最容易漏，症狀是 `The user has not accepted the invite to test the app`。邀請不會有明顯通知，要自己走進那個選單找。

Threads 帳號必須是**公開**的，私人帳號拿不到權杖。

這兩組憑證在系統裡也是分開存的（`clubs.settings.threads_app_id` 與 `club_secrets.threads_app_secret`）。`_threads_app()` 讀它們，**刻意不回退到 Meta 那組**——回退不會讓它變得能用，只會把「你還沒填 Threads App ID」重新包裝成上面那句指向錯方向的話。

暫時不做 Threads 可以整段跳過，不影響 FB／IG。

#### G. 把幹部加進 App 角色 ← 開發模式的關鍵

「應用程式設定」→「角色」→ 新增**管理員／開發人員／測試人員**。

**沒有角色的人授權會失敗。** 所有要用這功能發文的幹部都要加進來，且他們得自己收 FB 通知去接受邀請。

**這份名單跟步驟 F 的 Threads 測試人員是兩張表**，Facebook 角色不涵蓋 Threads，反之亦然。**每年 7/1 交接時兩張都要更新。**

#### H. 回到系統連接

見下方「OAuth 流程」。填 App ID / Secret 需要伺服器已設定 `CREDENTIALS_SECRET_KEY`（secret 是加密存的，沒設會直接儲存失敗）。

#### I. 第一次驗證順序

**照複雜度遞增**測，一次只加一個變數。用測試貼文，不要拿真的例會宣傳來試：

1. **FB 純文字** — 一次 Graph 呼叫，最單純 ✅ 已驗證
2. **Threads 純文字** — 獨立 host，允許純文字 ✅ 已驗證
3. **FB 單圖 → FB 多圖** — 多圖形狀最不一樣（未發布照片 → `/feed`）
4. **Threads 多圖** — 走輪播，沒有轉檔等待
5. **Instagram** — 兩步式，**沒有媒體一定失敗**，這是規格不是 bug
6. **短影片，單一平台** — 先確認轉檔等待邏輯
7. **影片 + 多平台** — 最後測，最容易撞到時間預算

每步成功後到平台上眼睛確認，然後**手動刪掉**測試貼文。

> 測試時**每次換一句文案**。Threads 疑似會擋重複內容（未證實）：同一段文字發第二次失敗過，而 Facebook 不擋，於是看起來很像「兩個平台一起發就壞」。

#### 失敗訊息對照

| 訊息大意 | 缺什麼 |
|---|---|
| `這個網址的網域未包含在應用程式的網域中` | C-1：基本資料的「應用程式網域」＋網站平台 |
| `redirect_uri isn't an absolute URI` / `URL blocked` | C-2 沒做或填錯 |
| `Invalid Scopes: pages_manage_posts, …` | D：使用案例沒加，或加了但權限沒按「新增」|
| 提到 `pages_manage_posts` 未授予 | 授權的人在 App 沒有角色（步驟 G）|
| `not a business account` 之類 | IG 還是個人帳號，或沒連到粉專（步驟 E）|
| `No app ID was sent with the request` | Threads 填成了 Facebook 的 App ID（F-2）|
| `The user has not accepted the invite to test the app` | Threads 測試人員沒接受邀請（F-6）|
| token 失效／過期 | 長效 token 約 60 天到期（`club_social_accounts.expires_at` 有存），重新連接一次 |

### 三種貼文用途（`social_posts.kind`）

| | 用途 | 文案的寫法 | 有版型 |
|---|---|---|---|
| `promo` | 例會宣傳 | 邀請人來，現在式，結尾給一個低壓力的行動 | ✅ |
| `recap` | 例會回顧 | 記錄已經發生的那場，過去式，講現場細節 | ✅ |
| `other` | 其他 | 特殊活動、佈達，以使用者的補充指示為主 | — |

差別不是裝飾：宣傳要讀者到場，回顧告訴沒到的人錯過什麼，時態、行動呼籲、哪些事實重要全都從這裡分岔。所以三種各有一份文案指示（`_KIND_BRIEF`），不是同一個 prompt 加一句話。

`kind` 是欄位不是 JSONB 的鍵，因為它要被驗證、也會被列表用到。**新貼文預設是 `promo`**——分會最常寫的就是宣傳，而且那是護欄最有價值的一種。API 端的預設則是 `other`：那是給沒帶 `kind` 的請求用的，多半是這個分類存在之前寫的資料，把它們當成宣傳是猜測。

**宣傳缺日期、地址或入場費會被擋下**（`_KIND_REQUIRED`），訊息指名缺哪一個、去哪裡填。缺了還硬產，會得到一則看起來完成、實際上沒人能赴約的邀請。

### 例會資訊從哪裡來

三個欄位散在兩張表，而且其中兩個一度是拼不上的：

| 要的東西 | 實際存在哪 |
|---|---|
| 日期、時間 | `agendas.data.meetingDate` / `timeRange` |
| 地址 | `agendas.data.**venueInfo**`（不是 `venue`——那個鍵從來沒被寫過）|
| 入場費 | `clubs.fee` |

`_meeting_fields()` 把它們收齊，`_meeting_brief()`（餵給文案模型）與 `GET /api/meeting-fields`（餵給版型）共用同一份。**文案和海報因此不可能對同一場例會講出不同的時間地點。**

### 海報版型（`lib/postTemplates.js`）

宣傳與回顧可以把例會資訊合成到圖上。目前三個版面：宣傳直式 4:5、宣傳方形 1:1、回顧直式 4:5。

**日期、地址、入場費一律由程式疊成真實文字，不寫進生圖提示詞。** 影像模型畫中文會壞——扭曲、錯字、假字——而生圖視窗的範例自己就寫著「不要有文字」。一張以承載資訊為目的的圖，不能把資訊交給會寫錯字的東西。

分工因此是：**模型（或照片、或 PowerPoint 匯出的 PNG）給插圖，版型給事實。**

合成在**瀏覽器的 canvas 2D** 上做，不是伺服器產圖：

- 中文字型已經在瀏覽器裡，不必打包，也不會變豆腐字
- 沒有 Vercel 跑不動的轉檔器（LibreOffice 之類）卡在路徑上
- 產出的 PNG 走既有的 R2 上傳，發布管線一行都不用改
- **預覽和輸出是同一個 `drawTemplate`、同一張 canvas**，畫面上確認的東西跟上傳的位元組一致

幾個版面上的決定，都是量出來而不是猜的：

- **插圖填滿版位、裁掉溢出**，而不是 contain。方形的圖放進較寬的版位時，contain 會在左右各留一條白，讀起來是「一個洞裡有張小圖」。
- **裁切往上偏**（`anchorY` 0.38）。人臉幾乎都在中線以上；置中裁切上下各切一樣多，正好是會把人頭切掉的那一種。
- **插圖不會比高度的 1.7 倍更寬**（`MAX_ART_RATIO`）。方形版的版位本來就矮，無限制填滿會把它壓成一條橫幅、裁掉超過一半高度。
- **沒有插圖時主題字放大並置中**，不留一塊空白。那塊空白讀起來像「圖沒載出來」而不是「這張本來就沒有圖」，而它會出現在成品上。
- **插圖本身已含標題時可以勾掉標題**。PowerPoint／Canva 匯出的完稿通常需要，照片和 AI 生圖不用——哪一種只有選圖的人知道。

Toastmasters 標誌從本站的 `/media/toastmasters_logo.png` 取，同源，所以不需要 `image-proxy` 也不會污染 canvas。插圖則來自 R2，**必須經過 `/api/image-proxy` 取成 blob 再進 canvas**——直接用公開網址會讓 canvas 被污染，`toBlob()` 就會拋錯。

### 生圖可以直接產出海報

生圖視窗有一個選項（宣傳／回顧且已綁定例會時預設開啟）：**產生後直接套成海報，只加入合成後那一張**，不另外留原圖。

這不只是省一個步驟。原本第二步靠人記得；忘了就發出一張沒有日期、地址、入場費的圖，而那正是宣傳貼文唯一非有不可的東西。

三個防呆：例會資料**在送出生圖之前**就讀（填不出來應該在付錢前失敗）；合成失敗仍然保留原圖（那張已經付過錢）；合成期間保留等待中的縮圖（工作確實還沒結束）。

### 附件的順序就是發布順序

`social_posts.images` 的陣列順序即各平台的發布順序，**第一個是輪播封面**——多數人唯一會看到的那張。縮圖上有 ◀ ▶ 可以調整，第一個標示「封面」。

### 平台差異寫在哪

`lib/socialPlatforms.js` 是唯一一份：字數上限、要不要媒體、影片與多媒體的規則、內文連結能不能點。編輯器的計數器、警告、發布視窗的可勾選狀態全部讀它。後端另有一份**散文版**的同一組規則（`api/index.py` 的 `_PLATFORM_BRIEF`）餵給寫文案的模型——一份是給人看的檢查，一份是給模型的指示，刻意不共用。

| | 字數上限 | 一定要媒體 | 影片 | 多個媒體 | 內文連結 |
|---|---|---|---|---|---|
| Facebook | 63206 | 否 | 1 支，**不能和圖片混放** | 多圖可 | 可點 |
| Instagram | 2200 | **是** | 可，單支發成 **Reels** | 輪播上限 **10** | **不可點** |
| Threads | 500 | 否 | 可 | 輪播上限 **20** | 可點 |

Facebook 那條不是偷懶：Page 貼文就是「一支影片」**或**「若干張圖」，`/videos` 也只吃一個檔案。硬要合併只能悄悄丟掉東西，所以選擇在發布前擋下來並說明要分成兩則。

hashtag 沒有特殊處理——就是文案的一部分，**算在字數裡**。AI 產文案時會依平台調整數量（FB 2–3 個、IG 5–10 個、Threads 1–2 個）。

「FB 發了 IG 會不會跟著發」——不會。Meta 內建的跨平台分享只有 `IG → FB` 方向有自動開關；這裡是分別呼叫各自的 API，**你勾哪些平台就發哪些**。若同時開著 Meta 的跨平台分享，IG 會出現兩則重複貼文。

### AI 帳號：個人 → 分會 → 伺服器，三層取用

金鑰的取用順序是 **你自己的 → 分會共用的 → 伺服器的**：

| 層級 | 存哪 | 誰設定 |
|---|---|---|
| 個人 | `user_ai_credentials` | 每個使用者自己 |
| 分會共用 | `club_secrets`（`ai_openai` / `ai_anthropic`）| 幹部 |
| 伺服器 | 環境變數 `ANTHROPIC_API_KEY` | 只有 Anthropic 有，OpenAI 沒有退路 |

**個人優先**才是允許兩層並存的意義：連了自己金鑰的人，是明確表示要用自己的帳號計費，分會之後設了一組不該把那件事悄悄接管過去。分會那組是地板，讓新幹部第一天就能產文案，不必先去註冊——對一個每年 7/1 交接的幹部群，這是「工具能用」與「每年重新辦一次帳號」的差別。

分會金鑰放在 `club_secrets`，那張表本來就是 Meta 憑證的 name/value 儲存、用同一把 Fernet 主密鑰，所以共用帳號**不需要 migration**。只有幹部看得到與設定得了那一區，因為花的是分會的錢。

`GET /api/me/ai-credentials` 會多回一個 `clubHint`：瀏覽器看不到分會那組存不存在，少了它，「未連接」這個標籤會同時代表三種結果——會用分會的、會用伺服器的、和根本不能用。

三條規則：

- **加密後才進資料庫**。欄位叫 `key_cipher` 而不是 `key`，存的是 Fernet token。主密鑰讀環境變數 `CREDENTIALS_SECRET_KEY`，**沒有預設值也沒有 fallback**——沒設定就儲存失敗，不會默默以明文落地。用 `openssl rand -base64 32` 產一組。
- **金鑰不會再回到瀏覽器**。`GET /api/me/ai-credentials` 只回傳末四碼與「已連接」布林值。
- **計費走上面那條順序**。文案可在產生視窗裡選 Claude 或 ChatGPT；生圖只走 OpenAI，而且**沒有伺服器退路**（沒有伺服器 OpenAI 帳號可以花）。

### 模型也可以選，預設一律最便宜的

兩家各三個（`COPY_MODELS`），生圖三個（`IMAGE_MODELS`），由 `GET /api/ai-models` 出給前端，瀏覽器不會提供伺服器會拒絕的選項。

清單**依價格由低到高排**方便比價；**預設是哪一個由 `default` 旗標決定，不靠排序**——顯示順序與預設值回答的是不同問題，綁在一起就會有一個被另一個悄悄改掉。目前 Claude 預設 Opus 5.5、ChatGPT 預設最省的、生圖預設最省的。

模型清單帶著 `thinking` 旗標，記的是**呼叫差異而不是偏好**：Opus 5.5 與 Sonnet 5.5 吃 adaptive thinking 與 effort，**Haiku 4.5 兩個都拒收，送過去就是 400**。把差異放在 id 旁邊，選模型才不會變成組出一個無效的請求。

生圖另外可選**品質**（low／medium／high／auto，預設 low）。不指定時 OpenAI 用 `auto`，等於由模型決定品質，也就等於由模型決定你付多少——`gpt-image-1` 的 low 與 high 相差約 15 倍。選 `auto` 時不送這個參數，因為那本來就是 API 的預設，明寫只是多冒一次「某個模型不認得它」的風險。

輪換 `CREDENTIALS_SECRET_KEY` 會讓既有金鑰解不開——此時 `_open()` 回一個「請重新設定」的錯誤，而不是丟出無意義的例外。

文案有兩條路（`COPY_WRITERS`），兩邊拿到**完全相同**的 system prompt、使用者輸入與 JSON schema，回傳同一個 dict——端點不在乎是誰寫的。刻意寫成兩個函式而不是在一個函式裡分支，是為了讓兩家 SDK 各自演進時不會互相污染：

- **Claude**：`claude-opus-5` + adaptive thinking + structured outputs。`effort` 設 `medium` 而非預設的 `high`——這是掛在瀏覽器請求後面的短篇創作，深一層推理帶來的延遲比它換到的品質更貴。
- **ChatGPT**：`chat.completions` + `response_format: json_schema`（`strict`）。

**模型由使用者在產生視窗裡選**，兩家各三個（`COPY_MODELS`），清單依價格由低到高排，方便比價；預設是哪一個則由 `default` 旗標決定，不靠排序——顯示順序與預設值回答的是不同問題，綁在一起就會有一個被另一個悄悄改掉。目前 Claude 預設 Opus 5.5、ChatGPT 預設 GPT-6 Luna、生圖預設 GPT-Image 1 mini。`thinking` 旗標記的是呼叫差異不是偏好：Opus 5.5 與 Sonnet 5.5 吃 adaptive thinking 與 effort，Haiku 4.5 兩個都拒收，送了就是 400。

兩邊都用 structured output，所以一次就吐出主文案與各平台版本，不用解析散文。生圖用 OpenAI `gpt-image-1`，產生後直接進 R2 只回公開 URL——**IG 與 Threads 只能發布平台抓得到的公開圖片**，所以這一步 Phase 1 也用得上。

### 生圖是「工作」不是「請求」

生圖動輒數十秒，把瀏覽器掛在一條 HTTP 回應上是錯的形狀：闔上筆電就丟掉一張 OpenAI 已經收過錢的圖。所以**擁有結果的是 `ai_jobs` 的那一列，不是那個回應**：

1. `POST /api/ai-jobs` 建立 `queued` 列，**立刻**回傳 id；
2. 前端 `POST /api/ai-jobs/{id}/run` 但**不 await**（這才是那條長請求）；
3. 前端每 2 秒輪詢 `GET /api/ai-jobs/{id}`，圖片區出現一格虛線佔位 + spinner + 已等秒數，這段期間**文案照樣可以編輯**。

`/run` 用一次 `UPDATE ... WHERE status='queued'` 做原子認領，重複點擊或重試不會跟 OpenAI 買第二張圖。輪詢時若發現某列卡在 `running` 超過 5 分鐘（負責執行的 invocation 被砍掉了），會就地標成失敗，而不是讓前端無限轉圈。圖片完成時會比對貼文物件的 identity，避免落到使用者中途切換過去的另一則貼文上。

**這個做法沒有把工作移出請求**：serverless 上沒有常駐 worker，`/run` 仍然得在函式的 `maxDuration`（`vercel.json` 設為 60 秒）內跑完。換到的是瀏覽器不再與它綁死、斷線不遺失結果、以及等待期間介面不凍結。真正的背景執行需要 Vercel 以外的 worker。

### 憑證放哪，以及為什麼分兩種

| 東西 | 存哪 | 範圍 | 為什麼 |
|---|---|---|---|
| AI API 金鑰 | `user_ai_credentials` | **每個使用者** | 是個人帳號在計費 |
| Meta App Secret | `club_secrets` | **每個分會** | App 是分會註冊的 |
| Page / IG / Threads Token | `club_social_accounts` | **每個分會** | 粉專是分會資產——會長授權後，教育副會長也要能發 |

三者都用同一組 `_seal()` / `_open()`（Fernet，主密鑰 `CREDENTIALS_SECRET_KEY`）加密，也都套用同一條規則：**存進去之後不再回傳給瀏覽器**，UI 只看得到末四碼。

Meta App Secret **刻意不放進 `clubs.settings`**：`GET /api/clubs` 是**公開、免登入**的端點（註冊表單要讀），任何進到那個 JSONB 的東西等同全世界可讀。`meta_app_id` 不算機密所以留在 settings，secret 走獨立資料表。

### OAuth 流程

1. 分會管理 →「社群」→ 填 App ID / Secret → 按「連接 Facebook / Instagram」
2. 前端先存設定，再跟後端要授權網址，跳轉到 Meta
3. Meta 導回 `<你的網域>/club`，頁面接住 `?code=`，換成長效 token
4. 列出該帳號管理的粉專讓你挑一個 → 存下 Page token（IG 用同一個 Page token 授權）
5. Threads 是**另一顆按鈕**：獨立的授權入口（`threads.net`）、獨立的 API host（`graph.threads.net`）、**獨立的 App ID / Secret**，以及獨立的重新導向網址欄位

設定畫面因此有**兩組** App 憑證欄位，不是一組。`_meta_app()` 與 `_threads_app()` 各讀各的，後者不回退到前者——見步驟 F。

重新導向網址同樣是兩份，`<你的網域>/club` 兩邊都要填。畫面上有把這串印出來給你複製。

IG 的取得方式是**從粉專身上取**（`instagram_business_account`），不是直接取 IG 帳號。所以 IG 沒有連結到那個粉專時，授權再多次也拿不到——見步驟 E。

### 發布

走跟生圖同一套 `ai_jobs` 管線——每個平台都是好幾次連續的 Graph 呼叫，所以前端輪詢 job 而不是掛著長請求。

三個平台形狀都不同：

| | 純文字 | 單圖 | 多圖 | 影片 |
|---|---|---|---|---|
| Facebook | `/feed` | `/photos` | 未發布照片 → `attached_media` 串到 `/feed` | `/videos` + `file_url` |
| Instagram | 拒收 | 容器 → 發布 | 子容器 → `CAROUSEL` → 發布 | 單支是 **REELS** 容器 |
| Threads | `media_type=TEXT` | `IMAGE` | 子容器 → `CAROUSEL` → 發布 | `media_type=VIDEO` |

三者都只吃**檔案 URL**、不吃位元組——這就是為什麼所有圖片和影片都先進 R2。

**影片多一段等待**：容器被接受不代表可以發布，Meta 轉檔完成（`FINISHED`）之前 `media_publish` 與 `threads_publish` 都會失敗。所以有影片時會輪詢容器狀態；**只有影片會輪詢**，圖片容器建立當下就緒，多一次往返只會拖慢本來就能用的路徑。Facebook 沒有這段——它接收後自己轉檔，貼文晚點才出現。

轉檔等待是**整個工作共用一份 40 秒預算**（`_MEDIA_READY_BUDGET`），不是每個平台各一份。各等各的會超過 `vercel.json` 的 `maxDuration`，invocation 被砍掉的話，連「哪些平台已經成功發布」的紀錄都會一起消失——那比等不到更糟。超時時該則**並未發布**，重試不會變成兩則。

> 長影片或同時發多個平台很可能撞到這個上限。真正的解法是把 `maxDuration` 調高（Vercel Hobby 上限就是 60 秒，Pro 可到 300），不是把預算調大。

附件的種類由**上傳當下記下的 `type`** 決定，副檔名只是舊資料的退路（`_media_kind`）。JSONB 欄位仍叫 `images` 雖然它現在也放影片：改名要一次 migration，而它換不到 `type` 沒說清楚的事。

**單一平台失敗不會中斷其他平台**：Instagram 失敗不構成把 Facebook 那則收回的理由，所以結果是逐平台收集後一起回報。發布成功的連結存在 `social_posts.published`，編輯器會列出來，讓「要不要再發一次」是個知情的選擇。

### 編輯器

左側草稿清單，右側編輯區：標題／狀態（草稿・待發布・已發布）／綁定例會 → AI 產生文案 → 主文案 → 各平台分頁（可各自關閉、即時字數、規則警告、一鍵複製）→ 圖片（手動上傳或 AI 生圖）。綁定例會之後，AI 會讀那場議程的日期、主題、講者、題目、單元當素材，不會自己編造沒給的資訊。

## Pathways 路徑管理（`/pathways`）

議程編輯器與角色安排頁的「學習路徑／等級／專案名稱」下拉選單，資料都來自 DB（migration `0013`），由系統管理員在 `/pathways` 維護，Toastmasters 調整 Pathways 時不用改程式。

| 資料表 | 內容 |
|------|------|
| `pathways` | 路徑代碼（主鍵）、中英名稱、是否已停用（legacy）、排序 |
| `pathway_projects` | 專案中英名稱、排序 |
| `pathway_required` | 每條路徑各級的必修專案（第 1 級、指導計畫、回顧路徑都明列，程式不預設任何規則） |
| `pathway_electives` | 各級選修清單，所有路徑共用；某專案若是該路徑的必修，就不會出現在該路徑的選修選單 |

- **全站共用**：目錄不分分會，只有 `system_admin` 能改。前端 `lib/pathways.js` 在頁面初始化時 `loadPathways()` 取一次，之後同步讀取。
- **整份存檔**：編輯頁把整份目錄當草稿，`PUT /api/pathways` 在一個 transaction 裡整份取代，不會存到一半。
- **議程存英文名稱**：`speeches[].pathwayProject` 存的是專案**英文名稱**（不是 id，因為這個欄位也放自由備註），印出時依議程語言顯示中文或英文。在管理頁改了既有專案的名稱，存檔時會把所有議程裡的舊名稱（含舊中文名）一併改成新英文名稱。
- **路徑代碼建立後不可改**：議程以代碼記錄路徑；要換代碼請新增路徑再刪除舊的，已存的舊代碼會落在「其他／自訂」文字框。
- **三個欄位都保留手動輸入**：學習路徑、等級、專案名稱都有「其他／自訂」選項，選了會出現文字框可自由輸入。目錄裡沒有的值（手動輸入的、Sheet 匯入的 `4-1`、已刪除的路徑）開啟時直接顯示在文字框裡，可繼續編輯，開啟議程不會改寫資料。

---

## Microsoft 帳號登入

登入頁有「使用 Microsoft 帳號登入」按鈕，**任何 Microsoft 帳號**都能用（公司／學校帳號或個人 Outlook、Hotmail 帳號）。帳號密碼登入照常保留。伺服器沒設 `MS_CLIENT_ID` / `MS_CLIENT_SECRET` 時按鈕不會出現。

### 流程

1. `/svc/auth/microsoft/start`（Next.js）產生 state、nonce、PKCE verifier，存進 10 分鐘的 httpOnly cookie，把瀏覽器導到 Microsoft（`common` 端點）。
2. Microsoft 導回 `/svc/auth/microsoft/callback`。這裡先比對 state，再請 FastAPI 用 client secret 換 code、驗證 id_token（簽章、`aud`、`iss` 必須對應 token 裡的 `tid`、nonce）。
3. 依下面的規則找到帳號後，設定跟密碼登入一樣的 `auth_token` cookie。

### id_token 怎麼對應到帳號

| 順序 | 條件 | 結果 |
|------|------|------|
| 1 | `users.ms_sub` 等於 token 的 `sub` | 登入該帳號。**第一次之後只看這條** |
| 2 | Email **經 Microsoft 驗證**，且等於某個還沒綁定的帳號的 `users.email`（不分大小寫） | 綁定（寫入 `ms_sub`）後登入 |
| 3 | 都對不到 | 進入申請表單：填中英文姓名、選分會，建立 `pending` 帳號（沒有密碼），等分會管理員審核 |

帳號是 `pending` 時一律顯示「尚待審核」，不會登入。

**為什麼要「經 Microsoft 驗證」**：`common` 端點接受任何租戶，任何人都能自己開一個租戶、在裡面把任意 Email 設給自己，id_token 的 `email` 就會帶著那個地址（即「nOAuth」帳號接管手法）。所以只在以下情況才拿 Email 去比對：

- **個人 Microsoft 帳號**（`tid` 為 `9188040d-6c67-4c5b-b112-36a304b66dad`）：Email 由 Microsoft 驗證過。
- **公司／學校帳號**且 token 帶 `xms_edov=true`：該租戶證明自己擁有這個網域。這個 claim **要在 App 註冊的「權杖設定」加上 optional claim 才會出現**，見下方設定步驟。

Email 沒有經過驗證的帳號照樣可以申請新帳號，但申請時不會帶入那個 Email。如果系統裡已經有人用那個 Email，會請對方先用帳號密碼登入，再到「設定」手動連結。

### 相關規則

- **Email 只能由管理員設定**（`/member` 編輯會員），使用者在「設定」頁只能看、不能改。如果自己能改，就可以把別人的 Email 填進自己的帳號，搶走對方第一次 Microsoft 登入的對應。第一次用經驗證的 Microsoft 帳號連結時，如果該帳號還沒有 Email，會自動帶入。
- **手動連結**：已登入的使用者在「設定 → 登入方式」按「連結 Microsoft 帳號」，不看 Email 直接綁定。一個 Microsoft 帳號只能綁一個使用者。
- **解除連結**：帳號沒有密碼時不能解除，否則就沒辦法登入了。請先在「設定密碼」設一組。
- **沒有密碼的帳號**（從 Microsoft 申請來的）：`password_hash` 存空字串，帳號密碼登入一律失敗。到 `/change-password` 不用輸入舊密碼就能設定第一組密碼。管理員重設密碼也可以。

### 在 Microsoft Entra 註冊 App

1. [Entra 系統管理中心](https://entra.microsoft.com) → **應用程式** → **應用程式註冊** → **新增註冊**。
   - 名稱：隨意（使用者登入時會看到，例如「分會管理平台」）。
   - **支援的帳戶類型**：選「**任何組織目錄中的帳戶及個人 Microsoft 帳戶**」。
   - **重新導向 URI**：平台選 **Web**，填 `https://<你的網域>/svc/auth/microsoft/callback`。
2. 註冊完成後，「概觀」頁的 **應用程式 (用戶端) 識別碼** 就是 `MS_CLIENT_ID`。
3. **憑證及祕密** → **新增用戶端密碼** → 複製「**值**」（不是「祕密識別碼」），這就是 `MS_CLIENT_SECRET`。密碼會過期（最長 24 個月），到期前要換新的，並更新 Vercel 的環境變數。
4. **驗證** → 再加上其他要用的重新導向 URI：預覽站、本機 `http://localhost:3000/svc/auth/microsoft/callback`。每個 URI 都要完全一致，包含 http／https 和連接埠。
5. **權杖設定** → **新增選擇性宣告** → 權杖類型選 **ID** → 勾選 `email` 和 `xms_edov`。
6. **API 權限**：預設的 `User.Read` 就夠了（實際只用到 `openid profile email`）。
7. 把 `MS_CLIENT_ID`、`MS_CLIENT_SECRET` 設到 Vercel，然後 Redeploy。

> 某些公司租戶會禁止使用者自行同意第三方 App，那些使用者登入時會看到「需要管理員核准」。這是對方租戶的設定，只能請對方的 IT 核准，或改用帳號密碼登入。

---

## MCP：讓 AI 助理操作這個系統

Claude 之類的 MCP 客戶端可以直接連上這個站台：列例會、讀寫貼文草稿、產生文案，經使用者另外同意後也能發布。實作全部在 `api/index.py` 的「MCP」兩段。

### 連線方式

在 MCP 客戶端新增一個遠端（Streamable HTTP）伺服器，網址填：

```
https://<你的網域>/api/mcp
```

客戶端會自己走完 OAuth：讀 `/.well-known/...` → 把使用者帶到 `/oauth/authorize` 同意畫面（沒登入會先到 `/login`，登入後回到同意畫面）→ 換到 token。不需要事先在系統裡登記客戶端。

前提：伺服器有設 `MCP_TOKEN_SECRET`，資料庫已跑到 migration `0018`。

### 工具與 scope

| 工具 | scope | 說明 |
|------|-------|------|
| `list_meetings` | `posts:read` | 列出分會例會（最近的在前），回傳 `agendaId` |
| `get_meeting` | `posts:read` | 一場例會的日期、時間、地址、入場費、主題；缺宣傳必填欄位會指出 |
| `list_posts` | `posts:read` | 列出貼文草稿與已發布貼文 |
| `get_post` | `posts:read` | 一則貼文的完整內容（主文案、各平台版本、圖片、發布狀態） |
| `create_post` | `posts:write` | 建立草稿（`promo` / `recap` / `other`） |
| `update_post` | `posts:write` | 修改標題、文案、用途、狀態、綁定例會、各平台版本 |
| `generate_copy` | `ai:generate` | 用 AI 產生文案並存進貼文，**消耗呼叫者（或分會共用）的 AI 額度** |
| `publish_post` | `publish` | 發布到 Facebook／Instagram／Threads，**公開且無法透過本系統收回**。已發布過的平台會略過，要再發一則得帶 `republish: true` |

- **四個 scope 都公開宣告**（`scopes_supported` 與 401 挑戰都列出），所以客戶端會一起請求；但同意畫面上 `publish` 預設**不勾**，並標示「公開且無法收回」，要使用者自己勾。客戶端沒指定 scope 時給 `posts:read posts:write ai:generate`。
  - 早先的做法是連宣告都不宣告 `publish`、`tools/list` 也藏起 `publish_post`，結果模型看不到工具就不會呼叫，客戶端也不會請求這個 scope，同意畫面根本沒機會問——等於永遠拿不到。
- 請求的 scope 全都不認得時回 400（`openid`、`offline_access` 這類 OIDC 慣用 scope 除外，忽略即可）。
- **scope 只會收窄、不會放寬權限。** 每支工具底下照跑網頁版用的同一套 helper 與角色檢查（`_social_scope`、分會管理員限制）；`club_member` 拿到 `posts:write` 也一樣寫不了。
- `tools/list` **一律列出全部工具**，並帶 `annotations`（`readOnlyHint` / `destructiveHint` / `openWorldHint`），客戶端（例如 ChatGPT）據此決定哪些呼叫要先問使用者。呼叫沒 scope 的工具會收到 403 + `insufficient_scope` 挑戰，挑戰裡的 scope 是「現有的＋缺的」，客戶端補授權後不會掉掉原本的權限。
- 工具層級的失敗（找不到貼文、平台未連接、缺欄位）回 `isError: true` 的結果讓模型自行修正，不回 JSON-RPC 錯誤。

### 授權伺服器的設計

| 項目 | 做法 |
|------|------|
| 客戶端註冊（CIMD） | **Client ID Metadata Documents**：`client_id` 本身是 https 網址，伺服器去抓、驗證 `client_id` 與網址相符、`redirect_uri` 在清單內。抓取限 https、**DNS 解析後**擋內部位址（私有、loopback、link-local 等）、**不跟隨轉址**、64 KB 上限、8 秒逾時 |
| 客戶端註冊（DCR） | 給還不支援 CIMD 的客戶端（例如 Claude Desktop 的 connector）：`POST /api/oauth/register`（RFC 7591）。**不存資料表**：`client_id` 是 `dcr:` 加上用 `MCP_TOKEN_SECRET` 簽的 JWT，內含 redirect_uris 與名稱，改了就驗不過。redirect_uri 限 https，或 localhost 的 http（CLI 類客戶端）。任何人都能註冊、名稱可以亂取，所以同意畫面會另外顯示「授權後會導回哪個網域」 |
| PKCE | 必填，只收 `S256` |
| 授權碼 | 5 分鐘有效，只存 SHA-256 雜湊，`DELETE … RETURNING` 保證只能用一次 |
| access token | JWT（`MCP_TOKEN_SECRET` 簽），**1 小時**；`aud` 綁定 `https://<host>/api/mcp`，別的伺服器發的 token 一律拒絕 |
| refresh token | 只存雜湊（`oauth_refresh_tokens`），每一列就是一個「授權」，以固定的 `grant_id` 識別。**每次使用都輪換**：舊的作廢、發新的，有效期限從這次起再算 **60 天**（持續使用就不會過期，閒置 60 天才失效）。已輪換掉的舊 token 再被拿來用，代表有人複製了它，**整個授權直接撤銷** |
| 撤銷 | access token 帶 `grant` claim（授權的 `grant_id`），MCP 端點**每次呼叫都檢查該授權仍有效**，所以撤銷立即生效，不用等 access token 過期 |
| resource | 依 RFC 8707 檢查 `resource` 必須是本伺服器；客戶端沒帶（不少 OAuth 函式庫還不支援）時視為本伺服器 |
| 同意畫面 | `/oauth/*` 與 `/login` 帶 `X-Frame-Options: DENY` 與 `frame-ancestors 'none'`，不能被別的網站嵌在 iframe 裡誘導點擊 |
| 帳號狀態 | 換 token 與每次呼叫都會重查 `users`，帳號被刪或變回 `pending` 立即失效 |
| 網域 | resource URI 依請求的 host 算，不寫死：正式站、預覽站、本機各自獨立，token 不能跨站用。Vercel 會覆寫 `X-Forwarded-Host` 所以可信；部署到會轉傳客戶端標頭的平台時，設 `MCP_PUBLIC_ORIGIN` 寫死 |

### 協定

- **先驗授權，再看協定。** 沒帶有效 token 的請求一律回 401 加 `WWW-Authenticate`，不論內容是新版、舊版或空的。客戶端（以及 connector 的「檢查伺服器」）只能從 401 知道要去哪裡登入。
- **目前版本 `2026-07-28`**：單一 `POST /api/mcp`，沒有 session、沒有 `initialize`，每個請求在 `params._meta` 自帶 `protocolVersion` 與 `clientCapabilities`。`MCP-Protocol-Version`、`Mcp-Method`、`Mcp-Name` 標頭必須與內容一致，不一致回 `-32020`。
- **舊版 `2025-11-25` / `2025-06-18` / `2025-03-26`**（`_meta` 沒有 protocolVersion 時走這條）：支援 `initialize` 握手、`notifications/*`（回 202）、`ping`、`tools/list`、`tools/call`。版本看 `MCP-Protocol-Version` 標頭，沒帶就當 `2025-03-26`。**不發 `Mcp-Session-Id`**，舊版規格允許無狀態伺服器這樣做，所以一樣能跑在 serverless 上。回應一律是 JSON，不用 SSE。不支援 JSON-RPC 批次。
- `GET` / `DELETE /api/mcp` 回 405（沒有伺服器主動推送的串流，也沒有 session 可以結束）。

### 撤銷授權

- **使用者自己撤銷**：「設定」頁（`/settings`）的「已授權的應用程式」區塊列出目前有效的授權：客戶端名稱、scope（`publish` 標紅）、授權時間、最後使用、到期日。可以逐筆撤銷，也可以全部撤銷。同一個客戶端從兩台裝置授權會是兩筆，可以只撤掉其中一台。
- **客戶端自己登出**：RFC 7009 `POST /api/oauth/revoke`，access token 或 refresh token 都收，撤銷的是整個授權。不論有沒有找到 token 一律回 200。
- **管理員停權**：刪除帳號（FK cascade 一併刪掉授權），或把 status 改回 `pending`（每次呼叫都會檢查），授權都會立即失效。管理員目前不能替別人撤銷個別授權。
- 只能撤銷自己的授權；別人的授權 id 一律回 404。

### 其他注意事項

- 輪換 `MCP_TOKEN_SECRET` 會讓所有 access token 立刻失效（refresh token 不受影響，客戶端會用它換新的 access token）。
- refresh token 輪換的代價：客戶端換 token 時若網路斷掉、沒收到新的 refresh token，下次拿舊的來換會被當成重複使用而撤銷，使用者需要重新連線授權一次。

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

`lib/auth.js` 的 `applyRoleUI()` 會依角色隱藏對應元素（`club_member` 另外會把 `.form-scroll-body` 裡的輸入欄位全部 disable）：

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
| `CREDENTIALS_SECRET_KEY` | 加密 AI 金鑰與 Meta App Secret 的主密鑰（`openssl rand -base64 32`）。**未設定時儲存金鑰會直接失敗**，不會以明文落地 |
| `MS_CLIENT_ID` / `MS_CLIENT_SECRET` | Microsoft 登入用的 Entra App（見「Microsoft 帳號登入」）。**選填**：沒設就不顯示 Microsoft 按鈕 |
| `MCP_TOKEN_SECRET` | 簽 MCP access token 的密鑰（`python -c "import secrets; print(secrets.token_urlsafe(48))"`）。**必須和 `JWT_SECRET` 不同**；正式站與預覽站建議各用一把。未設定時 MCP 與 OAuth 端點回 503，其他功能不受影響 |
| `MCP_PUBLIC_ORIGIN` | 選填。寫死對外網址（例如 `https://agenda.example.com`），MCP 的 resource／issuer 就不再從 `X-Forwarded-Host` 推算。Vercel 上不用設 |

> `JWT_SECRET` 同時被 FastAPI（簽發）與 Next.js `middleware.js`（驗證登入 cookie）讀取，Vercel 上設一次兩邊都拿得到。

以下為**選填**，只有「全站共用一個 App」才需要。各分會自己填 App ID / Secret 時用不到——分會層的值優先，這些只是沒填時的退路：

| Key | Value |
|-----|-------|
| `META_APP_ID` / `META_APP_SECRET` | 全站共用的 Facebook App。**注意變數名是 `META_` 不是 `FACEBOOK_`**，取名 `FACEBOOK_APP_ID` 不會被讀到 |
| `THREADS_APP_ID` / `THREADS_APP_SECRET` | 全站共用的 **Threads** App。跟上面那組是不同的值，見「Threads：獨立的一套」|
| `META_GRAPH_VERSION` | Graph API 版本，預設 `v21.0` |
| `ANTHROPIC_API_KEY` | Claude 文案的伺服器退路（OpenAI 沒有對應退路，一定要使用者自己連）|

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

Push 到 GitHub 的 **`master`** 分支，Vercel 自動部署到正式站；其他分支只會產生預覽部署。Vercel 專案的 Framework Preset 要是 **Next.js**；`api/index.py` 會被另外部署成 Python function。

> 正式部署的分支設定在 Vercel 專案 **Settings → Environments → Production → Branch Tracking**，目前是 `master`。改 git 預設分支名稱時這裡要一起改，否則推上去不會部署到正式站。

> **同步到組織 repo**：[toastmasters-d67/agenda-management](https://github.com/toastmasters-d67/agenda-management) 把本 repo 設成 `upstream`。在那個 repo 執行 `git pull upstream master`，再 `git push origin main`（那邊的分支仍叫 `main`）。

> ⚠️ Vercel **不會自動執行 migration**。每次新增 migration 版本後，請手動在正式 DB 執行 `alembic upgrade head`。

### 3. URL 路由

| URL | 由誰處理 | 設定在 |
|-----|---------|--------|
| `/api/*` | FastAPI（`api/index.py`） | `vercel.json` rewrite |
| `/.well-known/*` | FastAPI（OAuth 探索，免登入） | `vercel.json` rewrite；`middleware.js` 也排除它 |
| `/svc/*` | Next.js route handler → 轉發到 `/api/*` | `app/svc/**` |
| `/index` | `app/agenda/page.js` | `next.config.mjs` rewrite（Next.js 保留 `index` 這個路由名稱） |
| `/` | 轉址到 `/login` | `next.config.mjs` |
| `/login.html`、`/home.html`… | 轉址到不含 `.html` 的新網址；`/admin`、`/admin.html` 轉到 `/member` | `next.config.mjs` |
| 其他頁面 | `app/<route>/page.js`（見「前端頁面」） | — |

未登入（或 cookie 驗不過）造訪頁面時，`middleware.js` 會導向 `/login?next=<原網址>`，登入後回到原頁。回跳目標會解析網址並比對 origin，不接受站外網址。

---

## 本地開發

本機要同時跑兩個行程：FastAPI（:8001）與 Next.js（:3000）。瀏覽器開 `http://localhost:3000`，Next.js 的 `/svc/*` 代理會把請求轉到 `http://localhost:8001/api/*`（可用 `FASTAPI_BASE_URL` 覆寫）。

### 第一次設定

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
npm install
```

### 之後每次啟動

```powershell
# 終端機 1：後端
.\venv\Scripts\Activate.ps1
uvicorn api.index:app --reload --port 8001

# 終端機 2：前端
npm run dev
```

> 測 MCP 時客戶端要直接連後端看得到的網址（例如 `http://localhost:8001/api/mcp`）。resource URI 是依請求的 host 算的，同一把 token 換個 host 就會被拒絕。

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
CREDENTIALS_SECRET_KEY=用 openssl rand -base64 32 產生
MCP_TOKEN_SECRET=另外產生一把，不要和 JWT_SECRET 相同
# 選填
# MS_CLIENT_ID=...                         # Microsoft 登入；本機的重新導向 URI 也要加進 Entra App
# MS_CLIENT_SECRET=...
# FASTAPI_BASE_URL=http://localhost:8001   # Next.js 代理的後端位址，預設本機 :8001、正式環境同源
# ANTHROPIC_API_KEY=...                    # Claude 文案的伺服器退路
```

Next.js 也會讀 `.env`（`middleware.js` 要用 `JWT_SECRET` 驗 cookie），所以一份 `.env` 兩邊共用。

> `CREDENTIALS_SECRET_KEY` 本機與 Vercel **必須是同一組**，否則兩邊存的金鑰互相解不開。輪換它會讓既有金鑰全部失效，需要各使用者重新設定一次。

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
8. `0008` — `clubs` 加品牌欄位 + `template_key` + `settings`（分會專屬品牌與版型）
9. `0009` — 建立 `social_posts`（社群貼文草稿，`variants` / `images` 為 JSONB）
10. `0010` — 建立 `user_ai_credentials`（個人 AI 金鑰，加密存）
11. `0011` — 建立 `ai_jobs`（生圖／發布工作，前端輪詢）
12. `0012` — 建立 `club_secrets`（分會層級密鑰：Meta App Secret、分會共用 AI 金鑰）、`club_social_accounts`（已連接的粉專／IG／Threads）；`social_posts` 加 `published`
13. `0013` — 建立 Pathways 目錄四張表並匯入初始資料
14. `0014` — `social_posts` 加 `kind`（`promo` / `recap` / `other`，既有資料設為 `other`）
15. `0015` — 建立 `oauth_codes`、`oauth_refresh_tokens`（MCP 的 OAuth 授權）
16. `0016` — 兩張 OAuth 表加 `client_name`（同意當下記下客戶端名稱，給「已授權的應用程式」顯示）
17. `0017` — `users` 加 `email`（不分大小寫唯一）與 `ms_sub`（綁定的 Microsoft 身分，唯一）
18. `0018` — `oauth_refresh_tokens` 加 `grant_id`（授權的固定識別碼，回填為原 `token_hash`，已發出的 access token 不受影響）與 `prev_token_hash`（refresh token 輪換與重複使用偵測）

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
.\venv\Scripts\alembic.exe current   # 應顯示 0017 (head)
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

圖片命名規則（presign 依 `club_id` 分資料夾）：

- 帶 `club_id`：`media/clubs/{club_id}/...`
  - 議程主題圖：`media/clubs/3/2026-05-20_No280_213022.jpg`
  - 分會 logo/QR/第二頁圖：`media/clubs/3/{時間}_{uuid}.png`
- 未帶 `club_id`：fallback 到扁平 `media/{時間}_{uuid}.png`

> **分會圖片採「延後上傳」**：在 `/club` 選圖時只在瀏覽器本地預覽快取，按「儲存」才上傳 R2。
> - 新增分會：先 `POST` 建立分會拿到 id → 把快取的圖上傳到 `media/clubs/{新id}/` → `PUT` 寫回 URL。
> - 編輯既有分會：直接上傳到該分會資料夾後存檔。
> - 按「取消」不會上傳，不留孤兒檔。
>
> 議程主題圖（`/index`）仍為選檔即時上傳，帶該議程所屬分會（system_admin 用所選分會、其餘用自己分會）。

---

## 前端頁面

| 頁面（Vercel URL） | 檔案 | 說明 | 最低權限 |
|--------------------|------|------|----------|
| `/login` | `app/login/page.js` | 登入 / 自行註冊（送出後需等待審核）/ Microsoft 登入與申請；支援 `?next=` 回跳 | 無 |
| `/home` | `app/home/page.js` | 會務管理 Dashboard，含統計卡片、議程列表 | 任何登入用戶 |
| `/index` | `app/agenda/page.js` | 議程表產生器，即時預覽並可匯出 PDF / JPG | 任何登入用戶 |
| `/roles` | `app/roles/page.js` | 角色安排，多場例會 × 角色矩陣，人選可下拉選取或自由輸入 | `club_admin`（寫入） |
| `/social` | `app/social/page.js` | 社群發文，AI 產生文案／生圖、海報版型、各平台版本與規則檢查、發布；個人與分會共用 AI 金鑰也在這裡設定 | `club_admin`（寫入） |
| `/member` | `app/member/page.js` | 會員管理，新增、編輯（含 Email）、批量匯入、審核、重設密碼、移除會員；system_admin 另可設定角色與所屬分會 | `club_admin`（寫入） |
| `/club` | `app/club/page.js` | 分會管理：新增／刪除分會、品牌、版型設定、社群帳號（Meta App）設定 | `system_admin`（寫入） |
| `/pathways` | `app/pathways/page.js` | Pathways 路徑管理：路徑、各級必修、專案中英名稱、選修清單 | `system_admin` |
| `/change-password` | `app/change-password/page.js` | 修改密碼；admin 建立帳號後首次登入強制跳轉；沒有密碼的帳號在這裡設定第一組（不需舊密碼） | 任何登入用戶 |
| `/oauth/authorize` | `app/oauth/authorize/page.js` | MCP 客戶端的授權同意畫面，scope 逐項勾選 | 任何登入用戶 |
| `/settings` | `app/settings/page.js` | 設定：修改自己的中英文姓名；查看帳號、Email、分會、角色；設定／變更密碼；連結／解除 Microsoft 帳號；列出並撤銷已授權的應用程式 | 任何登入用戶 |

前端不直接打 `/api/*`：一律透過 `lib/api.js` 打同源的 `/svc/*`，由 Next.js 在伺服器端附上 Bearer token。JWT 只存在 httpOnly cookie 裡，前端 JS 讀不到。

---

## API 端點

### 認證

| 方法 | 路徑 | 說明 | 權限 |
|------|------|------|------|
| POST | `/api/auth/register` | 自行註冊；帳號預設 `status=pending`，**需審核後才能登入** | 無 |
| POST | `/api/auth/login` | 登入，回傳 JWT token（有效期 24 小時）；`pending` 帳號拒絕登入 | 無 |
| GET  | `/api/auth/verify` | 驗證 token，回傳 username / role / club_id / must_change_pw / has_password | 已登入 |
| PUT  | `/api/auth/change-password` | 修改自己的密碼；成功後清除 `must_change_pw` 旗標。帳號沒有密碼時不需 `old_password` | 已登入 |
| GET  | `/api/auth/microsoft/config` | 是否啟用 Microsoft 登入（`{enabled}`） | 無 |
| GET  | `/api/auth/microsoft/authorize-url` | 組 Microsoft 授權網址（由 `/svc/auth/microsoft/start` 呼叫） | 無 |
| POST | `/api/auth/microsoft/callback` | 換 code、驗 id_token、對應帳號；回傳 `login` / `pending` / `signup` / `linked`（由 `/svc/auth/microsoft/callback` 呼叫；`mode=link` 需帶登入 token） | 無／已登入 |
| POST | `/api/auth/microsoft/register` | 用 sign-up ticket（30 分鐘）建立 `pending` 帳號 | 無（持有 ticket） |

### 我的帳號

| 方法 | 路徑 | 說明 | 權限 |
|------|------|------|------|
| GET    | `/api/me` | 自己的個人資料、是否有密碼、是否連結 Microsoft | 已登入 |
| PUT    | `/api/me` | 修改自己的中英文姓名（其他欄位由管理員設定） | 已登入 |
| DELETE | `/api/me/microsoft` | 解除 Microsoft 連結（沒有密碼時拒絕） | 已登入 |

### 議程管理（需 Bearer Token）

| 方法 | 路徑 | 說明 | 權限 |
|------|------|------|------|
| GET    | `/api/agendas` | 取得議程列表（支援 `date`、`date_from`、`date_to`、`page`、`limit`、`club_id`、`full`、`order`） | 已登入 |
| POST   | `/api/agendas` | 新增議程 | `club_admin` 以上 |
| GET    | `/api/agendas/{id}` | 取得單一議程 | 已登入 |
| PUT    | `/api/agendas/{id}` | 更新議程 | `club_admin` 以上 |
| DELETE | `/api/agendas/{id}` | 刪除議程 | `club_admin` 以上 |

> `club_admin` 只能看到 / 操作自己分會的議程；`system_admin` 可看到全部。

`GET /api/agendas` 的選用參數：

| 參數 | 說明 |
|------|------|
| `full=1` | 每筆額外回傳完整的 `data` JSONB，避免一場一次 GET 的 N+1 請求（角色安排頁一次取多場用） |
| `order=date` | 改以 `meeting_date DESC NULLS LAST` 排序（預設為 `updated_at DESC`） |
| `order=date_asc` | 同上，但由舊到新（`meeting_date ASC NULLS LAST`）——CHINA 議程頁靠 `date_from` + `limit=1` 查「日期最近的下一場」時用 |
| `date_from` / `date_to` | `meeting_date` 範圍（起訖皆含），可只給單邊。給任一邊時，沒有 `meeting_date` 的議程會被排除 |

> `total` 回傳的是**篩選後**的總數，因此可用來判斷是否被 `limit` 截斷。

> 列表每筆另含 `clubId`。未帶這兩個參數時回傳格式與行為不變。

### 分會管理（需 Bearer Token）

| 方法 | 路徑 | 說明 | 權限 |
|------|------|------|------|
| GET    | `/api/clubs` | 取得分會列表（含品牌與 `template_key` 等欄位；**不需登入**，註冊表單只取 `id/name`） | 無 |
| POST   | `/api/clubs` | 新增分會（可帶品牌欄位 + `template_key`） | `system_admin` |
| PUT    | `/api/clubs/{id}` | 更新分會名稱與品牌 / 版型 | `system_admin` |
| DELETE | `/api/clubs/{id}` | 刪除分會 | `system_admin` |
| GET    | `/api/pathways` | Pathways 目錄（路徑、各級必修、專案、選修清單） | 已登入 |
| PUT    | `/api/pathways` | 整份取代 Pathways 目錄；專案改名時同步更新既有議程 | `system_admin` |
| GET    | `/api/social-posts` | 貼文草稿列表（依分會） | 已登入 |
| POST   | `/api/social-posts` | 新增貼文草稿 | `club_admin` |
| GET/PUT/DELETE | `/api/social-posts/{id}` | 讀取／更新／刪除單則貼文 | 讀已登入，寫 `club_admin` |
| POST   | `/api/social-posts/generate` | 用呼叫者選定的 AI 帳號（Claude／ChatGPT）產生各平台文案 | `club_admin` |
| POST   | `/api/ai-jobs` | 建立生圖／發布工作，立刻回傳 job id | `club_admin` |
| POST   | `/api/ai-jobs/{id}/run` | 認領並執行該工作（前端不等它回應） | `club_admin` |
| GET    | `/api/ai-jobs/{id}` | 輪詢工作狀態與結果 | 已登入（限自己的工作） |
| GET    | `/api/clubs/{id}/social-config` | Meta App 設定與各平台連接狀態（**不含 secret／token**） | `club_admin` |
| PUT    | `/api/clubs/{id}/social-config` | 設定 Meta App ID／Secret（secret 加密存） | `club_admin` |
| GET    | `/api/clubs/{id}/meta/oauth-url` | 取得 Meta 授權跳轉網址 | `club_admin` |
| POST   | `/api/clubs/{id}/meta/connect` | 用 code 換長效 token，回傳可選的粉專清單 | `club_admin` |
| POST   | `/api/clubs/{id}/meta/select-page` | 確定要連接的粉專（含其 IG 帳號） | `club_admin` |
| DELETE | `/api/clubs/{id}/social-accounts/{platform}` | 中斷某平台的連接 | `club_admin` |
| GET    | `/api/meeting-fields` | 一場例會的日期／時間／地址／入場費（版型與文案共用） | 已登入 |
| GET    | `/api/ai-models` | 可選的文案／生圖模型清單與預設值 | 已登入 |
| GET    | `/api/clubs/{id}/ai-credentials` | 分會共用 AI 帳號的連接狀態（**不回金鑰**） | `club_admin` |
| PUT/DELETE | `/api/clubs/{id}/ai-credentials/{provider}` | 設定／移除分會共用 AI 金鑰 | `club_admin` |
| GET    | `/api/me/ai-credentials` | 自己已連接哪些 AI 服務（**只回末四碼，不回金鑰**） | 已登入 |
| PUT    | `/api/me/ai-credentials/{provider}` | 設定自己的 API 金鑰（加密後存） | 已登入 |
| DELETE | `/api/me/ai-credentials/{provider}` | 移除自己的金鑰 | 已登入 |
| GET    | `/api/clubs/{id}/roles-sheet` | 後端代抓該分會 `settings.roles_sheet_url` 綁定的 Google Sheet，回傳 CSV 原文（角色安排頁匯入用） | `club_admin`（限自己分會） |

> `/api/clubs` 回傳每個分會的 `name_zh / name_en / charter_no / founded_date / fee / logo_url / fb_qr_url / line_qr_url / template_key / settings`。Logo/QR 透過既有的 `/api/upload/presign` 上傳至 R2 後，URL 存進對應欄位。

### 用戶 / 會員管理（需 Bearer Token）

> **注意：** `members` 資料表已廢棄，會員資料統一由 `users` 管理。

| 方法 | 路徑 | 說明 | 權限 |
|------|------|------|------|
| GET    | `/api/users` | 取得用戶列表（含 level、status、email、microsoftLinked；`?club_id=X` 可篩選） | 已登入 |
| POST   | `/api/users` | 新增單一用戶（直接 `active`，`must_change_pw=true`） | `club_admin` 以上 |
| POST   | `/api/users/bulk` | 批量建立 `club_member`（username 自動從 name_en 產生） | `club_admin` 以上 |
| PUT    | `/api/users/{username}` | 更新用戶資料（club_admin：name / level / email；system_admin：另含 role / club_id）。`email` 省略不變、`""` 清空，重複回 400 | `club_admin` 以上 |
| PUT    | `/api/users/{username}/reset-password` | 管理員替用戶重設密碼（至少 6 字元；club_admin 限同分會） | `club_admin` 以上 |
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

### OAuth 與 MCP

這組端點給 MCP 客戶端用，認證方式跟上面不同：MCP 端點吃的是 OAuth access token，不是登入 JWT。細節見「MCP：讓 AI 助理操作這個系統」。

| 方法 | 路徑 | 說明 | 權限 |
|------|------|------|------|
| GET  | `/.well-known/oauth-protected-resource`（及 `/api/mcp` 後綴版） | RFC 9728 資源中繼資料 | 無 |
| GET  | `/.well-known/oauth-authorization-server` | RFC 8414 授權伺服器中繼資料 | 無 |
| GET  | `/api/oauth/authorize-info` | 同意畫面要顯示的客戶端名稱與 scope（會先驗證請求） | 已登入 |
| POST | `/api/oauth/authorize` | 使用者按「允許」，發授權碼並回傳要跳轉的網址 | 已登入 |
| POST | `/api/oauth/token` | 授權碼／refresh token 換 access token（form-encoded） | 無（靠 PKCE 與授權碼） |
| POST | `/api/oauth/register` | RFC 7591 動態註冊客戶端（JSON），回傳 `dcr:` 開頭的 client_id | 無 |
| POST | `/api/oauth/revoke` | RFC 7009 撤銷（form-encoded，`token` 可以是 access 或 refresh token；帶 `client_id` 時只能撤自己的）；一律回 200 | 無（持有 token 即可） |
| GET  | `/api/me/oauth-grants` | 自己目前有效的授權列表 | 已登入 |
| DELETE | `/api/me/oauth-grants/{id}` | 撤銷自己的一筆授權 | 已登入 |
| DELETE | `/api/me/oauth-grants` | 撤銷自己的全部授權 | 已登入 |
| POST | `/api/mcp` | MCP JSON-RPC：`tools/list`、`tools/call` | MCP access token |
| GET / DELETE | `/api/mcp` | 一律 405 | — |

---

## 資料庫 Schema

```sql
CREATE TABLE clubs (
    id           SERIAL PRIMARY KEY,
    name         VARCHAR(100) NOT NULL UNIQUE,   -- 選單顯示用名稱
    name_zh      VARCHAR(150),                   -- 議程表頭中文全名
    name_en      VARCHAR(150),                   -- 議程表頭英文名
    charter_no   VARCHAR(50),                    -- 章程編號
    founded_date VARCHAR(20),                    -- 成立日（字串）
    fee          VARCHAR(50),                    -- 會費字串
    logo_url     TEXT,                           -- R2 Logo URL
    fb_qr_url    TEXT,                           -- R2 Facebook QR URL
    line_qr_url  TEXT,                           -- R2 LINE QR URL
    template_key VARCHAR(50) NOT NULL DEFAULT 'standard',  -- 議程版型代號
    settings     JSONB DEFAULT '{}'::jsonb,      -- 版型專屬設定（slogan/venue/scheduleZh…，依版型 manifest）
    created_at   TIMESTAMPTZ DEFAULT NOW()
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
    email          VARCHAR(254),          -- 不分大小寫唯一；Microsoft 首次登入的比對依據
    ms_sub         VARCHAR(100),          -- 綁定的 Microsoft 身分（id_token sub），唯一
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

### 其他資料表

完整欄位見各 migration 檔（每個檔案裡都有寫設計理由）。

| 資料表 | migration | 用途 |
|--------|-----------|------|
| `social_posts` | `0009`、`0012`、`0014` | 社群貼文。`kind`（promo/recap/other）、`status`、主文案 `body`、各平台版本 `variants`（JSONB）、圖片 `images`（JSONB，順序即發布順序）、發布結果 `published`（JSONB）；`agenda_id` 例會刪除時設為 NULL |
| `user_ai_credentials` | `0010` | 個人 AI 金鑰。`key_cipher` 是 Fernet 密文，`key_hint` 只存末幾碼；`(username, provider)` 唯一 |
| `ai_jobs` | `0011` | 生圖／發布工作。`status` 由 `queued` 推進，結果存 `result`；`updated_at` 用來判斷被中斷的工作 |
| `club_secrets` | `0012` | 分會層級密鑰（Meta App Secret、分會共用 AI 金鑰），加密存；不放 `clubs.settings` 是因為 `GET /api/clubs` 不需登入 |
| `club_social_accounts` | `0012` | 分會已連接的 FB 粉專／IG／Threads，長效 token 加密存，`expires_at` 用來提前警告；`(club_id, platform)` 唯一 |
| `pathways`、`pathway_projects`、`pathway_required`、`pathway_electives` | `0013` | Pathways 目錄，見「Pathways 路徑管理」 |
| `oauth_codes` | `0015`、`0016` | MCP 授權碼（只存雜湊，5 分鐘） |
| `oauth_refresh_tokens` | `0015`、`0016`、`0018` | MCP 的「授權」本身。`grant_id` 固定識別碼；`token_hash` 目前這把 refresh token 的雜湊（每次使用輪換）、`prev_token_hash` 上一把（用來偵測重複使用）；`client_name` 同意時的客戶端名稱、`revoked_at` 撤銷時間、`last_used_at` 最後使用時間、`expires_at` 閒置到期（60 天，每次使用往後延） |

### users 欄位說明

| 欄位 | 說明 |
|------|------|
| `role` | `system_admin` / `club_admin` / `club_member` |
| `level` | TM 等級（`TM`、`ACB`、`DTM` 等），預設 `TM` |
| `must_change_pw` | `true` → 登入後強制導向改密碼頁；admin 建立帳號時自動設為 `true` |
| `status` | `active`（正常）/ `pending`（自行註冊或 Microsoft 申請，等待審核） |
| `password_hash` | bcrypt 雜湊；**空字串**表示沒有密碼（Microsoft 申請的帳號），帳號密碼登入一律失敗 |
| `email` | 由管理員設定，或首次用經驗證的 Microsoft 帳號登入／連結時自動帶入 |
| `ms_sub` | 綁定的 Microsoft 帳號；有值之後 Microsoft 登入只比對這欄 |

### Role 值說明

| role | 說明 |
|------|------|
| `system_admin` | 最高管理員（`admin` 帳號為唯一預設值，不可改、不可刪） |
| `club_admin` | 分會管理員，需指定 `club_id` |
| `club_member` | 一般會員（預設值） |

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiJson } from '@/lib/api';
import { setAuth, clearAuth, applyRoleUI } from '@/lib/auth';
import Sidebar from '@/components/Sidebar';
import './mcp.css';

// ================================================================
// AI 助理串接（MCP）— how to connect Claude / ChatGPT, and what they can do
// ================================================================
// The endpoint, the scopes and the tool list all come from GET /api/mcp/catalog,
// which reads them off the MCP server itself: a tool added there appears here
// without touching this page. Only the per-client setup steps are written out.

const ROLE_LABELS = {
  system_admin: '系統管理員',
  club_admin: '分會管理員',
  club_member: '一般會員',
};
const ROLE_RANK = { club_member: 0, club_admin: 1, system_admin: 2 };
// Sub-path deploys (NEXT_PUBLIC_BASE_PATH, e.g. /club-management) — Next.js
// prefixes <Link> itself, but not location.href.
const BASE = process.env.NEXT_PUBLIC_BASE_PATH || '';

const CLIENTS = [
  {
    key: 'claude',
    name: 'Claude',
    needs: '需要 Claude Pro、Max、Team 或 Enterprise 方案。網頁版 claude.ai 與 Claude Desktop 設定方式相同。',
    steps: [
      '打開 Claude 的「設定」→「連接器」（Connectors）。',
      '按「新增自訂連接器」（Add custom connector）。',
      '名稱隨意（例如「分會管理」），網址貼上上面的伺服器網址，按「新增」。',
      '按「連接」，瀏覽器會開到本站的授權畫面（沒登入會先登入）。',
      '勾選要給 Claude 的權限，按「允許」，回到 Claude 就完成了。',
      '在對話的工具選單（輸入框旁）把這個連接器打開，就能直接用中文請它做事。',
    ],
  },
  {
    key: 'claude-code',
    name: 'Claude Code（CLI）',
    needs: '需要已安裝並登入的 Claude Code（終端機裡的 claude 指令）。',
    // Shown above the steps, each with a copy button; the endpoint is filled
    // in. A string, or an array for several commands run in order.
    command: (endpoint) => `claude mcp add --transport http --scope user club-mgmt ${endpoint}`,
    steps: [
      '在終端機執行上面這行指令（--scope user 讓你所有專案都能用；只想在目前專案用就拿掉它）。',
      '啟動 Claude Code，輸入 /mcp，選擇 club-mgmt，再選「Authenticate」。',
      '瀏覽器會開到本站的授權畫面（沒登入會先登入），勾選權限後按「允許」。',
      '看到授權成功的訊息後回到終端機，就能直接用中文請 Claude Code 操作。',
      '之後要重新授權（例如系統新增了權限項目），一樣在 /mcp 裡對 club-mgmt 重新 Authenticate。',
    ],
  },
  {
    key: 'codex-cli',
    name: 'Codex CLI',
    needs: '需要已安裝並登入的 Codex CLI（終端機裡的 codex 指令）。Codex CLI 與 Codex App 共用同一份設定，在其中一邊加過就不用再加。',
    command: (endpoint) => [
      `codex mcp add club-mgmt --url ${endpoint}`,
      'codex mcp login club-mgmt',
    ],
    steps: [
      '執行第一行指令，把這個系統加進 Codex。',
      '執行第二行指令，瀏覽器會開到本站的授權畫面（沒登入會先登入），勾選權限後按「允許」。',
      '回到終端機看到登入成功後，啟動 codex 就能直接用中文請它操作。',
      '之後要重新授權（例如系統新增了權限項目），先執行 codex mcp logout club-mgmt，再執行一次第二行指令。',
    ],
  },
  {
    key: 'chatgpt',
    name: 'ChatGPT',
    needs: '需要 ChatGPT Plus、Pro、Business、Enterprise 或 Edu 方案；公司或學校管理的工作區要管理員開放自訂連接器。',
    steps: [
      '打開 ChatGPT 的「設定」→「Apps」→「進階設定」，開啟「開發者模式」（Developer mode）。',
      '按「建立」（Create）新增一個 App。',
      '名稱隨意；「MCP 伺服器網址」貼上上面的網址；驗證方式選「OAuth」，其他欄位留空。',
      '按「建立」，瀏覽器會開到本站的授權畫面（沒登入會先登入）。',
      '勾選要給 ChatGPT 的權限，按「允許」。',
      '開新對話，在輸入框的「＋」選單選這個 App 就能使用。會修改資料的動作，ChatGPT 會先請你確認。',
    ],
  },
  {
    key: 'codex',
    name: 'Codex App',
    needs: 'ChatGPT 桌面版的 Codex（Plugins 頁面有「MCPs」分頁的版本）。',
    steps: [
      '打開「設定」→「Plugins」→「MCPs」分頁，按右上角「Add」。',
      'URL 貼上上面的網址；「Bearer token」與「Headers」都留空（授權走 OAuth）。',
      '存檔後會開瀏覽器到本站的授權畫面，勾選權限後按「允許」。',
      '回到 Codex，開新對話就能使用。',
    ],
  },
];

const EXAMPLES = [
  '我是誰？我現在可以做哪些事？',
  '列出 Entrepreneur TM 最近五場例會',
  '幫 10/20 那場建議程，主題「我的英雄」，從角色試算表帶入角色',
  '把 10/20 的總主持人改成高莉雅，第 2 篇演講者改成 Bob Lin',
  '給我 10/20 議程的 PDF',
  '幫下一場例會建一則宣傳貼文，用 AI 產生文案和圖片，我確認後再發到 Facebook',
];

function Copyable({ text, toast }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      toast('已複製');
    } catch {
      toast('無法複製，請手動選取', true);
    }
  }
  return (
    <div className="mcp-copy">
      <code>{text}</code>
      <button className="btn-primary" onClick={copy}>複製</button>
    </div>
  );
}

function SetupSection({ endpoint, toast }) {
  const [tab, setTab] = useState(CLIENTS[0].key);
  const client = CLIENTS.find((c) => c.key === tab);
  return (
    <section className="mcp-card">
      <h3 className="mcp-title">串接步驟</h3>
      <p className="mcp-hint">伺服器網址（每種 AI 助理都用這一個）：</p>
      <Copyable text={endpoint} toast={toast} />

      <div className="mcp-tabs" role="tablist">
        {CLIENTS.map((c) => (
          <button key={c.key} role="tab" aria-selected={tab === c.key}
                  className={`mcp-tab ${tab === c.key ? 'active' : ''}`}
                  onClick={() => setTab(c.key)}>
            {c.name}
          </button>
        ))}
      </div>
      <p className="mcp-hint">{client.needs}</p>
      {client.command && [].concat(client.command(endpoint)).map((cmd) => (
        <Copyable key={cmd} text={cmd} toast={toast} />
      ))}}
      <ol className="mcp-steps">
        {client.steps.map((s, i) => <li key={i}>{s}</li>)}
      </ol>
      <p className="mcp-hint">
        各家 App 改版頻繁，選單名稱可能略有不同；找不到時搜尋設定裡的「Connectors」「MCP」或「Developer mode」。
        不需要事先登記、也不需要任何金鑰，授權全程在本站完成。
      </p>
    </section>
  );
}

function ScopesSection({ scopes }) {
  return (
    <section className="mcp-card">
      <h3 className="mcp-title">授權畫面上的選項</h3>
      <p className="mcp-hint mcp-hint-top">
        連接時會跳到本站的授權畫面，逐項勾選要讓 AI 助理代替你做的事。
        <strong>授權只會限縮、不會超過你帳號本身的權限</strong>——一般會員就算勾了「建立與修改議程」也一樣只能查看。
      </p>
      <ul className="mcp-scopes">
        {scopes.map((s) => (
          <li key={s.key}>
            <span className={`mcp-badge ${s.default ? 'on' : 'off'}`}>{s.default ? '預設勾選' : '預設不勾'}</span>
            <span>{s.label}</span>
            <code className="mcp-key">{s.key}</code>
          </li>
        ))}
      </ul>
      <p className="mcp-hint">
        已授權的 AI 助理可以在 <Link href="/settings">設定 → 已授權的應用程式</Link> 隨時撤銷，立即生效。
        之後系統新增了權限項目，舊的授權不會自動取得；要用新功能時，先在設定頁撤銷，再回 AI 助理重新連接一次。
      </p>
    </section>
  );
}

function ToolsSection({ groups, role }) {
  const mine = ROLE_RANK[role] ?? 0;
  const total = groups.reduce((n, g) => n + g.tools.length, 0);
  const usable = groups.reduce((n, g) => n + g.tools.filter((t) => ROLE_RANK[t.minRole] <= mine).length, 0);
  return (
    <section className="mcp-card">
      <h3 className="mcp-title">支援的功能</h3>
      <p className="mcp-hint mcp-hint-top">
        共 {total} 項。你的角色是<strong>{ROLE_LABELS[role] || role}</strong>，可以使用其中 {usable} 項
        {role !== 'system_admin' ? '，而且只限自己分會的資料' : '，可操作所有分會'}。
        每項都要同時符合「授權時有勾該權限」與「帳號角色足夠」才能執行。不用記工具名稱，直接用中文告訴 AI 助理要做什麼即可。
      </p>
      {groups.map((g) => (
        <div key={g.name} className="mcp-group">
          <h4 className="mcp-group-title">{g.name}</h4>
          <div className="mcp-table-wrap">
            <table className="mcp-table">
              <thead>
                <tr><th>功能</th><th>說明</th><th>需要的授權</th><th>最低角色</th></tr>
              </thead>
              <tbody>
                {g.tools.map((t) => {
                  const ok = ROLE_RANK[t.minRole] <= mine;
                  return (
                    <tr key={t.name} className={ok ? '' : 'mcp-locked'}>
                      <td>
                        <div className="mcp-tool-title">{t.title}</div>
                        <code className="mcp-key">{t.name}</code>
                        {!t.readOnly && <span className="mcp-badge write">會修改資料</span>}
                      </td>
                      <td className="mcp-desc" data-label="說明">{t.description}</td>
                      <td data-label="需要的授權">{t.scope ? t.scopeLabel : <span className="mcp-muted">不需要</span>}</td>
                      <td data-label="最低角色">
                        {ROLE_LABELS[t.minRole]}{t.minRole !== 'system_admin' && t.minRole !== 'club_member' ? '以上' : ''}
                        {!ok && <div className="mcp-muted">你無法使用</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </section>
  );
}

function ExamplesSection() {
  return (
    <section className="mcp-card">
      <h3 className="mcp-title">可以這樣問</h3>
      <ul className="mcp-examples">
        {EXAMPLES.map((e) => <li key={e}>「{e}」</li>)}
      </ul>
      <p className="mcp-hint">
        發布到社群是公開且無法透過本系統收回的動作，授權畫面上預設不勾；AI 助理發布前也會先請你確認。
        不確定自己能做什麼時，問一句「我是誰」即可。
      </p>
    </section>
  );
}

export default function McpPage() {
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState('');
  const [toastState, setToastState] = useState(null);

  function toast(msg, isError = false) {
    setToastState({ msg, isError });
    clearTimeout(toast.t);
    toast.t = setTimeout(() => setToastState(null), 2600);
  }

  useEffect(() => {
    (async function init() {
      try {
        const data = await apiJson('/auth/verify');
        setAuth(data.username, data.role, data.club_id, data.must_change_pw);
        if (data.must_change_pw) { location.href = `${BASE}/change-password`; return; }
        applyRoleUI();
        document.getElementById('navUser').textContent = data.username;
        document.getElementById('userAvatar').textContent = data.username.slice(0, 1).toUpperCase();
      } catch {
        clearAuth();
        location.href = `${BASE}/login`;
        return;
      }
      try {
        setCatalog(await apiJson('/mcp/catalog'));
      } catch (e) {
        setError(e.message || '讀取功能清單失敗');
      }
    })();
  }, []);

  return (
    <>
      <Sidebar active="mcp" />

      <div className="main-area">
        <header className="topbar">
          <div className="topbar-title">AI 助理串接（MCP）</div>
        </header>

        <div className="content mcp-content">
          <section className="mcp-card mcp-intro">
            <p>
              把 Claude 或 ChatGPT 連到這個系統後，就能直接用對話查例會、建議程、安排角色、下載議程 PDF、寫社群貼文。
              它們透過 <strong>MCP</strong>（Model Context Protocol）操作系統，用的是你的帳號與權限，
              你可以控制給它哪些權限，也能隨時撤銷。
            </p>
          </section>

          {error ? (
            <section className="mcp-card mcp-error">{error}</section>
          ) : catalog === null ? (
            <div className="loading-spinner"><div className="spinner"></div></div>
          ) : (
            <>
              <SetupSection endpoint={catalog.endpoint} toast={toast} />
              <ScopesSection scopes={catalog.scopes} />
              <ToolsSection groups={catalog.groups} role={catalog.role} />
              <ExamplesSection />
            </>
          )}
        </div>
      </div>

      <div className={`toast ${toastState ? 'visible' : ''} ${toastState?.isError ? 'error' : ''}`}>{toastState?.msg}</div>
    </>
  );
}

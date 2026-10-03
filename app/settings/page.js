'use client';

import { useEffect, useState } from 'react';
import { apiJson } from '@/lib/api';
import { setAuth, clearAuth, applyRoleUI } from '@/lib/auth';
import Sidebar from '@/components/Sidebar';
import './settings.css';

// ================================================================
// 設定 — every user's own profile, sign-in methods and authorized apps
// ================================================================
// What a member may change about themselves: their name, their password, the
// Microsoft account they sign in with, and which MCP apps may act as them.
// Role, club, level and email are shown but set by admins — email especially,
// because a first Microsoft sign-in matches on it (see api/index.py).

const ROLE_LABELS = {
  system_admin: '系統管理員',
  club_admin: '分會管理員',
  club_member: '一般會員',
};

function fmt(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit',
                                                 hour: '2-digit', minute: '2-digit', hour12: false });
}

// ---------------------------------------------------------------- profile
function ProfileSection({ me, onSaved, toast }) {
  const [nameZh, setNameZh] = useState(me.nameZh);
  const [nameEn, setNameEn] = useState(me.nameEn);
  const [busy, setBusy] = useState(false);
  const dirty = nameZh.trim() !== me.nameZh || nameEn.trim() !== me.nameEn;

  async function save() {
    if (!nameZh.trim() || !nameEn.trim()) { toast('請填入中英文姓名', true); return; }
    setBusy(true);
    try {
      await apiJson('/me', { method: 'PUT', body: { name_zh: nameZh.trim(), name_en: nameEn.trim() } });
      toast('已儲存');
      onSaved();
    } catch (e) {
      toast(e.message || '儲存失敗', true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="st-card">
      <h3 className="st-title">個人資料</h3>
      <div className="st-grid">
        <label className="st-field">
          <span>中文姓名</span>
          <input value={nameZh} onChange={(e) => setNameZh(e.target.value)} maxLength={100} />
        </label>
        <label className="st-field">
          <span>英文姓名</span>
          <input value={nameEn} onChange={(e) => setNameEn(e.target.value)} maxLength={100} />
        </label>
        <div className="st-field">
          <span>帳號</span>
          <div className="st-value">{me.username}</div>
        </div>
        <div className="st-field">
          <span>Email</span>
          <div className="st-value">{me.email || <span className="st-muted">未設定</span>}</div>
        </div>
        <div className="st-field">
          <span>所屬分會</span>
          <div className="st-value">{me.clubName || <span className="st-muted">—</span>}</div>
        </div>
        <div className="st-field">
          <span>角色／等級</span>
          <div className="st-value">{ROLE_LABELS[me.role] || me.role} · {me.level || 'TM'}</div>
        </div>
      </div>
      <p className="st-hint">Email、分會、角色與等級由管理員設定，需要更改請聯絡分會管理員。</p>
      <div className="st-actions">
        <button className="btn-primary" disabled={!dirty || busy} onClick={save}>
          {busy ? '儲存中…' : '儲存'}
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- sign-in methods
function SignInSection({ me, onChanged, toast }) {
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [busy, setBusy] = useState(false);

  async function unlink() {
    setBusy(true);
    try {
      await apiJson('/me/microsoft', { method: 'DELETE' });
      toast('已解除 Microsoft 帳號連結');
      setConfirmUnlink(false);
      onChanged();
    } catch (e) {
      toast(e.message || '解除失敗', true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="st-card">
      <h3 className="st-title">登入方式</h3>

      <div className="st-row">
        <div>
          <div className="st-row-title">密碼</div>
          <div className="st-row-sub">{me.hasPassword ? '已設定，可以用帳號密碼登入' : '尚未設定，目前只能用 Microsoft 帳號登入'}</div>
        </div>
        <a className="btn-secondary" href="/change-password">{me.hasPassword ? '變更密碼' : '設定密碼'}</a>
      </div>

      {(me.microsoftEnabled || me.microsoftLinked) && (
        <div className="st-row">
          <div>
            <div className="st-row-title">Microsoft 帳號</div>
            <div className="st-row-sub">
              {me.microsoftLinked ? '已連結，可以用 Microsoft 帳號登入' : '尚未連結'}
            </div>
          </div>
          {me.microsoftLinked ? (
            confirmUnlink ? (
              <div className="st-inline-actions">
                <button className="btn-secondary" disabled={busy} onClick={() => setConfirmUnlink(false)}>取消</button>
                <button className="btn-danger" disabled={busy} onClick={unlink}>確定解除</button>
              </div>
            ) : (
              <button className="btn-danger" onClick={() => {
                if (!me.hasPassword) { toast('請先設定密碼再解除連結，否則將無法登入', true); return; }
                setConfirmUnlink(true);
              }}>解除連結</button>
            )
          ) : (
            me.microsoftEnabled && (
              <a className="btn-secondary" href="/svc/auth/microsoft/start?mode=link">連結 Microsoft 帳號</a>
            )
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- authorized apps
// One row per grant (refresh token), not per client: the same client
// authorized from two devices is two grants, and cutting off a lost laptop
// should not also sign out the desktop. Revoking takes effect on the next
// call — the MCP endpoint checks the grant on every request.
function AppsSection({ toast }) {
  const [grants, setGrants] = useState(null);
  const [confirming, setConfirming] = useState(null);   // grant id, or 'all'
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setGrants(await apiJson('/me/oauth-grants'));
    } catch (e) {
      toast(e.message || '載入授權失敗', true);
      setGrants([]);
    }
  }
  useEffect(() => { load(); }, []);

  async function revoke(id) {
    setBusy(true);
    try {
      if (id === 'all') {
        const r = await apiJson('/me/oauth-grants', { method: 'DELETE' });
        toast(`已撤銷 ${r.revoked} 個授權`);
      } else {
        await apiJson(`/me/oauth-grants/${id}`, { method: 'DELETE' });
        toast('已撤銷授權');
      }
      setConfirming(null);
      await load();
    } catch (e) {
      toast(e.message || '撤銷失敗', true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="st-card">
      <div className="st-title-row">
        <h3 className="st-title">已授權的應用程式</h3>
        {grants?.length > 1 && (
          confirming === 'all' ? (
            <div className="st-inline-actions">
              <button className="btn-secondary" disabled={busy} onClick={() => setConfirming(null)}>取消</button>
              <button className="btn-danger" disabled={busy} onClick={() => revoke('all')}>確定全部撤銷</button>
            </div>
          ) : (
            <button className="btn-danger" onClick={() => setConfirming('all')}>全部撤銷</button>
          )
        )}
      </div>
      <p className="st-hint">
        這些應用程式（例如 Claude）透過 MCP 以你的身分操作這個系統。它們能做的事不會超過你本身的權限，
        且只限於列出的範圍。撤銷後立即生效，應用程式需要重新請你授權才能再使用。
      </p>

      {grants === null ? (
        <div className="loading-spinner"><div className="spinner"></div></div>
      ) : grants.length === 0 ? (
        <div className="st-empty">目前沒有任何應用程式取得你的授權。</div>
      ) : (
        <div className="st-apps">
          {grants.map((g) => (
            <div className="st-app" key={g.id}>
              <div className="st-app-head">
                <div>
                  <div className="st-app-name">{g.clientName || g.clientHost}</div>
                  <div className="st-app-client">{g.clientHost}</div>
                </div>
                {confirming === g.id ? (
                  <div className="st-inline-actions">
                    <button className="btn-secondary" disabled={busy} onClick={() => setConfirming(null)}>取消</button>
                    <button className="btn-danger" disabled={busy} onClick={() => revoke(g.id)}>確定撤銷</button>
                  </div>
                ) : (
                  <button className="btn-danger" onClick={() => setConfirming(g.id)}>撤銷</button>
                )}
              </div>
              <ul className="st-scopes">
                {g.scopes.map((s) => (
                  <li key={s.key} className={s.sensitive ? 'sensitive' : ''}>
                    {s.label}{s.sensitive && <span className="st-tag">公開且無法收回</span>}
                  </li>
                ))}
              </ul>
              <div className="st-app-meta">
                <span>授權於 {fmt(g.createdAt)}</span>
                <span>最後使用 {fmt(g.lastUsedAt)}</span>
                <span>到期 {fmt(g.expiresAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- page
export default function SettingsPage() {
  const [me, setMe] = useState(null);
  const [toastState, setToastState] = useState(null);

  function toast(msg, isError = false) {
    setToastState({ msg, isError });
    clearTimeout(toast.t);
    toast.t = setTimeout(() => setToastState(null), 3600);
  }

  async function loadMe() {
    const data = await apiJson('/me');
    setMe(data);
    document.getElementById('navUser').textContent = data.username;
    document.getElementById('userAvatar').textContent = data.username.slice(0, 1).toUpperCase();
  }

  useEffect(() => {
    (async function init() {
      try {
        const data = await apiJson('/auth/verify');
        setAuth(data.username, data.role, data.club_id, data.must_change_pw);
        if (data.must_change_pw) { location.href = '/change-password'; return; }
        applyRoleUI();
        await loadMe();
      } catch {
        clearAuth();
        location.href = '/login';
        return;
      }
      // Results of the Microsoft link round-trip, then drop them from the URL.
      const params = new URLSearchParams(window.location.search);
      if (params.get('ms_linked')) toast('已連結 Microsoft 帳號');
      if (params.get('ms_error')) toast(params.get('ms_error'), true);
      if (params.has('ms_linked') || params.has('ms_error')) {
        window.history.replaceState(null, '', '/settings');
      }
    })();
  }, []);

  return (
    <>
      <Sidebar active="settings" />

      <div className="main-area">
        <header className="topbar">
          <div className="topbar-title">設定</div>
        </header>

        <div className="content st-content">
          {me === null ? (
            <div className="loading-spinner"><div className="spinner"></div></div>
          ) : (
            <>
              {/* key: remount with fresh inputs after a save reloads `me` */}
              <ProfileSection key={`${me.nameZh}|${me.nameEn}`} me={me} onSaved={loadMe} toast={toast} />
              <SignInSection me={me} onChanged={loadMe} toast={toast} />
              <AppsSection toast={toast} />
            </>
          )}
        </div>
      </div>

      <div className={`toast ${toastState ? 'visible' : ''} ${toastState?.isError ? 'error' : ''}`}>{toastState?.msg}</div>
    </>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { apiJson } from '@/lib/api';
import { setAuth } from '@/lib/auth';
import './login.css';

/**
 * Where to go once logged in.
 *
 * `next` arrives from the middleware when someone was sent here mid-flow —
 * most often from the OAuth consent screen, which is reached from outside the
 * app. It is a query parameter, so it is attacker-controllable, and only
 * same-origin destinations are honoured.
 */
function afterLogin() {
  const target = new URLSearchParams(window.location.search).get('next') || '';
  try {
    // Resolve against this origin and insist the result stayed on it. That
    // rejects "//evil.example" and its backslash variants without any string
    // picking, which is where open-redirect checks usually go wrong.
    const u = new URL(target, window.location.origin);
    if (u.origin === window.location.origin) return u.pathname + u.search;
  } catch {
    /* not a usable path — fall through */
  }
  return '/home';
}

// The sign-up ticket is a JWT from our own server; the page only reads the
// name / email out of it to prefill the form. The server re-verifies it.
function readTicket(ticket) {
  try {
    const b64 = ticket.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function startMicrosoft() {
  const next = new URLSearchParams(window.location.search).get('next') || '';
  window.location.href = `/svc/auth/microsoft/start${next ? `?next=${encodeURIComponent(next)}` : ''}`;
}

function MicrosoftButton({ label }) {
  return (
    <button type="button" className="btn-microsoft" onClick={startMicrosoft}>
      <svg width="16" height="16" viewBox="0 0 21 21" aria-hidden="true">
        <rect x="1" y="1" width="9" height="9" fill="#f25022" />
        <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
        <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
        <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
      </svg>
      {label}
    </button>
  );
}

export default function LoginPage() {
  const [tab, setTab] = useState('login');
  const [loginError, setLoginError] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [registerError, setRegisterError] = useState('');
  const [registerBusy, setRegisterBusy] = useState(false);
  const [registered, setRegisteredUsername] = useState(null);

  const loginUsernameRef = useRef(null);
  const loginPasswordRef = useRef(null);
  const registerUsernameRef = useRef(null);
  const registerNameEnRef = useRef(null);
  const registerNameZhRef = useRef(null);
  const registerClubRef = useRef(null);
  const registerPasswordRef = useRef(null);
  const clubsLoadedRef = useRef(false);

  const [clubs, setClubs] = useState([]);
  const [msEnabled, setMsEnabled] = useState(false);
  const [notice, setNotice] = useState(null);          // { kind: 'info'|'error', text }
  const [msSignup, setMsSignup] = useState(null);      // { ticket, name, email }
  const [msSignupDone, setMsSignupDone] = useState(null);
  const msNameEnRef = useRef(null);
  const msNameZhRef = useRef(null);
  const msClubRef = useRef(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('ms_error')) {
      setNotice({ kind: 'error', text: params.get('ms_error') });
    } else if (params.get('ms_status') === 'pending') {
      setNotice({ kind: 'info', text: '你的帳號尚待審核，請等待分會管理員批准後再登入。' });
    }
    const ticket = params.get('ms_signup');
    if (ticket) {
      const t = readTicket(ticket);
      if (t) {
        setMsSignup({ ticket, name: t.name || '', email: t.email || '' });
        loadRegisterClubs();
      }
    }
    // Drop the one-shot parameters so a reload does not replay them.
    if (params.has('ms_error') || params.has('ms_status') || params.has('ms_signup')) {
      ['ms_error', 'ms_status', 'ms_signup'].forEach((k) => params.delete(k));
      const qs = params.toString();
      window.history.replaceState(null, '', `/login${qs ? `?${qs}` : ''}`);
    }
    apiJson('/auth/microsoft/config').then((d) => setMsEnabled(!!d.enabled)).catch(() => {});
  }, []);

  async function doMsRegister() {
    const name_en = msNameEnRef.current.value.trim();
    const name_zh = msNameZhRef.current.value.trim();
    const clubVal = msClubRef.current.value;
    setRegisterError('');
    if (!name_en) { setRegisterError('請輸入英文姓名'); return; }
    if (!name_zh) { setRegisterError('請輸入中文姓名'); return; }
    if (!clubVal) { setRegisterError('請選擇所屬分會'); return; }
    setRegisterBusy(true);
    try {
      const data = await apiJson('/auth/microsoft/register', {
        method: 'POST',
        body: { ticket: msSignup.ticket, name_en, name_zh, club_id: parseInt(clubVal) },
      });
      setMsSignupDone(data.username);
    } catch (e) {
      setRegisterError(e.message || '無法連線到伺服器');
    } finally {
      setRegisterBusy(false);
    }
  }

  function switchTab(next) {
    setTab(next);
    setLoginError('');
    setRegisterError('');
    if (next === 'register') loadRegisterClubs();
  }

  async function loadRegisterClubs() {
    if (clubsLoadedRef.current) return;
    try {
      const data = await apiJson('/clubs');
      setClubs(data);
      clubsLoadedRef.current = true;
    } catch {
      // ignore — club picker just stays empty
    }
  }

  async function doLogin() {
    const username = loginUsernameRef.current.value.trim();
    const password = loginPasswordRef.current.value;
    setLoginError('');
    if (!username || !password) { setLoginError('請填寫帳號和密碼'); return; }
    setLoginBusy(true);
    try {
      const data = await apiJson('/auth/login', { method: 'POST', body: { username, password } });
      setAuth(data.username, data.role, data.club_id, data.must_change_pw);
      window.location.href = data.must_change_pw ? '/change-password' : afterLogin();
    } catch (e) {
      setLoginError(e.message || '無法連線到伺服器，請確認後端已啟動');
    } finally {
      setLoginBusy(false);
    }
  }

  async function doRegister() {
    const username = registerUsernameRef.current.value.trim();
    const name_en = registerNameEnRef.current.value.trim();
    const name_zh = registerNameZhRef.current.value.trim();
    const clubVal = registerClubRef.current.value;
    const password = registerPasswordRef.current.value;
    setRegisterError('');
    if (!username || !password) { setRegisterError('請填寫帳號和密碼'); return; }
    if (!name_en) { setRegisterError('請輸入英文姓名'); return; }
    if (!name_zh) { setRegisterError('請輸入中文姓名'); return; }
    const club_id = clubVal ? parseInt(clubVal) : null;
    setRegisterBusy(true);
    try {
      await apiJson('/auth/register', { method: 'POST', body: { username, password, name_en, name_zh, club_id } });
      setRegisteredUsername(username);
    } catch (e) {
      setRegisterError(e.message || '無法連線到伺服器，請確認後端已啟動');
    } finally {
      setRegisterBusy(false);
    }
  }

  return (
    <div className="login-card">
      <div className="login-logo">
        <img src="/media/toastmasters_logo.png" alt="TM Logo" />
      </div>
      <h2>分會管理平台</h2>
      <p className="login-subtitle">Club Management</p>

      {notice && <div className={`login-notice ${notice.kind}`}>{notice.text}</div>}

      {msSignup ? (
        msSignupDone ? (
          <div style={{ textAlign: 'center', padding: '8px 0' }}>
            <div style={{ fontSize: 36, marginBottom: 14 }}>✅</div>
            <div style={{ fontWeight: 700, fontSize: 15, color: '#0f172a', marginBottom: 8 }}>申請已提交！</div>
            <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.7, marginBottom: 18 }}>
              請等待分會管理員審核，通過後用 Microsoft 帳號登入即可。<br />
              （系統帳號：<strong>{msSignupDone}</strong>）
            </div>
            <a href="/login" style={{ color: '#004165', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>← 返回登入</a>
          </div>
        ) : (
          <div>
            <div className="login-notice info">
              這個 Microsoft 帳號還沒有對應的系統帳號。填寫以下資料送出申請，分會管理員審核後即可登入。
            </div>
            {msSignup.email && (
              <div className="login-field">
                <label>Email</label>
                <div className="login-readonly">{msSignup.email}</div>
              </div>
            )}
            <div className="login-field">
              <label>英文姓名 English Name</label>
              <input type="text" ref={msNameEnRef} defaultValue={msSignup.name} placeholder="e.g. John Smith" />
            </div>
            <div className="login-field">
              <label>中文姓名</label>
              <input type="text" ref={msNameZhRef} placeholder="e.g. 王小明" />
            </div>
            <div className="login-field">
              <label>所屬分會</label>
              <select ref={msClubRef}>
                <option value="">— 請選擇分會 —</option>
                {clubs.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
              </select>
            </div>
            <div className="login-error">{registerError}</div>
            <button className="btn-login-submit" disabled={registerBusy} onClick={doMsRegister}>
              {registerBusy ? (<><span className="spinner" />處理中...</>) : '提交申請'}
            </button>
            <p style={{ marginTop: 14, fontSize: 12 }}>
              <a href="/login" style={{ color: '#004165' }}>取消</a>
            </p>
          </div>
        )
      ) : (<>
      <div className="login-tabs">
        <button className={`login-tab ${tab === 'login' ? 'active' : ''}`} onClick={() => switchTab('login')}>登入</button>
        <button className={`login-tab ${tab === 'register' ? 'active' : ''}`} onClick={() => switchTab('register')}>註冊</button>
      </div>

      {tab === 'login' && (
        <div id="loginForm">
          <div className="login-field">
            <label>帳號</label>
            <input
              type="text"
              ref={loginUsernameRef}
              placeholder="請輸入帳號"
              onKeyDown={(e) => { if (e.key === 'Enter') loginPasswordRef.current?.focus(); }}
            />
          </div>
          <div className="login-field">
            <label>密碼</label>
            <input
              type="password"
              ref={loginPasswordRef}
              placeholder="請輸入密碼"
              onKeyDown={(e) => { if (e.key === 'Enter') doLogin(); }}
            />
          </div>
          <div className="login-error">{loginError}</div>
          <button className="btn-login-submit" disabled={loginBusy} onClick={doLogin}>
            {loginBusy ? (<><span className="spinner" />處理中...</>) : '登入'}
          </button>
          {msEnabled && (
            <>
              <div className="login-divider">或</div>
              <MicrosoftButton label="使用 Microsoft 帳號登入" />
            </>
          )}
        </div>
      )}

      {tab === 'register' && (
        <div id="registerForm">
          {registered ? (
            <div style={{ textAlign: 'center', padding: '16px 0 8px' }}>
              <div style={{ fontSize: 36, marginBottom: 14 }}>✅</div>
              <div style={{ fontWeight: 700, fontSize: 15, color: '#0f172a', marginBottom: 8 }}>申請已提交！</div>
              <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.7, marginBottom: 18 }}>
                帳號 <strong>{registered}</strong> 已成功送出，<br />
                請等待分會管理員審核批准後即可登入。
              </div>
              <a href="#" onClick={(e) => { e.preventDefault(); switchTab('login'); }} style={{ color: '#004165', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
                ← 返回登入
              </a>
            </div>
          ) : (
            <div id="registerFields">
              <div className="login-field">
                <label>帳號（至少 3 字元）</label>
                <input
                  type="text"
                  ref={registerUsernameRef}
                  placeholder="請輸入帳號"
                  onKeyDown={(e) => { if (e.key === 'Enter') registerNameEnRef.current?.focus(); }}
                />
              </div>
              <div className="login-field">
                <label>英文姓名 English Name</label>
                <input
                  type="text"
                  ref={registerNameEnRef}
                  placeholder="e.g. John Smith"
                  onKeyDown={(e) => { if (e.key === 'Enter') registerNameZhRef.current?.focus(); }}
                />
              </div>
              <div className="login-field">
                <label>中文姓名</label>
                <input
                  type="text"
                  ref={registerNameZhRef}
                  placeholder="e.g. 王小明"
                  onKeyDown={(e) => { if (e.key === 'Enter') registerPasswordRef.current?.focus(); }}
                />
              </div>
              <div className="login-field">
                <label>所屬分會</label>
                <select ref={registerClubRef} style={{ width: '100%', padding: '9px 11px', border: '1px solid #ccc', borderRadius: 6, fontSize: 13, background: '#fff' }}>
                  <option value="">— 請選擇分會 —</option>
                  {clubs.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div className="login-field">
                <label>密碼（至少 6 字元）</label>
                <input
                  type="password"
                  ref={registerPasswordRef}
                  placeholder="請輸入密碼"
                  onKeyDown={(e) => { if (e.key === 'Enter') doRegister(); }}
                />
              </div>
              <div className="login-error">{registerError}</div>
              <button className="btn-login-submit" disabled={registerBusy} onClick={doRegister}>
                {registerBusy ? (<><span className="spinner" />處理中...</>) : '提交申請'}
              </button>
              {msEnabled && (
                <>
                  <div className="login-divider">或</div>
                  <MicrosoftButton label="使用 Microsoft 帳號申請" />
                </>
              )}
            </div>
          )}
        </div>
      )}
      </>)}
    </div>
  );
}

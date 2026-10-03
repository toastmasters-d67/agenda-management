'use client';

import { useEffect, useRef, useState } from 'react';
import { apiJson } from '@/lib/api';
import { setAuth, getUsername, getRole, getClubId, clearAuth } from '@/lib/auth';
import './change-password.css';
import { withBase } from '@/lib/basePath';

export default function ChangePasswordPage() {
  const [notice, setNotice] = useState('您的帳號是首次登入，請先設定自己的密碼才能繼續使用系統。');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [forced, setForced] = useState(true);
  // Accounts created through Microsoft sign-up have no password yet; this page
  // then sets the first one, with nothing to confirm.
  const [hasPassword, setHasPassword] = useState(true);

  const oldPasswordRef = useRef(null);
  const newPasswordRef = useRef(null);
  const confirmPasswordRef = useRef(null);

  useEffect(() => {
    (async function onLoad() {
      try {
        const data = await apiJson('/auth/verify');
        setAuth(data.username, data.role, data.club_id, data.must_change_pw);
        setForced(!!data.must_change_pw);
        setHasPassword(data.has_password !== false);
        setNotice(
          data.must_change_pw
            ? `${data.username}，您的帳號是首次登入，請先設定自己的密碼才能繼續使用系統。`
            : data.has_password === false
              ? `${data.username}，你目前用 Microsoft 帳號登入。設定密碼後，也可以用帳號密碼登入。`
              : `${data.username}，請輸入目前密碼與新密碼。`
        );
      } catch {
        clearAuth();
        location.href = withBase('/login');
      }
    })();
  }, []);

  async function doChange() {
    const oldPassword = oldPasswordRef.current?.value || '';
    const newPassword = newPasswordRef.current.value;
    const confirmPassword = confirmPasswordRef.current.value;

    setError('');
    if (hasPassword && !oldPassword) { setError('請輸入目前密碼'); return; }
    if (!newPassword) { setError('請輸入新密碼'); return; }
    if (newPassword.length < 6) { setError('新密碼至少需要 6 個字元'); return; }
    if (newPassword !== confirmPassword) { setError('兩次輸入的新密碼不一致'); return; }
    if (hasPassword && newPassword === oldPassword) { setError('新密碼不能與目前密碼相同'); return; }

    setBusy(true);
    try {
      await apiJson('/auth/change-password', {
        method: 'PUT',
        body: { old_password: oldPassword, new_password: newPassword },
      });
      setAuth(getUsername(), getRole(), getClubId(), false);
      location.href = forced ? '/home' : '/settings';
    } catch (e) {
      setError(e.message || '無法連線到伺服器，請確認後端已啟動');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-logo">
        <img src={withBase('/media/toastmasters_logo.png')} alt="TM Logo" />
      </div>
      <h2>{hasPassword ? '設定新密碼' : '設定密碼'}</h2>
      <p className="card-subtitle">分會管理平台</p>

      <div className="notice-box" id="noticeBox">{notice}</div>

      {hasPassword && (
        <div className="field">
          <label>{forced ? '目前密碼（由管理員提供）' : '目前密碼'}</label>
          <input
            type="password"
            ref={oldPasswordRef}
            placeholder="請輸入目前密碼"
            onKeyDown={(e) => { if (e.key === 'Enter') newPasswordRef.current?.focus(); }}
          />
        </div>
      )}
      <div className="field">
        <label>新密碼（至少 6 個字元）</label>
        <input
          type="password"
          ref={newPasswordRef}
          placeholder="請輸入新密碼"
          onKeyDown={(e) => { if (e.key === 'Enter') confirmPasswordRef.current?.focus(); }}
        />
      </div>
      <div className="field">
        <label>確認新密碼</label>
        <input
          type="password"
          ref={confirmPasswordRef}
          placeholder="再輸入一次新密碼"
          onKeyDown={(e) => { if (e.key === 'Enter') doChange(); }}
        />
      </div>

      <div id="errorMsg" className="error-msg">{error}</div>
      <button className="btn-submit" id="btnSubmit" disabled={busy} onClick={doChange}>
        {busy ? (<><span className="spinner" />處理中...</>) : '確認送出'}
      </button>
      {!forced && (
        <p className="hint" id="skipHint">
          <a href={withBase('/settings')} style={{ color: '#004165' }}>取消，返回設定</a>
        </p>
      )}
    </div>
  );
}

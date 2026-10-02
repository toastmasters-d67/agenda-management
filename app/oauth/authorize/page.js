'use client';

import { useEffect, useState } from 'react';
import { apiJson } from '@/lib/api';
import './authorize.css';

// ================================================================
// OAUTH CONSENT
// ================================================================
// The screen where an officer decides what an MCP client may do on their
// behalf. It is deliberately a page in this app rather than anything the
// client renders: the whole point of the OAuth detour is that the decision is
// made somewhere the client cannot draw.
//
// Scopes are checkboxes, not a take-it-or-leave-it. `publish` in particular is
// public and cannot be undone, so it arrives unticked and has to be turned on
// by hand — see MCP_SCOPES in api/index.py.

const REQUIRED_PARAMS = ['client_id', 'redirect_uri', 'code_challenge', 'resource'];

export default function AuthorizePage() {
  const [state, setState] = useState({ phase: 'loading' });
  const [granted, setGranted] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const missing = REQUIRED_PARAMS.filter((k) => !q.get(k));
    if (missing.length) {
      setState({ phase: 'error', message: `授權請求缺少參數：${missing.join('、')}` });
      return;
    }
    (async () => {
      try {
        const info = await apiJson(`/oauth/authorize-info?${q.toString()}`);
        setState({ phase: 'ask', info, q });
        // Sensitive scopes start off. Everything else starts on, because the
        // client asked for it and the user came here to say yes.
        setGranted(Object.fromEntries(info.scopes.map((s) => [s.key, !s.sensitive])));
      } catch (e) {
        setState({ phase: 'error', message: e.message || '授權請求無效' });
      }
    })();
  }, []);

  function deny() {
    const q = state.q;
    const back = new URL(q.get('redirect_uri'));
    back.searchParams.set('error', 'access_denied');
    if (q.get('state')) back.searchParams.set('state', q.get('state'));
    window.location.href = back.toString();
  }

  async function allow() {
    const q = state.q;
    setBusy(true);
    try {
      const { redirect } = await apiJson('/oauth/authorize', {
        method: 'POST',
        body: {
          client_id: q.get('client_id'),
          redirect_uri: q.get('redirect_uri'),
          code_challenge: q.get('code_challenge'),
          code_challenge_method: q.get('code_challenge_method') || 'S256',
          resource: q.get('resource'),
          state: q.get('state') || '',
          scope: Object.entries(granted).filter(([, on]) => on).map(([k]) => k).join(' '),
        },
      });
      window.location.href = redirect;
    } catch (e) {
      setState({ phase: 'error', message: e.message || '授權失敗' });
    } finally {
      setBusy(false);
    }
  }

  if (state.phase === 'loading') {
    return <div className="oa-wrap"><div className="oa-card">讀取授權請求…</div></div>;
  }

  if (state.phase === 'error') {
    return (
      <div className="oa-wrap">
        <div className="oa-card">
          <h1 className="oa-title">無法完成授權</h1>
          <p className="oa-error">{state.message}</p>
          <p className="oa-note">
            這個畫面是由你的 AI 客戶端導向過來的。請回到那邊重新發起連線。
          </p>
        </div>
      </div>
    );
  }

  const { info } = state;
  const nothing = !Object.values(granted).some(Boolean);

  return (
    <div className="oa-wrap">
      <div className="oa-card">
        <h1 className="oa-title">
          <strong>{info.clientName}</strong> 想要存取你的帳號
        </h1>
        <p className="oa-who">
          以 <strong>{info.username}</strong> 的身分
          {info.clientUri ? <> · <a href={info.clientUri} target="_blank" rel="noreferrer">{info.clientUri}</a></> : null}
        </p>

        <div className="oa-scopes">
          {info.scopes.map((s) => (
            <label key={s.key} className={`oa-scope${s.sensitive ? ' sensitive' : ''}`}>
              <input
                type="checkbox"
                checked={!!granted[s.key]}
                onChange={(e) => setGranted({ ...granted, [s.key]: e.target.checked })}
              />
              <span className="oa-scope-text">
                {s.label}
                {s.sensitive ? <span className="oa-flag">公開且無法收回</span> : null}
              </span>
            </label>
          ))}
        </div>

        <p className="oa-note">
          授權之後，這個客戶端可以在不再詢問你的情況下做上面勾選的事，
          但它<strong>永遠不會超過你自己的權限</strong>——分會與角色的限制照常生效。
          取消勾選的項目之後若被用到，客戶端會再問你一次。
        </p>

        <div className="oa-actions">
          <button className="oa-btn" onClick={deny} disabled={busy}>取消</button>
          <button className="oa-btn primary" onClick={allow} disabled={busy || nothing}>
            {busy ? '處理中…' : nothing ? '請至少勾選一項' : '允許'}
          </button>
        </div>
      </div>
    </div>
  );
}

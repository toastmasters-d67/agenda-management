// ----------------------------------------------------------------
// Meeting roles — the shared catalog (lib/meetingRoles.json) plus each
// club's own roles, for every page that reads or writes them: the 角色 page
// builds its matrix from it, the agenda editor keeps every role it doesn't
// show, and the Word export turns each role into a {{mark}}.
//
// Built-in roles live at agendas.data[key]. A club's own roles
// (clubs.settings.custom_roles = [{ id, zh, en }]) live at
// agendas.data.customRoles[id], so renaming one keeps who was assigned.
// ----------------------------------------------------------------
import catalog from './meetingRoles.json';

export const ROLE_GROUP_DEFS = catalog.groups;
export const MEETING_ROLES = catalog.roles;
export const MEETING_META = catalog.meta;

/** Whether a built-in agenda template prints this role / meta field. */
export function roleInTemplate(role, templateKey) {
  return !role.templates || role.templates.includes(templateKey);
}

// The club modal's editor for the club's own roles (appended to every
// template's manifest, like the Word template: the roles belong to the club).
export const CUSTOM_ROLES_FIELD = {
  key: 'custom_roles', label: '分會自訂角色', type: 'roles', store: 'setting',
  group: 'template', section: '分會自訂角色',
};

/** The club's own roles, cleaned up (blank names dropped). */
export function clubCustomRoles(club) {
  const list = (club && club.settings && club.settings.custom_roles) || [];
  return (Array.isArray(list) ? list : [])
    .filter((r) => r && r.id && String(r.zh || '').trim())
    .map((r) => ({ id: String(r.id), zh: String(r.zh).trim(), en: String(r.en || '').trim() }));
}

/** A new, unused id for a club role (ids never change once given). */
export function newCustomRoleId(existing) {
  const used = new Set((existing || []).map((r) => r.id));
  let id;
  do { id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`; } while (used.has(id));
  return id;
}

/** Value of a built-in role on one meeting's data. */
export function builtinRoleValue(data, role) {
  if (role.kind === 'variety') return (data.varietySession && data.varietySession.host) || '';
  return data[role.key] || '';
}

/** Value of a club role on one meeting's data. */
export function customRoleValue(data, id) {
  return (data.customRoles && data.customRoles[id]) || '';
}

/** Every Word mark the catalog provides, for the help list and upload check. */
export function builtinWordMarks() {
  return [
    ...MEETING_META.map((m) => [m.word, m.zh]),
    ...MEETING_ROLES.map((r) => [r.word, r.zh === r.word ? '' : r.zh]),
  ];
}

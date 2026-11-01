// Who should the call be transferred to right now?
//
// Two built-in sources, first match wins:
//   SHIFTS_URL           an HTTP endpoint of your rota / HR system returning
//                        { "operators": [ { "name": "…", "sipExtension": "201", "externalPhone": "+1555…" } ] }
//                        Shifts are never hard-coded into the dialplan.
//   STAFF_DIAL_TARGETS   a static list, e.g. "PJSIP/201&PJSIP/202" (all ring at once)
//
// Returns Asterisk dial targets, so the dialplan does not care where operators
// sit: SIP extensions → Local/<ext>@internal, mobiles → Local/<number>@outbound.
const { str } = require('../../packages/core/config');

async function fetchOperators() {
  const url = str('SHIFTS_URL');
  if (!url) return [];
  const token = str('SHIFTS_TOKEN');
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`shifts API -> ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.operators) ? data.operators : [];
}

// The [outbound] context only allows digits without '+'. Rotas return
// "+1 555 …", "00…" or national formats — normalise to one shape.
// DEFAULT_COUNTRY_CODE is prepended to national numbers of NATIONAL_NUMBER_LENGTH digits.
function normalizePhone(raw) {
  let n = String(raw).replace(/[^0-9+]/g, '');
  if (n.startsWith('+')) n = n.slice(1);
  else if (n.startsWith('00')) n = n.slice(2);
  else if (str('DEFAULT_COUNTRY_CODE') && n.length === Number(str('NATIONAL_NUMBER_LENGTH', '9'))) n = str('DEFAULT_COUNTRY_CODE') + n;
  return n;
}

function operatorDialTarget(op) {
  if (op.sipExtension) return `Local/${op.sipExtension}@internal`;
  if (op.externalPhone) return `Local/${normalizePhone(op.externalPhone)}@outbound`;
  return null;
}

async function staffTargets() {
  if (str('SHIFTS_URL')) {
    const operators = await fetchOperators();
    const targets = operators.map(operatorDialTarget).filter(Boolean);
    console.log('[ROUTING] on call:', operators.map((o) => o.name).join(', ') || '(nobody)', '->', targets.join('&') || '(no targets)');
    return targets;
  }
  return str('STAFF_DIAL_TARGETS').split('&').map((t) => t.trim()).filter(Boolean);
}

const routingConfigured = () => !!(str('SHIFTS_URL') || str('STAFF_DIAL_TARGETS') || str('FALLBACK_NUMBER'));

module.exports = { staffTargets, routingConfigured, normalizePhone, operatorDialTarget };

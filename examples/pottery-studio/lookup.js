// Example data access for the pottery-studio agent: a JSON file instead of a
// database. Replace these functions with queries against your CRM / shop /
// data warehouse — keep the same shapes and the agent does not change.
const fs = require('fs');
const path = require('path');
const { phoneKey, extractDigits } = require('../../packages/core/text');

const FILE = process.env.EXAMPLE_DATA_FILE || path.join(__dirname, 'data.json');
const load = () => JSON.parse(fs.readFileSync(FILE, 'utf8')); // re-read so edits apply without restart

// CallerLookup: phone number -> { name, email, ... } | null
async function lookupCaller(phone) {
  const key = phoneKey(phone);
  if (key.length < 7) return null;
  const c = load().customers.find((x) => phoneKey(x.phone) === key);
  return c ? { name: c.name, email: c.email, phone: c.phone } : null;
}

// Order numbers in this example are 6 digits starting with 1. Exact match only:
// fuzzy matching on garbled speech can return somebody else's order.
async function findOrderInTranscript(transcript) {
  const m = extractDigits(transcript).match(/1\d{5}/);
  if (!m) return null;
  const o = load().orders.find((x) => x.number === m[0]);
  // Never read out personal data: return only what the agent needs to talk about
  return o ? { number: o.number, date: o.date, status: o.status, items: o.items, classDate: o.classDate || null } : null;
}

async function upcomingClasses({ title } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  return load().classes
    .filter((c) => c.date >= today && (!title || c.title.toLowerCase().includes(String(title).toLowerCase())))
    .slice(0, 10);
}

module.exports = { lookupCaller, findOrderInTranscript, upcomingClasses };

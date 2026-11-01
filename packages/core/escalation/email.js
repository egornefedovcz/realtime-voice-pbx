// E-mail escalation via SMTP. Requires the optional dependency `nodemailer`.
const { formatConversation } = require('../summary');

function emailNotifier({ host, port = 587, user, pass, from, to, agentName = 'Voice agent' } = {}) {
  if (!host || !to) throw new Error('emailNotifier: host and to are required');
  let nodemailer;
  try { nodemailer = require('nodemailer'); } catch (_) {
    throw new Error('emailNotifier needs the optional dependency "nodemailer" (npm install nodemailer)');
  }
  const transporter = nodemailer.createTransport({
    host, port, secure: Number(port) === 465, ...(user ? { auth: { user, pass } } : {}),
  });
  return {
    name: 'email',
    async notify(h) {
      const name = h.caller?.name || 'Unknown caller';
      const ref = h.facts?.orderNumber || h.facts?.reference || '';
      const body = [
        `${agentName} took a request over the phone and is handing it over.`,
        ...(h.summary ? ['', 'SUMMARY:', h.summary] : []),
        '',
        '==============================',
        'CALLER',
        '==============================',
        `Name: ${name}`,
        `Phone: ${h.callerPhone || '—'}`,
        ...(h.caller?.email ? [`E-mail: ${h.caller.email}`] : []),
        ...(ref ? [`Reference: ${ref}`] : []),
        `Reason: ${h.reason}`,
        '',
        '==============================',
        'TRANSCRIPT',
        '==============================',
        formatConversation(h.conversation, agentName) || '(empty)',
      ].join('\n');
      await transporter.sendMail({
        from: from || user,
        to,
        subject: `[${agentName}] Phone request from ${name}${ref ? ` — ${ref}` : ''}`,
        text: body,
      });
      console.log('[ESCALATION:email] sent');
    },
  };
}

module.exports = { emailNotifier };

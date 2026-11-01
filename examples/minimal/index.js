// The smallest useful agent: a prompt and a greeting. No lookups, no tools.
//   AGENT=./examples/minimal npm start
const { defineAgent } = require('../../packages/core');

module.exports = defineAgent({
  name: 'minimal',
  greeting: 'Hello, you are talking to an AI assistant. How can I help?',
  instructions: `You are a friendly phone assistant. Keep answers short — one to three sentences —
and let the caller speak. No lists, no markdown, no URLs. If you do not know something, say so.
Reply in the language the caller speaks.`,
});

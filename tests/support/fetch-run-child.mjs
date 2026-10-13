// Exercise the shipped CLI in a child process without opening listening sockets.
// The parent handles each HTTP request through Fastify.inject or a response fixture.
import { fetchRun } from '../../scripts/fetch-run.mjs';
let nextId = 0;
const pending = new Map();
process.on('message', message => {
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error));
  else {
    const response = new Response(message.body, { status: message.status, headers: message.headers });
    resolve(response);
  }
});
globalThis.fetch = async (url, options) => {
  const id = nextId++;
  const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  process.send({ id, url, headers: options.headers, redirect: options.redirect });
  const response = await result;
  if (options.redirect === 'error' && response.status >= 300 && response.status < 400) throw new Error('fetch failed');
  return response;
};
// Start without top-level await so Node can finish bootstrapping IPC reception.
fetchRun(process.argv[2]).then(filename => {
  process.send({ filename }, () => process.disconnect());
}, error => {
  process.exitCode = 1;
  process.send({ error: error.message }, () => process.disconnect());
});

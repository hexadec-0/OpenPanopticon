// SPDX-License-Identifier: GPL-3.0-or-later
//
// Container health probe. It asks /api/health over loopback, which is always
// an allowed Host. A 401 also counts as healthy: it means the server is up and
// enforcing its access key, which this probe cannot know when ACCESS_KEY was
// left for the server to generate.

const port = process.env.PORT || '8420';
const headers = { 'X-Panopticon': '1' };
if (process.env.ACCESS_KEY) headers.Cookie = `op_access=${process.env.ACCESS_KEY.trim()}`;

fetch(`http://127.0.0.1:${port}/api/health`, { headers, signal: AbortSignal.timeout(4000) })
  .then((res) => process.exit(res.ok || res.status === 401 ? 0 : 1))
  .catch(() => process.exit(1));

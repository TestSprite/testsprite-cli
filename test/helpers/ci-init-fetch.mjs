// Preload in the CLI child so the real command runs without opening API sockets.
globalThis.fetch = async (url, init) => {
  if (
    url !== 'http://127.0.0.1:9/api/cli/v1/projects/dummy-project/env' ||
    init?.method !== 'GET'
  ) {
    throw new Error(`Unexpected request in ci init fixture: ${init?.method} ${url}`);
  }
  return new Response(JSON.stringify({ environments: [{ name: 'staging', isDefault: true }] }), {
    headers: { 'content-type': 'application/json' },
  });
};

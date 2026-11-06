export async function verifyEngine(bytes: ArrayBuffer) {
  const response = await fetch(`/build-manifest.json?v=${__BUILD_ID__}`, { cache: 'no-store' });
  if (!response.ok) throw new Error('Build manifest missing. Reinstall or reload the complete app build.');
  const manifest = await response.json();
  if (manifest.buildId !== __BUILD_ID__) throw new Error('App assets changed or are cached from another build. Reload to load the matching app and engine.');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hash !== manifest.engine['bckgrnd_msc_engine_bg.wasm']) throw new Error('WASM does not match this app build. Reload or reinstall the complete build.');
  return manifest;
}

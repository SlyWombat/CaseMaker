const url = new URL('./src/engine/fonts/files/Barlow-Regular.ttf', import.meta.url);
console.log('href', url.href);
try {
  const r = await fetch(url);
  console.log('fetch ok', r.ok, r.status, (await r.arrayBuffer()).byteLength);
} catch (e) {
  console.log('fetch FAILED:', e.message, '| cause:', e.cause?.message ?? e.cause);
}

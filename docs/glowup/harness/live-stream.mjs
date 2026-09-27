// Live (real API) check of the streamed /api/recommend. Start the server WITHOUT the
// fixture shim (npm start), then: node live-stream.mjs. Bills one Places search, up to
// 8 Place Details and one Claude call per run.
const base = 'http://localhost:3000';
const d = await (await fetch(`${base}/api/restaurants?lat=40.73&lng=-73.995&maxDistance=3`)).json();
console.log('candidates', d.restaurants.length);
const t0 = Date.now();
const res = await fetch(`${base}/api/recommend`, { method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
  body: JSON.stringify({ restaurants: d.restaurants, price: 2, groupSize: 1, sharing: false, dish: '' }) });
console.log('content-type', res.headers.get('content-type'));
const dec = new TextDecoder(); let buf = ''; let partials = 0;
for await (const chunk of res.body) {
  buf += dec.decode(chunk, { stream: true }); let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const ev = buf.slice(0, i); buf = buf.slice(i + 2);
    const name = ev.match(/event: (\w+)/)[1];
    if (name === 'partial') { partials++; if (partials % 8 !== 1) continue; }
    console.log(`${Date.now() - t0}ms`, name, ev.split('data: ')[1].slice(0, 140));
  }
}
console.log('partials', partials, 'total', Date.now() - t0, 'ms');

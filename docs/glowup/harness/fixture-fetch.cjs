// Preloaded into the server (node -r) by the glow-up perf harness. Intercepts
// the server's outbound fetch() calls to Google Places/Geocoding/Details and
// Anthropic so every perf run sees identical data and identical latencies,
// without billing a real API call per run.
//
//   FF_FIXTURES=record  pass through to the real APIs and save responses
//   FF_FIXTURES=replay  serve saved responses with the latencies below
//
// Math.random is seeded too, so /api/recommend's random candidate pool (and
// therefore the recorded Claude response it maps to) is the same every run.
// Nothing here ships to production: it lives outside server/ and is only
// loaded via `node -r`.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MODE = process.env.FF_FIXTURES || 'replay';
const DIR = path.join(__dirname, 'fixtures');
fs.mkdirSync(DIR, { recursive: true });

// Latencies modelled on what the real APIs did from a home connection in
// Sept 2026 (see PERF.md). Claude: ~2s to first tool-input token (measured
// live with eager_input_streaming on Haiku 4.5), ~3s to the end of the call.
const LATENCY = { places: 600, geocode: 250, details: 350, claudeTtft: 2000, claudeTotal: 3000 };

let seed = 0x5eed;
Math.random = function mulberry32() {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const realFetch = globalThis.fetch;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

function fixturePath(kind, key) { return path.join(DIR, `${kind}-${hash(key)}.json`); }
function load(kind, key) {
  const p = fixturePath(kind, key);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}
function save(kind, key, body) {
  fs.writeFileSync(fixturePath(kind, key), JSON.stringify({ key, body }, null, 1));
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function classifyGoogle(url) {
  if (url.pathname.includes('/place/details/')) return 'details';
  if (url.pathname.includes('/geocode/')) return 'geocode';
  return 'places';
}

function googleKey(url) {
  const params = [...url.searchParams.entries()].filter(([k]) => k !== 'key').sort();
  return url.pathname + '?' + params.map(([k, v]) => `${k}=${v}`).join('&');
}

// Keyed on the conversation only (not stream/max_tokens), so a request that
// later switches to stream:true still maps to the same recorded answer.
function claudeKey(body) {
  return JSON.stringify(body.messages);
}

function syntheticClaude(body) {
  // Fallback when replay has no recording for this exact prompt: pick the
  // first candidate and a generic dish, which is what the real grounding
  // rules require when no review names a specific dish.
  const text = typeof body.messages[0].content === 'string' ? body.messages[0].content : '';
  const m = text.match(/"place_id":\s*"([^"]+)"/);
  return {
    id: 'msg_synthetic', type: 'message', role: 'assistant', model: body.model,
    content: [{
      type: 'tool_use', id: 'toolu_synthetic', name: 'recommend_restaurant',
      input: {
        place_id: m ? m[1] : 'unknown',
        dish_suggestion: 'their most popular item',
        reason: 'Reviewers keep coming back for the consistent quality and friendly service.',
        flavor_tags: ['Savory', 'Rich', 'Fresh']
      }
    }],
    stop_reason: 'tool_use'
  };
}

// Replays a recorded (non-streamed) tool_use message as the SSE event
// sequence the Messages API emits with stream:true, pacing the partial JSON
// so the first token lands at claudeTtft and the last at claudeTotal.
function sseStream(message) {
  const tool = message.content.find(b => b.type === 'tool_use');
  const json = JSON.stringify(tool.input);
  const chunks = [];
  for (let i = 0; i < json.length; i += 12) chunks.push(json.slice(i, i + 12));
  const enc = new TextEncoder();
  const ev = (type, data) => enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  return new ReadableStream({
    async start(controller) {
      await sleep(LATENCY.claudeTtft);
      controller.enqueue(ev('message_start', { message: { ...message, content: [], stop_reason: null } }));
      controller.enqueue(ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } }));
      const per = (LATENCY.claudeTotal - LATENCY.claudeTtft) / chunks.length;
      for (const c of chunks) {
        controller.enqueue(ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: c } }));
        await sleep(per);
      }
      controller.enqueue(ev('content_block_stop', { index: 0 }));
      controller.enqueue(ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 150 } }));
      controller.enqueue(ev('message_stop', {}));
      controller.close();
    }
  });
}

globalThis.fetch = async function fixtureFetch(input, init = {}) {
  const url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);

  if (url.hostname === 'maps.googleapis.com') {
    const kind = classifyGoogle(url);
    const key = googleKey(url);
    if (MODE === 'record') {
      const res = await realFetch(input, init);
      const body = await res.json();
      save(kind, key, body);
      return jsonResponse(body);
    }
    await sleep(LATENCY[kind]);
    const rec = load(kind, key);
    if (!rec) {
      console.warn(`[fixtures] no recording for ${kind} ${key}`);
      return jsonResponse(kind === 'details' ? { status: 'OK', result: { reviews: [] } } : { status: 'ZERO_RESULTS', results: [] });
    }
    return jsonResponse(rec.body);
  }

  if (url.hostname === 'api.anthropic.com') {
    const body = JSON.parse(init.body);
    const key = claudeKey(body);
    let message;
    if (MODE === 'record') {
      const res = await realFetch(input, { ...init, body: JSON.stringify({ ...body, stream: false }) });
      message = await res.json();
      save('claude', key, message);
    } else {
      const rec = load('claude', key);
      if (!rec) console.warn('[fixtures] no recording for claude prompt, using synthetic pick');
      message = rec ? rec.body : syntheticClaude(body);
    }
    if (body.stream) {
      return new Response(sseStream(message), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (MODE !== 'record') await sleep(LATENCY.claudeTotal);
    return jsonResponse(message);
  }

  return realFetch(input, init);
};

console.log(`[fixtures] mode=${MODE} dir=${DIR}`);

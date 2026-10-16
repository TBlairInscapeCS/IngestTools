// MV3 service workers can't play audio - this offscreen document owns the
// AudioContext and plays alert chimes on demand. Three sounds, one per
// alert kind ('stop' cuts any of them early, e.g. the user opened the
// panel):
//   'request'  - service-bell "order's up" double ding: a new request
//                needs action (unchanged original chime)
//   'delivery' - single soft mid ding: a delivery notice arrived
//                (Yangaroo/Comcast manifest, first Tatari ER batch notice)
//                - informational, not urgent
//   'arrived'  - ascending A-major bell arpeggio: a WATCHED batch's files
//                finally landed after the "not yet available" wait -
//                resolution, not new work
let ac = null, nodes = [];

function stopAll() {
  nodes.forEach(n => { try { n.stop ? n.stop() : n.disconnect(); } catch (e) {} });
  nodes = [];
}

// The original service bell: inharmonic partials make it metal, hot gain
// (0.9) so it reads at normal system volume.
function ding(when) {
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(0.9, when + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 1.1);
  g.connect(ac.destination);
  [1, 2.76, 5.4, 8.9].forEach((r, i) => {
    const o = ac.createOscillator();
    o.type = 'sine';
    o.frequency.value = 1750 * r;
    const og = ac.createGain();
    og.gain.value = [0.5, 0.28, 0.14, 0.06][i];
    o.connect(og); og.connect(g);
    o.start(when); o.stop(when + 1.15);
    nodes.push(o, og);
  });
  nodes.push(g);
}

// Parameterized bell for the other sounds - same inharmonic-partials
// recipe so the family of sounds is coherent, pitched per note.
function bell(freq, when, peak) {
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(peak || 0.55, when + 0.007);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.95);
  g.connect(ac.destination);
  [1, 2.76, 5.4].forEach((r, i) => {
    const o = ac.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq * r;
    const og = ac.createGain();
    og.gain.value = [0.5, 0.24, 0.1][i];
    o.connect(og); og.connect(g);
    o.start(when); o.stop(when + 1);
    nodes.push(o, og);
  });
  nodes.push(g);
}

function ctx() {
  stopAll();
  ac = ac || new (self.AudioContext || self.webkitAudioContext)();
  if (ac.state === 'suspended') ac.resume();
  return ac.currentTime;
}

function chimeRequest() { const t = ctx(); ding(t); ding(t + 0.38); }
function chimeDelivery() { bell(1568, ctx(), 0.45); }
function chimeArrived() {
  const t = ctx();
  // A5 -> C#6 -> E6 -> A6: rising major arpeggio reads as "resolved".
  [880, 1108.7, 1318.5, 1760].forEach((f, i) => bell(f, t + i * 0.14, 0.5));
}

chrome.runtime.onMessage.addListener(msg => {
  if (!msg) return;
  const kind = msg.play === true ? 'request' : msg.play;
  if (kind === 'request') chimeRequest();
  else if (kind === 'delivery') chimeDelivery();
  else if (kind === 'arrived') chimeArrived();
  if (msg.stop) stopAll();
});

// Readiness ping: the service worker waits on this before sending the
// first 'play' - firing it right after createDocument raced past the
// listener registration and silently ate the sound.
chrome.runtime.sendMessage({ type: 'offscreen-ready' }).catch(() => {});

// MV3 service workers can't play audio - this offscreen document owns the
// AudioContext and plays the new-request siren on demand. A two-tone
// alternating square wave at high gain for ~6s, then silence; 'stop' cuts
// it early (e.g. the user opened the panel).
let ac = null, nodes = [];

function stopAll() {
  nodes.forEach(n => { try { n.stop ? n.stop() : n.disconnect(); } catch (e) {} });
  nodes = [];
}

function siren() {
  stopAll();
  ac = ac || new (self.AudioContext || self.webkitAudioContext)();
  if (ac.state === 'suspended') ac.resume();
  const g = ac.createGain();
  g.gain.value = 0.85;
  g.connect(ac.destination);
  const o = ac.createOscillator();
  o.type = 'square';
  const t0 = ac.currentTime;
  for (let t = 0; t < 6; t += 0.35)
    o.frequency.setValueAtTime((t / 0.35) % 2 ? 660 : 920, t0 + t);
  o.connect(g);
  o.start();
  o.stop(t0 + 6);
  nodes = [o, g];
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg && msg.play) siren();
  if (msg && msg.stop) stopAll();
});

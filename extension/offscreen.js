// MV3 service workers can't play audio - this offscreen document owns the
// AudioContext and plays the new-request chime on demand. The chime is a
// service-bell "order's up" double ding: inharmonic sine partials with a
// sharp attack, fast decay, hot gain (0.9 peak) so it reads at normal
// system volume, ~1.6s total. 'stop' cuts it early (e.g. the user opened
// the panel).
let ac = null, nodes = [];

function stopAll() {
  nodes.forEach(n => { try { n.stop ? n.stop() : n.disconnect(); } catch (e) {} });
  nodes = [];
}

function ding(when) {
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(0.9, when + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 1.1);
  g.connect(ac.destination);
  // Bell partials - inharmonic ratios make it metal, not a beep.
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

function chime() {
  stopAll();
  ac = ac || new (self.AudioContext || self.webkitAudioContext)();
  if (ac.state === 'suspended') ac.resume();
  const t0 = ac.currentTime;
  ding(t0);
  ding(t0 + 0.38);
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg && msg.play) chime();
  if (msg && msg.stop) stopAll();
});

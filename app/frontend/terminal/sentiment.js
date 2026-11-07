import { parseSentiment } from './sentiment-data.js';

export function mountSentiment(panel) {
  panel.innerHTML = `<div class="section-title"><h2>Fear &amp; Greed</h2><span class="sentiment-frequency">DAILY</span></div>
    <div class="sentiment-reading" aria-live="polite"><strong id="sentiment-score">—</strong><span id="sentiment-label">Loading sentiment…</span></div>
    <div class="sentiment-scale" role="meter" aria-label="Bitcoin Fear and Greed" aria-valuemin="0" aria-valuemax="100" hidden><i></i></div>
    <div class="sentiment-ends"><span>Extreme fear</span><span>Extreme greed</span></div>
    <p id="sentiment-date">Bitcoin sentiment · Updates daily</p>
    <a href="https://alternative.me/crypto/fear-and-greed-index/" target="_blank" rel="noopener noreferrer">Source: Alternative.me ↗</a>`;
  const score = panel.querySelector('#sentiment-score'), label = panel.querySelector('#sentiment-label');
  const scale = panel.querySelector('.sentiment-scale'), date = panel.querySelector('#sentiment-date');
  async function refresh() {
    try {
      const response = await fetch('https://api.alternative.me/fng/?limit=1', { credentials: 'omit', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Sentiment unavailable');
      const reading = parseSentiment(await response.json());
      score.textContent = String(reading.value);
      label.textContent = reading.label + (reading.stale ? ' · Outdated' : '');
      scale.hidden = false;
      scale.setAttribute('aria-valuenow', String(reading.value));
      scale.setAttribute('aria-valuetext', `${reading.value} out of 100: ${reading.label}${reading.stale ? ', outdated' : ''}`);
      scale.style.setProperty('--sentiment-position', `${reading.value}%`);
      date.textContent = `${new Date(reading.timestamp).toLocaleDateString(undefined, {month:'short',day:'numeric',year:'numeric'})} · Bitcoin sentiment${reading.stale ? ' · Over 48h old' : ''}`;
    } catch {
      score.textContent = '—';
      label.textContent = 'Temporarily unavailable';
      scale.hidden = true;
      scale.removeAttribute('aria-valuenow');
      date.textContent = 'Bitcoin sentiment · Updates daily';
    }
  }
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 15 * 60 * 1000);
}

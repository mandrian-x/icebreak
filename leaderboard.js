import { db, collection, onSnapshot } from './firebase.js';

const $ = id => document.getElementById(id);

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;'
}[char]));

$('fullscreen').onclick = async () => {
  try {
    await document.documentElement.requestFullscreen();
  } catch {}
};

function renderPodium(players) {
  const podium = $('podium');

  if (!players || players.length === 0) {
    podium.innerHTML = '<div class="podium-empty">No player scores yet.</div>';
    return;
  }

  const [first, second, third] = players.slice(0, 3);

  const podiumCard = (player, rank) => {
    if (!player) return '';

    const config = {
      1: { className: 'podium-first', medal: '🥇', label: '1ST PLACE' },
      2: { className: 'podium-second', medal: '🥈', label: '2ND PLACE' },
      3: { className: 'podium-third', medal: '🥉', label: '3RD PLACE' }
    }[rank];

    return `
      <article class="podium-player ${config.className}">
        <div class="podium-rank">${config.label}</div>
        <div class="podium-medal" aria-hidden="true">${config.medal}</div>
        <div class="podium-name">${esc(player.name || 'Unknown Player')}</div>
        <div class="podium-team">${esc(player.teamName || player.team || 'NO TEAM')}</div>
        <div class="podium-xp">${Number(player.xp || 0)} XP</div>
      </article>
    `;
  };

  // Deliberately render 2nd → 1st → 3rd so #1 sits in the center.
  podium.innerHTML = `
    ${podiumCard(second, 2)}
    ${podiumCard(first, 1)}
    ${podiumCard(third, 3)}
  `;
}

onSnapshot(
  collection(db, 'leaderboard'),
  snap => {
    const rows = snap.docs
      .map(d => ({ uid: d.id, ...d.data() }))
      .sort((a, b) =>
        Number(b.xp || 0) - Number(a.xp || 0) ||
        String(a.name || '').localeCompare(String(b.name || ''))
      );

    renderPodium(rows);

    const rest = rows.slice(3);
    $('board').innerHTML = rest.length
      ? rest.map((player, index) => `
          <div class="board-row">
            <span class="board-rank">#${index + 4}</span>
            <div><b>${esc(player.name || 'Unknown Player')}</b></div>
            <div>${esc(player.teamName || player.team || 'NO TEAM')}</div>
            <strong class="board-xp">${Number(player.xp || 0)} XP</strong>
          </div>
        `).join('')
      : '<div class="empty-state">No positions below the podium yet.</div>';
  },
  error => {
    $('podium').innerHTML = '<div class="podium-empty">Leaderboard unavailable.</div>';
    $('board').innerHTML = `<div class="empty-state">Leaderboard unavailable: ${esc(error.message || 'permission denied')}</div>`;
  }
);

import {
  auth,
  db,
  signOut,
  onAuthStateChanged,
  doc,
  getDoc,
  collection,
  onSnapshot,
  updateDoc,
  setDoc,
  serverTimestamp
} from './firebase.js';

const esc = value => String(value ?? '').replace(
  /[&<>"']/g,
  char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[char])
);

let player = null;
let inboxMessages = [];
let missions = [];
let completions = [];
let users = [];
let eventData = {};
let teamData = null;

// Multiple Firestore listeners call render() during startup. Cache the
// publication promise per mission/target so all listeners share one Firebase
// write and one short-code value instead of racing QR renders.
const missionCodePromises = new Map();
const missionStartPromises = new Map();
const missionStartTimes = new Map();
let renderedMissionKey = '';
let timerHandle = null;
let missionTimerExpired = false;
let missionRenderSequence = 0;

const $ = id => document.getElementById(id);

async function start(user) {

  const profile = await getDoc(doc(db, 'users', user.uid));

  if (!profile.exists() || profile.data().role !== 'player') {
    await signOut(auth);
    location.href = 'player-login.html';
    return;
  }

  player = {
    uid: user.uid,
    ...profile.data()
  };

  $('welcome').textContent =
    `WELCOME, ${player.name.split(' ')[0].toUpperCase()}.`;

  $('logout').onclick = async event => {
    event.preventDefault();
    await signOut(auth);
    location.href = 'index.html';
  };

  $('renameTeam').onclick = renameTeam;

  watchMissions();
  watchCompletions();
  watchUsers();
  watchSettings();
  watchTeam();
  watchInbox();
}

function watchInbox() {
  if (!player) return;

  onSnapshot(
    collection(db, 'inboxes', player.uid, 'messages'),
    snapshot => {
      inboxMessages = snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
        .sort((a, b) => {
          const at = a.createdAt?.toMillis?.() || 0;
          const bt = b.createdAt?.toMillis?.() || 0;
          return bt - at;
        });
      renderInbox();
    },
    error => console.error('Inbox listener failed:', error)
  );
}

function formatMessageTime(timestamp) {
  if (!timestamp?.toDate) return 'JUST NOW';
  try { return timestamp.toDate().toLocaleString(); } catch { return 'RECENTLY'; }
}

function renderInbox() {
  const container = $('inboxMessages');
  const count = $('inboxCount');
  if (!container) return;

  const unread = inboxMessages.filter(message => !message.read).length;
  if (count) {
    count.textContent = `${unread} NEW`;
    count.classList.toggle('hidden', unread === 0);
  }

  container.innerHTML = inboxMessages.length
    ? inboxMessages.map(message => `
        <article class="inbox-message ${message.read ? '' : 'unread'}" data-message-id="${esc(message.id)}">
          <div class="inbox-message-head">
            <h3 class="inbox-message-title">${esc(message.title || 'MESSAGE')}</h3>
            <span class="inbox-message-time">${esc(formatMessageTime(message.createdAt))}</span>
          </div>
          <p class="inbox-message-body">${esc(message.body || '')}</p>
          <div class="inbox-message-meta">FROM ${esc(message.senderName || 'ADMIN')}</div>
        </article>
      `).join('')
    : '<div class="empty-state">No messages yet.</div>';

  container.querySelectorAll('.inbox-message.unread').forEach(card => {
    card.addEventListener('click', async () => {
      const id = card.dataset.messageId;
      try {
        await updateDoc(doc(db, 'inboxes', player.uid, 'messages', id), {
          read: true,
          readAt: serverTimestamp()
        });
      } catch (error) {
        console.error('Could not mark message as read:', error);
      }
    }, { once: true });
  });
}

function watchMissions() {
  onSnapshot(collection(db, 'missions'), snapshot => {
    missions = snapshot.docs
      .map(item => ({
        id: item.id,
        ...item.data()
      }))
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    render();
  });
}

function watchCompletions() {
  onSnapshot(collection(db, 'completions'), snapshot => {
    completions = snapshot.docs.map(item => ({
      id: item.id,
      ...item.data()
    }));

    render();
  });
}

function watchUsers() {
  onSnapshot(collection(db, 'users'), snapshot => {
    users = snapshot.docs
      .map(item => ({
        uid: item.id,
        ...item.data()
      }))
      .filter(user => user.role === 'player');

    render();
  });
}

function watchTeam() {
  if (!player.teamId) {
    teamData = null;
    render();
    return;
  }

  onSnapshot(doc(db, 'teams', player.teamId), snapshot => {
    teamData = snapshot.exists()
      ? {
          id: snapshot.id,
          ...snapshot.data()
        }
      : null;

    render();
  });
}

function watchSettings() {
  onSnapshot(doc(db, 'settings', 'event'), snapshot => {
    eventData = snapshot.exists()
      ? snapshot.data()
      : { eventState: 'pre_event' };

    render();
  });
}

function isLiveEvent() {
  return eventData.eventState === 'live';
}

function completionForMission(missionId) {
  return completions.find(completion =>
    completion.missionId === missionId &&
    Array.isArray(completion.awardedPlayerIds) &&
    completion.awardedPlayerIds.includes(player.uid)
  );
}

function getCurrentMission() {
  if (!isLiveEvent()) {
    return null;
  }

  const active = missions
    .filter(mission => mission.status === 'active')
    .sort((a, b) => a.order - b.order);

  for (const mission of active) {
    if (!completionForMission(mission.id)) {
      return mission;
    }
  }

  return null;
}

function calculateXP(uid) {
  return completions.reduce((total, completion) => {
    if (!Array.isArray(completion.awardedPlayerIds)) {
      return total;
    }

    if (!completion.awardedPlayerIds.includes(uid)) {
      return total;
    }

    return total + Number(completion.xpAwarded || 0);
  }, 0);
}

function render() {
  if (!player) {
    return;
  }

  renderEventState();

  const xp = calculateXP(player.uid);
  const sorted = [...users]
    .map(user => ({
      ...user,
      calculatedXP: calculateXP(user.uid)
    }))
    .sort((a, b) => b.calculatedXP - a.calculatedXP);

  const rank = sorted.findIndex(user => user.uid === player.uid) + 1;
  const current = getCurrentMission();

  $('xp').textContent = xp;
  $('team').textContent = teamData
    ? `TEAM ${teamData.id}`
    : '—';
  $('rank').textContent = rank > 0 ? rank : '—';

  renderTeam();
  renderMission(current);
  renderProgress();
  renderBoard(sorted);
}

function renderTeam() {
  const panel = $('teamPanel');

  if (!player.teamId || !teamData) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');

  $('teamName').textContent =
    teamData.name || `Team ${teamData.id}`;

  const leader = users.find(user => user.uid === teamData.leaderId);

  $('teamLeader').textContent =
    leader?.name || 'Leader not assigned';

  const isLeader = teamData.leaderId === player.uid;
  const alreadyRenamed = teamData.nameChanged === true;

  $('leaderRename').classList.toggle(
    'hidden',
    !isLeader || alreadyRenamed
  );

  if (alreadyRenamed) {
    $('renameHelp').textContent =
      'Your team name has already been changed for this event.';
  } else if (isLeader) {
    $('renameHelp').textContent =
      'You are the team leader. You can rename your team once this event.';
  }
}

async function renameTeam() {
  if (!player.teamId || !teamData) {
    return;
  }

  if (teamData.leaderId !== player.uid) {
    alert('Only the team leader can rename the team.');
    return;
  }

  if (teamData.nameChanged === true) {
    alert('Your team name has already been changed this event.');
    return;
  }

  const name = $('newTeamName').value.trim();

  if (!name) {
    alert('Enter a team name.');
    return;
  }

  if (name.length > 32) {
    alert('Team names can be at most 32 characters.');
    return;
  }

  if (!confirm(`Rename your team to "${name}"? You can only do this once.`)) {
    return;
  }

  try {
    await updateDoc(doc(db, 'teams', player.teamId), {
      name,
      nameChanged: true
    });

    $('newTeamName').value = '';
  } catch (error) {
    console.error(error);

    alert(
      error?.code === 'permission-denied'
        ? 'Only the team leader can rename the team, and the rename can only be used once.'
        : (error.message || 'Could not rename the team.')
    );
  }
}

function renderEventState() {
  const live = isLiveEvent();
  const banner = $('eventBanner');

  banner.classList.toggle('live', live);

  $('eventBannerTitle').textContent = live
    ? 'LIVE EVENT'
    : 'PRE-EVENT';

  $('eventBannerText').textContent = live
    ? 'The event is live. Complete your current mission and show your QR to a volunteer when you finish.'
    : 'The event has not started yet. Your missions will appear when the admin starts the live event.';

}

function buildMissionCode(mission, targetType, targetId) {
  // Human-friendly, deterministic 10-character code. It contains no Firebase
  // UID or mission ID, so the code shown to the player stays short.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let hash = 2166136261;

  for (const char of `${mission.id}|${targetType}|${targetId}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }

  let code = '';
  for (let i = 0; i < 10; i += 1) {
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 2246822519);
    hash ^= hash >>> 16;
    code += alphabet[(hash >>> 0) % alphabet.length];
  }

  return code;
}

async function publishMissionCode(mission, targetType, targetId) {
  const code = buildMissionCode(mission, targetType, targetId);
  const cacheKey = `${mission.id}|${targetType}|${targetId}`;

  if (missionCodePromises.has(cacheKey)) {
    return missionCodePromises.get(cacheKey);
  }

  const promise = (async () => {
    const codeRef = doc(db, 'qrCodes', code);

    try {
      // setDoc() on an existing code is an UPDATE, not a CREATE. The
      // Firestore rules intentionally block arbitrary QR updates, so first
      // check whether this deterministic code is already published.
      const existingCode = await getDoc(codeRef);

      if (existingCode.exists()) {
        const data = existingCode.data();
        if (data.missionId === mission.id
          && data.targetType === targetType
          && data.targetId === targetId) {
          return code;
        }

        throw new Error('A mission-code collision was detected.');
      }

      await setDoc(codeRef, {
        code,
        missionId: mission.id,
        targetType,
        targetId,
        createdBy: player.uid,
        createdAt: serverTimestamp()
      });
    } catch (error) {
      console.error('Could not publish mission code:', error);

      if (error?.code === 'already-exists') {
        return code;
      }

      if (error?.code === 'permission-denied') {
        throw new Error(
          'Firebase rejected the mission QR. Deploy the current Firestore rules, then hard-refresh this page.'
        );
      }

      throw error;
    }

    return code;
  })();

  missionCodePromises.set(cacheKey, promise);

  try {
    return await promise;
  } catch (error) {
    missionCodePromises.delete(cacheKey);
    throw error;
  }
}


function finalizeQRRender(container) {
  const canvas = container.querySelector('canvas');
  const image = container.querySelector('img');
  const table = container.querySelector('table');

  // qrcodejs may create multiple renderer elements. Prefer the canvas.
  if (canvas) {
    if (image) image.remove();
    if (table) table.remove();

    canvas.style.display = 'block';
    canvas.style.width = '260px';
    canvas.style.height = '260px';
    canvas.style.imageRendering = 'pixelated';
    return;
  }

  if (image) {
    if (table) table.remove();

    image.style.display = 'block';
    image.style.width = '260px';
    image.style.height = '260px';
    image.style.imageRendering = 'pixelated';
    return;
  }

  if (table) {
    table.style.display = 'table';
    table.style.width = '260px';
    table.style.height = '260px';
    table.style.margin = '0';
  }
}


async function ensureMissionStart(mission) {
  if (!mission?.timeSensitive) {
    return null;
  }

  // Individual missions get a per-player start time.
  // Team missions get ONE shared start time for the whole team.
  // This prevents team members from having different countdowns.
  const targetType = mission.type === 'team' ? 'team' : 'player';
  const targetId = targetType === 'team' ? player.teamId : player.uid;

  if (!targetId) {
    throw new Error(
      targetType === 'team'
        ? 'You are not assigned to a team.'
        : 'Player account is unavailable.'
    );
  }

  const key = `${mission.id}_${targetType}_${targetId}`;

  if (missionStartTimes.has(key)) {
    return missionStartTimes.get(key);
  }

  if (missionStartPromises.has(key)) {
    return missionStartPromises.get(key);
  }

  const promise = (async () => {
    const ref = doc(db, 'missionStarts', key);

    // First try to use an existing shared/player start.
    const existing = await getDoc(ref);

    if (existing.exists() && existing.data().startedAt) {
      const millis = existing.data().startedAt.toMillis?.();

      if (Number.isFinite(millis)) {
        missionStartTimes.set(key, millis);
        return millis;
      }
    }

    try {
      await setDoc(ref, {
        missionId: mission.id,
        targetType,
        targetId,
        playerId: player.uid,
        startedAt: serverTimestamp()
      });
    } catch (error) {
      // For team missions another team member may have created the
      // shared start milliseconds before us. Re-read it instead of
      // treating that race as a timer failure.
      if (error?.code === 'permission-denied') {
        const raced = await getDoc(ref);

        if (raced.exists() && raced.data().startedAt) {
          const millis = raced.data().startedAt.toMillis?.();

          if (Number.isFinite(millis)) {
            missionStartTimes.set(key, millis);
            return millis;
          }
        }
      }

      throw error;
    }

    // serverTimestamp() is resolved by Firestore after the write.
    const saved = await getDoc(ref);
    const millis = saved.exists()
      ? saved.data().startedAt?.toMillis?.()
      : null;

    if (!Number.isFinite(millis)) {
      throw new Error('Mission start time was not saved.');
    }

    missionStartTimes.set(key, millis);
    return millis;
  })();

  missionStartPromises.set(key, promise);

  try {
    return await promise;
  } catch (error) {
    missionStartPromises.delete(key);
    throw error;
  }
}

function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [hours, minutes, seconds]
    .map(value => String(value).padStart(2, '0'))
    .join(':');
}

function stopMissionTimer() {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }

  missionTimerExpired = false;
  $('missionTimer').classList.add('hidden');
}

function startMissionTimer(startedAt, limitMinutes = 0) {
  stopMissionTimer();

  if (!startedAt) {
    return;
  }

  const limitMs = Math.max(0, Number(limitMinutes || 0)) * 60 * 1000;
  const timed = limitMs > 0;

  $('missionTimerLabel').textContent =
    timed ? 'TIME REMAINING' : 'MISSION TIME';

  const update = () => {
    const elapsed = Math.max(0, Date.now() - startedAt);
    const value = timed ? Math.max(0, limitMs - elapsed) : elapsed;

    $('missionTimerValue').textContent = formatElapsed(value);

    if (timed && value <= 0) {
      missionTimerExpired = true;
      $('missionTimerValue').classList.add('expired');
      $('progressMessage').textContent =
        'TIME EXPIRED — this mission can no longer be verified.';
    } else {
      missionTimerExpired = false;
      $('missionTimerValue').classList.remove('expired');
    }
  };

  $('missionTimer').classList.remove('hidden');
  update();
  timerHandle = setInterval(update, 1000);
}

async function renderMission(mission) {
  const renderId = ++missionRenderSequence;
  const qr = $('qr');
  const missionKey = mission
    ? `${mission.id}|${mission.type}|${player.teamId || ''}|${player.uid}`
    : 'none';

  // Every render owns the QR container. This prevents overlapping Firestore
  // listeners (especially when a player is assigned/removed as team leader)
  // from clearing or overwriting a newer QR render.
  if (missionKey !== renderedMissionKey) {
    qr.innerHTML = '';
    $('qrCodeValue').textContent = '';
    renderedMissionKey = missionKey;
  }

  if (!mission) {
    stopMissionTimer();
    const live = isLiveEvent();

    $('type').textContent = live
      ? 'ALL CURRENT MISSIONS COMPLETE'
      : 'EVENT NOT STARTED';

    $('missionNumber').textContent = live ? '✓' : '—';
    $('mission').textContent = live ? 'You are caught up.' : 'Get ready.';
    $('desc').textContent = live
      ? 'Wait for the admin to launch the next mission.'
      : 'The admin will start the live event when everyone is ready.';
    $('xpMission').textContent = '';
    $('qrTitle').textContent = 'NO ACTIVE QR';
    $('qrHelp').textContent =
      'There is no mission waiting for you right now.';
    $('qrCodeValue').textContent = '';
    $('notice').classList.add('hidden');
    $('progressMessage').textContent = '';
    return;
  }

  $('type').textContent = mission.type === 'team'
    ? 'TEAM MISSION'
    : 'INDIVIDUAL MISSION';
  $('missionNumber').textContent = String(mission.order).padStart(2, '0');
  $('mission').textContent = mission.title;
  $('desc').textContent = mission.description || '';
  $('xpMission').textContent = `+${mission.xp} XP`;
  $('qrCodeValue').textContent = '';

  // IMPORTANT: QR rendering is independent of team-leader status and timer
  // initialization. A player who becomes a team leader must still receive a
  // PLAYER QR for an individual mission.
  if (mission.type === 'team') {
    $('qrTitle').textContent = player.teamId
      ? `TEAM ${player.teamId} QR`
      : 'WAITING FOR TEAM';
    $('qrHelp').textContent = player.teamId
      ? 'Your team completes this mission together. Show the Team QR to a volunteer.'
      : 'The admin has not assigned you to a team yet.';

    $('notice').classList.remove('hidden');
    $('notice').innerHTML = player.teamId
      ? `<b>TEAM ${esc(player.teamId)}</b> — This is a team mission. Everyone waits until the team completes it.`
      : '<b>TEAM MISSION</b> — Wait for your team assignment.';

    if (player.teamId) {
      const code = buildMissionCode(mission, 'team', player.teamId);

      qr.innerHTML = '';
      new QRCode(qr, {
        text: code,
        width: 260,
        height: 260,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.H
      });
      finalizeQRRender(qr);
      $('qrCodeValue').textContent = code;

      publishMissionCode(mission, 'team', player.teamId)
        .catch(error => {
          console.error('Team QR publication failed:', error);
          $('qrHelp').textContent =
            'QR ready. The code is shown below and can be scanned now.';
          $('progressMessage').textContent =
            'QR is ready. Firebase synchronization is running in the background.';
        });
    } else {
      qr.innerHTML = '';
    }

    $('progressMessage').textContent =
      missionTimerExpired
        ? 'TIME EXPIRED — this mission can no longer be verified.'
        : 'This mission must be completed by your team before the next mission unlocks.';
  } else {
    // INDIVIDUAL MISSION: always use targetType=player, regardless of whether
    // this player is a team leader, team member, or unassigned.
    $('qrTitle').textContent = 'YOUR PLAYER QR';
    $('qrHelp').textContent =
      'Complete the challenge, then show this QR to a volunteer.';
    $('notice').classList.add('hidden');

    const code = buildMissionCode(mission, 'player', player.uid);

    qr.innerHTML = '';
    new QRCode(qr, {
      text: code,
      width: 260,
      height: 260,
      colorDark: '#000000',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.H
    });
    finalizeQRRender(qr);
    $('qrCodeValue').textContent = code;

    publishMissionCode(mission, 'player', player.uid)
      .catch(error => {
        console.error('Player QR publication failed:', error);
        $('qrHelp').textContent =
          'QR displayed. Firebase has not synchronized this code yet.';
        $('progressMessage').textContent =
          'Check your connection and make sure the current Firestore rules are deployed.';
      });

    $('progressMessage').textContent =
      missionTimerExpired
        ? 'TIME EXPIRED — this mission can no longer be verified.'
        : 'Complete this mission before the next one unlocks.';
  }

  // Timer setup happens AFTER the QR has been rendered. If Firebase is slow
  // or missionStarts is temporarily unavailable, the QR remains visible.
  if (mission.timeSensitive) {
    try {
      const startedAt = await ensureMissionStart(mission);

      // Ignore a late timer result belonging to an older render.
      if (renderId !== missionRenderSequence) return;

      startMissionTimer(startedAt, mission.timeLimitMinutes);
      $('progressMessage').textContent = missionTimerExpired
        ? 'TIME EXPIRED — this mission can no longer be verified.'
        : mission.type === 'team'
          ? 'This mission must be completed by your team before the next mission unlocks.'
          : 'Complete this mission before the next one unlocks.';
    } catch (error) {
      console.error('Could not start mission timer:', error);

      if (renderId !== missionRenderSequence) return;

      stopMissionTimer();
      $('progressMessage').textContent =
        error?.message || 'Mission timer could not be started. Please reload the page.';
    }
  } else if (renderId === missionRenderSequence) {
    stopMissionTimer();
  }
}

function renderProgress() {
  if (!missions.length) {
    $('missionProgress').innerHTML =
      '<div class="empty-state">No missions have been created yet.</div>';
    return;
  }

  const current = getCurrentMission();

  $('missionProgress').innerHTML = missions.map(mission => {
    const completion = completionForMission(mission.id);
    const ended = mission.status === 'ended';
    const complete = !!completion;
    const isCurrent = current?.id === mission.id;

    let state = 'LOCKED';

    if (complete) {
      state = '✓ COMPLETED';
    } else if (ended) {
      state = 'SKIPPED · 0 XP';
    } else if (isCurrent) {
      state = 'CURRENT';
    } else if (mission.status === 'active') {
      // Do not reveal the title, type, description, or XP of a future
      // mission. The player only knows which mission number is available.
      return `
        <div class="progress-row mission-hidden">
          <span class="progress-number">
            ${String(mission.order).padStart(2, '0')}
          </span>
          <div>
            <b>MISSION ${String(mission.order).padStart(2, '0')}</b>
            <small>AVAILABLE</small>
          </div>
          <strong>AVAILABLE</strong>
        </div>
      `;
    }

    return `
      <div class="progress-row">
        <span class="progress-number">
          ${String(mission.order).padStart(2, '0')}
        </span>
        <div>
          <b>${esc(mission.title)}</b>
          <small>
            ${mission.type === 'team' ? 'TEAM' : 'INDIVIDUAL'} · ${mission.xp} XP
          </small>
        </div>
        <strong>${state}</strong>
      </div>
    `;
  }).join('');
}

function renderBoard(sorted) {
  $('board').innerHTML = sorted.map((user, index) => `
    <div class="row">
      <span>#${index + 1}</span>
      <b>${esc(user.name)}</b>
      <span>${user.teamId ? `TEAM ${esc(user.teamId)}` : '—'}</span>
      <strong>${user.calculatedXP} XP</strong>
    </div>
  `).join('');
}


onAuthStateChanged(auth, user => {
  if (!user) {
    location.href = 'player-login.html';
    return;
  }

  start(user);
});

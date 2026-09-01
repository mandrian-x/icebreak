import {
  auth,
  db,
  signOut,
  onAuthStateChanged,
  doc,
  getDoc,
  updateDoc,
  collection,
  getDocs,
  query,
  where,
  onSnapshot,
  setDoc,
  serverTimestamp,
  writeBatch
} from './firebase.js';

let volunteer = null;
let inboxMessages = [];
let selected = null;
let scanner = null;
let completions = [];
let players = [];
let eventData = {};

const $ = id => document.getElementById(id);

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

async function start(user) {

  const profile = await getDoc(doc(db, 'users', user.uid));

  if (!profile.exists() || profile.data().role !== 'volunteer') {
    await signOut(auth);
    location.href = 'volunteer-login.html';
    return;
  }

  volunteer = {
    uid: user.uid,
    ...profile.data()
  };

  $('logout').onclick = async event => {
    event.preventDefault();
    await signOut(auth);
    location.href = 'index.html';
  };

  $('scan').onclick = startScanner;
  $('verify').onclick = verify;
  $('submitMissionCode').onclick = submitMissionCode;
  $('missionCode').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      submitMissionCode();
    }
  });

  $('qrImage').addEventListener('change', event => {
    const file = event.target.files?.[0];

    if (file) {
      scanImageFile(file);
    }

    event.target.value = '';
  });

  watchPlayers();
  watchCompletions();
  watchSettings();
  watchInbox();
}

function watchInbox() {
  if (!volunteer) return;

  onSnapshot(
    collection(db, 'inboxes', volunteer.uid, 'messages'),
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
        await updateDoc(doc(db, 'inboxes', volunteer.uid, 'messages', id), {
          read: true,
          readAt: serverTimestamp()
        });
      } catch (error) {
        console.error('Could not mark message as read:', error);
      }
    }, { once: true });
  });
}

function watchPlayers() {
  onSnapshot(
    query(collection(db, 'users'), where('role', '==', 'player')),
    snapshot => {
      players = snapshot.docs.map(item => ({
        uid: item.id,
        ...item.data()
      }));

      renderBoard();
    }
  );
}

function watchCompletions() {
  onSnapshot(collection(db, 'completions'), snapshot => {
    completions = snapshot.docs.map(item => ({
      id: item.id,
      ...item.data()
    }));

    renderBoard();
  });
}

function watchSettings() {
  onSnapshot(doc(db, 'settings', 'event'), snapshot => {
    eventData = snapshot.exists()
      ? snapshot.data()
      : { eventState: 'pre_event' };

    renderEventState();
  });
}

function isLiveEvent() {
  return eventData.eventState === 'live';
}

function renderEventState() {
  const live = isLiveEvent();

  $('eventBanner').classList.toggle('live', live);

  $('eventBannerTitle').textContent = live
    ? 'LIVE EVENT'
    : 'PRE-EVENT';

  $('eventBannerText').textContent = live
    ? 'The event is live. Scan a player or team QR to verify the current mission.'
    : 'The event has not started yet. The scanner will activate when the admin starts the live event.';

  $('scan').disabled = !live;
  $('submitMissionCode').disabled = !live;
  $('missionCode').disabled = !live;
  $('scan').textContent = live
    ? 'OPEN CAMERA SCANNER'
    : 'SCANNER LOCKED — PRE-EVENT';
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

function renderBoard() {
  const sorted = players
    .map(player => ({
      ...player,
      calculatedXP: calculateXP(player.uid)
    }))
    .sort((a, b) => {
      if (b.calculatedXP !== a.calculatedXP) {
        return b.calculatedXP - a.calculatedXP;
      }

      return String(a.name || '').localeCompare(
        String(b.name || '')
      );
    });

  $('board').innerHTML = sorted.length
    ? sorted.map((player, index) => `
        <div class="row leaderboard-row ${index < 3 ? 'top-position' : ''}">
          <span>#${index + 1}</span>
          <b>${esc(player.name)}</b>
          <span>${player.teamId ? `TEAM ${esc(player.teamId)}` : '—'}</span>
          <strong>${player.calculatedXP} XP</strong>
        </div>
      `).join('')
    : '<div class="empty-state">No players have registered yet.</div>';
}


async function syncPublicLeaderboard() {
  try {
    const [playerSnapshot, completionSnapshot, teamSnapshot] = await Promise.all([
      getDocs(query(collection(db, 'users'), where('role', '==', 'player'))),
      getDocs(collection(db, 'completions')),
      getDocs(collection(db, 'teams'))
    ]);

    const completionRows = completionSnapshot.docs.map(item => item.data());
    const teamsById = Object.fromEntries(
      teamSnapshot.docs.map(item => [item.id, { id: item.id, ...item.data() }])
    );

    const rows = playerSnapshot.docs.map(item => {
      const player = { uid: item.id, ...item.data() };
      const team = player.teamId ? teamsById[player.teamId] : null;

      const xp = completionRows.reduce((total, completion) => {
        if (!Array.isArray(completion.awardedPlayerIds)) return total;
        return completion.awardedPlayerIds.includes(player.uid)
          ? total + Number(completion.xpAwarded || 0)
          : total;
      }, 0);

      return {
        uid: player.uid,
        name: player.name || 'Player',
        teamId: player.teamId || '',
        teamName: team?.name || (player.teamId ? `TEAM ${player.teamId}` : 'NO TEAM'),
        xp
      };
    }).sort((a, b) => b.xp - a.xp || a.name.localeCompare(b.name));

    const batch = writeBatch(db);
    rows.forEach((row, index) => {
      batch.set(doc(db, 'leaderboard', row.uid), {
        ...row,
        rank: index + 1,
        updatedAt: serverTimestamp()
      }, { merge: true });
    });

    await batch.commit();
  } catch (error) {
    console.error('Public leaderboard sync failed:', error);
    // Verification has already succeeded; leaderboard sync failure should
    // never make a valid XP award look like a failed verification.
  }
}

async function stopScanner() {
  if (!scanner) {
    return;
  }

  try {
    if (scanner.isScanning) {
      await scanner.stop();
    }
  } catch (error) {
    console.warn('Scanner stop warning:', error);
  }

  try {
    await scanner.clear();
  } catch (error) {
    console.warn('Scanner clear warning:', error);
  }

  scanner = null;
}

function setScannerStatus(message, type = '') {
  const element = $('scannerStatus');

  element.textContent = message;
  element.className = `scanner-status ${type}`.trim();
}

async function startScanner() {
  if (!isLiveEvent()) {
    alert('The event is still in PRE-EVENT mode.');
    return;
  }

  await stopScanner();

  selected = null;
  $('result').classList.add('hidden');
  $('verify').classList.add('hidden');

  if (!window.Html5Qrcode) {
    setScannerStatus(
      'QR scanner library did not load. Check your internet connection.',
      'error'
    );
    return;
  }

  scanner = new Html5Qrcode('reader');

  setScannerStatus(
    'Starting camera… allow camera permission if your browser asks.',
    'working'
  );

  const config = {
    fps: 15,
    qrbox: {
      width: 280,
      height: 280
    },
    aspectRatio: 1,
    disableFlip: false,
    formatsToSupport: [
      Html5QrcodeSupportedFormats.QR_CODE
    ]
  };

  try {
    await scanner.start(
      {
        facingMode: {
          exact: 'environment'
        }
      },
      config,
      async decodedText => {
        setScannerStatus('QR detected. Reading…', 'success');

        await stopScanner();
        await handleQR(decodedText);
      },
      () => {
        // html5-qrcode calls this repeatedly while looking for a QR.
        // Do not show an error for every unsuccessful camera frame.
      }
    );

    setScannerStatus(
      'Scanning… hold the Player or Team QR inside the square.',
      'working'
    );
  } catch (firstError) {
    console.warn('Environment camera failed:', firstError);

    // Some phones do not accept the exact environment-facing constraint.
    // Retry with the simpler facingMode form.
    try {
      await stopScanner();

      scanner = new Html5Qrcode('reader');

      await scanner.start(
        { facingMode: 'environment' },
        config,
        async decodedText => {
          setScannerStatus('QR detected. Reading…', 'success');

          await stopScanner();
          await handleQR(decodedText);
        },
        () => {}
      );

      setScannerStatus(
        'Scanning… hold the Player or Team QR inside the square.',
        'working'
      );
    } catch (secondError) {
      console.error('QR scanner failed:', secondError);

      await stopScanner();

      setScannerStatus(
        'Camera could not start. Make sure camera permission is allowed and the site is HTTPS.',
        'error'
      );

      alert(
        'Could not start the camera scanner.\n\n' +
        'Check that camera permission is allowed for this site and that you are using HTTPS.'
      );
    }
  }
}

async function scanImageFile(file) {
  if (!file) {
    return;
  }

  if (!window.Html5Qrcode) {
    setScannerStatus(
      'QR scanner library did not load.',
      'error'
    );
    return;
  }

  await stopScanner();

  const imageScanner = new Html5Qrcode('reader');

  setScannerStatus('Reading QR image…', 'working');

  try {
    const decodedText = await imageScanner.scanFile(file, true);

    setScannerStatus(
      'QR image detected. Reading…',
      'success'
    );

    await imageScanner.clear();
    await handleQR(decodedText);
  } catch (error) {
    console.error('QR image scan failed:', error);

    try {
      await imageScanner.clear();
    } catch (_) {
      // Nothing to clear.
    }

    setScannerStatus(
      'No readable QR was found in that image.',
      'error'
    );
  }
}

async function submitMissionCode() {
  if (!isLiveEvent()) {
    alert('The event is not live.');
    return;
  }

  const input = $('missionCode');
  const code = input.value.trim().toUpperCase();

  if (!/^[A-HJ-NP-Z2-9]{10}$/.test(code)) {
    alert('Enter the 10-character mission code shown below the QR.');
    input.focus();
    return;
  }

  try {
    setScannerStatus('Looking up mission code…', 'working');

    const snapshot = await getDoc(doc(db, 'qrCodes', code));

    if (!snapshot.exists()) {
      setScannerStatus('Mission code not found.', 'error');
      alert('Invalid or expired mission code.');
      return;
    }

    await handleQR(code);
  } catch (error) {
    console.error('Mission code lookup failed:', error);
    setScannerStatus('Could not look up the mission code.', 'error');
    alert(error.message || 'Could not verify the mission code.');
  }
}

async function handleQR(text) {
  const decoded = String(text || '').trim().toUpperCase();
  console.log('ICEBREAK code decoded:', decoded);

  let missionId;
  let targetType;
  let targetId;

  // Current QR format: the QR contains ONLY the short 10-character code.
  // Resolve that code server-side through qrCodes/{code}; the Firebase IDs
  // never need to be exposed to the QR/scanner.
  if (/^[A-HJ-NP-Z2-9]{10}$/.test(decoded)) {
    const codeSnapshot = await getDoc(doc(db, 'qrCodes', decoded));

    if (!codeSnapshot.exists()) {
      alert('Invalid or expired ICEBREAK code.');
      return;
    }

    const codeData = codeSnapshot.data();
    missionId = codeData.missionId;
    targetType = codeData.targetType;
    targetId = codeData.targetId;
  } else {
    // Backward compatibility for old QR codes already issued before the
    // short-code format.
    const parts2 = String(text || '').trim().split('|');

    if (
      parts2.length === 5 &&
      parts2[0] === 'ICEBREAK' &&
      parts2[1] === 'M' &&
      ['P', 'T'].includes(parts2[3])
    ) {
      missionId = parts2[2];
      targetType = parts2[3] === 'T' ? 'team' : 'player';
      targetId = parts2[4];
    } else {
      alert('Invalid QR.');
      return;
    }
  }

  if (!missionId || !targetId || !['player', 'team'].includes(targetType)) {
    alert('Invalid ICEBREAK code.');
    return;
  }

  const missionSnapshot = await getDoc(doc(db, 'missions', missionId));

  if (!missionSnapshot.exists()) {
    alert('This mission no longer exists.');
    return;
  }

  const mission = {
    id: missionSnapshot.id,
    ...missionSnapshot.data()
  };

  if (mission.status !== 'active') {
    alert('This mission is not currently active.');
    return;
  }

  // Admin stores an individual mission as `individual`, while QR/completion
  // targets use the canonical `player` name.
  const missionTargetType =
    mission.type === 'individual' ? 'player' : mission.type;

  if (missionTargetType !== targetType) {
    alert('This QR does not match the mission type.');
    return;
  }

  const completionId = `${missionId}_${targetType}_${targetId}`;

  if (
    targetType === 'player'
    && mission.timeSensitive
    && Number(mission.timeLimitMinutes || 0) > 0
  ) {
    const startSnapshot = await getDoc(
      doc(db, 'missionStarts', `${mission.id}_player_${targetId}`)
    );

    if (!startSnapshot.exists() || !startSnapshot.data().startedAt) {
      alert('This player has not started the timed mission yet.');
      return;
    }

    const startedAt = startSnapshot.data().startedAt.toMillis?.();

    if (
      Number.isFinite(startedAt)
      && Date.now() > startedAt + Number(mission.timeLimitMinutes) * 60 * 1000
    ) {
      alert('The time limit for this mission has expired.');
      return;
    }
  }

  const existing = await getDoc(doc(db, 'completions', completionId));

  if (existing.exists()) {
    alert('This mission has already been verified for this target.');
    return;
  }

  let awardedPlayerIds = [];
  let display = '';

  if (targetType === 'player') {
    const playerSnapshot = await getDoc(doc(db, 'users', targetId));

    if (!playerSnapshot.exists() || playerSnapshot.data().role !== 'player') {
      alert('Unknown player.');
      return;
    }

    awardedPlayerIds = [targetId];
    display = `
      <b>${esc(playerSnapshot.data().name)}</b><br>
      ${esc(playerSnapshot.data().email)}<br>
      Mission ${mission.order}: ${esc(mission.title)}<br>
      <strong>+${mission.xp} XP</strong>
    `;
  } else {
    const teamSnapshot = await getDoc(doc(db, 'teams', targetId));

    if (!teamSnapshot.exists()) {
      alert('Unknown team.');
      return;
    }

    awardedPlayerIds = teamSnapshot.data().memberIds || [];

    if (!awardedPlayerIds.length) {
      alert('This team has no members.');
      return;
    }

    display = `
      <b>TEAM ${esc(targetId)}</b><br>
      ${awardedPlayerIds.length} members<br>
      Mission ${mission.order}: ${esc(mission.title)}<br>
      <strong>+${mission.xp} XP EACH</strong>
    `;
  }

  selected = {
    completionId,
    mission,
    targetType,
    targetId,
    awardedPlayerIds
  };

  $('result').classList.remove('hidden');
  $('verify').classList.remove('hidden');
  $('result').innerHTML = display;
}

async function verify() {
  if (!isLiveEvent()) {
    alert('The event is no longer live.');
    return;
  }

  if (!selected || !volunteer) {
    return;
  }

  try {
    await setDoc(
      doc(db, 'completions', selected.completionId),
      {
        missionId: selected.mission.id,
        missionOrder: selected.mission.order,
        targetType: selected.targetType,
        targetId: selected.targetId,
        awardedPlayerIds: selected.awardedPlayerIds,
        xpAwarded: Number(selected.mission.xp),
        verifiedBy: volunteer.uid,
        verifiedAt: serverTimestamp()
      }
    );

    await syncPublicLeaderboard();

    alert('Marked successful. XP awarded.');

    selected = null;
    $('result').classList.add('hidden');
    $('verify').classList.add('hidden');
  } catch (error) {
    console.error('ICEBREAK mission verification failed:', error);
    alert(
      error?.code
        ? `${error.code}: ${error.message || 'Could not award XP.'}`
        : (error.message || 'Could not award XP.')
    );
  }
}


onAuthStateChanged(auth, user => {
  if (!user) {
    location.href = 'volunteer-login.html';
    return;
  }

  start(user);
});

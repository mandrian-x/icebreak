import {
  auth,
  db,
  signOut,
  onAuthStateChanged,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  getDocs,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  writeBatch,
  EmailAuthProvider,
  reauthenticateWithCredential
} from './firebase.js';

const ADMIN_EMAILS = [
  'srdevanarayanan8@gmail.com',
  'iedc@jcmcsiit.ac.in'
];

let admin = null;
let eventData = {};
let players = [];
let missions = [];
let completions = [];
let teams = [];
let teamsById = {};
let volunteers = [];
let allUsers = [];
let inboxMessages = [];
let leaderboardSyncKey = "";
let leaderboardSyncRunning = false;
let leaderboardSyncQueued = false;

const $ = id => document.getElementById(id);

function membershipPatternToRegex(format) {
  let pattern = '';

  for (const char of String(format || '')) {
    if (char === '#') {
      pattern += '[0-9]';
    } else if (char === '^') {
      pattern += '[A-Z]';
    } else if (char === '$') {
      pattern += '[a-z]';
    } else if (char === '*') {
      pattern += '.';
    } else {
      pattern += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }

  return `^${pattern}$`;
}

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
  const status = $('liveDataStatus');

  try {
    const email = (user.email || '').trim().toLowerCase();

    if (!ADMIN_EMAILS.includes(email)) {
      await signOut(auth);
      location.href = 'admin-login.html';
      return;
    }

    status.textContent = 'Authenticated — connecting to Firebase data…';

    const profileRef = doc(db, 'users', user.uid);
    const profile = await getDoc(profileRef);

    if (!profile.exists()) {
      await setDoc(profileRef, {
        uid: user.uid,
        name: 'ICEBREAK Admin',
        email,
        role: 'admin',
        xp: 0,
        teamId: '',
        isLeader: false,
        createdAt: serverTimestamp()
      });
    }

    admin = {
      uid: user.uid,
      email
    };

    // Verify Firestore access before opening the live listeners.
    // This turns silent/empty dashboards into an explicit Firebase error.
    await getDoc(doc(db, 'settings', 'event'));

    $('logout').onclick = async event => {
      event.preventDefault();
      await signOut(auth);
      location.href = 'index.html';
    };

    $('createMission').onclick = createMission;
    $('mtime').onchange = renderTimeLimitField;
    $('assign').onclick = assignTeams;
    $('saveSettings').onclick = saveSettings;
    $('deleteAll').onclick = deleteAll;
    $('eventToggle').onclick = toggleEventState;
    $('grantAll').onclick = () => bulkGrantXP('all');
    $('grantAllExceptPlayer').onclick = () => bulkGrantXP('exceptPlayer');
    $('grantAllExceptTeam').onclick = () => bulkGrantXP('exceptTeam');
    $('messageAudience').onchange = renderMessageRecipientOptions;
    $('sendMessage').onclick = sendAdminMessage;

    watchPlayers();
    watchVolunteers();
    watchAllUsers();
    watchInbox();
    watchTeams();
    watchMissions();
    watchCompletions();
    watchSettings();

    status.textContent = 'Connected — live Firebase data is synchronizing…';
  } catch (error) {
    console.error('Admin Firebase bootstrap failed:', error);
    status.textContent =
      `FIREBASE CONNECTION ERROR: ${error.code || error.message || 'unknown error'}`;
  }
}

function watchPlayers() {
  onSnapshot(
    collection(db, 'users'),
    snapshot => {
      players = snapshot.docs
        .map(item => ({ uid: item.id, ...item.data() }))
        .filter(player => player.role === 'player');

      renderPlayers();
      renderTeams();
      renderBulkAwardControls();
      syncPublicLeaderboard();
    },
    error => {
      console.error('Players listener failed:', error);
      $('liveDataStatus').textContent =
        `MEMBER DATA ERROR: ${error.message || error.code || 'unknown error'}`;
    }
  );
}

function watchAllUsers() {
  onSnapshot(
    collection(db, 'users'),
    snapshot => {
      allUsers = snapshot.docs.map(item => ({ uid: item.id, ...item.data() }));
      renderMessageRecipientOptions();
    },
    error => {
      console.error('Message recipient listener failed:', error);
    }
  );
}

function watchInbox() {
  if (!admin) return;

  onSnapshot(
    collection(db, 'inboxes', admin.uid, 'messages'),
    snapshot => {
      inboxMessages = snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
        .sort((a, b) => {
          const at = a.createdAt?.toMillis?.() || 0;
          const bt = b.createdAt?.toMillis?.() || 0;
          return bt - at;
        });
      renderInbox();
    },
    error => console.error('Admin inbox listener failed:', error)
  );
}

function watchVolunteers() {
  onSnapshot(
    query(collection(db, 'users'), where('role', '==', 'volunteer')),
    snapshot => {
      volunteers = snapshot.docs
        .map(item => ({ uid: item.id, ...item.data() }))
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

      renderVolunteers();
    },
    error => {
      console.error('Volunteers listener failed:', error);
      $('liveDataStatus').textContent =
        `VOLUNTEER DATA ERROR: ${error.message || error.code || 'unknown error'}`;
    }
  );
}

function renderMessageRecipientOptions() {
  const audience = $('messageAudience')?.value;
  const wrap = $('messageRecipientWrap');
  const select = $('messageRecipient');
  if (!wrap || !select) return;

  let candidates = [];
  let label = 'SELECT RECIPIENT';

  if (audience === 'one_player') {
    candidates = allUsers.filter(user => user.role === 'player');
    label = 'SELECT PLAYER';
  } else if (audience === 'one_volunteer') {
    candidates = allUsers.filter(user => user.role === 'volunteer');
    label = 'SELECT VOLUNTEER';
  } else if (audience === 'other_admin') {
    candidates = allUsers.filter(user => user.role === 'admin' && user.uid !== admin?.uid);
    label = 'SELECT ADMIN';
  }

  if (!candidates.length && ['one_player', 'one_volunteer', 'other_admin'].includes(audience)) {
    wrap.classList.remove('hidden');
    select.innerHTML = `<option value="">NO RECIPIENT AVAILABLE</option>`;
    return;
  }

  if (!['one_player', 'one_volunteer', 'other_admin'].includes(audience)) {
    wrap.classList.add('hidden');
    select.innerHTML = '';
    return;
  }

  candidates.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  wrap.classList.remove('hidden');
  select.innerHTML = `
    <option value="">${label}</option>
    ${candidates.map(user => `<option value="${esc(user.uid)}">${esc(user.name || user.email || user.uid)}${user.email ? ` — ${esc(user.email)}` : ''}</option>`).join('')}
  `;
}

async function sendAdminMessage() {
  const audience = $('messageAudience').value;
  const title = $('messageTitle').value.trim();
  const body = $('messageBody').value.trim();
  const status = $('messageStatus');

  if (!title || !body) {
    alert('Please enter both a message title and message body.');
    return;
  }

  let recipients = [];

  if (audience === 'all_players') {
    recipients = allUsers.filter(user => user.role === 'player');
  } else if (audience === 'all_volunteers') {
    recipients = allUsers.filter(user => user.role === 'volunteer');
  } else if (audience === 'everyone') {
    recipients = [...allUsers];
  } else {
    const uid = $('messageRecipient').value;
    if (!uid) {
      alert('Select a recipient first.');
      return;
    }
    recipients = allUsers.filter(user => user.uid === uid);
  }

  // Do not send an "other admin" message back to the sending admin.
  if (audience === 'other_admin') {
    recipients = recipients.filter(user => user.role === 'admin' && user.uid !== admin.uid);
  }

  if (!recipients.length) {
    alert('No matching recipients are currently registered.');
    return;
  }

  const sendButton = $('sendMessage');
  sendButton.disabled = true;
  status.textContent = `Sending to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}…`;

  try {
    const batch = writeBatch(db);
    const messageId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`;

    recipients.forEach(recipient => {
      const ref = doc(db, 'inboxes', recipient.uid, 'messages', messageId);
      batch.set(ref, {
        messageId,
        senderId: admin.uid,
        senderName: 'ICEBREAK Admin',
        recipientId: recipient.uid,
        audience,
        title,
        body,
        read: false,
        createdAt: serverTimestamp()
      });
    });

    await batch.commit();
    $('messageTitle').value = '';
    $('messageBody').value = '';
    status.textContent = `Delivered to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}.`;
  } catch (error) {
    console.error('Message send failed:', error);
    status.textContent = `SEND FAILED: ${error.message || error.code || 'unknown error'}`;
    alert(error.message || 'Could not send the message.');
  } finally {
    sendButton.disabled = false;
  }
}

function formatMessageTime(timestamp) {
  if (!timestamp?.toDate) return 'JUST NOW';
  try {
    return timestamp.toDate().toLocaleString();
  } catch {
    return 'RECENTLY';
  }
}

function renderInbox() {
  const container = $('inboxMessages');
  if (!container) return;

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
        await updateDoc(doc(db, 'inboxes', admin.uid, 'messages', id), {
          read: true,
          readAt: serverTimestamp()
        });
      } catch (error) {
        console.error('Could not mark admin message as read:', error);
      }
    }, { once: true });
  });
}

function watchTeams() {
  onSnapshot(
    collection(db, 'teams'),
    snapshot => {
      teams = snapshot.docs.map(item => ({
        id: item.id,
        ...item.data()
      }));

      teamsById = Object.fromEntries(
        teams.map(team => [team.id, team])
      );

      renderTeams();
      renderPlayers();
      renderBulkAwardControls();
      syncPublicLeaderboard();
    },
    error => {
      console.error('Teams listener failed:', error);
      $('liveDataStatus').textContent =
        `TEAM DATA ERROR: ${error.message || error.code || 'unknown error'}`;
    }
  );
}

function watchMissions() {
  onSnapshot(
    collection(db, 'missions'),
    snapshot => {
      missions = snapshot.docs
        .map(item => ({
          id: item.id,
          ...item.data()
        }))
        .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));

      renderMissions();
      renderBulkAwardControls();
    },
    error => {
      console.error('Mission listener failed:', error);
      $('liveDataStatus').textContent =
        `TASK DATA ERROR: ${error.message || error.code || 'unknown error'}`;
    }
  );
}

function watchCompletions() {
  onSnapshot(
    collection(db, 'completions'),
    snapshot => {
      completions = snapshot.docs.map(item => ({
        id: item.id,
        ...item.data()
      }));

      renderPlayers();
      syncPublicLeaderboard();
    },
    error => {
      console.error('Completion listener failed:', error);
      $('liveDataStatus').textContent =
        `COMPLETION DATA ERROR: ${error.message || error.code || 'unknown error'}`;
    }
  );
}


async function syncPublicLeaderboard() {
  if (!admin) return;

  if (leaderboardSyncRunning) {
    leaderboardSyncQueued = true;
    return;
  }

  const rows = players.map(player => {
    const team = player.teamId ? teamsById[player.teamId] : null;
    return {
      uid: player.uid,
      name: player.name || 'Player',
      teamId: player.teamId || '',
      teamName: team?.name || (player.teamId ? `TEAM ${player.teamId}` : 'NO TEAM'),
      xp: calculateXP(player.uid)
    };
  }).sort((a, b) => b.xp - a.xp || a.name.localeCompare(b.name));

  const key = JSON.stringify(rows);
  if (key == leaderboardSyncKey) return;
  leaderboardSyncRunning = true;

  try {
    const existing = await getDocs(collection(db, 'leaderboard'));
    const batch = writeBatch(db);
    const wanted = new Set(rows.map(row => row.uid));

    existing.docs.forEach(item => {
      if (!wanted.has(item.id)) batch.delete(item.ref);
    });

    rows.forEach((row, index) => {
      batch.set(doc(db, 'leaderboard', row.uid), {
        ...row,
        rank: index + 1,
        updatedAt: serverTimestamp()
      }, { merge: true });
    });

    await batch.commit();
    leaderboardSyncKey = key;
  } catch (error) {
    console.error('Public leaderboard sync failed:', error);
  } finally {
    leaderboardSyncRunning = false;

    if (leaderboardSyncQueued) {
      leaderboardSyncQueued = false;
      queueMicrotask(() => syncPublicLeaderboard());
    }
  }
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

function watchSettings() {
  onSnapshot(doc(db, 'settings', 'event'), snapshot => {
    eventData = snapshot.exists()
      ? snapshot.data()
      : {
          eventState: 'pre_event',
        membershipIdPattern: 'IEDCJIT2026###',
        membershipIdRegex: '^IEDCJIT2026[0-9]{3}$'
        };

    $('reqReg').checked = !!eventData.requireRegistrationId;
    $('regPattern').value =
      eventData.registrationIdPattern || 'IEDCJIT2026###';
    $('membershipPattern').value =
      eventData.membershipIdPattern || 'IEDCJIT2026###';

    renderTimeLimitField();
    renderEventState();
  }, error => {
    console.error('Settings listener failed:', error);
    $('liveDataStatus').textContent =
      `SETTINGS DATA ERROR: ${error.message || error.code || 'unknown error'}`;
  });
}

function renderEventState() {
  const live = eventData.eventState === 'live';

  $('eventStateTitle').textContent = live
    ? 'LIVE EVENT'
    : 'PRE-EVENT';

  $('eventStateTitle').classList.toggle('event-live', live);

  $('eventStateHelp').textContent = live
    ? 'The game is live. Players can receive missions and volunteers can verify completions.'
    : 'Players can register and admins can prepare the event. Missions are not playable yet.';

  $('eventToggle').textContent = live
    ? 'RETURN TO PRE-EVENT'
    : 'START LIVE EVENT →';

  $('eventToggle').classList.toggle('live', live);
}

async function toggleEventState() {
  const live = eventData.eventState === 'live';

  if (!live) {
    const confirmed = confirm(
      'Start the live event? Players will immediately be able to receive active missions.'
    );

    if (!confirmed) {
      return;
    }
  } else {
    const confirmed = confirm(
      'Return to PRE-EVENT? Players and volunteers will temporarily be unable to play or verify missions.'
    );

    if (!confirmed) {
      return;
    }
  }

  await setDoc(
    doc(db, 'settings', 'event'),
    {
      eventState: live ? 'pre_event' : 'live',
      stateChangedAt: serverTimestamp(),
      stateChangedBy: admin.uid
    },
    { merge: true }
  );
}

function renderPlayers() {
  $('count').textContent = players.length;
  $('liveMemberCount').textContent = players.length;
  $('liveDataStatus').textContent = 'LIVE';
  $('teams').textContent = new Set(
    players.map(player => player.teamId).filter(Boolean)
  ).size;

  $('total').textContent = players.reduce(
    (sum, player) => sum + calculateXP(player.uid),
    0
  );

  const sorted = players
    .map(player => ({
      ...player,
      calculatedXP: calculateXP(player.uid)
    }))
    .sort((a, b) => b.calculatedXP - a.calculatedXP);

  $('playersList').innerHTML = sorted.map((player, index) => `
    <div class="row">
      <span>#${index + 1}</span>
      <b>${esc(player.name)}</b>
      <span>
        ${player.teamId ? `TEAM ${esc(player.teamId)}` : 'NO TEAM'}
        ${player.isLeader ? ' · ★ LEADER' : ''}
      </span>
      <strong>${player.calculatedXP} XP</strong>
    </div>
  `).join('');

  const top = sorted.slice(0, 10);

  $('topPositions').innerHTML = top.length
    ? top.map((player, index) => `
        <div class="top-position-card ${index < 3 ? 'podium' : ''}">
          <div class="top-rank">#${index + 1}</div>

          <div class="top-player">
            <b>${esc(player.name)}</b>
            <span>${esc(player.email || 'No email')}</span>
            <small>
              ${
                eventData.requireRegistrationId
                  ? `REGISTRATION ID: ${esc(player.registrationId || 'NOT PROVIDED')}`
                  : 'REGISTRATION ID: NOT COLLECTED'
              }
            </small>
          </div>

          <strong class="top-xp">${player.calculatedXP} XP</strong>
        </div>
      `).join('')
    : '<div class="empty-state">No player scores yet.</div>';

  syncPublicLeaderboard();
}

function renderVolunteers() {
  const container = $('volunteersList');

  if (!container) return;

  container.innerHTML = volunteers.length
    ? volunteers.map((volunteer, index) => `
        <div class="list-row volunteer-row">
          <span class="rank">#${index + 1}</span>
          <div>
            <b>${esc(volunteer.name || 'Volunteer')}</b>
            <div class="muted-small">${esc(volunteer.email || 'No email')}</div>
          </div>
          <div>
            <div class="muted-small volunteer-field-label">MEMBERSHIP ID</div>
            <b>${esc(volunteer.membershipId || 'NO MEMBERSHIP ID')}</b>
          </div>
          <button class="inline-action danger-inline" type="button" data-volunteer-delete="${esc(volunteer.uid)}">DELETE</button>
        </div>
      `).join('')
    : '<div class="empty-state">No volunteers registered.</div>';

  container.querySelectorAll('[data-volunteer-delete]').forEach(button => {
    button.addEventListener('click', () => removeVolunteer(button.dataset.volunteerDelete));
  });
}

async function removeVolunteer(uid) {
  const volunteer = volunteers.find(item => item.uid === uid);

  if (!volunteer) {
    alert('Volunteer not found. Refresh the page and try again.');
    return;
  }

  const password = prompt('Enter your admin password to continue.');
  if (!password) return;

  const confirmation = prompt(
    `Type DELETE to permanently remove ${volunteer.name || 'this volunteer'} from the event.`
  );

  if (confirmation !== 'DELETE') {
    alert('Cancelled.');
    return;
  }

  try {
    await reauthenticateWithCredential(
      auth.currentUser,
      EmailAuthProvider.credential(auth.currentUser.email, password)
    );

    await deleteDoc(doc(db, 'users', uid));

    alert(
      'Volunteer profile removed. Their Firebase Authentication account remains, but the event volunteer profile has been deleted.'
    );
  } catch (error) {
    console.error('Volunteer removal failed:', error);
    alert(error.message || 'Volunteer removal failed.');
  }
}

function renderTeams() {
  const groups = {};

  players
    .filter(player => player.teamId)
    .forEach(player => {
      if (!groups[player.teamId]) {
        groups[player.teamId] = [];
      }

      groups[player.teamId].push(player);
    });

  $('teamList').innerHTML = Object.entries(groups).map(
    ([team, members]) => {
      const teamData = teamsById[team] || {};
      const teamName = teamData.name || 'NAME NOT SET';

      return `
        <div class="team">
          <b>TEAM ${esc(team)} · ${esc(teamName)}</b>
          <p>
            ${members.map(member => esc(member.name)).join(' · ')}
          </p>

          <label>LEADER</label>
          <select onchange="window.setLeader('${esc(team)}', this.value)">
            ${members.map(member => `
              <option
                value="${esc(member.uid)}"
                ${member.isLeader ? 'selected' : ''}
              >
                ${esc(member.name)}
              </option>
            `).join('')}
          </select>

          ${
            teamData.nameChanged
              ? '<p class="status-note">NAME LOCKED FOR THIS EVENT</p>'
              : ''
          }
        </div>
      `;
    }
  ).join('');
}


function renderMissions() {
  const activeTasks = missions.filter(mission => mission.status === 'active').length;
  $('activeTasks').textContent = activeTasks;
  $('liveTaskCount').textContent = activeTasks;
  $('missionCount').textContent = missions.length;

  if (!missions.length) {
    $('missionsList').innerHTML = `
      <div class="empty-state">
        No missions yet. Create your first mission above.
      </div>
    `;
    return;
  }

  $('missionsList').innerHTML = missions.map(mission => {
    const status = mission.status || 'draft';
    const type = mission.type === 'team' ? 'TEAM' : 'INDIVIDUAL';

    return `
      <article class="mission-card ${status}">
        <div class="mission-number">
          ${String(mission.order).padStart(2, '0')}
        </div>

        <div class="mission-main">
          <div class="mission-meta">
            <span>${type}</span>
            <span>${mission.xp} XP</span>
            ${mission.timeSensitive ? `<span>⏱ ${mission.timeLimitMinutes || 0} MIN</span>` : ''}
            <span>${status.toUpperCase()}</span>
          </div>
          <h3>${esc(mission.title)}</h3>
          <p>${esc(mission.description)}</p>
        </div>

        <div class="mission-actions">
          ${status === 'draft' ? `
            <button class="small-btn" onclick="window.launchMission('${mission.id}')">
              LAUNCH
            </button>
          ` : ''}

          ${status === 'active' ? `
            <button class="small-btn secondary" onclick="window.endMission('${mission.id}')">
              END
            </button>
          ` : ''}

          ${status === 'ended' ? '<span class="status-note">ENDED</span>' : ''}
        </div>
      </article>
    `;
  }).join('');
}

async function createMission() {
  const title = $('mtitle').value.trim();
  const description = $('mdesc').value.trim();
  const type = $('mtype').value;
  const xp = Math.max(1, Number($('mxp').value) || 25);
  const timeSensitive = $('mtime').checked;
  const timeLimitMinutes = timeSensitive
    ? Math.max(1, Math.min(1440, Number($('mtimeLimit').value) || 10))
    : 0;

  if (!title) {
    alert('Enter a mission title.');
    return;
  }

  if (type === 'team' && !players.some(player => player.teamId)) {
    alert('Assign teams before creating a team mission.');
    return;
  }

  const order = missions.length
    ? Math.max(...missions.map(mission => mission.order || 0)) + 1
    : 1;

  const previous = missions.length
    ? [...missions].sort((a, b) => a.order - b.order).at(-1)
    : null;

  const missionRef = doc(collection(db, 'missions'));

  await setDoc(missionRef, {
    title,
    description,
    type,
    xp,
    timeSensitive,
    timeLimitMinutes,
    order,
    previousMissionId: previous?.id || '',
    status: 'draft',
    createdAt: serverTimestamp()
  });

  $('mtitle').value = '';
  $('mdesc').value = '';
  $('mxp').value = '25';
  $('mtime').checked = false;
  $('mtimeLimit').value = '10';
  renderTimeLimitField();

  alert(`Mission ${order} created as DRAFT.`);
}

async function launchMission(id) {
  const mission = missions.find(item => item.id === id);

  if (!mission) {
    return;
  }

  if (eventData.eventState !== 'live') {
    alert('Start the LIVE EVENT before launching a mission.');
    return;
  }

  if (mission.type === 'team') {
    const activeIndividual = missions
      .filter(item => item.status === 'active' && item.type === 'individual')
      .sort((a, b) => a.order - b.order);

    // End the currently active individual phase. Later missions should
    // normally still be DRAFT until the event reaches them.
    const currentIndividual = activeIndividual[0];

    if (currentIndividual) {
      await setDoc(doc(db, 'missions', currentIndividual.id), {
        status: 'ended',
        endedReason: 'team_phase_started',
        endedAt: serverTimestamp()
      }, { merge: true });
    }
  }

  await setDoc(doc(db, 'missions', id), {
    status: 'active',
    launchedAt: serverTimestamp()
  }, { merge: true });

  alert(`Mission ${mission.order} is now ACTIVE.`);
}

async function endMission(id) {
  const mission = missions.find(item => item.id === id);

  if (!mission) {
    return;
  }

  if (!confirm(
    `End Mission ${mission.order}? Unfinished players will receive 0 XP for it.`
  )) {
    return;
  }

  await setDoc(doc(db, 'missions', id), {
    status: 'ended',
    endedAt: serverTimestamp()
  }, { merge: true });
}

async function assignTeams() {
  if (!players.length) {
    alert('There are no players yet.');
    return;
  }

  const size = Math.max(2, Number($('teamSize').value) || 6);
  const shuffled = [...players].sort(() => Math.random() - 0.5);
  const teamCount = Math.ceil(shuffled.length / size);
  const batch = writeBatch(db);
  const grouped = {};

  shuffled.forEach((player, index) => {
    const team = String.fromCharCode(65 + (index % teamCount));

    if (!grouped[team]) {
      grouped[team] = [];
    }

    grouped[team].push(player.uid);
  });

  const existingTeams = await getDocs(collection(db, 'teams'));

  existingTeams.docs.forEach(teamDoc => {
    if (!grouped[teamDoc.id]) {
      batch.delete(teamDoc.ref);
    }
  });

  Object.entries(grouped).forEach(([teamId, memberIds]) => {
    const leaderId =
      memberIds[Math.floor(Math.random() * memberIds.length)];

    memberIds.forEach(uid => {
      batch.update(doc(db, 'users', uid), {
        teamId,
        isLeader: uid === leaderId
      });
    });

    batch.set(doc(db, 'teams', teamId), {
      name: '',
      memberIds,
      leaderId,
      nameChanged: false,
      updatedAt: serverTimestamp()
    });
  });

  await batch.commit();
  alert(`Assigned ${shuffled.length} players into ${teamCount} teams.`);
}

window.setLeader = async (team, uid) => {
  const members = players.filter(player => player.teamId === team);
  const batch = writeBatch(db);

  members.forEach(member => {
    batch.update(doc(db, 'users', member.uid), {
      isLeader: member.uid === uid
    });
  });

  const currentTeam = teamsById[team] || {};

  batch.set(doc(db, 'teams', team), {
    leaderId: uid,
    memberIds: members.map(member => member.uid),
    name: currentTeam.name || `Team ${team}`,
    nameChanged: currentTeam.nameChanged === true,
    updatedAt: serverTimestamp()
  }, { merge: true });

  await batch.commit();
};

window.launchMission = launchMission;
window.endMission = endMission;


function getActiveMission() {
  return missions
    .filter(mission => mission.status === 'active')
    .sort((a, b) => (a.order || 0) - (b.order || 0))[0] || null;
}

function renderBulkAwardControls() {
  const active = getActiveMission();

  $('grantExceptPlayer').innerHTML = `
    <option value="">SELECT PLAYER</option>
    ${players
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map(player => `<option value="${esc(player.uid)}">${esc(player.name)}</option>`)
      .join('')}
  `;

  $('grantExceptTeam').innerHTML = `
    <option value="">SELECT TEAM</option>
    ${teams
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .map(team => `<option value="${esc(team.id)}">${esc(team.name || `Team ${team.id}`)}</option>`)
      .join('')}
  `;

  const hasMission = !!active;
  const individual = active?.type === 'individual';
  const team = active?.type === 'team';

  $('grantAll').disabled = !hasMission;
  $('grantAllExceptPlayer').disabled = !individual;
  $('grantAllExceptTeam').disabled = !team;

  if (!active) {
    $('bulkAwardHelp').textContent =
      'No mission is currently active. Launch a mission first.';
    return;
  }

  $('bulkAwardHelp').textContent =
    `${active.title} · ${active.xp} XP · ${active.type === 'team' ? 'TEAM' : 'INDIVIDUAL'}.
    Every grant ends this active mission.`;
}

async function bulkGrantXP(mode) {
  const mission = getActiveMission();

  if (!mission) {
    alert('There is no active mission to grant XP for.');
    return;
  }

  if (mode === 'exceptPlayer' && mission.type !== 'individual') {
    alert('EXCEPT PLAYER can only be used during an individual mission.');
    return;
  }

  if (mode === 'exceptTeam' && mission.type !== 'team') {
    alert('EXCEPT TEAM can only be used during a team mission.');
    return;
  }

  const excludedPlayerId =
    mode === 'exceptPlayer' ? $('grantExceptPlayer').value : '';

  const excludedTeamId =
    mode === 'exceptTeam' ? $('grantExceptTeam').value : '';

  if (mode === 'exceptPlayer' && !excludedPlayerId) {
    alert('Select the player to exclude.');
    return;
  }

  if (mode === 'exceptTeam' && !excludedTeamId) {
    alert('Select the team to exclude.');
    return;
  }

  let targets = [];

  if (mission.type === 'individual') {
    targets = players
      .filter(player => player.teamId !== null)
      .filter(player => player.uid !== excludedPlayerId)
      .map(player => ({
        targetType: 'player',
        targetId: player.uid,
        awardedPlayerIds: [player.uid]
      }));
  } else {
    targets = teams
      .filter(team => Array.isArray(team.memberIds) && team.memberIds.length)
      .filter(team => team.id !== excludedTeamId)
      .map(team => ({
        targetType: 'team',
        targetId: team.id,
        awardedPlayerIds: [...team.memberIds]
      }));
  }

  const existing = new Set(completions.map(item => item.id));
  targets = targets.filter(target =>
    !existing.has(`${mission.id}_${target.targetType}_${target.targetId}`)
  );

  const scope =
    mode === 'all'
      ? 'everyone'
      : mode === 'exceptPlayer'
        ? `everyone except ${players.find(p => p.uid === excludedPlayerId)?.name || 'the selected player'}`
        : `every team except ${teams.find(t => t.id === excludedTeamId)?.name || `Team ${excludedTeamId}`}`;

  if (!confirm(
    `Grant ${mission.xp} XP to ${scope} for "${mission.title}" and END this mission?`
  )) {
    return;
  }

  const buttons = [
    $('grantAll'),
    $('grantAllExceptPlayer'),
    $('grantAllExceptTeam')
  ];
  buttons.forEach(button => button.disabled = true);

  try {
    const chunkSize = 450;

    for (let start = 0; start < targets.length; start += chunkSize) {
      const batch = writeBatch(db);
      const chunk = targets.slice(start, start + chunkSize);

      chunk.forEach(target => {
        const completionId =
          `${mission.id}_${target.targetType}_${target.targetId}`;

        batch.set(doc(db, 'completions', completionId), {
          missionId: mission.id,
          targetType: target.targetType,
          targetId: target.targetId,
          xpAwarded: mission.xp,
          awardedPlayerIds: target.awardedPlayerIds,
          verifiedBy: admin.uid,
          awardedBy: admin.uid,
          bulkGrant: true,
          createdAt: serverTimestamp()
        });
      });

      await batch.commit();
    }

    await setDoc(doc(db, 'missions', mission.id), {
      status: 'ended',
      endedReason: `bulk_xp_${mode}`,
      endedAt: serverTimestamp(),
      endedBy: admin.uid
    }, { merge: true });

    alert(
      `Granted ${mission.xp} XP to ${targets.length} ${mission.type === 'team' ? 'teams' : 'players'} and ended Mission ${mission.order}.`
    );
  } catch (error) {
    console.error('Bulk XP grant failed:', error);
    alert(error.message || 'Could not grant XP.');
  } finally {
    renderBulkAwardControls();
  }
}


function renderTimeLimitField() {
  $('timeLimitWrap').classList.toggle(
    'hidden',
    !$('mtime').checked
  );
}


async function saveSettings() {
  const pattern = $('regPattern').value.trim();
  const membershipPattern = $('membershipPattern').value.trim();

  if ($('reqReg').checked && !pattern) {
    alert('Enter a registration ID structure.');
    return;
  }

  if (!membershipPattern) {
    alert('Enter a volunteer membership ID structure.');
    return;
  }

  // Validate the administrator's format before saving it.
  try {
    new RegExp(membershipPatternToRegex(membershipPattern));
  } catch {
    alert('The volunteer membership format is invalid.');
    return;
  }

  await setDoc(doc(db, 'settings', 'event'), {
    requireRegistrationId: $('reqReg').checked,
    registrationIdPattern: pattern,
    membershipIdPattern: membershipPattern || 'IEDCJIT2026###',
    membershipIdRegex: membershipPatternToRegex(
      membershipPattern || 'IEDCJIT2026###'
    ),
    updatedAt: serverTimestamp()
  }, { merge: true });

  alert('Registration settings saved.');
}

async function deleteAll() {
  const password = prompt('Enter your admin password to continue.');

  if (!password) {
    return;
  }

  const confirmation = prompt('Type DELETE to confirm.');

  if (confirmation !== 'DELETE') {
    alert('Cancelled.');
    return;
  }

  try {
    await reauthenticateWithCredential(
      auth.currentUser,
      EmailAuthProvider.credential(admin.email, password)
    );

    const collections = [
      'users',
      'missions',
      'completions',
      'teams',
      'leaderboard'
    ];

    for (const name of collections) {
      const snapshot = await getDocs(collection(db, name));
      let batch = writeBatch(db);
      let count = 0;

      for (const item of snapshot.docs) {
        // Never delete administrator profiles.
        // The wipe is for event participants and event data only.
        if (name === 'users' && item.data().role === 'admin') {
          continue;
        }

        batch.delete(item.ref);
        count++;

        if (count === 450) {
          await batch.commit();
          batch = writeBatch(db);
          count = 0;
        }
      }

      if (count) {
        await batch.commit();
      }
    }

    await setDoc(doc(db, 'settings', 'event'), {
      eventState: 'pre_event',
      requireRegistrationId: false,
      registrationIdPattern: 'IEDCJIT2026###',
      membershipIdPattern: 'IEDCJIT2026###',
      membershipIdRegex: '^IEDCJIT2026[0-9]{3}$',
      resetAt: serverTimestamp()
    });

    alert(
      'Event data deleted. Player and volunteer profiles were removed. Admin accounts were preserved.'
    );
  } catch (error) {
    alert(error.message || 'Deletion failed.');
  }
}


let authBootstrapStarted = false;

const initialStatus = $('liveDataStatus');
if (initialStatus) {
  initialStatus.textContent = 'Initializing Firebase Auth…';
}

const authBootstrapTimeout = window.setTimeout(() => {
  const status = $('liveDataStatus');
  if (!authBootstrapStarted && status) {
    status.textContent =
      'FIREBASE AUTH IS NOT RESPONDING — check Firebase Auth/network settings.';
  }
}, 8000);

onAuthStateChanged(auth, user => {
  authBootstrapStarted = true;
  window.clearTimeout(authBootstrapTimeout);

  const status = $('liveDataStatus');

  if (!user) {
    if (status) status.textContent = 'No admin session — redirecting to admin login…';
    location.href = 'admin-login.html';
    return;
  }

  start(user).catch(error => {
    console.error('Admin startup failed:', error);
    if (status) {
      status.textContent =
        `FIREBASE STARTUP ERROR: ${error.code || error.message || 'unknown error'}`;
    }
  });
});


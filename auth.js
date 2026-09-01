import {
  auth,
  db,
  authReady,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  doc,
  getDoc,
  setDoc,
  serverTimestamp
} from './firebase.js';

const role = location.pathname.split('/').pop().split('-')[0];
const ADMIN_EMAILS = ['srdevanarayanan8@gmail.com', 'iedc@jcmcsiit.ac.in'];

const copy = {
  player: {
    eyebrow: 'PLAYER ACCESS',
    loginTitle: 'Welcome back.',
    loginDescription: 'Log in with your email address.',
    registerTitle: 'PLAYER REGISTRATION',
    registerDescription: 'Create your player account.'
  },
  volunteer: {
    eyebrow: 'VOLUNTEER ACCESS',
    loginTitle: 'Welcome back.',
    loginDescription: 'Log in with your email address.',
    registerTitle: 'VOLUNTEER REGISTRATION',
    registerDescription: 'Create your volunteer account.'
  },
  admin: {
    eyebrow: 'ADMIN ACCESS',
    loginTitle: 'Control room.',
    loginDescription: 'Authorized administrators only.'
  }
};

const c = copy[role];
const $ = id => document.getElementById(id);
let registering = false;

function formatToRegex(format) {
  let pattern = '';
  for (const char of String(format || '')) {
    if (char === '#') pattern += '[0-9]';
    else if (char === '^') pattern += '[A-Z]';
    else if (char === '$') pattern += '[a-z]';
    else if (char === '*') pattern += '.';
    else pattern += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`);
}

function matchesFormat(value, format) {
  return !format || formatToRegex(format).test(value);
}

function message(error) {
  const known = {
    'auth/email-already-in-use': 'This email already has an account. Use the same password to complete registration or log in.',
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/weak-password': 'Password must be at least 6 characters.',
    'auth/invalid-credential': 'Invalid email or password.',
    'auth/network-request-failed': 'Network error. Check your connection.',
    'permission-denied': 'Firebase denied this operation. Confirm the rebuilt Firestore rules are published.'
  };
  return known[error?.code] || error?.message || 'Something went wrong.';
}

async function getRegistrationSettings() {
  // Public get of settings/event is intentional in firestore.rules so a brand
  // new user can validate the registration form before signing in.
  const snap = await getDoc(doc(db, 'settings', 'event'));
  return snap.exists() ? snap.data() : {};
}

function setMode(value) {
  registering = value;
  $('loginTab').classList.toggle('active', !value);
  $('registerTab')?.classList.toggle('active', value);
  $('title').textContent = value ? c.registerTitle : c.loginTitle;
  $('desc').textContent = value ? c.registerDescription : c.loginDescription;
  $('submit').textContent = value ? 'CREATE ACCOUNT →' : 'LOGIN →';

  for (const id of ['name', 'email', 'confirm', 'nameLabel', 'emailLabel', 'confirmLabel']) {
    $(id).classList.toggle('hidden', !value);
  }

  $('id').classList.toggle('hidden', value);
  $('idLabel').classList.toggle('hidden', value);
  $('id').required = !value;

  if (role === 'player' && value) {
    updatePlayerRegistrationField();
  }

  const volunteerRegister = role === 'volunteer' && value;
  $('membership').classList.toggle('hidden', !volunteerRegister);
  $('membershipLabel').classList.toggle('hidden', !volunteerRegister);
}

async function updatePlayerRegistrationField() {
  if (role !== 'player' || !registering) return;
  try {
    const settings = await getRegistrationSettings();
    const required = !!settings.requireRegistrationId;
    $('idLabel').textContent = 'REGISTRATION ID';
    $('id').classList.toggle('hidden', !required);
    $('idLabel').classList.toggle('hidden', !required);
    $('id').required = required;
  } catch (error) {
    console.warn('Could not load registration settings:', error);
    $('id').classList.add('hidden');
    $('idLabel').classList.add('hidden');
    $('id').required = false;
  }
}

async function profileFor(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? snap.data() : null;
}

async function registerAccount() {
  await authReady;

  const name = $('name').value.trim();
  const email = $('email').value.trim().toLowerCase();
  const password = $('pin').value;
  const confirm = $('confirm').value;

  if (!name || !email || password.length < 6) {
    throw new Error('Complete all required fields. Password must be at least 6 characters.');
  }
  if (password !== confirm) throw new Error('Passwords do not match.');

  const settings = await getRegistrationSettings();
  let registrationId = '';
  let membershipId = '';

  if (role === 'player') {
    registrationId = $('id').value.trim();
    if (settings.requireRegistrationId && !registrationId) {
      throw new Error('Registration ID is required for this event.');
    }
    if (settings.requireRegistrationId && settings.registrationIdPattern
      && !matchesFormat(registrationId, settings.registrationIdPattern)) {
      throw new Error(`Registration ID must follow: ${settings.registrationIdPattern}`);
    }
  }

  if (role === 'volunteer') {
    membershipId = $('membership').value.trim().toUpperCase();
    const pattern = settings.membershipIdPattern || 'IEDCJIT2026###';
    if (!membershipId) throw new Error('Membership ID is required.');
    if (!matchesFormat(membershipId, pattern)) {
      throw new Error(`Membership ID must follow: ${pattern}`);
    }
  }

  let credential;
  let newlyCreated = false;

  try {
    credential = await createUserWithEmailAndPassword(auth, email, password);
    newlyCreated = true;
  } catch (error) {
    // Recovery path for the common failure mode where Authentication succeeded
    // during an earlier attempt but the old Firestore profile write failed.
    if (error?.code !== 'auth/email-already-in-use') throw error;
    credential = await signInWithEmailAndPassword(auth, email, password);
  }

  const uid = credential.user.uid;
  const existing = await profileFor(uid);

  if (existing) {
    if (existing.role !== role) {
      await signOut(auth);
      throw new Error(`This email is already registered as a ${existing.role}.`);
    }
    location.href = role === 'player' ? 'player.html' : 'volunteer.html';
    return;
  }

  try {
    await setDoc(doc(db, 'users', uid), {
      uid,
      name,
      email,
      role,
      registrationId,
      membershipId,
      teamId: '',
      isLeader: false,
      xp: 0,
      createdAt: serverTimestamp()
    });
  } catch (error) {
    console.error('Profile creation failed after auth succeeded:', error);
    if (newlyCreated) {
      // Keep the auth account recoverable. A retry with the same email/password
      // will sign in and complete this missing profile instead of getting stuck.
      await signOut(auth);
    }
    throw error;
  }

  location.href = role === 'player' ? 'player.html' : 'volunteer.html';
}

async function loginAccount() {
  await authReady;
  const email = $('id').value.trim().toLowerCase();
  const password = $('pin').value;
  const credential = await signInWithEmailAndPassword(auth, email, password);

  if (role === 'admin') {
    if (!ADMIN_EMAILS.includes(email)) {
      await signOut(auth);
      throw new Error('This email is not an authorized admin.');
    }
    const existing = await profileFor(credential.user.uid);
    if (!existing) {
      await setDoc(doc(db, 'users', credential.user.uid), {
        uid: credential.user.uid,
        name: 'ICEBREAK Admin',
        email,
        role: 'admin',
        xp: 0,
        teamId: '',
        isLeader: false,
        registrationId: '',
        membershipId: '',
        createdAt: serverTimestamp()
      });
    }
    location.href = 'admin.html';
    return;
  }

  const profile = await profileFor(credential.user.uid);
  if (!profile || profile.role !== role) {
    await signOut(auth);
    throw new Error('This account is not authorized for this portal.');
  }
  location.href = role === 'player' ? 'player.html' : 'volunteer.html';
}

$('ey').textContent = c.eyebrow;
$('title').textContent = c.loginTitle;
$('desc').textContent = c.loginDescription;
$('idLabel').textContent = 'EMAIL';

if (role === 'admin') {
  $('registerTab').remove();
  $('hint').textContent = 'Admin accounts are provisioned by ICEBREAK. There is no public admin registration.';
}

$('loginTab').onclick = () => setMode(false);
$('registerTab')?.addEventListener('click', () => setMode(true));

$('form').onsubmit = async event => {
  event.preventDefault();
  $('submit').disabled = true;
  try {
    if (registering) await registerAccount();
    else await loginAccount();
  } catch (error) {
    console.error('ICEBREAK auth error:', error);
    alert(message(error));
  } finally {
    $('submit').disabled = false;
  }
};

$('forgot').onclick = async () => {
  const email = $('id').value.trim().toLowerCase();
  if (!email) return alert('Enter your email first.');
  try {
    await sendPasswordResetEmail(auth, email);
    alert('Password reset email sent.');
  } catch (error) {
    alert(message(error));
  }
};

setMode(false);

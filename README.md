# ICEBREAK — Rebuilt V61

This build is a clean recovery build based on the working V60 UI and feature set.

## Included
- Player registration and login
- Volunteer registration and login
- Admin-only control room
- Individual and team missions
- Time-sensitive mission countdowns
- Player/team QR mission codes
- Volunteer QR/manual-code verification and XP grants
- Admin bulk XP grants
- Public live leaderboard with 2nd / 1st / 3rd podium order
- Player, volunteer and admin inboxes
- Admin messages to all players, all volunteers, one player, one volunteer, another admin or everyone
- Team assignment and one-time team rename by leader

## Critical registration fix
The old build could fail during profile creation because registration and Firestore rules were coupled too tightly. V61:
1. lets a newly authenticated player/volunteer create exactly their own profile;
2. removes the fragile auth-token-email equality check;
3. allows a retry with the same email/password to recover an Auth account that was created before an earlier profile-write failure;
4. allows public `get` of `settings/event` so registration format validation works before login.

## Deploy order
1. Replace your website files with this build.
2. Publish `firestore.rules` in Firebase Console → Firestore Database → Rules.
3. Hard-refresh the website.
4. Test registration with a new email, or retry an orphaned account using the same password.

## Admin emails
- srdevanarayanan8@gmail.com
- iedc@jcmcsiit.ac.in

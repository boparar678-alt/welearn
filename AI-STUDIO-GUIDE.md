# Publishing QuizLive with Google AI Studio

There are two ways to do this. Try **Way A** first because it keeps the tested code exactly as it is.

---

## Way A: Import this code and deploy it

1. Upload this folder to a GitHub repository. On github.com go to **New repository → "uploading an existing file"** and drag in all the files plus the `public` folder.
2. Open **aistudio.google.com**, then go to **Build**.
3. In the prompt box, click **+ (Add files) → Import from GitHub** and choose your repo.
4. Paste this prompt and send it:

```
This is an existing, working Node.js app (Express + Socket.IO). Do NOT rewrite it,
convert it to React, or change the game logic.
- Start command: `npm start` (runs `node server.js`). It listens on process.env.PORT
  (default 3000) on 0.0.0.0.
- The frontend is plain HTML/JS in /public, served by Express. There's no build step.
- Players and hosts talk to the server over Socket.IO WebSockets at /socket.io.
Only make the minimum changes needed for it to run in the preview and to deploy to
Cloud Run. Explain anything you change.
```

5. Check that the preview works. Create a quiz, then open the join link in another tab.
6. Click **Deploy → Cloud Run**. You get a public URL.
7. **Important:** change these Cloud Run settings. In Google Cloud Console go to **Cloud Run → your service → Edit & deploy new revision**:

| Setting | Value | Why |
|---|---|---|
| Maximum instances | **1** | All live quiz state is in one server's memory. With 2+ instances, players end up split across servers. |
| Minimum instances | **1** | Keeps the server awake so a running quiz isn't cut off. |
| Request timeout | **3600** seconds | Lets WebSocket connections stay open for up to 1 hour. |
| Session affinity | **On** | Keeps each player on the same connection. |
| CPU allocation | **Always allocated** | The quiz timer keeps running between answers. |
| Memory | 1 GiB (2 GiB or more for very large crowds) | |

A minimum of 1 instance means the server always runs, so Cloud Run charges a small monthly amount.

**Saving quizzes:** Cloud Run's disk is wiped whenever the service restarts or redeploys. Live quizzes work fine, but saved quizzes and results are lost when that happens, so export results (CSV) after each quiz. To keep quizzes permanently, ask the AI Studio agent:

```
Add Firebase Firestore persistence. Keep the in-memory `quizzes` object as the live
state, but in save()/saveNow() also write each quiz document to a Firestore
collection "quizzes" (doc id = quiz.id), and in load() read all quiz docs from
Firestore instead of data/quizzes.json. Don't change anything else.
```

---

## Way B: Have AI Studio build it from scratch

Use this if the import doesn't work. Paste this whole prompt into AI Studio **Build**:

```
Build "QuizLive", a real-time multiplayer quiz website (like Kahoot/Quizzard) with a
Node.js server (Express + Socket.IO) and Firebase Firestore for storage.

HOST – CREATE QUIZ (home page "/")
- Form: quiz title, seconds per question (default 20), seconds to show the answer +
  leaderboard (default 6), toggles: speed bonus (on), allow late join (on), shuffle questions (off).
- Bulk upload questions from CSV or Excel (.xlsx, use SheetJS), or paste rows copied from
  Excel/Google Sheets (tab-separated). Columns (auto-detected from the header row):
  Question, Option A..Option F (2–6 options), Answer, Time (optional per-question seconds),
  Image (optional URL), Explanation (optional).
- Answer key accepts a letter (A–F), a number (1–6) or the exact option text.
- Optional separate "answer key" textbox like "1-B, 2-A, 3-D" (or one letter per line)
  that overrides the Answer column.
- "Download CSV template" button. Preview table highlights the correct option and lists
  row-by-row errors. Creation is blocked until there are no errors.
- On create, the server returns quiz id, a 6-character join code and a secret host key.
  Redirect to /host/:id#key=HOSTKEY and save it in localStorage under "My quizzes".

JOIN
- Each quiz has a link /join/CODE (plus a QR code generated on the server) and the code.
  Players enter only a name (duplicate names get " (2)" appended). No sign-up. Store the
  player id in localStorage so a refresh or reconnect rejoins automatically.
- No limit on the number of players.

AUTOMATIC RUN (no host action needed after Start)
- Host presses Start, then a 3-second countdown, then each question runs for its time,
  then a reveal phase (correct answer, how many picked each option, top-10 leaderboard,
  the player's own rank and points), then the next question automatically, until a final
  podium screen.
- If every player has answered, move to the reveal 1.2 seconds early.
- All timing is driven by server timers. Send endsAt + server time so clients show an
  accurate countdown.
- Scoring: correct = 500 + 500 × (time remaining / total time), or a flat 1000 if speed
  bonus is off. Wrong = 0. Ties are broken by total answer time.
- Never send the correct answer to players before the reveal phase.
- Optional host buttons: Skip ahead, End now, Reset (clear players to rerun with the same
  link), Remove player.

HOST DASHBOARD (/host/:id, authorised by the host key)
- Join code, link with a Copy button, QR code, players joined, players online.
- Live current question with countdown, the answer key highlighted, a live count per option,
  attempted / not attempted / correct / accuracy %, and an attempted progress bar.
- "Who attempted" table: name, chosen option, correct/wrong, time taken, points, searchable.
  "Not attempted" tab listing names with online/offline status.
- Question-by-question table (attempted, correct, accuracy); click a row to see who
  attempted that question.
- Real-time leaderboard of all players (rank, score, correct, attempted, online dot),
  searchable.
- Export results CSV: rank, name, score, correct, attempted, total time, and each
  question's answer, ✓/✗ and time.
- Throttle host updates (~400 ms) and player count updates (~1 s) so it scales to
  thousands of players.

PLAYER SCREEN (mobile-first)
- Big coloured answer tiles (A red, B blue, C yellow, D green, E purple, F orange). Lock
  after tapping and show "Answer locked in".
- Reveal: ✅ Correct +points / ❌ Wrong with the correct answer, explanation, top 10 with
  my row highlighted, my rank.
- End: my final rank and score, a podium for the top 3, the final top 10.

STORAGE
- Keep live game state in server memory (single instance). Write quizzes, players and
  answers to Firestore so they survive restarts. Resume running quizzes after a restart.

STYLE
- Dark purple gradient theme, yellow accent (#ffcc33), Poppins font, rounded cards.
```

After it's built, deploy to Cloud Run and apply the same Cloud Run settings as in Way A, step 7.

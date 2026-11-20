# QuizLive: a self-hosted live quiz platform

Host live multiplayer quizzes. Upload questions in bulk with an answer key and share one link. Press **Start** and the quiz runs by itself while the leaderboard updates live.

## Features
- **Unlimited players.** No player cap in the app. The only limit is the size of your server (see "Scaling" below).
- **Bulk upload** from CSV or Excel (.xlsx), or paste rows straight from Excel or Google Sheets.
  - Columns: `Question, Option A … Option F, Answer, Time, Image, Explanation` (Time, Image and Explanation are optional)
  - **Answer key** can be a letter (A–F), a number (1–6) or the exact option text.
  - You can also give a **separate answer key** (`1-B, 2-A, 3-D…`), which overrides the Answer column.
  - Each question can have 2 to 6 options and its own timer.
  - You preview and check the questions before the quiz is created.
- **Join link and QR code** for each quiz (`/join/CODE`). Players only enter a name. There's no sign-up.
- **Runs automatically:** a 3-second countdown, then question, then answer reveal and leaderboard, then the next question, until the final podium. The host doesn't need to do anything after pressing Start.
  - If every player has answered, the reveal comes early.
  - The host can still choose to **Skip ahead**, **End now**, or **Reset** (clears the players so the same link can run again).
- **Real-time leaderboard** for the host (every player, live). Players see the top 10 plus their own rank after each question.
- **Attempt tracking.** For the live question and for any past question, the host sees:
  - how many attempted and how many didn't
  - **exactly which participants attempted**, what they picked, whether it was right, and how long they took
  - which participants **did not attempt**, and whether they're online
  - the spread of answers across the options, and the accuracy
- **Scoring:** a correct answer earns 500–1000 points, with a speed bonus. You can turn the speed bonus off so every correct answer is worth 1000. Ties are broken by total answer time.
- **Refresh-safe:** players who reload or lose connection rejoin automatically.
- **Export results to CSV:** rank, score, and each player's answer, result and time for every question.
- Quizzes are saved to `data/quizzes.json`. A quiz that's running when the server restarts carries on.

## Run it locally
```bash
npm install
npm start
# open http://localhost:3000
```
Requires Node.js 18 or newer.

## Put it online
The app needs a host that runs **Node.js with WebSockets**. Static hosts such as Netlify, GitHub Pages or plain Vercel won't work.

**Render.com / Railway.app (simplest)**
1. Push this folder to a GitHub repo.
2. Create a new *Web Service*. Build command: `npm install`. Start command: `npm start`.
3. Add a **persistent disk** and set the env var `DATA_DIR` to its mount path (for example `/var/data`). Without a disk, saved quizzes are lost every time the app redeploys.

**Your own VPS (DigitalOcean, AWS Lightsail, Hostinger VPS…)**
```bash
npm install --omit=dev
PORT=3000 npx pm2 start server.js --name quizlive
```
Put Nginx in front for HTTPS. Pass WebSocket upgrade headers:
```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
}
```

## Hosting
1. Go to the home page, upload your file (or use **Download CSV template**), check the preview, then click **Create quiz & get link**.
2. You land on the **host dashboard**. Bookmark it: the URL contains your private host key. It's also saved under "My quizzes" on that browser.
3. Share the join link, code or QR code. When people have joined, press **Start**.

## Scaling notes
- A single server comfortably handles a few thousand players at once. Updates sent to the host and the players are throttled, which keeps the traffic manageable.
- For tens of thousands of players at once, give the server more CPU and RAM. Running more than one server process would need a Redis adapter plus a shared database.

## Files
```
server.js            game engine, REST API, Socket.IO
public/index.html    home page: create a quiz (bulk upload), join with a code
public/host.html     host dashboard
public/play.html     player screen (mobile-friendly)
public/parse.js      CSV/Excel question and answer-key parser
public/style.css     styles
public/sample-questions.csv   template
```

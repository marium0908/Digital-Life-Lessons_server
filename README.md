# Digital Life Lessons

Digital Life Lessons is an elegant, fully responsive web application designed for students and professionals to store, curate, and share life-changing guidelines, personal growth workflows, and wisdom gathered over time.

---

### 🌐 Live Showcase

- **Live URL (Production)**: [https://ais-pre-b4whccp573tak4gikmamhm-710385799111.asia-east1.run.app](https://ais-pre-b4whccp573tak4gikmamhm-710385799111.asia-east1.run.app)
- **Development Preview**: [https://ais-dev-b4whccp573tak4gikmamhm-710385799111.asia-east1.run.app](https://ais-dev-b4whccp573tak4gikmamhm-710385799111.asia-east1.run.app)

---

## 🎯 Purpose

In the rapid flux of modern society, critical lessons learned during failures, career pivots, and emotional breakthroughs are often lost to memory. Digital Life Lessons provides an elegant digital safety net — allowing scholars to systematically organize their cognitive telemetry, and selectively share wisdom with others with modern, balanced, premium aesthetics.

---

## 📦 Key npm Packages Used

- **`react` & `react-dom` (v19)**: Directing component loops, state management, and unified views.
- **`motion` (v12)**: Used for smooth animations, staggered entrances, and polished UI transitions.
- **`lucide-react`**: Delivering responsive, crisp vector iconography across components.
- **`express` (v4)**: Driving backend endpoint coordination and static package delivery.
- **`mongoose`**: Handling database abstractions & schema safety.
- **`vite` & `@tailwindcss/vite`**: For ultra-fast builds and declarative, utility-first styling.

---

## 🚀 Key Features

### 1. Unified Philosophy Hub (Home Page)
- **Interactive Carousel**: Features a beautifully styled, automatic 3-slide hero slider highlighting the value of wisdom preservation.
- **Featured Wisdom Grid**: Dynamic grid rendering lessons nominated by admins as "Featured," presenting premium/blurred badges.
- **Why Learning Matters**: An adaptive 4-card layout mapping the cognitive safeguards of systematic documentation.
- **Weekly Contributors**: Dynamically derived leaderboard displaying top active members and their lesson counts.
- **Most Saved Archive**: Lists highly bookmarked insights based on user engagement metric counters.

### 2. Live Public Wisdom Archive (Catalog Page)
- **Filters & Search**: Multi-input panel enabling keyword searches, category segregation, and emotional tone sorting.
- **One-Page Pagination**: Balanced page navigation distributing public items elegantly without overloading viewport bounds.
- **Access Gating & Blurring**: Premium lessons are automatically blurred for Guest/Free tier users. An overlay informs them of subscription terms and offers upgrade pathways.

### 3. Lifetime Premium Upgrades (Stripe Emulation)
- **Feature Comparison Matrix**: A detailed 8-row layout contrasting Free vs. Premium Master tier privileges.
- **Secure Stripe Simulator Sandbox**: Integrates a complete transaction workflow executing success/cancel webhook states.
- **Instant Activation**: Confirmed transactions update User profiles to Premium immediately, lifting catalog access barriers and enabling "Premium" post creation.

### 4. Interactive Details Inspector (Details Page)
- **Engagement Mechanics**: Full support for real-time Likes/Unlikes toggles (re-render safe) and Favorite Saves.
- **Estimated Reading Time**: Auto-calculates word-count-derived indicators (e.g., "5 min read").
- **Verification Badges**: Integrated verified badges for experienced contributors.
- **Community Commentary**: Live submission forms for logged-in scholars to exchange observations and insights.
- **Recommended Rails**: Staggers up to 6 similar items matching category topics or emotional tones.
- **Compliance Disputes**: Allows users to report offensive publications with cause checklists (Inappropriate content, Copyright, etc.).

### 5. Multi-Module Scholar Workspace (Dashboard Page)
- **Workspace Overview**: Features daily streaks tracker panels, publication metrics, and dynamic contribution charts.
- **Publish Wisdom (Forms)**: Form inputs validating image links, categories, visibilities, and gating rules.
- **My Publications (Table)**: Direct toggles for Visibilities (Public/Private) and Access levels (Free/Premium), as well as details inspection, live modal edits, and deletion triggers.
- **Scholar Settings**: Updates profile metadata (avatar URL, names) and keeps account information synchronised.

### 6. Admin Control Gateway (Gated Panels)
- **Analytics Center**: Visual growth indicators displaying user-to-lesson ratios, verified subscriptions coverage, and report queues.
- **Member Directory**: Table showing emails, roles, and publications counts. Features account deletions and single-click promotions to Administrator roles.
- **Content Moderation Table**: Direct access to nominate/remove slider list items, clear report counts, and mark content "reviewed."
- **Disputes Monitor**: Lists reported lessons and dispute details, allowing admins to inspect comments, remove offending content, or discard complaints.

---

## 🛠️ Technical Stack & Architecture

- **Client**: React 19 (Functional Components), Vite, Tailwind CSS, Lucide Icons, Framer Motion (`motion/react`).
- **Server**: Node.js + Express.
- **Data Layer**: File-authoritative state simulation via local JSON storage (`db.json`), persisting users, authentications, comments, and reports.
- **Authentication**: Custom security-locked session token hashes mapped via HTTP headers, persisting state securely over page reloads.

---

## 💻 Commands

### Development
Starts the tsx-authoritative development Express server (which dynamically hosts Vite asset compilers inside standard Node):
```bash
npm run dev
```

### Production Build
Compiles all static frontend assets into standard distribution packages and bundles backend TypeScript code into a single, optimized `dist/server.cjs` file using esbuild:
```bash
npm run build
```

### Start Production Application
Launches compiled bundles instantly:
```bash
npm start
```
"# Digital-Life-Lessons_server" 
"# Digital-Life-Lessons_server" 

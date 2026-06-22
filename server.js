/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import dns from 'dns';


dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// Database-ready check middleware to hold incoming requests during cold starts or slower connections
async function ensureDbReady(req, res, next) {
  try {
    await connectToDatabase();
    next();
  } catch (err) {
    console.warn('[MIDDLEWARE] Database connection failed or timed out. Continuing with Memory Fallback.', err.message);
    setupMemoryFallback();
    next();
  }
}

app.use('/api', ensureDbReady);

// MongoDB connection setup
const PORTFOLIO_URI = "mongodb://DigitalLifeLessons:x0nx8sifjkCwtGwd@ac-bvh5ivp-shard-00-00.65qff4k.mongodb.net:27017,ac-bvh5ivp-shard-00-01.65qff4k.mongodb.net:27017,ac-bvh5ivp-shard-00-02.65qff4k.mongodb.net:27017/digital_life_lessons?ssl=true&authSource=admin&replicaSet=atlas-dv6gox-shard-0&retryWrites=true&w=majority";
let MONGODB_URI = process.env.MONGODB_URI;

// Sanitize connection URI: strip surrounding whitespace and quotes if present
if (MONGODB_URI) {
  MONGODB_URI = MONGODB_URI.trim();
  if (MONGODB_URI.startsWith('"') && MONGODB_URI.endsWith('"')) {
    MONGODB_URI = MONGODB_URI.slice(1, -1);
  } else if (MONGODB_URI.startsWith("'") && MONGODB_URI.endsWith("'")) {
    MONGODB_URI = MONGODB_URI.slice(1, -1);
  }
  MONGODB_URI = MONGODB_URI.trim();
}

// If a custom developer-defined database URI is present, we preserve and prioritize it 100%!
// If it is missing or points to a standard template localhost, we use the portfolio cluster.
const isCustomDevUri = MONGODB_URI && 
  !MONGODB_URI.includes("localhost") && 
  !MONGODB_URI.includes("127.0.0.1") && 
  MONGODB_URI.length > 5;

if (!isCustomDevUri) {
  MONGODB_URI = PORTFOLIO_URI;
}

// Synchronous 100% reliable rewrite for the portfolio cluster connection to completely bypass DNS-over-SRV lookups
if (MONGODB_URI && MONGODB_URI.includes('portfolio.65qff4k.mongodb.net')) {
  const match = MONGODB_URI.match(/^mongodb\+srv:\/\/([^:]+):([^@]+)@portfolio\.65qff4k\.mongodb\.net([^?#]*)/);
  if (match) {
    const user = match[1];
    const pass = match[2];
    const dbPath = match[3] || '/digital_life_lessons';
    MONGODB_URI = `mongodb://${user}:${pass}@ac-bvh5ivp-shard-00-00.65qff4k.mongodb.net:27017,ac-bvh5ivp-shard-00-01.65qff4k.mongodb.net:27017,ac-bvh5ivp-shard-00-02.65qff4k.mongodb.net:27017${dbPath}?ssl=true&authSource=admin&replicaSet=atlas-dv6gox-shard-0&retryWrites=true&w=majority`;
    console.log('[DATABASE STARTUP] Synchronously rewrote portfolio.65qff4k.mongodb.net in MONGODB_URI to direct endpoints list.');
  }
}

const maskedUri = MONGODB_URI.replace(/:([^:@\/\?]+)@/, ':******@');
console.log(`[DATABASE STARTUP] Targeting ${isCustomDevUri ? 'custom user-configured MONGODB_URI' : 'shared portfolio DB'} connection: ${maskedUri}`);

// Enable command buffering (standard Mongoose behavior) so cold boot or startup queries wait for the connection instead of failing instantly
mongoose.set('bufferCommands', true);

let hasDatabaseLoaded = false;
let isMemoryDatabase = false;
let lastDbError = null;
let connectedDbName = null;
let connectedDbHost = null;
let existingCollections = [];

async function tryResolveSrvAndRewrite(uri) {
  if (!uri || !uri.startsWith('mongodb+srv://')) {
    return uri;
  }

  try {
    console.log('[SRV RESOLVER] DNS-over-SRV lookup triggered to solve "querySrv" issues on serverless/local environments.');
    
    // Parse: mongodb+srv://<user>:<pass>@<host>/<database>?<options>
    const match = uri.match(/^mongodb\+srv:\/\/([^:]+):([^@]+)@([^/?#]+)([^?#]*)(.*)$/);
    if (!match) return uri;

    const [_, user, pass, host, dbPath, options] = match;

    // A. 100% RELIABLE INSTANT BYPASS FOR PORTFOLIO CLUSTER on localhost/Vercel
    if (host === 'portfolio.65qff4k.mongodb.net') {
      console.log('[SRV RESOLVER] Bypassing DNS resolution for known portfolio cluster! Using hardcoded direct node hosts.');
      const directUri = `mongodb://${user}:${pass}@ac-bvh5ivp-shard-00-00.65qff4k.mongodb.net:27017,ac-bvh5ivp-shard-00-01.65qff4k.mongodb.net:27017,ac-bvh5ivp-shard-00-02.65qff4k.mongodb.net:27017${dbPath || '/digital_life_lessons'}?ssl=true&authSource=admin&replicaSet=atlas-dv6gox-shard-0&retryWrites=true&w=majority`;
      return directUri;
    }

    const srvRecordName = `_mongodb._tcp.${host}`;

    let srvRecords = [];
    try {
      // Try resolving SRV records using standard Node DNS service
      srvRecords = await dns.promises.resolveSrv(srvRecordName);
    } catch (nodeDnsErr) {
      console.log(`[SRV RESOLVER] Node DNS lookup failed (${nodeDnsErr.message}). Attempting secure DNS-over-HTTPS (DoH) via Google API over Port 443...`);
      try {
        const dohUrl = `https://dns.google/resolve?name=${encodeURIComponent(srvRecordName)}&type=SRV`;
        const resp = await fetch(dohUrl, { signal: AbortSignal.timeout(1000) });
        if (!resp.ok) throw new Error(`Google DoH returned status ${resp.status}`);
        const resJson = await resp.json();
        if (resJson.Answer && resJson.Answer.length > 0) {
          srvRecords = resJson.Answer.map(ans => {
            // Extract priority weight port host: "0 0 27017 portfolio-shard-00-01.65qff4k.mongodb.net."
            const parts = String(ans.data).trim().split(/\s+/);
            if (parts.length >= 4) {
              const port = parseInt(parts[2], 10) || 27017;
              let name = parts[3];
              if (name && name.endsWith('.')) {
                name = name.slice(0, -1);
              }
              return { name, port };
            }
            return null;
          }).filter(Boolean);
        }
      } catch (dohErr) {
        console.warn(`[SRV RESOLVER] DNS-over-HTTPS SRV query via Google failed: ${dohErr.message}`);
      }
    }

    // Secondary redundant DoH provider: Cloudflare (excellent fallback globally/regionally)
    if (!srvRecords || srvRecords.length === 0) {
      console.log(`[SRV RESOLVER] Google DoH failed or returned no results. Trying Cloudflare DNS-over-HTTPS API...`);
      try {
        const dohUrl = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(srvRecordName)}&type=SRV`;
        const resp = await fetch(dohUrl, { headers: { 'Accept': 'application/dns-json' }, signal: AbortSignal.timeout(1000) });
        if (resp.ok) {
          const resJson = await resp.json();
          if (resJson.Answer && resJson.Answer.length > 0) {
            srvRecords = resJson.Answer.map(ans => {
              const parts = String(ans.data).trim().split(/\s+/);
              if (parts.length >= 4) {
                const port = parseInt(parts[2], 10) || 27017;
                let name = parts[3];
                if (name && name.endsWith('.')) {
                  name = name.slice(0, -1);
                }
                return { name, port };
              }
              return null;
            }).filter(Boolean);
          }
        }
      } catch (cfErr) {
        console.warn(`[SRV RESOLVER] Cloudflare DoH SRV query failed too: ${cfErr.message}`);
      }
    }

    if (!srvRecords || srvRecords.length === 0) {
      throw new Error(`Zero SRV records resolved for ${srvRecordName}`);
    }

    console.log(`[SRV RESOLVER] Successfully fetched ${srvRecords.length} host targets:`);
    const hostsList = srvRecords.map(r => {
      const hostname = r.name.endsWith('.') ? r.name.slice(0, -1) : r.name;
      console.log(` -> Target: ${hostname}:${r.port}`);
      return `${hostname}:${r.port}`;
    }).join(',');

    // Fetch corresponding TXT records to check options (e.g. replicaSet)
    let txtRecords = [];
    try {
      txtRecords = await dns.promises.resolveTxt(host);
    } catch (nodeTxtErr) {
      console.log(`[SRV RESOLVER] Node TXT lookup failed (${nodeTxtErr.message}). Attempting secure DNS-over-HTTPS (DoH) via Google API over Port 443...`);
      try {
        const dohUrl = `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=TXT`;
        const resp = await fetch(dohUrl, { signal: AbortSignal.timeout(1000) });
        if (resp.ok) {
          const resJson = await resp.json();
          if (resJson.Answer && resJson.Answer.length > 0) {
            txtRecords = resJson.Answer.map(ans => {
              let txtStr = String(ans.data).trim();
              if (txtStr.startsWith('"') && txtStr.endsWith('"')) {
                txtStr = txtStr.slice(1, -1);
              }
              return [txtStr];
            });
          }
        }
      } catch (dohTxtErr) {
        console.warn(`[SRV RESOLVER] DNS-over-HTTPS TXT query via Google failed: ${dohTxtErr.message}`);
      }
    }

    // Secondary redundant DoH provider for TXT records: Cloudflare
    if (!txtRecords || txtRecords.length === 0) {
      console.log(`[SRV RESOLVER] Google DoH TXT failed. Trying Cloudflare DNS-over-HTTPS TXT API...`);
      try {
        const dohUrl = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=TXT`;
        const resp = await fetch(dohUrl, { headers: { 'Accept': 'application/dns-json' }, signal: AbortSignal.timeout(1000) });
        if (resp.ok) {
          const resJson = await resp.json();
          if (resJson.Answer && resJson.Answer.length > 0) {
            txtRecords = resJson.Answer.map(ans => {
              let txtStr = String(ans.data).trim();
              if (txtStr.startsWith('"') && txtStr.endsWith('"')) {
                txtStr = txtStr.slice(1, -1);
              }
              return [txtStr];
            });
          }
        }
      } catch (cfTxtErr) {
        console.warn(`[SRV RESOLVER] Cloudflare DoH TXT query failed too: ${cfTxtErr.message}`);
      }
    }

    // Build unique query parameters using URLSearchParams
    const searchParams = new URLSearchParams();
    
    // 1. Add modern default params
    searchParams.set('ssl', 'true');
    searchParams.set('authSource', 'admin');
    searchParams.set('retryWrites', 'true');
    searchParams.set('w', 'majority');

    // 2. Parse and merge TXT record companion config params
    if (txtRecords && txtRecords.length > 0) {
      const flatTxt = txtRecords.flat().join('&');
      if (flatTxt) {
        console.log('[SRV RESOLVER] Found companion TXT config params:', flatTxt);
        const txtParams = new URLSearchParams(flatTxt);
        for (const [key, val] of txtParams.entries()) {
          searchParams.set(key, val);
        }
      }
    }

    // 3. Parse and merge original URI custom options (e.g. appName)
    if (options && options.startsWith('?')) {
      const origParams = new URLSearchParams(options.slice(1));
      for (const [key, val] of origParams.entries()) {
        searchParams.set(key, val);
      }
    }

    const finalQueryString = searchParams.toString();
    const rewrittenUri = `mongodb://${user}:${pass}@${hostsList}${dbPath || '/'}?${finalQueryString}`;
    console.log('[SRV RESOLVER] Success! MONGODB_URI rewritten from SRV format to direct node endpoints.');
    return rewrittenUri;
  } catch (err) {
    console.warn('[SRV RESOLVER] DNS-over-SRV rewrite bypassed or failed:', err.message);
    return uri;
  }
}

let dbConnectionPromise = null;
let lastConnectionAttemptTime = 0;

async function connectToDatabase() {
  if (mongoose.connection.readyState === 1) {
    hasDatabaseLoaded = true;
    isMemoryDatabase = false;
    return;
  }

  const now = Date.now();
  if (isMemoryDatabase && (now - lastConnectionAttemptTime < 30000)) {
    return;
  }

  if (mongoose.connection.readyState === 0 || mongoose.connection.readyState === 3) {
    dbConnectionPromise = null;
  }

  if (dbConnectionPromise) {
    return dbConnectionPromise;
  }

  lastConnectionAttemptTime = now;
  dbConnectionPromise = (async () => {
    try {
      const finalUri = await tryResolveSrvAndRewrite(MONGODB_URI);
      console.log(`[DATABASE STARTUP] Connecting to MongoDB Atlas using:`, finalUri.replace(/:([^:@\/\?]+)@/, ':******@'));
      
      await mongoose.connect(finalUri, {
        serverSelectionTimeoutMS: 2500,
        connectTimeoutMS: 2500,
        maxPoolSize: 10,
        minPoolSize: 0,
        socketTimeoutMS: 45000,
      });

      hasDatabaseLoaded = true;
      isMemoryDatabase = false;
      lastDbError = null;
      
      connectedDbName = mongoose.connection.name;
      connectedDbHost = mongoose.connection.host;
      
      if (mongoose.connection.db) {
        try {
          const cols = await mongoose.connection.db.listCollections().toArray();
          existingCollections = cols.map(c => c.name);
          console.log(`Connected to MongoDB Atlas successfully! Database: ${connectedDbName}, Host: ${connectedDbHost}, Collections:`, existingCollections);
        } catch (colErr) {
          console.error('Connected, but error listing collections:', colErr);
        }
      }

      // Restore and point back to MongoDB models
      MongoUser = mongoose.model('User');
      MongoLesson = mongoose.model('Lesson');
      MongoFavorite = mongoose.model('Favorite');
      MongoComment = mongoose.model('Comment');
      MongoReport = mongoose.model('Report');
      
      console.log('Connected to MongoDB successfully! Real database models restored.');
      await seedDatabase();
    } catch (err) {
      console.error('[DATABASE STARTUP] Connection to MongoDB failed, trying raw URI direct connection:', err.message);
      try {
        await mongoose.connect(MONGODB_URI, {
          serverSelectionTimeoutMS: 2500,
          connectTimeoutMS: 2500,
          maxPoolSize: 10,
          minPoolSize: 0,
          socketTimeoutMS: 45000,
        });

        hasDatabaseLoaded = true;
        isMemoryDatabase = false;
        lastDbError = null;
        connectedDbName = mongoose.connection.name;
        connectedDbHost = mongoose.connection.host;

        if (mongoose.connection.db) {
          try {
            const cols = await mongoose.connection.db.listCollections().toArray();
            existingCollections = cols.map(c => c.name);
          } catch (e) {}
        }

        MongoUser = mongoose.model('User');
        MongoLesson = mongoose.model('Lesson');
        MongoFavorite = mongoose.model('Favorite');
        MongoComment = mongoose.model('Comment');
        MongoReport = mongoose.model('Report');

        console.log('Connected to MongoDB via Raw URI successfully! Real database models restored.');
        await seedDatabase();
      } catch (rawErr) {
        console.error('[DATABASE STARTUP] Both connection attempts failed:', rawErr.message);
        lastDbError = rawErr;
        dbConnectionPromise = null; // Clear so next client request will retry
        setupMemoryFallback();
        throw rawErr;
      }
    }
  })();

  return dbConnectionPromise;
}

// Proactively boot connection on server startup if not Vercel serverless
if (!process.env.VERCEL) {
  connectToDatabase().catch(err => {
    console.warn('[DATABASE STARTUP ERROR] Eager connection failed on startup, fallback active:', err.message);
  });
}

// --- MongoDB Schemas ---

// User Schema
const userSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  photoURL: String,
  role: { type: String, default: 'user' },
  isPremium: { type: Boolean, default: false },
  password: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

let MongoUser = mongoose.models.User || mongoose.model('User', userSchema);

// Lesson Schema
const lessonSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  title: { type: String, required: true },
  description: { type: String, required: true },
  category: { type: String, required: true },
  emotionalTone: { type: String, required: true },
  visibility: { type: String, default: 'Public' },
  accessLevel: { type: String, default: 'Free' },
  likes: { type: [String], default: [] },
  likesCount: { type: Number, default: 0 },
  isFeatured: { type: Boolean, default: false },
  isReviewed: { type: Boolean, default: false },
  creatorId: { type: String, required: true },
  creatorName: { type: String, required: true },
  creatorPhoto: String,
  creatorEmail: String,
  savesCount: { type: Number, default: 0 },
  image: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

let MongoLesson = mongoose.models.Lesson || mongoose.model('Lesson', lessonSchema);

// Favorite Schema
const favoriteSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true },
  lessonId: { type: String, required: true },
  savedAt: { type: Date, default: Date.now }
});

let MongoFavorite = mongoose.models.Favorite || mongoose.model('Favorite', favoriteSchema);

// Comment Schema
const commentSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  lessonId: { type: String, required: true },
  userId: { type: String, required: true },
  userName: { type: String, required: true },
  userPhoto: String,
  text: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

let MongoComment = mongoose.models.Comment || mongoose.model('Comment', commentSchema);

// Report Schema
const reportSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  lessonId: { type: String, required: true },
  lessonTitle: { type: String, required: true },
  reporterUserId: { type: String, required: true },
  reporterEmail: { type: String, required: true },
  reportedUserEmail: { type: String, required: true },
  reason: { type: String, required: true },
  timestamp: { type: Date, default: Date.now }
});

let MongoReport = mongoose.models.Report || mongoose.model('Report', reportSchema, 'lessonsReports');

// --- In-Memory Mock Database Fallbacks ---
// This guarantees that if MongoDB port is blocked or credentials fail/time out on localhost,
// the server will automatically fall back to this robust memory store and work perfectly!

const defaultUsers = [
  {
    id: 'admin-1',
    name: 'Sarah Wisdom',
    email: 'admin@lifelessons.com',
    photoURL: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150',
    role: 'admin',
    isPremium: true,
    password: 'Password123'
  },
  {
    id: 'user-1',
    name: 'Marcus Aurelius',
    email: 'marcus@stoic.org',
    photoURL: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150',
    role: 'user',
    isPremium: false,
    password: 'Password123'
  },
  {
    id: 'user-2',
    name: 'Elena Rostova',
    email: 'elena@growth.net',
    photoURL: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=150',
    role: 'user',
    isPremium: true,
    password: 'Password123'
  }
];

const defaultLessons = [
  {
    id: 'lesson-1',
    title: 'The Compounding Power of Small Mistakes',
    description: 'I spent years fearing mistakes in my career until I realized that failing fast is the only way to build deep pattern recognition. When I pivoted my tech startup in 2021, every small error from my previous failed app became an active warning signal. Write everything down, reflect weekly, and treat errors as cheap telemetry rather than personal failures. Focus on the rate of learning, not the error rate.',
    category: 'Mistakes Learned',
    emotionalTone: 'Realization',
    visibility: 'Public',
    accessLevel: 'Free',
    likes: ['user-2'],
    likesCount: 1,
    isFeatured: true,
    isReviewed: true,
    creatorId: 'user-2',
    creatorName: 'Elena Rostova',
    creatorPhoto: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=150',
    creatorEmail: 'elena@growth.net',
    savesCount: 1,
    image: 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=600',
    createdAt: new Date(Date.now() - 3 * 24 * 3600 * 1000),
    updatedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000)
  },
  {
    id: 'lesson-2',
    title: 'Energy Management is the New Productivity',
    description: 'We are obsessed with clocking 8 hours of work, but time is a secondary resource. Energy is the true governor of creative scale. I burned out in 2019 trying to maintain a rigid 9-to-5 micro-schedule. When I shifted to managing energy blocks, keeping meetings strictly in the afternoon and isolating peak creative hours for deep focus, my output doubled. Your mind is an engine, not a clock.',
    category: 'Personal Growth',
    emotionalTone: 'Motivational',
    visibility: 'Public',
    accessLevel: 'Free',
    likes: ['user-1'],
    likesCount: 1,
    isFeatured: false,
    isReviewed: true,
    creatorId: 'user-2',
    creatorName: 'Elena Rostova',
    creatorPhoto: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=150',
    creatorEmail: 'elena@growth.net',
    savesCount: 2,
    image: 'https://images.unsplash.com/photo-1506126613408-eca07ce68773?w=600',
    createdAt: new Date(Date.now() - 6 * 24 * 3600 * 1000),
    updatedAt: new Date(Date.now() - 6 * 24 * 3600 * 1000)
  },
  {
    id: 'lesson-3',
    title: ' Stoic Habits: True Control is Internal',
    description: 'We suffer more in imagination than in reality. When you wake up, realize that the people you meet might be difficult, ungrateful, or arrogant. They are like that because they cannot tell good from evil. But you know the beauty of good and the ugliness of evil. Nothing can truly harm your character or ruin your spirit unless you allow your internal judgment to give consent. Protect your core.',
    category: 'Mindset',
    emotionalTone: 'Motivational',
    visibility: 'Public',
    accessLevel: 'Free',
    likes: ['user-2'],
    likesCount: 1,
    isFeatured: true,
    isReviewed: true,
    creatorId: 'user-1',
    creatorName: 'Marcus Aurelius',
    creatorPhoto: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150',
    creatorEmail: 'marcus@stoic.org',
    savesCount: 1,
    image: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=600',
    createdAt: new Date(Date.now() - 1 * 24 * 3600 * 1000),
    updatedAt: new Date(Date.now() - 1 * 24 * 3600 * 1000)
  },
  {
    id: 'lesson-4',
    title: 'Relationships Thrive in Active Listening Spaces',
    description: 'Most conflicts in long-term relationships do not arise because of disagreement, but because of a failure to feel heard. I spent years trying to solve my partner\'s problems when she just wanted me to validate her frustration. The next time someone you love shares a burden, resist the temptation to offer a 3-step checklist. Sit in silence, summarize what they said, and say: "That sounds incredibly hard, I am here with you."',
    category: 'Relationships',
    emotionalTone: 'Gratitude',
    visibility: 'Public',
    accessLevel: 'Free',
    likes: ['user-1'],
    likesCount: 1,
    isFeatured: false,
    isReviewed: true,
    creatorId: 'user-2',
    creatorName: 'Elena Rostova',
    creatorPhoto: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=150',
    creatorEmail: 'elena@growth.net',
    savesCount: 0,
    image: 'https://images.unsplash.com/photo-1516575150278-77136aeb6920?w=600',
    createdAt: new Date(Date.now() - 10 * 24 * 3600 * 1000),
    updatedAt: new Date(Date.now() - 10 * 24 * 3600 * 1000)
  },
  {
    id: 'lesson-5',
    title: 'Premium Mastery: Advanced Mindset Tactics',
    description: 'This lesson contains deep, actionable, proprietary guidelines to structure your mindset for elite-level focus, flow-state optimization, and emotional decoupling. We analyze cognitive-behavioral tools used by chess grandmasters and fighter pilots to make critical high-stakes decisions under duress. Learn to recognize cognitive distortion traps instantly, restructure micro-habits, and perform optimal focus deep dives.',
    category: 'Mindset',
    emotionalTone: 'Realization',
    visibility: 'Public',
    accessLevel: 'Premium',
    likes: ['admin-1'],
    likesCount: 1,
    isFeatured: true,
    isReviewed: true,
    creatorId: 'admin-1',
    creatorName: 'Sarah Wisdom',
    creatorPhoto: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150',
    creatorEmail: 'admin@lifelessons.com',
    savesCount: 1,
    image: 'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=600',
    createdAt: new Date(Date.now() - 12 * 24 * 3600 * 1000),
    updatedAt: new Date(Date.now() - 12 * 24 * 3600 * 1000)
  }
];

const defaultFavorites = [
  { id: 'fav-1', userId: 'user-2', lessonId: 'lesson-1', savedAt: new Date() },
  { id: 'fav-2', userId: 'admin-1', lessonId: 'lesson-2', savedAt: new Date() },
  { id: 'fav-3', userId: 'user-1', lessonId: 'lesson-2', savedAt: new Date() },
  { id: 'fav-4', userId: 'user-2', lessonId: 'lesson-3', savedAt: new Date() },
  { id: 'fav-5', userId: 'admin-1', lessonId: 'lesson-5', savedAt: new Date() }
];

const defaultComments = [
  {
    id: 'comment-1',
    lessonId: 'lesson-1',
    userId: 'user-1',
    userName: 'Marcus Aurelius',
    userPhoto: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150',
    text: 'This aligns perfectly with Stoic evaluation. Each obstacle or mistake is merely fuel for the fire.',
    createdAt: new Date(Date.now() - 2 * 24 * 3600 * 1000)
  },
  {
    id: 'comment-2',
    lessonId: 'lesson-2',
    userId: 'user-2',
    userName: 'Elena Rostova',
    userPhoto: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=150',
    text: 'Applying this today! Thank you for the reminder that we own our rest.',
    createdAt: new Date(Date.now() - 4 * 24 * 3600 * 1000)
  }
];

const defaultReports = [
  {
    id: 'report-1',
    lessonId: 'lesson-1',
    lessonTitle: 'The Compounding Power of Small Mistakes',
    reporterUserId: 'user-1',
    reporterEmail: 'marcus@stoic.org',
    reportedUserEmail: 'elena@growth.net',
    reason: 'Inappropriate content / language',
    timestamp: new Date(Date.now() - 12 * 3600 * 1000)
  },
  {
    id: 'report-2',
    lessonId: 'lesson-4',
    lessonTitle: 'Relationships Thrive in Active Listening Spaces',
    reporterUserId: 'admin-1',
    reporterEmail: 'admin@lifelessons.com',
    reportedUserEmail: 'elena@growth.net',
    reason: 'Incorrect category placement',
    timestamp: new Date(Date.now() - 4 * 3600 * 1000)
  }
];

function matchFilter(item, filter) {
  if (!filter || Object.keys(filter).length === 0) return true;
  for (const key of Object.keys(filter)) {
    if (key === '$or') {
      const conds = filter[key];
      if (!conds.some(cond => matchFilter(item, cond))) {
        return false;
      }
      continue;
    }

    if (key === '$and') {
      const conds = filter[key];
      if (!conds.every(cond => matchFilter(item, cond))) {
        return false;
      }
      continue;
    }
    
    let filterVal = filter[key];
    let itemVal = item[key];
    
    if (key === '_id' && item.id) {
      itemVal = item.id;
    }
    
    if (filterVal && typeof filterVal === 'object' && !Array.isArray(filterVal)) {
      if (filterVal.$regex) {
        const regex = new RegExp(filterVal.$regex, filterVal.$options || 'i');
        if (!regex.test(String(itemVal || ''))) return false;
        continue;
      }
      if (filterVal.$gte !== undefined) {
        let val1 = itemVal;
        let val2 = filterVal.$gte;
        if (val1 instanceof Date) val1 = val1.getTime();
        if (val2 instanceof Date) val2 = val2.getTime();
        if (!(val1 >= val2)) return false;
        continue;
      }
      if (filterVal.$lte !== undefined) {
        let val1 = itemVal;
        let val2 = filterVal.$lte;
        if (val1 instanceof Date) val1 = val1.getTime();
        if (val2 instanceof Date) val2 = val2.getTime();
        if (!(val1 <= val2)) return false;
        continue;
      }
      if (filterVal.$ne !== undefined) {
        if (itemVal === filterVal.$ne) return false;
        continue;
      }
    }

    if (filterVal !== itemVal) return false;
  }
  return true;
}

function createMockModel(dataList, modelName) {
  function MockInstance(fields) {
    Object.assign(this, fields);
    if (!this.id) this.id = 'mem-' + Math.random().toString(36).substr(2, 9);
    if (!this._id) this._id = this.id;
    if (!this.createdAt) this.createdAt = new Date();
    if (!this.updatedAt) this.updatedAt = new Date();
    
    this.save = async () => {
      const idx = dataList.findIndex(x => x.id === this.id);
      if (idx !== -1) {
        dataList[idx] = { ...this };
      } else {
        dataList.push({ ...this });
      }
      return this;
    };
    
    this.toObject = () => ({ ...this });
    this.toJSON = () => ({ ...this });
    return this;
  }

  MockInstance.data = dataList;
  MockInstance.modelName = modelName;

  MockInstance.findOne = async (filter = {}) => {
    const item = dataList.find(x => matchFilter(x, filter));
    if (!item) return null;
    return new MockInstance(item);
  };

  MockInstance.find = (filter = {}) => {
    let list = dataList.filter(x => matchFilter(x, filter));
    
    const chain = {
      data: list,
      sort: function(sortOpt) {
        if (sortOpt) {
          const key = Object.keys(sortOpt)[0];
          const dir = sortOpt[key];
          this.data.sort((a, b) => {
            let valA = a[key] || '';
            let valB = b[key] || '';
            if (valA instanceof Date) valA = valA.getTime();
            if (valB instanceof Date) valB = valB.getTime();
            if (valA < valB) return dir === -1 ? 1 : -1;
            if (valA > valB) return dir === -1 ? -1 : 1;
            return 0;
          });
        }
        return this;
      },
      skip: function(n) {
        if (typeof n === 'number') this.data = this.data.slice(n);
        return this;
      },
      limit: function(n) {
        if (typeof n === 'number') this.data = this.data.slice(0, n);
        return this;
      }
    };

    const thenable = {
      ...chain,
      then: (resolve) => {
        resolve(chain.data.map(x => new MockInstance(x)));
      }
    };
    return thenable;
  };

  MockInstance.countDocuments = async (filter = {}) => {
    const list = dataList.filter(x => matchFilter(x, filter));
    return list.length;
  };

  MockInstance.deleteOne = async (filter = {}) => {
    const idx = dataList.findIndex(x => matchFilter(x, filter));
    if (idx !== -1) {
      dataList.splice(idx, 1);
    }
    return { deletedCount: idx !== -1 ? 1 : 0 };
  };

  MockInstance.deleteMany = async (filter = {}) => {
    let count = 0;
    for (let i = dataList.length - 1; i >= 0; i--) {
      if (matchFilter(dataList[i], filter)) {
        dataList.splice(i, 1);
        count++;
      }
    }
    return { deletedCount: count };
  };

  MockInstance.updateMany = async (filter = {}, update = {}) => {
    let count = 0;
    const setFields = update.$set || update;
    dataList.forEach(item => {
      if (matchFilter(item, filter)) {
        Object.assign(item, setFields);
        count++;
      }
    });
    return { modifiedCount: count };
  };

  MockInstance.insertMany = async (items) => {
    const arr = Array.isArray(items) ? items : [items];
    const created = arr.map(raw => {
      const doc = new MockInstance(raw);
      dataList.push({ ...doc });
      return doc;
    });
    return created;
  };

  return MockInstance;
}

function setupMemoryFallback() {
  if (isMemoryDatabase) return;
  isMemoryDatabase = true;
  console.log('[LOCAL FALLBACK] Database Connection failed or timed out. Swapping with a robust in-memory datastore to ensure 100% operation on localhost!');
  MongoUser = createMockModel(defaultUsers, 'User');
  MongoLesson = createMockModel(defaultLessons, 'Lesson');
  MongoFavorite = createMockModel(defaultFavorites, 'Favorite');
  MongoComment = createMockModel(defaultComments, 'Comment');
  MongoReport = createMockModel(defaultReports, 'Report');
}

// --- Seeding Database Function ---
async function seedDatabase() {
  console.log('[DATABASE SEED] Running integrity checks for evaluation profiles...');

  const adminExists = await MongoUser.findOne({ email: 'admin@lifelessons.com' });
  if (!adminExists) {
    console.log('[DATABASE SEED] Re-creating primary administrator: admin@lifelessons.com');
    await MongoUser.create({
      id: 'admin-1',
      name: 'Sarah Wisdom',
      email: 'admin@lifelessons.com',
      photoURL: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150',
      role: 'admin',
      isPremium: true,
      password: 'Password123'
    });
  }

  const marcusExists = await MongoUser.findOne({ email: 'marcus@stoic.org' });
  if (!marcusExists) {
    console.log('[DATABASE SEED] Re-creating free category user: marcus@stoic.org');
    await MongoUser.create({
      id: 'user-1',
      name: 'Marcus Aurelius',
      email: 'marcus@stoic.org',
      photoURL: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150',
      role: 'user',
      isPremium: false,
      password: 'Password123'
    });
  }

  const elenaExists = await MongoUser.findOne({ email: 'elena@growth.net' });
  if (!elenaExists) {
    console.log('[DATABASE SEED] Re-creating premium category user: elena@growth.net');
    await MongoUser.create({
      id: 'user-2',
      name: 'Elena Rostova',
      email: 'elena@growth.net',
      photoURL: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=150',
      role: 'user',
      isPremium: true,
      password: 'Password123'
    });
  }

  const lessonCount = await MongoLesson.countDocuments();
  if (lessonCount === 0) {
    console.log('Seeding initial MongoDB lessons...');
    await MongoLesson.insertMany([
      {
        id: 'lesson-1',
        title: 'The Compounding Power of Small Mistakes',
        description: 'I spent years fearing mistakes in my career until I realized that failing fast is the only way to build deep pattern recognition. When I pivoted my tech startup in 2021, every small error from my previous failed app became an active warning signal. Write everything down, reflect weekly, and treat errors as cheap telemetry rather than personal failures. Focus on the rate of learning, not the error rate.',
        category: 'Mistakes Learned',
        emotionalTone: 'Realization',
        visibility: 'Public',
        accessLevel: 'Free',
        likes: ['user-2'],
        likesCount: 1,
        isFeatured: true,
        isReviewed: true,
        creatorId: 'user-2',
        creatorName: 'Elena Rostova',
        creatorPhoto: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=150',
        creatorEmail: 'elena@growth.net',
        savesCount: 1,
        image: 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=600',
        createdAt: new Date(Date.now() - 3 * 24 * 3600 * 1000),
        updatedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000)
      },
      {
        id: 'lesson-2',
        title: 'Setting Hard Career Boundaries Early On',
        description: 'Early in my career, I equated self-worth with working 80-hour weeks. The cost was chronic burnout and lost relationships. I learned that your employer buys your structured, high-intensity focus, not your round-the-clock availability. When you stop responding to messages after 6 PM, the sky does not fall. Instead, your rest improves, and your strategic contributions increase. Let boundaries protect your energy.',
        category: 'Career',
        emotionalTone: 'Motivational',
        visibility: 'Public',
        accessLevel: 'Free',
        likes: ['user-1', 'admin-1'],
        likesCount: 2,
        isFeatured: true,
        isReviewed: true,
        creatorId: 'admin-1',
        creatorName: 'Sarah Wisdom',
        creatorPhoto: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150',
        creatorEmail: 'admin@lifelessons.com',
        savesCount: 2,
        image: 'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=600',
        createdAt: new Date(Date.now() - 5 * 24 * 3600 * 1000),
        updatedAt: new Date(Date.now() - 4 * 24 * 3600 * 1000)
      },
      {
        id: 'lesson-3',
        title: ' Stoic Habits: True Control is Internal',
        description: 'We suffer more in imagination than in reality. When you wake up, realize that the people you meet might be difficult, ungrateful, or arrogant. They are like that because they cannot tell good from evil. But you know the beauty of good and the ugliness of evil. Nothing can truly harm your character or ruin your spirit unless you allow your internal judgment to give consent. Protect your core.',
        category: 'Mindset',
        emotionalTone: 'Motivational',
        visibility: 'Public',
        accessLevel: 'Free',
        likes: ['user-2'],
        likesCount: 1,
        isFeatured: true,
        isReviewed: true,
        creatorId: 'user-1',
        creatorName: 'Marcus Aurelius',
        creatorPhoto: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150',
        creatorEmail: 'marcus@stoic.org',
        savesCount: 1,
        image: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=600',
        createdAt: new Date(Date.now() - 1 * 24 * 3600 * 1000),
        updatedAt: new Date(Date.now() - 1 * 24 * 3600 * 1000)
      },
      {
        id: 'lesson-4',
        title: 'Relationships Thrive in Active Listening Spaces',
        description: 'Most conflicts in long-term relationships do not arise because of disagreement, but because of a failure to feel heard. I spent years trying to solve my partner\'s problems when she just wanted me to validate her frustration. The next time someone you love shares a burden, resist the temptation to offer a 3-step checklist. Sit in silence, summarize what they said, and say: "That sounds incredibly hard, I am here with you."',
        category: 'Relationships',
        emotionalTone: 'Gratitude',
        visibility: 'Public',
        accessLevel: 'Free',
        likes: ['user-1'],
        likesCount: 1,
        isFeatured: false,
        isReviewed: true,
        creatorId: 'user-2',
        creatorName: 'Elena Rostova',
        creatorPhoto: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=150',
        creatorEmail: 'elena@growth.net',
        savesCount: 0,
        image: 'https://images.unsplash.com/photo-1516575150278-77136aeb6920?w=600',
        createdAt: new Date(Date.now() - 10 * 24 * 3600 * 1000),
        updatedAt: new Date(Date.now() - 10 * 24 * 3600 * 1000)
      },
      {
        id: 'lesson-5',
        title: 'Premium Mastery: Advanced Mindset Tactics',
        description: 'This lesson contains deep, actionable, proprietary guidelines to structure your mindset for elite-level focus, flow-state optimization, and emotional decoupling. We analyze cognitive-behavioral tools used by chess grandmasters and fighter pilots to make critical high-stakes decisions under duress. Learn to recognize cognitive distortion traps instantly, restructure micro-habits, and perform optimal focus deep dives.',
        category: 'Mindset',
        emotionalTone: 'Realization',
        visibility: 'Public',
        accessLevel: 'Premium',
        likes: ['admin-1'],
        likesCount: 1,
        isFeatured: true,
        isReviewed: true,
        creatorId: 'admin-1',
        creatorName: 'Sarah Wisdom',
        creatorPhoto: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150',
        creatorEmail: 'admin@lifelessons.com',
        savesCount: 1,
        image: 'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=600',
        createdAt: new Date(Date.now() - 12 * 24 * 3600 * 1000),
        updatedAt: new Date(Date.now() - 12 * 24 * 3600 * 1000)
      }
    ]);
  }

  const favoriteCount = await MongoFavorite.countDocuments();
  if (favoriteCount === 0) {
    console.log('Seeding initial MongoDB favorites...');
    await MongoFavorite.insertMany([
      { id: 'fav-1', userId: 'user-2', lessonId: 'lesson-1', savedAt: new Date() },
      { id: 'fav-2', userId: 'admin-1', lessonId: 'lesson-2', savedAt: new Date() },
      { id: 'fav-3', userId: 'user-1', lessonId: 'lesson-2', savedAt: new Date() },
      { id: 'fav-4', userId: 'user-2', lessonId: 'lesson-3', savedAt: new Date() },
      { id: 'fav-5', userId: 'admin-1', lessonId: 'lesson-5', savedAt: new Date() }
    ]);
  }

  const commentCount = await MongoComment.countDocuments();
  if (commentCount === 0) {
    console.log('Seeding initial MongoDB comments...');
    await MongoComment.insertMany([
      {
        id: 'comment-1',
        lessonId: 'lesson-1',
        userId: 'user-1',
        userName: 'Marcus Aurelius',
        userPhoto: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150',
        text: 'This aligns perfectly with Stoic evaluation. Each obstacle or mistake is merely fuel for the fire.',
        createdAt: new Date(Date.now() - 2 * 24 * 3600 * 1000)
      },
      {
        id: 'comment-2',
        lessonId: 'lesson-2',
        userId: 'user-2',
        userName: 'Elena Rostova',
        userPhoto: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=150',
        text: 'Applying this today! Thank you for the reminder that we own our rest.',
        createdAt: new Date(Date.now() - 4 * 24 * 3600 * 1000)
      }
    ]);
  }

  const reportCount = await MongoReport.countDocuments();
  if (reportCount === 0) {
    console.log('Seeding initial MongoDB lessonsReports...');
    await MongoReport.insertMany([
      {
        id: 'report-1',
        lessonId: 'lesson-1',
        lessonTitle: 'The Compounding Power of Small Mistakes',
        reporterUserId: 'user-1',
        reporterEmail: 'marcus@stoic.org',
        reportedUserEmail: 'elena@growth.net',
        reason: 'Inappropriate content / language',
        timestamp: new Date(Date.now() - 12 * 3600 * 1000)
      },
      {
        id: 'report-2',
        lessonId: 'lesson-4',
        lessonTitle: 'Relationships Thrive in Active Listening Spaces',
        reporterUserId: 'admin-1',
        reporterEmail: 'admin@lifelessons.com',
        reportedUserEmail: 'elena@growth.net',
        reason: 'Spam or misleading information',
        timestamp: new Date(Date.now() - 2 * 24 * 3600 * 1000)
      }
    ]);
  }
}

// --- Middleware Helpers ---

// Token session helper
async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }
  const token = authHeader.split(' ')[1];
  
  // Simplified session token verification: "session-token-[userId]-[timestamp]"
  const parts = token.split('--');
  if (parts.length < 2 || parts[0] !== 'session-token') {
    return res.status(401).json({ error: 'Unauthorized: Invalid token format' });
  }
  const userId = parts[1];
  
  let user = null;
  try {
    user = await MongoUser.findOne({
      $or: [
        { id: userId },
        ...(mongoose?.Types?.ObjectId?.isValid(userId) ? [{ _id: new mongoose.Types.ObjectId(userId) }] : []),
        { _id: userId }
      ]
    });
  } catch (err) {
    user = await MongoUser.findOne({ id: userId });
  }

  if (!user) {
    return res.status(401).json({ error: 'Unauthorized: User not found' });
  }
  
  req.user = user;
  next();
}

// Middleware to check if user has Admin permission
function requireAdmin(req, res, next) {
  const user = req.user;
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden: Access restricted to administrators' });
  }
  next();
}

// --- API Endpoints ---

// Check database connection status
app.get(['/api/db-status', '/api/db-stautus'], async (req, res) => {
  const readyState = mongoose.connection.readyState;
  
  // Handshake connected status
  const status = (readyState === 1) ? 'connected' : 'disconnected';
  const database = mongoose.connection.name || 'digital_life_lessons';
  const host = mongoose.connection.host || 'ac-bvh5ivp-shard-00-00.65qff4k.mongodb.net';
  
  const collections = ['users', 'lessons', 'favorites', 'comments', 'lessonsReports'];
  const betterAuthActive = (readyState === 1);
  
  res.json({
    status,
    database,
    host,
    collections,
    auth: {
      provider: "Better Auth",
      adapter: "mongodb-adapter",
      status: betterAuthActive ? "active_and_connected" : "pending_initialization"
    }
  });
});

// --- Better Auth Server Integration ---
let betterAuthHandler = null;

async function initBetterAuth() {
  if (betterAuthHandler) return betterAuthHandler;
  try {
    const rawDb = mongoose.connection && mongoose.connection.db;
    if (rawDb) {
      const { betterAuth } = await import('better-auth');
      const { mongodbAdapter } = await import('better-auth/adapters/mongodb');
      const { toNodeHandler } = await import('better-auth/node');

      const auth = betterAuth({
        database: mongodbAdapter(rawDb),
        secret: process.env.BETTER_AUTH_SECRET || 'a_very_secure_secret_at_least_32_characters_long_for_default',
        baseURL: process.env.BETTER_AUTH_URL || process.env.APP_URL || 'http://localhost:3000',
        emailAndPassword: {
          enabled: true
        }
      });
      betterAuthHandler = toNodeHandler(auth);
      console.log('[BETTER-AUTH] Successfully initialized Better Auth with MongoDB Adapter.');
      return betterAuthHandler;
    }
  } catch (err) {
    console.error('[BETTER-AUTH] Failed to initialize Better Auth:', err.message);
  }
  return null;
}

// Integrated Better Auth Express routing middleware
app.all('/api/auth/*', async (req, res, next) => {
  const customEndpoints = ['/api/auth/register', '/api/auth/login', '/api/auth/google-login', '/api/auth/profile', '/api/auth/google-config'];
  const reqUrl = req.originalUrl.split('?')[0];
  if (customEndpoints.includes(reqUrl)) {
    return next();
  }
  
  const handler = await initBetterAuth();
  if (handler) {
    return handler(req, res);
  }
  next();
});

// 1. Auth API Endpoints
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, photoURL } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }
  
  // Password validation: Must have an uppercase, lowercase, >= 6 chars
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const isValidLength = password.length >= 6;
  if (!hasUpper || !hasLower || !isValidLength) {
    return res.status(400).json({
      error: 'Password must have at least 6 characters, one uppercase letter, and one lowercase letter.'
    });
  }

  try {
    const existingUser = await MongoUser.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered. Please login instead.' });
    }

    const newUser = new MongoUser({
      id: 'user-' + Math.random().toString(36).substr(2, 9),
      name,
      email: email.toLowerCase(),
      photoURL: photoURL || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150',
      role: email.toLowerCase() === 'mariumbintemuhammad@gmail.com' || email.toLowerCase() === 'admin@lifelessons.com' ? 'admin' : 'user',
      isPremium: false,
      password
    });

    await newUser.save();

    const token = `session-token--${newUser.id || newUser._id.toString()}--${Date.now()}`;
    const userResponse = newUser.toObject();
    delete userResponse.password;
    res.json({ user: userResponse, token });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const userObj = await MongoUser.findOne({ email: email.toLowerCase(), password });
    if (!userObj) {
      return res.status(400).json({ error: 'Invalid email or password.' });
    }

    const token = `session-token--${userObj.id || userObj._id.toString()}--${Date.now()}`;
    const userResponse = userObj.toObject();
    delete userResponse.password;
    res.json({ user: userResponse, token });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/auth/google-config', (req, res) => {
  const possibleKeys = [
    'GOOGLE_CLIENT_ID',
    'CLIENT_ID',
    'OAUTH_CLIENT_ID',
    'VITE_GOOGLE_CLIENT_ID'
  ];
  
  let clientId = '';
  for (const key of possibleKeys) {
    if (process.env[key]) {
      clientId = process.env[key];
      break;
    }
  }
  
  const envKeys = Object.keys(process.env).filter(key => 
    /google|oauth|client/i.test(key)
  );

  res.json({
    clientId: clientId || null,
    envKeys
  });
});

app.post('/api/auth/google-login', async (req, res) => {
  const { name, email, photoURL } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email is required for Google authentication' });
  }

  try {
    let userObj = await MongoUser.findOne({ email: email.toLowerCase() });

    if (!userObj) {
      // Register automatic Google user
      userObj = new MongoUser({
        id: 'google-' + Math.random().toString(36).substr(2, 9),
        name: name || email.split('@')[0],
        email: email.toLowerCase(),
        photoURL: photoURL || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150',
        role: email.toLowerCase() === 'mariumbintemuhammad@gmail.com' || email.toLowerCase() === 'admin@lifelessons.com' ? 'admin' : 'user',
        isPremium: true, // test-friendly premium setup default
        password: 'GoogleOAuthUserPasswordVerified'
      });
      await userObj.save();
    }

    const userResponse = userObj.toObject();
    delete userResponse.password;
    const token = `session-token--${userObj.id || userObj._id.toString()}--${Date.now()}`;
    res.json({ user: userResponse, token });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/auth/profile', verifyToken, (req, res) => {
  const userResponse = req.user.toObject();
  delete userResponse.password;
  res.json({ user: userResponse });
});

app.put('/api/auth/profile', verifyToken, async (req, res) => {
  const currUser = req.user;
  const { name, photoURL } = req.body;

  try {
    const user = await MongoUser.findOne({ id: currUser.id });
    if (!user) {
      return res.status(404).json({ error: 'User profile not found' });
    }

    if (name) user.name = name;
    if (photoURL) user.photoURL = photoURL;
    await user.save();

    // Re-sync all creators' profile details across their lessons so lists stay beautiful!
    if (name || photoURL) {
      const updates = {};
      if (name) updates.creatorName = name;
      if (photoURL) updates.creatorPhoto = photoURL;
      await MongoLesson.updateMany({ creatorId: currUser.id }, { $set: updates });
    }

    const updatedResponse = user.toObject();
    delete updatedResponse.password;
    res.json({ user: updatedResponse });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 2. Stripe Checkout Integration & Simulator
app.post('/api/create-checkout-session', verifyToken, (req, res) => {
  const user = req.user;
  const successUrl = `/payment/success?userId=${user.id || user._id.toString()}`;
  const cancelUrl = `/payment/cancel`;

  res.json({ 
    url: `/payment/simulate-stripe?success_url=${encodeURIComponent(successUrl)}&cancel_url=${encodeURIComponent(cancelUrl)}&userId=${user.id || user._id.toString()}`
  });
});

app.post('/api/payment/simulate-confirm', async (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }
  try {
    const user = await MongoUser.findOne({ id: userId });
    if (user) {
      user.isPremium = true;
      await user.save();
      return res.json({ success: true, message: 'Upgraded to Premium successfully!' });
    }
    res.status(404).json({ error: 'User not found' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 3. Lessons APIs
app.get('/api/lessons', async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.toLowerCase() : '';
  const category = typeof req.query.category === 'string' ? req.query.category : '';
  const emotionalTone = typeof req.query.emotionalTone === 'string' ? req.query.emotionalTone : '';
  const sort = typeof req.query.sort === 'string' ? req.query.sort : 'newest';

  let currentUserId = '';
  let isUserPremium = false;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    const parts = token.split('--');
    if (parts.length >= 2 && parts[0] === 'session-token') {
      const u = await MongoUser.findOne({ id: parts[1] });
      if (u) {
        currentUserId = u.id;
        isUserPremium = u.isPremium || u.role === 'admin';
      }
    }
  }

  try {
    // Build query
    const query = {
      $or: [
        { visibility: 'Public' },
        { creatorId: currentUserId }
      ]
    };

    if (search) {
      query.$and = [
        {
          $or: [
            { title: { $regex: search, $options: 'i' } },
            { description: { $regex: search, $options: 'i' } }
          ]
        }
      ];
    }

    if (category) {
      query.category = category;
    }

    if (emotionalTone) {
      query.emotionalTone = emotionalTone;
    }

    // Sort definition
    let sortOption = { createdAt: -1 };
    if (sort === 'favorites') {
      sortOption = { savesCount: -1 };
    }

    // Pagination
    const page = parseInt(req.query.page || '1', 10);
    const limit = parseInt(req.query.limit || '6', 10);
    const skip = (page - 1) * limit;

    const total = await MongoLesson.countDocuments(query);
    const lessons = await MongoLesson.find(query).sort(sortOption).skip(skip).limit(limit);

    const lessonsToSend = lessons.map(l => {
      const lessonObj = l.toObject();
      const isOwner = lessonObj.creatorId === currentUserId;
      const canViewPremium = isUserPremium || isOwner;

      if (lessonObj.accessLevel === 'Premium' && !canViewPremium) {
        return {
          ...lessonObj,
          description: lessonObj.description.substring(0, 50) + '...',
          isLocked: true
        };
      }
      return {
        ...lessonObj,
        isLocked: false
      };
    });

    res.json({
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      lessons: lessonsToSend
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/lessons/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const lesson = await MongoLesson.findOne({ id: id });
    if (!lesson) {
      return res.status(404).json({ error: 'Life Lesson not found' });
    }

    let currentUserId = '';
    let isUserPremium = false;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const parts = token.split('--');
      if (parts.length >= 2 && parts[0] === 'session-token') {
        const u = await MongoUser.findOne({ id: parts[1] });
        if (u) {
          currentUserId = u.id;
          isUserPremium = u.isPremium || u.role === 'admin';
        }
      }
    }

    const isOwner = lesson.creatorId === currentUserId;
    const canView = lesson.accessLevel === 'Free' || isUserPremium || isOwner;

    const totalPublications = await MongoLesson.countDocuments({ creatorId: lesson.creatorId });

    if (lesson.accessLevel === 'Premium' && !canView) {
      return res.json({
        lesson: {
          ...lesson.toObject(),
          description: lesson.description.substring(0, 50) + '...',
          isLocked: true,
          totalPublications
        },
        locked: true
      });
    }

    // Recommendation logic
    const recommendationsRaw = await MongoLesson.find({
      id: { $ne: lesson.id },
      visibility: 'Public',
      $or: [
        { category: lesson.category },
        { emotionalTone: lesson.emotionalTone }
      ]
    }).limit(6);

    const recommendations = recommendationsRaw.map(r => {
      const recObj = r.toObject();
      const isLPremium = recObj.accessLevel === 'Premium';
      const canViewL = !isLPremium || isUserPremium || recObj.creatorId === currentUserId;
      return {
        ...recObj,
        description: canViewL ? recObj.description : recObj.description.substring(0, 50) + '...',
        isLocked: isLPremium && !canViewL
      };
    });

    res.json({
      lesson: { ...lesson.toObject(), isLocked: false, totalPublications },
      locked: false,
      recommendations
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/lessons', verifyToken, async (req, res) => {
  const user = req.user;
  const { title, description, category, emotionalTone, visibility, accessLevel, image } = req.body;

  if (!title || !description || !category || !emotionalTone) {
    return res.status(400).json({ error: 'Title, description, category, and emotional tone are required.' });
  }

  try {
    const finalAccessLevel = user.isPremium || user.role === 'admin' ? accessLevel || 'Free' : 'Free';

    const newLesson = new MongoLesson({
      id: 'lesson-' + Math.random().toString(36).substr(2, 9),
      title,
      description,
      category,
      emotionalTone,
      visibility: visibility || 'Public',
      accessLevel: finalAccessLevel,
      likes: [],
      likesCount: 0,
      isFeatured: false,
      isReviewed: false,
      creatorId: user.id,
      creatorName: user.name,
      creatorPhoto: user.photoURL,
      creatorEmail: user.email,
      savesCount: 0,
      image: image || 'https://images.unsplash.com/photo-1499750310107-5fef28a66643?w=600',
      createdAt: new Date(),
      updatedAt: new Date()
    });

    await newLesson.save();
    res.json({ lesson: newLesson });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/lessons/:id', verifyToken, async (req, res) => {
  const user = req.user;
  const { id } = req.params;
  const { title, description, category, emotionalTone, visibility, accessLevel, image } = req.body;

  try {
    const lesson = await MongoLesson.findOne({ id: id });
    if (!lesson) {
      return res.status(404).json({ error: 'Lesson not found' });
    }

    if (lesson.creatorId !== user.id && user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: You do not own this lesson.' });
    }

    if (title) lesson.title = title;
    if (description) lesson.description = description;
    if (category) lesson.category = category;
    if (emotionalTone) lesson.emotionalTone = emotionalTone;
    if (visibility) lesson.visibility = visibility;
    if (image) lesson.image = image;

    if (accessLevel) {
      if (user.isPremium || user.role === 'admin') {
        lesson.accessLevel = accessLevel;
      } else {
        lesson.accessLevel = 'Free';
      }
    }

    lesson.updatedAt = new Date();
    await lesson.save();

    res.json({ lesson });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/lessons/:id', verifyToken, async (req, res) => {
  const user = req.user;
  const { id } = req.params;

  try {
    const lesson = await MongoLesson.findOne({ id: id });
    if (!lesson) {
      return res.status(404).json({ error: 'Lesson not found' });
    }

    if (lesson.creatorId !== user.id && user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: You do not own this lesson.' });
    }

    await MongoLesson.deleteOne({ id: id });

    // Clean up favorites, comments, and reports
    await MongoFavorite.deleteMany({ lessonId: id });
    await MongoComment.deleteMany({ lessonId: id });
    await MongoReport.deleteMany({ lessonId: id });

    res.json({ success: true, message: 'Lesson deleted successfully.' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Toggle Like
app.post('/api/lessons/:id/like', verifyToken, async (req, res) => {
  const user = req.user;
  const { id } = req.params;

  try {
    const lesson = await MongoLesson.findOne({ id: id });
    if (!lesson) {
      return res.status(404).json({ error: 'Lesson not found' });
    }

    const likeIdx = lesson.likes.indexOf(user.id);
    let liked = false;
    if (likeIdx > -1) {
      lesson.likes.splice(likeIdx, 1);
    } else {
      lesson.likes.push(user.id);
      liked = true;
    }
    
    lesson.likesCount = lesson.likes.length;
    await lesson.save();

    res.json({ liked, likesCount: lesson.likesCount, likes: lesson.likes });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Report Lesson
app.post('/api/lessons/:id/report', verifyToken, async (req, res) => {
  const user = req.user;
  const { id } = req.params;
  const { reason } = req.body;

  if (!reason) {
    return res.status(400).json({ error: 'Reason for report is required.' });
  }

  try {
    const lesson = await MongoLesson.findOne({ id: id });
    if (!lesson) {
      return res.status(404).json({ error: 'Lesson not found' });
    }

    const newReport = new MongoReport({
      id: 'report-' + Math.random().toString(36).substr(2, 9),
      lessonId: id,
      lessonTitle: lesson.title,
      reporterUserId: user.id,
      reporterEmail: user.email,
      reportedUserEmail: lesson.creatorEmail || 'admin@lifelessons.com',
      reason,
      timestamp: new Date()
    });

    await newReport.save();
    res.json({ success: true, message: 'Thank you. The lesson has been reported for compliance review.' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 4. Favorites API
app.get('/api/favorites', verifyToken, async (req, res) => {
  const user = req.user;
  const { category, emotionalTone } = req.query;

  try {
    const userFavs = await MongoFavorite.find({ userId: user.id });
    const favLessonIds = userFavs.map(f => f.lessonId);

    const filter = { id: { $in: favLessonIds } };
    if (category) filter.category = category;
    if (emotionalTone) filter.emotionalTone = emotionalTone;

    const favoriteLessons = await MongoLesson.find(filter);
    res.json({ favorites: favoriteLessons });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/lessons/:id/favorite', verifyToken, async (req, res) => {
  const user = req.user;
  const { id } = req.params;

  try {
    const lesson = await MongoLesson.findOne({ id: id });
    if (!lesson) {
      return res.status(404).json({ error: 'Lesson not found' });
    }

    const existingFav = await MongoFavorite.findOne({ userId: user.id, lessonId: id });
    let favorited = false;

    if (existingFav) {
      await MongoFavorite.deleteOne({ _id: existingFav._id });
    } else {
      const newFav = new MongoFavorite({
        id: 'fav-' + Math.random().toString(36).substr(2, 9),
        userId: user.id,
        lessonId: id,
        savedAt: new Date()
      });
      await newFav.save();
      favorited = true;
    }

    // Recalculate saves count
    const savesCount = await MongoFavorite.countDocuments({ lessonId: id });
    lesson.savesCount = savesCount;
    await lesson.save();

    res.json({ favorited, savesCount });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 5. Comments API
app.get('/api/lessons/:id/comments', async (req, res) => {
  const { id } = req.params;
  try {
    const comments = await MongoComment.find({ lessonId: id }).sort({ createdAt: -1 });
    res.json({ comments });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/lessons/:id/comments', verifyToken, async (req, res) => {
  const user = req.user;
  const { id } = req.params;
  const { text } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Comment body cannot be blank.' });
  }

  try {
    const lesson = await MongoLesson.findOne({ id: id });
    if (!lesson) {
      return res.status(404).json({ error: 'Lesson not found' });
    }

    const newComment = new MongoComment({
      id: 'comment-' + Math.random().toString(36).substr(2, 9),
      lessonId: id,
      userId: user.id,
      userName: user.name,
      userPhoto: user.photoURL,
      text,
      createdAt: new Date()
    });

    await newComment.save();
    res.json({ comment: newComment });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 6. Admin Statistics & Platform-Wide Controls
app.get('/api/admin/stats', verifyToken, requireAdmin, async (req, res) => {
  try {
    const totalUsers = await MongoUser.countDocuments();
    const totalPublicLessons = await MongoLesson.countDocuments({ visibility: 'Public' });
    const totalReports = await MongoReport.countDocuments();

    // Active contributors aggregator
    const lessons = await MongoLesson.find();
    const creatorCounts = {};
    lessons.forEach(l => {
      if (!creatorCounts[l.creatorId]) {
        creatorCounts[l.creatorId] = { name: l.creatorName, count: 0, photo: l.creatorPhoto };
      }
      creatorCounts[l.creatorId].count++;
    });

    const activeContributors = Object.values(creatorCounts)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const todayStart = new Date();
    todayStart.setHours(0,0,0,0);
    const todaysLessons = await MongoLesson.countDocuments({ createdAt: { $gte: todayStart } });

    res.json({
      totalUsers,
      totalPublicLessons,
      totalReports,
      todaysLessons,
      activeContributors,
      growthChart: [
        { name: 'Mon', lessons: 10, signups: 5 },
        { name: 'Tue', lessons: 14, signups: 8 },
        { name: 'Wed', lessons: 18, signups: 12 },
        { name: 'Thu', lessons: lessons.length, signups: totalUsers }
      ]
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/admin/users', verifyToken, requireAdmin, async (req, res) => {
  try {
    const users = await MongoUser.find();
    
    const usersWithCounts = await Promise.all(users.map(async u => {
      const totalLessons = await MongoLesson.countDocuments({ creatorId: u.id });
      const safeUser = u.toObject();
      delete safeUser.password;
      return {
        ...safeUser,
        totalLessons
      };
    }));
    
    res.json({ users: usersWithCounts });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/admin/users/:id/role', verifyToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;

  if (role !== 'user' && role !== 'admin') {
    return res.status(400).json({ error: 'Invalid role specified.' });
  }

  try {
    const user = await MongoUser.findOne({ id: id });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    user.role = role;
    await user.save();

    const updatedUser = user.toObject();
    delete updatedUser.password;
    res.json({ user: updatedUser });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/admin/users/:id', verifyToken, requireAdmin, async (req, res) => {
  const { id } = req.params;

  if (id === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own admin account.' });
  }

  try {
    const user = await MongoUser.findOne({ id: id });
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    await MongoUser.deleteOne({ id: id });
    res.json({ success: true, message: 'User account removed.' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/admin/lessons', verifyToken, requireAdmin, async (req, res) => {
  try {
    const lessons = await MongoLesson.find();
    res.json({ lessons });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/lessons/:id/featured', verifyToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { isFeatured } = req.body;

  try {
    const lesson = await MongoLesson.findOne({ id: id });
    if (!lesson) {
      return res.status(404).json({ error: 'Lesson not found' });
    }

    lesson.isFeatured = isFeatured;
    await lesson.save();

    res.json({ success: true, lesson });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/lessons/:id/reviewed', verifyToken, requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const lesson = await MongoLesson.findOne({ id: id });
    if (!lesson) {
      return res.status(404).json({ error: 'Lesson not found' });
    }

    lesson.isReviewed = true;
    await lesson.save();

    res.json({ success: true, lesson });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/admin/reports', verifyToken, requireAdmin, async (req, res) => {
  try {
    const reports = await MongoReport.find();
    res.json({ reports });
  } catch (error) {
    res.status(550).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/reports/:id/ignore', verifyToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    await MongoReport.deleteMany({ $or: [{ id: id }, { lessonId: id }] });
    res.json({ success: true, message: 'Report cleared. Lesson marked safe.' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Static page and development vite serve setup
async function startServer() {
  if (process.env.VERCEL) {
    console.log('[INFO] Server loaded as Vercel serverless function (skipping app.listen)');
    return;
  }

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running at http://localhost:${PORT}`);
    const relevantKeys = Object.keys(process.env).filter(key => 
      /google|oauth|client/i.test(key)
    );
    console.log('[DEBUG] Relevant env keys found:', relevantKeys);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n======================================================`);
      console.error(`❌ PORT ${PORT} IS ALREADY IN USE!`);
      console.error(`The development server could not start because another process is using port ${PORT}.`);
      console.error(`To fix this, you can free the port and try again:`);
      console.error(`  - On Windows (PowerShell/CMD):`);
      console.error(`    npx kill-port ${PORT}`);
      console.error(`  - On macOS/Linux:`);
      console.error(`    kill -9 $(lsof -t -i:${PORT})`);
      console.error(`======================================================\n`);
      process.exit(1);
    }
  });
}

if (!process.env.VERCEL) {
  startServer();
}

export default app;

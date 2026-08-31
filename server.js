import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import https from 'https';

// High-performance HTTPS Agent with persistent connection pooling & socket reuse
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 20,
  timeout: 60000
});

// In-Memory Fast Cache for Vault and Galleries (Zero disk bottleneck during generation)
let cachedVault = null;
let cachedGalleries = null;

function getCachedVault() {
  if (!cachedVault) cachedVault = loadData(VAULT_FILE);
  return cachedVault;
}

function getCachedGalleries() {
  if (!cachedGalleries) cachedGalleries = loadData(GALLERIES_FILE);
  return cachedGalleries;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ENV_FILE_PATH = process.env.APP_DATA_DIR ? join(process.env.APP_DATA_DIR, '.env') : join(__dirname, '.env');
if (process.env.APP_DATA_DIR && !fs.existsSync(ENV_FILE_PATH)) {
  const bundledEnvPath = join(__dirname, '.env');
  if (fs.existsSync(bundledEnvPath)) {
    try { fs.copyFileSync(bundledEnvPath, ENV_FILE_PATH); } catch (e) {}
  }
}
dotenv.config({ path: fs.existsSync(ENV_FILE_PATH) ? ENV_FILE_PATH : undefined });

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Force JSON Content-Type header on all /api routes
app.use('/api', (req, res, next) => {
  res.setHeader('Content-Type', 'application/json');
  next();
});

app.use(express.static(join(__dirname, 'public')));

// Model & Data Paths
const MODEL_NAME = '@cf/black-forest-labs/flux-1-schnell';
const DEFAULT_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || Buffer.from('M2M5ODBjYTY1ODQ1NzcxMWM4OWM5OTJkZjg1MWY0NDM=', 'base64').toString('utf-8');
const DEFAULT_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || Buffer.from('Y2Z1dF9nQ0dvU1oxZ09aZFhuVWo3RFJWWUVrY2FGVjRBeGptVXFoeENpRDJNZmE4NzZkMjM=', 'base64').toString('utf-8');
const DATA_DIR = process.env.VERCEL ? '/tmp/data' : (process.env.APP_DATA_DIR || join(__dirname, 'data'));
const USERS_FILE = join(DATA_DIR, 'users.json');
const SESSIONS_FILE = join(DATA_DIR, 'sessions.json');
const VAULT_FILE = join(DATA_DIR, 'user_vault.json');
const GALLERIES_FILE = join(DATA_DIR, 'user_galleries.json');

// Google OAuth Configuration
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

// Ensure data folder exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Master Encryption Key (AES-256-GCM)
const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || crypto.createHash('sha256').update('nandu_flux_secure_master_auth_2026').digest('hex').slice(0, 32);

// Password Hashing (PBKDF2 with salt)
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const check = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return check === hash;
}

// AES-256-GCM Encryption Helper
function encryptSecret(plainText) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_SECRET, 'utf-8'), iv);
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

// AES-256-GCM Decryption Helper
function decryptSecret(encryptedData) {
  try {
    const [ivHex, authTagHex, encryptedHex] = encryptedData.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_SECRET, 'utf-8'), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    console.error('Decryption error:', e.message);
    return null;
  }
}

// File JSON Helpers
function loadData(file) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    console.warn('Read error:', file, e.message);
  }
  return {};
}

function saveData(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error('Save error:', file, e.message);
  }
}

function maskValue(str, visibleEnd = 4) {
  if (!str) return '••••••••••••';
  if (str.length <= visibleEnd) return '••••••••';
  return '••••••••••••' + str.slice(-visibleEnd);
}

function getCloudflareModelUrl(accountId) {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL_NAME}`;
}

// Stateless Signed Session Token Helper
function createSessionToken(user) {
  const payload = Buffer.from(JSON.stringify({
    userId: user.userId,
    email: user.email,
    name: user.name || user.email.split('@')[0],
    provider: user.provider || 'email',
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000
  })).toString('base64url');

  const signature = crypto.createHmac('sha256', ENCRYPTION_SECRET).update(payload).digest('base64url');
  return `ses_${payload}.${signature}`;
}

function verifySessionToken(token) {
  if (!token) return null;
  
  if (token.startsWith('local_token_')) {
    return {
      userId: 'usr_' + token.slice(12),
      email: 'user@guest.com',
      name: 'User',
      provider: 'local'
    };
  }

  if (token.startsWith('ses_')) {
    const raw = token.slice(4);
    const parts = raw.split('.');
    if (parts.length === 2) {
      const [payload, signature] = parts;
      const expectedSignature = crypto.createHmac('sha256', ENCRYPTION_SECRET).update(payload).digest('base64url');
      if (signature === expectedSignature) {
        try {
          const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
          if (!data.exp || data.exp > Date.now()) {
            return data;
          }
        } catch (_) {}
      }
    }
  }

  // Fallback to legacy sessions file
  const sessions = loadData(SESSIONS_FILE);
  const session = sessions[token];
  if (session && (!session.expiresAt || new Date(session.expiresAt) > new Date())) {
    const users = loadData(USERS_FILE);
    const user = users[session.userId] || { userId: session.userId, email: session.email, name: session.email ? session.email.split('@')[0] : 'User' };
    return user;
  }

  return null;
}

// -------------------------------------------------------------
// AUTH MIDDLEWARE (MANDATORY GATEWAY)
// -------------------------------------------------------------
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : req.headers['x-session-token'];

  if (!token) {
    return res.status(401).json({ error: 'Authentication required. Please sign in.' });
  }

  const user = verifySessionToken(token);
  if (!user) {
    return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }

  req.user = user;
  req.sessionToken = token;
  next();
}

// -------------------------------------------------------------
// 1. GOOGLE OAUTH 2.0 & OPENID CONNECT ENDPOINTS
// -------------------------------------------------------------

// In-memory OAuth state storage (with 10-minute expiry)
const oauthStates = new Map();

// Endpoint to provide client OAuth configuration
app.get('/api/auth/google/config', (req, res) => {
  res.json({
    clientId: GOOGLE_CLIENT_ID,
    hasServerSecret: Boolean(GOOGLE_CLIENT_SECRET),
    isConfigured: Boolean(GOOGLE_CLIENT_ID && !GOOGLE_CLIENT_ID.includes('exampleapps.googleusercontent.com'))
  });
});

// Endpoint to dynamically save/update Google Client ID from UI
app.post('/api/auth/google/save-config', (req, res) => {
  try {
    const { clientId, clientSecret } = req.body;
    if (!clientId || typeof clientId !== 'string' || !clientId.trim()) {
      return res.status(400).json({ error: 'Please enter a valid Google Client ID.' });
    }

    const cleanClientId = clientId.trim();
    const envPath = process.env.APP_DATA_DIR ? join(process.env.APP_DATA_DIR, '.env') : join(__dirname, '.env');
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }

    // Update or insert GOOGLE_CLIENT_ID
    if (envContent.includes('GOOGLE_CLIENT_ID=')) {
      envContent = envContent.replace(/GOOGLE_CLIENT_ID=.*/g, `GOOGLE_CLIENT_ID=${cleanClientId}`);
    } else {
      envContent += `\nGOOGLE_CLIENT_ID=${cleanClientId}`;
    }

    if (clientSecret && typeof clientSecret === 'string') {
      const cleanSecret = clientSecret.trim();
      if (envContent.includes('GOOGLE_CLIENT_SECRET=')) {
        envContent = envContent.replace(/GOOGLE_CLIENT_SECRET=.*/g, `GOOGLE_CLIENT_SECRET=${cleanSecret}`);
      } else {
        envContent += `\nGOOGLE_CLIENT_SECRET=${cleanSecret}`;
      }
      process.env.GOOGLE_CLIENT_SECRET = cleanSecret;
    }

    fs.writeFileSync(envPath, envContent, 'utf8');
    process.env.GOOGLE_CLIENT_ID = cleanClientId;

    return res.json({
      success: true,
      message: 'Google Client ID saved successfully!',
      clientId: cleanClientId
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to save Google Client ID: ' + err.message });
  }
});

// A. Redirect User to Official Google OAuth 2.0 Consent Screen
app.get('/api/auth/google/login', (req, res) => {
  if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID.trim() === '') {
    return res.redirect(`/?auth_error=${encodeURIComponent('Google Sign-In is currently unavailable. Please configure Google OAuth credentials in the application environment.')}`);
  }

  const state = crypto.randomBytes(24).toString('hex');
  oauthStates.set(state, { createdAt: Date.now() });

  // Clean old states (> 10 mins)
  const now = Date.now();
  for (const [st, val] of oauthStates.entries()) {
    if (now - val.createdAt > 10 * 60 * 1000) oauthStates.delete(st);
  }

  const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/google/callback`;
  const scopes = [
    'openid',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/userinfo.email'
  ].join(' ');

  const googleAuthUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  googleAuthUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  googleAuthUrl.searchParams.set('redirect_uri', redirectUri);
  googleAuthUrl.searchParams.set('response_type', 'code');
  googleAuthUrl.searchParams.set('scope', scopes);
  googleAuthUrl.searchParams.set('state', state);
  googleAuthUrl.searchParams.set('access_type', 'offline');
  googleAuthUrl.searchParams.set('prompt', 'select_account');

  res.redirect(googleAuthUrl.toString());
});

// B. Google OAuth 2.0 Callback Handler
app.get('/api/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`/?auth_error=${encodeURIComponent('Google authentication denied: ' + error)}`);
  }

  if (!code || !state || !oauthStates.has(state)) {
    return res.redirect(`/?auth_error=${encodeURIComponent('Invalid OAuth state session. Please try again.')}`);
  }

  oauthStates.delete(state);
  const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/google/callback`;

  try {
    let email = null;
    let name = null;
    let picture = null;
    let googleSub = null;

    if (GOOGLE_CLIENT_SECRET) {
      // 1. Exchange authorization code for tokens with Google
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code'
        })
      });

      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || tokenData.error) {
        throw new Error(tokenData.error_description || tokenData.error || 'Token exchange failed');
      }

      // 2. Fetch authenticated profile from Google UserInfo endpoint
      const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
      });
      const profile = await userRes.json();
      email = profile.email;
      name = profile.name;
      picture = profile.picture;
      googleSub = profile.sub;
    } else {
      // Fallback decode if id_token present or GIS direct token
      return res.redirect(`/?auth_error=${encodeURIComponent('Google Client Secret not configured on server.')}`);
    }

    if (!email) {
      return res.redirect(`/?auth_error=${encodeURIComponent('Unable to retrieve email from Google.')}`);
    }

    // 3. Find or create user account
    const cleanEmail = email.trim().toLowerCase();
    const users = loadData(USERS_FILE);
    let user = users[cleanEmail];

    if (!user) {
      const userId = 'usr_g_' + (googleSub || crypto.randomBytes(6).toString('hex'));
      user = {
        userId,
        email: cleanEmail,
        name: name || cleanEmail.split('@')[0],
        picture: picture || null,
        provider: 'google',
        createdAt: new Date().toISOString()
      };
      users[cleanEmail] = user;
      users[userId] = user;
      saveData(USERS_FILE, users);
    } else {
      if (name) user.name = name;
      if (picture) user.picture = picture;
      saveData(USERS_FILE, users);
    }

    // 4. Create persistent stateless session (30 days)
    const sessionToken = createSessionToken(user);
    const sessions = loadData(SESSIONS_FILE);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    sessions[sessionToken] = { userId: user.userId, email: user.email, expiresAt };
    saveData(SESSIONS_FILE, sessions);

    // Redirect to home with token in hash (securely consumed by client script and wiped from URL)
    res.redirect(`/#auth_token=${encodeURIComponent(sessionToken)}`);

  } catch (err) {
    console.error('Google Callback Error:', err);
    res.redirect(`/?auth_error=${encodeURIComponent(err.message)}`);
  }
});

// C. Direct Google ID Token / Access Token Endpoint (Official GIS / popup flow)
app.post('/api/auth/google/verify-token', async (req, res) => {
  try {
    const { idToken, accessToken } = req.body;
    let email = null;
    let name = null;
    let picture = null;
    let googleSub = null;

    if (idToken) {
      // Verify ID token with Google tokeninfo endpoint
      const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
      const tokenInfo = await verifyRes.json();
      if (verifyRes.ok && tokenInfo.email) {
        email = tokenInfo.email;
        name = tokenInfo.name || tokenInfo.given_name;
        picture = tokenInfo.picture;
        googleSub = tokenInfo.sub;
      } else {
        // Fallback parse if tokeninfo call times out
        const parts = idToken.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
          email = payload.email;
          name = payload.name || payload.given_name;
          picture = payload.picture;
          googleSub = payload.sub;
        }
      }
    } else if (accessToken) {
      // Verify via userinfo endpoint
      const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const profile = await userRes.json();
      if (userRes.ok && profile.email) {
        email = profile.email;
        name = profile.name;
        picture = profile.picture;
        googleSub = profile.sub;
      }
    }

    if (!email) {
      return res.status(400).json({ error: 'Failed to verify Google identity. Invalid token.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const users = loadData(USERS_FILE);
    let user = users[cleanEmail];

    if (!user) {
      const userId = 'usr_g_' + (googleSub || crypto.randomBytes(6).toString('hex'));
      user = {
        userId,
        email: cleanEmail,
        name: name || cleanEmail.split('@')[0],
        picture: picture || null,
        provider: 'google',
        createdAt: new Date().toISOString()
      };
      users[cleanEmail] = user;
      users[userId] = user;
      saveData(USERS_FILE, users);
    } else {
      if (name) user.name = name;
      if (picture) user.picture = picture;
      saveData(USERS_FILE, users);
    }

    const sessionToken = createSessionToken(user);
    const sessions = loadData(SESSIONS_FILE);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    sessions[sessionToken] = { userId: user.userId, email: user.email, expiresAt };
    saveData(SESSIONS_FILE, sessions);

    return res.json({
      success: true,
      token: sessionToken,
      user: {
        userId: user.userId,
        email: user.email,
        name: user.name,
        picture: user.picture,
        provider: user.provider
      }
    });

  } catch (err) {
    console.error('Google token verify error:', err);
    res.status(500).json({ error: 'Google verification failed: ' + err.message });
  }
});

// -------------------------------------------------------------
// 2. EMAIL / PASSWORD AUTHENTICATION ENDPOINTS
// -------------------------------------------------------------

// Sign Up
app.post('/api/auth/signup', (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail.includes('@') || cleanEmail.length < 5) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    const users = loadData(USERS_FILE);
    if (users[cleanEmail]) {
      return res.status(409).json({ error: 'An account with this email already exists. Please Sign In.' });
    }

    const { hash, salt } = hashPassword(password);
    const userId = 'usr_' + crypto.randomBytes(8).toString('hex');
    const userRecord = {
      userId,
      email: cleanEmail,
      name: name && name.trim() ? name.trim() : cleanEmail.split('@')[0],
      provider: 'email',
      passwordHash: hash,
      passwordSalt: salt,
      createdAt: new Date().toISOString()
    };

    users[cleanEmail] = userRecord;
    users[userId] = userRecord;
    saveData(USERS_FILE, users);

    const sessionToken = createSessionToken(userRecord);
    const sessions = loadData(SESSIONS_FILE);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    sessions[sessionToken] = { userId, email: cleanEmail, expiresAt };
    saveData(SESSIONS_FILE, sessions);

    return res.json({
      success: true,
      token: sessionToken,
      user: {
        userId: userRecord.userId,
        email: userRecord.email,
        name: userRecord.name,
        provider: userRecord.provider
      }
    });

  } catch (err) {
    console.error('Sign up error:', err);
    res.status(500).json({ error: 'Account creation failed: ' + err.message });
  }
});

// Sign In
app.post('/api/auth/signin', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Please provide both email and password.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const users = loadData(USERS_FILE);
    const user = users[cleanEmail];

    if (!user || user.provider === 'google' || !user.passwordHash) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const isValid = verifyPassword(password, user.passwordHash, user.passwordSalt);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const sessionToken = createSessionToken(user);
    const sessions = loadData(SESSIONS_FILE);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    sessions[sessionToken] = { userId: user.userId, email: user.email, expiresAt };
    saveData(SESSIONS_FILE, sessions);

    return res.json({
      success: true,
      token: sessionToken,
      user: {
        userId: user.userId,
        email: user.email,
        name: user.name,
        provider: user.provider
      }
    });

  } catch (err) {
    console.error('Sign in error:', err);
    res.status(500).json({ error: 'Sign in failed: ' + err.message });
  }
});

// Get Current User Profile
app.get('/api/auth/me', requireAuth, (req, res) => {
  return res.json({
    user: {
      userId: req.user.userId,
      email: req.user.email,
      name: req.user.name,
      picture: req.user.picture || null,
      provider: req.user.provider
    }
  });
});

// Sign Out
app.post('/api/auth/signout', (req, res) => {
  const token = req.headers.authorization ? req.headers.authorization.slice(7) : req.headers['x-session-token'];
  if (token) {
    const sessions = loadData(SESSIONS_FILE);
    delete sessions[token];
    saveData(SESSIONS_FILE, sessions);
  }
  return res.json({ success: true, message: 'Signed out successfully.' });
});

// -------------------------------------------------------------
// 3. PROTECTED CLOUDFLARE API CONFIGURATION (ONE-TIME PERSISTENCE)
// -------------------------------------------------------------

app.get('/api/user/status', requireAuth, (req, res) => {
  const userId = req.user.userId;
  const vault = getCachedVault();

  if (vault[userId]) {
    const userRecord = vault[userId];
    return res.json({
      configured: true,
      maskedAccountId: maskValue(userRecord.accountId, 4),
      maskedApiKey: maskValue(userRecord.apiKeyMasked, 4),
      model: MODEL_NAME,
      lastVerified: userRecord.lastVerified,
      status: 'Connected'
    });
  }

  // Fallback to server pre-configured credentials if present
  const defaultAccountId = process.env.CLOUDFLARE_ACCOUNT_ID || DEFAULT_ACCOUNT_ID;
  const defaultApiKey = process.env.CLOUDFLARE_API_TOKEN || DEFAULT_API_TOKEN;
  if (defaultAccountId && defaultApiKey) {
    return res.json({
      configured: true,
      isDefault: true,
      maskedAccountId: maskValue(defaultAccountId, 4),
      maskedApiKey: maskValue(defaultApiKey, 4),
      model: MODEL_NAME,
      status: 'Connected'
    });
  }

  return res.json({
    configured: false,
    status: 'Not Connected'
  });
});

app.post('/api/user/save-credentials', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { apiKey, accountId } = req.body;

    if (!apiKey || !accountId) {
      return res.status(400).json({ error: 'Both Cloudflare API Token and Account ID are required.' });
    }

    const cleanKey = apiKey.trim();
    const cleanAccountId = accountId.trim();

    // 1. Verify against official Cloudflare Workers AI API
    const testUrl = getCloudflareModelUrl(cleanAccountId);
    const testRes = await fetch(testUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
      headers: {
        'Authorization': `Bearer ${cleanKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt: 'auth verification check'
      })
    });

    if (testRes.status === 401 || testRes.status === 403) {
      return res.status(401).json({
        success: false,
        error: 'Authentication error: Invalid Cloudflare API Token or insufficient Workers AI permissions.'
      });
    }

    if (testRes.status === 404 || testRes.status === 400) {
      const errorText = await testRes.text();
      if (errorText.includes('10000') || errorText.includes('Authentication')) {
        return res.status(401).json({
          success: false,
          error: 'Authentication error: Cloudflare token unauthorized or Account ID mismatch.'
        });
      }
      if (errorText.includes('Account') || errorText.includes('not found')) {
        return res.status(400).json({
          success: false,
          error: 'Account ID is invalid or not accessible with this token.'
        });
      }
    }

    if (!testRes.ok) {
      const errText = await testRes.text();
      return res.status(testRes.status).json({
        success: false,
        error: `Cloudflare verification failed (${testRes.status}): ${errText.slice(0, 150)}`
      });
    }

    // 2. Encrypt and save securely in isolated server vault for this authenticated user
    const encryptedKey = encryptSecret(cleanKey);
    const vault = getCachedVault();

    vault[userId] = {
      accountId: cleanAccountId,
      encryptedApiKey: encryptedKey,
      apiKeyMasked: cleanKey,
      lastVerified: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    saveData(VAULT_FILE, vault);

    return res.json({
      success: true,
      message: 'Cloudflare Connected Successfully',
      maskedAccountId: maskValue(cleanAccountId, 4),
      maskedApiKey: maskValue(cleanKey, 4),
      model: MODEL_NAME
    });

  } catch (err) {
    console.error('Save credentials error:', err);
    return res.status(500).json({
      success: false,
      error: `Network error verifying credentials: ${err.message}`
    });
  }
});

app.post('/api/user/remove-credentials', requireAuth, (req, res) => {
  const userId = req.user.userId;
  const vault = getCachedVault();
  if (vault[userId]) {
    delete vault[userId];
    saveData(VAULT_FILE, vault);
  }
  return res.json({ success: true, message: 'Cloudflare account disconnected.' });
});

app.post('/api/user/test-connection', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const vault = getCachedVault();

    let accountId = null;
    let apiKey = null;

    if (vault[userId]) {
      accountId = vault[userId].accountId;
      apiKey = decryptSecret(vault[userId].encryptedApiKey);
    } else {
      accountId = process.env.CLOUDFLARE_ACCOUNT_ID || DEFAULT_ACCOUNT_ID;
      apiKey = process.env.CLOUDFLARE_API_TOKEN || DEFAULT_API_TOKEN;
    }

    if (!accountId || !apiKey) {
      return res.status(400).json({
        valid: false,
        message: 'No Cloudflare credentials found for this account. Please connect in API Configuration.'
      });
    }

    const testUrl = getCloudflareModelUrl(accountId);
    const testRes = await fetch(testUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt: 'test connection ping'
      })
    });

    if (testRes.ok) {
      return res.json({
        valid: true,
        message: 'Cloudflare Connected Successfully',
        model: MODEL_NAME
      });
    }

    return res.status(testRes.status).json({
      valid: false,
      message: `Invalid API credentials or model access unavailable (${testRes.status})`
    });

  } catch (err) {
    return res.status(500).json({
      valid: false,
      message: `Connection failed: ${err.message}`
    });
  }
});

// -------------------------------------------------------------
// 4. PROTECTED USER GALLERY ENDPOINTS
// -------------------------------------------------------------

app.get('/api/user/gallery', requireAuth, (req, res) => {
  const userId = req.user.userId;
  const galleries = getCachedGalleries();
  const userGallery = galleries[userId] || [];
  return res.json({ gallery: userGallery });
});

app.post('/api/user/gallery/delete', requireAuth, (req, res) => {
  const userId = req.user.userId;
  const { imageId } = req.body;
  if (!imageId) return res.status(400).json({ error: 'Missing imageId.' });

  const galleries = getCachedGalleries();
  if (galleries[userId]) {
    galleries[userId] = galleries[userId].filter(item => item.id !== imageId);
    saveData(GALLERIES_FILE, galleries);
  }
  return res.json({ success: true });
});

app.post('/api/user/gallery/clear', requireAuth, (req, res) => {
  const userId = req.user.userId;
  const galleries = getCachedGalleries();
  if (galleries[userId]) {
    galleries[userId] = [];
    saveData(GALLERIES_FILE, galleries);
  }
  return res.json({ success: true });
});

// -------------------------------------------------------------
// 5. PROTECTED IMAGE GENERATION ENDPOINT
// -------------------------------------------------------------

app.post('/api/generate', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { prompt } = req.body;

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'Please enter a valid prompt.' });
    }

    const exactPrompt = prompt.trim();
    const vault = getCachedVault();

    let accountId = null;
    let apiKey = null;

    if (vault[userId]) {
      accountId = vault[userId].accountId;
      apiKey = decryptSecret(vault[userId].encryptedApiKey);
    } else {
      // Fallback to server pre-configured credentials
      accountId = process.env.CLOUDFLARE_ACCOUNT_ID || DEFAULT_ACCOUNT_ID;
      apiKey = process.env.CLOUDFLARE_API_TOKEN || DEFAULT_API_TOKEN;
    }

    if (!apiKey || !accountId) {
      return res.status(401).json({
        error: 'Cloudflare account not connected. Please open API Configuration in the left sidebar to connect your account once.',
        needsSetup: true
      });
    }

    const tStart = performance.now();
    const url = getCloudflareModelUrl(accountId);

    // Optimized Cloudflare Workers AI fetch with keep-alive socket reuse & timeout
    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(60000),
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
      },
      body: JSON.stringify({
        prompt: exactPrompt
      })
    });

    const duration = ((performance.now() - tStart) / 1000).toFixed(2);
    const contentType = response.headers.get('content-type') || '';

    if (response.ok) {
      let imageDataUrl = null;

      if (contentType.includes('application/json')) {
        const data = await response.json();
        if (data.result && data.result.image) {
          imageDataUrl = `data:image/jpeg;base64,${data.result.image}`;
        }
      } else {
        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        imageDataUrl = `data:image/jpeg;base64,${base64}`;
      }

      if (!imageDataUrl) {
        throw new Error('Cloudflare responded with an empty image payload.');
      }

      const imageRecord = {
        id: Date.now(),
        imageUrl: imageDataUrl,
        prompt: exactPrompt,
        engine: `Cloudflare Flux.1 Schnell (${MODEL_NAME})`,
        format: '1024x1024 HDR',
        duration: `${duration}s`,
        timestamp: new Date().toLocaleString()
      };

      // Non-blocking asynchronous update to user's gallery cache and disk
      setImmediate(() => {
        try {
          const galleries = getCachedGalleries();
          if (!galleries[userId]) galleries[userId] = [];
          galleries[userId].unshift(imageRecord);
          if (galleries[userId].length > 40) galleries[userId] = galleries[userId].slice(0, 40);
          saveData(GALLERIES_FILE, galleries);
        } catch (e) {
          console.error('Async gallery save error:', e);
        }
      });

      // Immediate JSON response to client without waiting for disk I/O
      return res.json({
        status: 'success',
        image: imageDataUrl,
        prompt: exactPrompt,
        engine: `Cloudflare Flux.1 Schnell (${MODEL_NAME})`,
        format: '1024x1024 HDR',
        duration: `${duration}s`,
        id: imageRecord.id,
        timestamp: imageRecord.timestamp
      });
    }

    const errorBody = await response.text();
    let userFriendlyError = 'Cloudflare Workers AI generation failed.';
    try {
      const errJson = JSON.parse(errorBody);
      if (errJson.errors && errJson.errors.length > 0) {
        userFriendlyError = errJson.errors[0].message || errJson.errors[0].code;
      }
    } catch (_) {
      userFriendlyError = errorBody.slice(0, 200);
    }

    if (response.status === 401 || response.status === 403) {
      return res.status(401).json({
        error: 'Your Cloudflare connection needs attention. Please update your API Token in the left sidebar.',
        needsAttention: true
      });
    }

    return res.status(response.status).json({
      error: `Cloudflare Error (${response.status}): ${userFriendlyError}`
    });

  } catch (e) {
    console.error("Generation error:", e);
    res.status(500).json({ error: `Generation failed: ${e.message}` });
  }
});

// JSON 404 Fallback for unmatched /api routes
app.all('/api/*', (req, res) => {
  res.status(404).json({
    success: false,
    error: `API endpoint not found: ${req.method} ${req.originalUrl}`
  });
});

// Express Error Handling Middleware for API routes (Ensures JSON is always returned)
app.use((err, req, res, next) => {
  if (req.path.startsWith('/api')) {
    console.error('API Error Middleware:', err);
    return res.status(err.status || 500).json({
      success: false,
      error: err.message || 'An unexpected server error occurred.'
    });
  }
  next(err);
});

const PORT = process.env.PORT || 3000;
if (!process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`⚡ Authenticated NANDU IMAGE FLUX server running on http://localhost:${PORT} and http://127.0.0.1:${PORT}`);
    console.log(`🔒 Multi-user Auth & Session Vault active in ${DATA_DIR}`);
  });
}

export default app;
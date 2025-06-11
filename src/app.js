const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();
const session = require('express-session');
const app = express();
console.log('--- app.js started ---');
console.log('🚀 ConnectFlows Express App - Initialization Start');
const PORT = process.env.PORT || 3000;
const path = require('path');
const fetch = require('node-fetch');
const bcrypt = require('bcryptjs');

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://connectfloww.lemonsqueezy.com", "https://app.lemonsqueezy.com"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https://*"],
      connectSrc: ["'self'", "https://api.lemonsqueezy.com", "https://o4505075539902464.ingest.sentry.io"],
      frameSrc: ["'self'", "https://connectfloww.lemonsqueezy.com", "https://app.lemonsqueezy.com"],
      childSrc: ["'self'", "https://connectfloww.lemonsqueezy.com", "https://app.lemonsqueezy.com"],
      workerSrc: ["'self'", "blob:", "https://connectfloww.lemonsqueezy.com"],
      fontSrc: ["'self'", "data:", "https://*"],
    },
  },
}));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'connectflows-secret-2024',
  resave: false,
  saveUninitialized: false
}));
console.log('✅ Middleware setup complete.');

// Authentication middleware
function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/signup?message=Please sign up to test the demo');
  }
  
  const trialStart = new Date(req.session.user.trialStarted);
  const trialEnd = new Date(trialStart.getTime() + (14 * 24 * 60 * 60 * 1000));
  
  if (new Date() > trialEnd) {
    return res.redirect('/upgrade?message=Your trial has expired');
  }
  
  next();
}
const { Pool } = require('pg');

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database tables
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        trial_ends_at TIMESTAMP DEFAULT (NOW() + INTERVAL '14 days'),
        subscription_status VARCHAR(50) DEFAULT 'trial',
        plan_type VARCHAR(50) DEFAULT 'starter',
        salesforce_token TEXT,
        hubspot_token TEXT,
        sync_settings JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS sync_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        status VARCHAR(50),
        contacts_processed INTEGER DEFAULT 0,
        conflicts INTEGER DEFAULT 0,
        error_message TEXT,
        sync_direction VARCHAR(50),
        sync_type VARCHAR(50) DEFAULT 'demo',
        started_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        salesforce_id VARCHAR(255),
        hubspot_id VARCHAR(255),
        email VARCHAR(255),
        name VARCHAR(255),
        phone VARCHAR(255),
        company VARCHAR(255),
        last_synced TIMESTAMP DEFAULT NOW(),
        sync_status VARCHAR(50) DEFAULT 'synced'
      );
    `);
    console.log('✅ Database tables initialized');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
  }
}

// Initialize database on startup
initDatabase();
console.log('✅ Database initialization triggered.');

// User data functions
async function createUser(email, passwordHash) {
  const result = await pool.query(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING *',
    [email, passwordHash]
  );
  return result.rows[0];
}

async function getUserByEmail(email) {
  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  return result.rows[0];
}

async function getUserById(id) {
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return result.rows[0];
}

async function updateUserTokens(userId, salesforceToken, hubspotToken) {
  await pool.query(
    'UPDATE users SET salesforce_token = $1, hubspot_token = $2 WHERE id = $3',
    [salesforceToken, hubspotToken, userId]
  );
}

async function getUserSyncHistory(userId) {
  const result = await pool.query(
    'SELECT * FROM sync_logs WHERE user_id = $1 ORDER BY started_at DESC LIMIT 10',
    [userId]
  );
  return result.rows;
}

async function createSyncLog(userId, status, contactsProcessed, conflicts, errorMessage = null) {
  const result = await pool.query(
    'INSERT INTO sync_logs (user_id, status, contacts_processed, conflicts, error_message) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [userId, status, contactsProcessed, conflicts, errorMessage]
  );
  return result.rows[0];
}

async function getUserStats(userId) {
  const syncHistory = await getUserSyncHistory(userId);
  const contactsResult = await pool.query(
    'SELECT COUNT(*) as total FROM contacts WHERE user_id = $1',
    [userId]
  );
  
  const lastSync = syncHistory.length > 0 ? syncHistory[0] : null;
  const totalContacts = parseInt(contactsResult.rows[0].total);
  
  return {
    totalContacts,
    lastSync: lastSync?.started_at || null,
    syncStatus: lastSync?.status || 'never',
    syncHistory: syncHistory.map(log => ({
      id: log.id,
      status: log.status,
      total: log.contacts_processed,
      conflicts: log.conflicts,
      error: log.error_message,
      timestamp: log.started_at
    }))
  };
}

// Salesforce API functions
async function fetchSalesforceContacts(accessToken) {
  const response = await fetch('https://login.salesforce.com/services/data/v57.0/query/?q=SELECT Id,FirstName,LastName,Email,Phone,Account.Name FROM Contact LIMIT 100', {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json'
    }
  });
  
  if (!response.ok) {
    throw new Error(`Salesforce API error: ${response.status}`);
  }
  
  const data = await response.json();
  return data.records.map(contact => ({
    id: contact.Id,
    name: `${contact.FirstName || ''} ${contact.LastName || ''}`.trim(),
    email: contact.Email,
    phone: contact.Phone,
    company: contact.Account?.Name || '',
    source: 'salesforce'
  }));
}

// HubSpot API functions
async function fetchHubSpotContacts(accessToken) {
  const response = await fetch('https://api.hubapi.com/crm/v3/objects/contacts?properties=firstname,lastname,email,phone,company&limit=100', {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json'
    }
  });
  
  if (!response.ok) {
    throw new Error(`HubSpot API error: ${response.status}`);
  }
  
  const data = await response.json();
  return data.results.map(contact => ({
    id: contact.id,
    name: `${contact.properties.firstname || ''} ${contact.properties.lastname || ''}`.trim(),
    email: contact.properties.email,
    phone: contact.properties.phone,
    company: contact.properties.company || '',
    source: 'hubspot'
  }));
}

// Sync engine
async function performSync(userId) {
  const user = await getUserById(userId);
  if (!user || !user.salesforce_token || !user.hubspot_token) {
    throw new Error('User not found or CRM accounts not connected');
  }
  
  try {
    // Create sync log
    const syncLog = await createSyncLog(userId, 'running', 0, 0);
    
    // Fetch contacts from both systems
    const [salesforceContacts, hubspotContacts] = await Promise.all([
      fetchSalesforceContacts(user.salesforce_token),
      fetchHubSpotContacts(user.hubspot_token)
    ]);
    
    // Compare and identify conflicts
    const conflicts = [];
    const processedContacts = [];
    
    for (const sfContact of salesforceContacts) {
      const hubspotMatch = hubspotContacts.find(hc => hc.email === sfContact.email);
      
      if (hubspotMatch) {
        // Check for conflicts
        const hasConflict = 
          sfContact.name !== hubspotMatch.name ||
          sfContact.phone !== hubspotMatch.phone ||
          sfContact.company !== hubspotMatch.company;
        
        if (hasConflict) {
          conflicts.push({
            email: sfContact.email,
            salesforce: sfContact,
            hubspot: hubspotMatch
          });
        }
        
        processedContacts.push({
          user_id: userId,
          salesforce_id: sfContact.id,
          hubspot_id: hubspotMatch.id,
          email: sfContact.email,
          name: sfContact.name,
          phone: sfContact.phone,
          company: sfContact.company
        });
      } else {
        // Contact only in Salesforce
        processedContacts.push({
          user_id: userId,
          salesforce_id: sfContact.id,
          email: sfContact.email,
          name: sfContact.name,
          phone: sfContact.phone,
          company: sfContact.company
        });
      }
    }
    
    // Store contacts
    for (const contact of processedContacts) {
      await pool.query(
        `INSERT INTO contacts (user_id, salesforce_id, hubspot_id, email, name, phone, company) 
         VALUES ($1, $2, $3, $4, $5, $6, $7) 
         ON CONFLICT (user_id, email) DO UPDATE SET 
         name = EXCLUDED.name, phone = EXCLUDED.phone, company = EXCLUDED.company, last_synced = NOW()`,
        [contact.user_id, contact.salesforce_id, contact.hubspot_id, contact.email, contact.name, contact.phone, contact.company]
      );
    }
    
    // Update sync log
    await pool.query(
      'UPDATE sync_logs SET status = $1, contacts_processed = $2, conflicts = $3, completed_at = NOW() WHERE id = $4',
      ['success', processedContacts.length, conflicts.length, syncLog.id]
    );
    
    return {
      success: true,
      contactsProcessed: processedContacts.length,
      conflicts: conflicts.length,
      conflictDetails: conflicts
    };
    
  } catch (error) {
    // Log error
    await createSyncLog(userId, 'error', 0, 0, error.message);
    throw error;
  }
}
// Routes 
// ========================================
// REAL SYNC ENGINE FOR PAYING CUSTOMERS
// ========================================
console.log('➡️ Defining / route.');
app.get('/', (req, res) => {
  res.json({ 
    message: '🚀 SF-HubSpot Sync API is running!',
    version: '1.0.0',
    status: 'active',
    endpoints: {
      auth: {
        salesforce: '/auth/salesforce',
        salesforce_callback: '/auth/salesforce/callback',
        hubspot: '/auth/hubspot',
        hubspot_callback: '/auth/hubspot/callback'
      },
      api: {
        sync: '/api/sync',
        sync_contacts: '/api/sync/contacts',
        status: '/api/status',
        health: '/health'
      }
    },
    environment: process.env.NODE_ENV || 'development'
  });
});
const crypto = require('crypto');
// Lemon Squeezy Billing Routes
console.log('➡️ Defining /pricing route.');
// Pricing page route
app.get('/pricing', (req, res) => {
  const message = req.query.message || '';
  const signupComplete = req.query.signup === 'complete';
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Pricing Plans - ConnectFlows</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <script src="https://cdn.tailwindcss.com"></script>
      <style>
        .gradient-bg {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        }
        .card-hover {
          transition: all 0.3s ease;
        }
        .card-hover:hover {
          transform: translateY(-5px);
          box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
        }
        .checkout-btn {
          transition: all 0.3s ease;
        }
        .checkout-btn:hover {
          transform: translateY(-2px);
        }
        .checkout-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
          transform: none;
        }
      </style>
    </head>
    <body class="bg-gray-50">
      <div class="min-h-screen">
        <!-- Header -->
        <header class="gradient-bg text-white py-8">
          <div class="container mx-auto px-4 text-center">
            <h1 class="text-4xl font-bold mb-4">Choose Your ConnectFlows Plan</h1>
            <p class="text-xl opacity-90">Sync Salesforce ↔ HubSpot with enterprise-grade reliability</p>
          </div>
        </header>

        <!-- Message Banner -->
        ${message ? `
          <div class="bg-yellow-50 border-l-4 border-yellow-400 p-4 mb-8">
            <div class="flex">
              <div class="flex-shrink-0">
                <svg class="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
                  <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
                </svg>
              </div>
              <div class="ml-3">
                <p class="text-sm text-yellow-700">${message}</p>
              </div>
            </div>
          </div>
        ` : ''}

        <!-- Signup Complete Banner -->
        ${signupComplete ? `
          <div class="bg-green-50 border-l-4 border-green-400 p-4 mb-8">
            <div class="flex">
              <div class="flex-shrink-0">
                <svg class="h-5 w-5 text-green-400" viewBox="0 0 20 20" fill="currentColor">
                  <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
                </svg>
              </div>
              <div class="ml-3">
                <p class="text-sm text-green-700">✅ Account created successfully! Choose your plan to continue.</p>
              </div>
            </div>
          </div>
        ` : ''}

        <!-- Pricing Cards -->
        <div class="container mx-auto px-4 py-12">
          <div class="grid md:grid-cols-3 gap-8 max-w-6xl mx-auto">
            
            <!-- Starter Plan -->
            <div class="bg-white rounded-lg shadow-lg card-hover p-8 border-2 border-gray-100">
              <div class="text-center mb-8">
                <h3 class="text-2xl font-bold text-gray-900 mb-4">Starter</h3>
                <div class="text-4xl font-bold text-gray-900 mb-2">$97</div>
                <div class="text-gray-600">per month</div>
                <p class="text-sm text-gray-500 mt-2">Perfect for small teams</p>
              </div>
              
              <ul class="space-y-4 mb-8">
                <li class="flex items-center">
                  <svg class="h-5 w-5 text-green-500 mr-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path>
                  </svg>
                  Up to 1,000 contacts
                </li>
                <li class="flex items-center">
                  <svg class="h-5 w-5 text-green-500 mr-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path>
                  </svg>
                  Real-time sync
                </li>
                <li class="flex items-center">
                  <svg class="h-5 w-5 text-green-500 mr-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path>
                  </svg>
                  Basic field mapping
                </li>
                <li class="flex items-center">
                  <svg class="h-5 w-5 text-green-500 mr-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path>
                  </svg>
                  Email support
                </li>
              </ul>
              
              <button class="checkout-btn w-full bg-blue-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-blue-700 transition" data-plan="starter">
                Start with Starter
              </button>
            </div>

            <!-- Professional Plan -->
            <div class="bg-white rounded-lg shadow-xl card-hover p-8 border-2 border-blue-500 relative">
              <div class="absolute -top-4 left-1/2 transform -translate-x-1/2">
                <span class="bg-blue-500 text-white px-4 py-1 rounded-full text-sm font-semibold">Most Popular</span>
              </div>
              
              <div class="text-center mb-8">
                <h3 class="text-2xl font-bold text-gray-900 mb-4">Professional</h3>
                <div class="text-4xl font-bold text-gray-900 mb-2">$197</div>
                <div class="text-gray-600">per month</div>
                <p class="text-sm text-gray-500 mt-2">For growing businesses</p>
              </div>
              
              <ul class="space-y-4 mb-8">
                <li class="flex items-center">
                  <svg class="h-5 w-5 text-green-500 mr-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path>
                  </svg>
                  Up to 10,000 contacts
                </li>
                <li class="flex items-center">
                  <svg class="h-5 w-5 text-green-500 mr-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path>
                  </svg>
                  Advanced field mapping
                </li>
                <li class="flex items-center">
                  <svg class="h-5 w-5 text-green-500 mr-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path>
                  </svg>
                  Conflict resolution
                </li>
                <li class="flex items-center">
                  <svg class="h-5 w-5 text-green-500 mr-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path>
                  </svg>
                  Priority support
                </li>
                <li class="flex items-center">
                  <svg class="h-5 w-5 text-green-500 mr-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path>
                  </svg>
                  Sync analytics
                </li>
              </ul>
              
              <button class="checkout-btn w-full bg-blue-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-blue-700 transition" data-plan="professional">
                Start with Professional
              </button>
            </div>

            <!-- Enterprise Plan -->
            <div class="bg-white rounded-lg shadow-lg card-hover p-8 border-2 border-gray-100">
              <div class="text-center mb-8">
                <h3 class="text-2xl font-bold text-gray-900 mb-4">Enterprise</h3>
                <div class="text-4xl font-bold text-gray-900 mb-2">$397</div>
                <div class="text-gray-600">per month</div>
                <p class="text-sm text-gray-500 mt-2">For large organizations</p>
              </div>
              
              <ul class="space-y-4 mb-8">
                <li class="flex items-center">
                  <svg class="h-5 w-5 text-green-500 mr-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path>
                  </svg>
                  Unlimited contacts
                </li>
                <li class="flex items-center">
                  <svg class="h-5 w-5 text-green-500 mr-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path>
                  </svg>
                  Custom field mapping
                </li>
                <li class="flex items-center">
                  <svg class="h-5 w-5 text-green-500 mr-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path>
                  </svg>
                  Advanced automation
                </li>
                <li class="flex items-center">
                  <svg class="h-5 w-5 text-green-500 mr-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path>
                  </svg>
                  Dedicated support
                </li>
                <li class="flex items-center">
                  <svg class="h-5 w-5 text-green-500 mr-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path>
                  </svg>
                  API access
                </li>
              </ul>
              
              <button class="checkout-btn w-full bg-blue-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-blue-700 transition" data-plan="enterprise">
                Start with Enterprise
              </button>
            </div>
          </div>
        </div>

        <!-- ROI Calculator -->
        <div class="bg-white py-12">
          <div class="container mx-auto px-4">
            <div class="max-w-4xl mx-auto text-center">
              <h2 class="text-3xl font-bold text-gray-900 mb-8">Calculate Your ROI</h2>
              <div class="bg-gray-50 rounded-lg p-8">
                <div class="grid md:grid-cols-2 gap-8">
                  <div>
                    <label for="hours" class="block text-sm font-medium text-gray-700 mb-2">
                      Hours spent manually syncing per week:
                    </label>
                    <input type="range" id="hours" min="1" max="20" value="5" class="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer">
                    <div class="text-center mt-2">
                      <span id="hoursValue" class="text-2xl font-bold text-blue-600">5</span> hours/week
                    </div>
                  </div>
                  <div class="space-y-4">
                    <div class="bg-white p-4 rounded-lg">
                      <div class="text-sm text-gray-600">Current monthly waste:</div>
                      <div id="monthlyWaste" class="text-2xl font-bold text-red-600">$1,000</div>
                    </div>
                    <div class="bg-white p-4 rounded-lg">
                      <div class="text-sm text-gray-600">Monthly savings with ConnectFlows:</div>
                      <div id="monthlySavings" class="text-2xl font-bold text-green-600">$803</div>
                    </div>
                    <div class="bg-white p-4 rounded-lg">
                      <div class="text-sm text-gray-600">ROI:</div>
                      <div id="roi" class="text-2xl font-bold text-blue-600">407%</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <footer class="bg-gray-800 text-white py-8">
          <div class="container mx-auto px-4 text-center">
            <p>&copy; 2024 ConnectFlows. All rights reserved.</p>
            <p class="mt-2 text-gray-400">Questions? Contact us at hello@connectfloww.lemonsqueezy.com</p>
          </div>
        </footer>
      </div>

      <script>
        // ROI Calculator
        function calculateSavings() {
          const hours = document.getElementById('hours').value;
          const monthlyWaste = hours * 4 * 50; // weeks * hourly rate
          const monthlySavings = monthlyWaste - 197;
          const roi = Math.round((monthlySavings / 197) * 100);
          
          document.getElementById('hoursValue').textContent = hours;
          document.getElementById('monthlyWaste').textContent = '$' + monthlyWaste.toLocaleString();
          document.getElementById('monthlySavings').textContent = '$' + monthlySavings.toLocaleString();
          document.getElementById('roi').textContent = roi + '%';
        }
        
        // Initialize calculator
        calculateSavings();
        
        // Update calculator when slider changes
        document.getElementById('hours').addEventListener('input', calculateSavings);
        
        // Checkout button event listeners (CSP-compliant)
        document.addEventListener('DOMContentLoaded', function() {
          document.querySelectorAll('.checkout-btn').forEach(btn => {
            btn.addEventListener('click', async function() {
              const plan = this.getAttribute('data-plan');
              const originalText = this.textContent;
              
              // Update button state
              this.textContent = 'Loading...';
              this.disabled = true;
              
              try {
                const res = await fetch('/create-checkout', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ plan })
                });
                
                const data = await res.json();
                
                if (data.success && data.checkoutUrl) {
                  window.location.href = data.checkoutUrl;
                } else {
                  alert('Error creating checkout. Please try again.');
                  this.textContent = originalText;
                  this.disabled = false;
                }
              } catch (err) {
                console.error('Checkout error:', err);
                alert('Network error. Please try again.');
                this.textContent = originalText;
                this.disabled = false;
              }
            });
          });
        });
      </script>
    </body>
    </html>
  `);
});

console.log('➡️ Defining POST /create-checkout route.');
// Create checkout session with Lemon Squeezy
app.post('/create-checkout', async (req, res) => {
  try {
    const { plan, signupData } = req.body;

    // Map plans to your Lemon Squeezy product variant IDs
    const planVariants = {
      starter: '839923',      // Basic/Starter plan
      professional: '845532', // Professional plan  
      enterprise: '845546'    // Enterprise plan
    };

    const variantId = planVariants[plan];
    if (!variantId) {
      return res.status(400).json({ error: 'Invalid plan selected' });
    }

    // Get signup data from session if available
    const signupInfo = req.session.pendingSignup || {};
    
    // Build success and error URLs
    const baseUrl = process.env.NODE_ENV === 'production' 
      ? (process.env.CUSTOM_DOMAIN || 'https://rapid-mailbox-production.up.railway.app')
      : 'http://localhost:3000';
    
    const successUrl = `${baseUrl}/success?plan=${plan}`;
    const errorUrl = `${baseUrl}/pricing?error=payment_failed`;
    
    // Create checkout with Lemon Squeezy API - FIXED FORMAT
    const checkoutResponse = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.LEMON_SQUEEZY_API_KEY}`,
        'Content-Type': 'application/vnd.api+json',
        'Accept': 'application/vnd.api+json'
      },
      body: JSON.stringify({
        data: {
          type: 'checkouts',
          attributes: {
            checkout_data: {
              email: signupInfo.email || 'customer@example.com',
              name: signupInfo.email ? signupInfo.email.split('@')[0] : 'ConnectFlows Customer',
              billing_address: {},
              custom: {
                plan: plan,
                signup_email: signupInfo.email || '',
                signup_password: signupInfo.password || '',
                signup_created: signupInfo.createdAt || new Date().toISOString()
              }
            },
            expires_at: null,
            test_mode: process.env.NODE_ENV !== 'production',
            product_options: {
              enabled: true,
              redirect_url: successUrl,
              receipt_button_text: "Go to Dashboard",
              receipt_link_url: `${baseUrl}/dashboard`
            }
          },
          relationships: {
            store: {
              data: {
                type: 'stores',
                id: process.env.LEMON_SQUEEZY_STORE_ID // Ensure this is a string
              }
            },
            variant: {
              data: {
                type: 'variants',
                id: variantId // Ensure this is a string
              }
            }
          }
        }
      })
    });

    console.log('💰 Lemon Squeezy request body:', JSON.stringify({
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: {
            email: signupInfo.email || 'customer@example.com',
            name: signupInfo.email ? signupInfo.email.split('@')[0] : 'ConnectFlows Customer',
            billing_address: {},
            custom: {
              plan: plan,
              signup_email: signupInfo.email || '',
              signup_password: signupInfo.password || '',
              signup_created: signupInfo.createdAt || new Date().toISOString()
            }
          },
          expires_at: null,
          test_mode: process.env.NODE_ENV !== 'production',
          product_options: {
            enabled: true,
            redirect_url: successUrl,
            receipt_button_text: "Go to Dashboard",
            receipt_link_url: `${baseUrl}/dashboard`
          }
        },
        relationships: {
          store: {
            data: {
              type: 'stores',
              id: process.env.LEMON_SQUEEZY_STORE_ID
            }
          },
          variant: {
            data: {
              type: 'variants',
              id: variantId
            }
          }
        }
      }
    }, null, 2));
    console.log('💰 Lemon Squeezy checkout request sent');
    console.log('📊 Response status:', checkoutResponse.status);
    
    const responseText = await checkoutResponse.text();
    console.log('📄 Raw response:', responseText);
    
    let checkoutData;
    try {
      checkoutData = JSON.parse(responseText);
    } catch (parseError) {
      console.error('❌ Failed to parse Lemon Squeezy response:', parseError);
      return res.status(500).json({ 
        error: 'Payment system error',
        details: 'Failed to process checkout request'
      });
    }

    if (!checkoutResponse.ok) {
      console.error('❌ Lemon Squeezy API error:', checkoutData);
      return res.status(500).json({ 
        error: 'Payment system error',
        details: checkoutData.errors?.[0]?.detail || 'Failed to create checkout'
      });
    }

    if (checkoutData.data && checkoutData.data.attributes.url) {
      const checkoutUrl = checkoutData.data.attributes.url;
      console.log(`✅ Checkout created successfully for plan: ${plan}`);
      console.log(`🔗 Checkout URL: ${checkoutUrl}`);
      
      res.json({ 
        success: true,
        checkoutUrl: checkoutUrl,
        message: 'Checkout created successfully'
      });
    } else {
      console.error('❌ Invalid checkout response:', checkoutData);
      res.status(500).json({ 
        error: 'Payment system error',
        details: 'Invalid checkout response from payment provider'
      });
    }

  } catch (error) {
    console.error('❌ Checkout creation error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: 'Failed to create checkout session'
    });
  }
});

console.log('➡️ Defining GET /create-checkout route.');
// Add the GET /create-checkout route here, before the 404 handler
app.get('/create-checkout', async (req, res) => {
  try {
    const plan = req.query.plan;
    
    const planVariants = {
      starter: '839923',
      professional: '845532', 
      enterprise: '845546'
    };

    const variantId = planVariants[plan];
    if (!variantId) {
      return res.status(400).send('Invalid plan');
    }

    const checkoutResponse = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.LEMON_SQUEEZY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        data: {
          type: 'checkouts',
          attributes: {
            checkout_data: { custom: { plan } }
          },
          relationships: {
            store: { data: { type: 'stores', id: process.env.LEMON_SQUEEZY_STORE_ID } },
            variant: { data: { type: 'variants', id: variantId } }
          }
        }
      })
    });
    
    const data = await checkoutResponse.json();
    if (data.data?.attributes?.url) {
      res.redirect(data.data.attributes.url);
    } else {
      res.status(500).send('Checkout failed');
    }
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).send('Server error');
  }
});

console.log('➡️ Defining /health route.');
// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});
console.log('➡️ Defining /signup route.');
// Signup page
app.get('/signup', (req, res) => {
  const message = req.query.message || '';
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Start Your Free Trial - ConnectFlows</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          max-width: 400px; 
          margin: 50px auto; 
          padding: 20px;
          background: #f8fafc;
        }
        .container {
          background: white;
          padding: 30px;
          border-radius: 10px;
          box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }
        .form-group { margin-bottom: 20px; }
        input { 
          width: 100%; 
          padding: 12px; 
          border: 2px solid #e2e8f0; 
          border-radius: 8px;
          font-size: 16px;
          box-sizing: border-box;
        }
        input:focus {
          outline: none;
          border-color: #3b82f6;
        }
        button { 
          width: 100%; 
          padding: 12px; 
          background: #3b82f6; 
          color: white; 
          border: none; 
          border-radius: 8px;
          font-size: 16px;
          cursor: pointer;
        }
        button:hover { background: #2563eb; }
        .message { 
          background: #fef3c7; 
          padding: 12px; 
          border-radius: 8px; 
          margin-bottom: 20px;
          border-left: 4px solid #f59e0b;
        }
        .benefits {
          background: #f0f9ff;
          padding: 15px;
          border-radius: 8px;
          margin-top: 20px;
          text-align: center;
          font-size: 14px;
        }
        h2 { text-align: center; color: #1e293b; margin-bottom: 10px; }
        .subtitle { text-align: center; color: #64748b; margin-bottom: 30px; }
      </style>
    </head>
    <body>
      <div class="container">
        <h2>🚀 Start Your Free Trial</h2>
        <p class="subtitle">Test Salesforce ↔ HubSpot sync with your real accounts</p>
        
        ${message ? `<div class="message">⚠️ ${message}</div>` : ''}
        
        <form action="/signup" method="post">
          <div class="form-group">
            <input type="email" name="email" placeholder="Your email address" required>
          </div>
          <div class="form-group">
            <input type="password" name="password" placeholder="Create a password" required>
          </div>
          <button type="submit">Start 14-Day Free Trial</button>
        </form>
        
        <div class="benefits">
          ✅ No credit card required<br>
          ✅ Connect your real CRM accounts<br>
          ✅ Full access for 14 days<br>
          ✅ Cancel anytime
        </div>
      </div>
    </body>
    </html>
  `);
});

console.log('➡️ Defining POST /signup route.');
// Handle signup form submission - REDIRECT TO PRICING FIRST
app.post('/signup', (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.redirect('/signup?message=Please fill in all fields');
  }
  
  // Store signup data in session for after payment
  req.session.pendingSignup = {
    email: email,
    password: password,
    createdAt: new Date().toISOString()
  };
  
  console.log('User signed up, redirecting to pricing:', email);
  // Redirect to pricing page instead of dashboard
  res.redirect('/pricing?signup=complete');
});

console.log('➡️ Defining /dashboard route.');
// Dashboard route - ONLY FOR PAID/TRIALING USERS
app.get('/dashboard', requireAuth, (req, res) => {
  const user = req.session.user;
  // Accept 'trialing', 'active', or 'paid' as valid subscription statuses
  const isPaidUser = ['paid', 'active', 'trialing'].includes(user.subscription_status);

  if (!isPaidUser) {
    // User is not paid, redirect to pricing
    return res.redirect('/pricing?message=Please complete your subscription to access the dashboard');
  }
  
  const trialStart = new Date(user.trialStarted);
  const trialEnd = new Date(trialStart.getTime() + (14 * 24 * 60 * 60 * 1000));
  const daysLeft = Math.ceil((trialEnd - new Date()) / (1000 * 60 * 60 * 24));
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Dashboard - ConnectFlows</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          max-width: 800px; 
          margin: 20px auto; 
          padding: 20px;
          background: #f8fafc;
        }
        .header {
          background: white;
          padding: 20px;
          border-radius: 10px;
          margin-bottom: 20px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .card { 
          background: white; 
          padding: 25px; 
          margin: 15px 0; 
          border-radius: 10px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .btn { 
          padding: 12px 24px; 
          background: #3b82f6; 
          color: white; 
          text-decoration: none; 
          border-radius: 8px; 
          display: inline-block; 
          margin: 8px 8px 8px 0;
          font-weight: 500;
        }
        .btn:hover { background: #2563eb; }
        .btn-orange { background: #f97316; }
        .btn-orange:hover { background: #ea580c; }
        .trial-info { 
          background: #d1fae5; 
          padding: 15px; 
          border-radius: 8px; 
          margin: 20px 0;
          border-left: 4px solid #10b981;
        }
        .status {
          display: inline-block;
          padding: 4px 12px;
          background: #dcfce7;
          color: #166534;
          border-radius: 20px;
          font-size: 14px;
          margin-left: 10px;
        }
        h1 { color: #1e293b; margin: 0; }
        h3 { color: #374151; margin-top: 0; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>🎛️ ConnectFlows Dashboard</h1>
        <p>Welcome back, <strong>${user.email}</strong>! <span class="status">${user.subscription_status.charAt(0).toUpperCase() + user.subscription_status.slice(1)}</span></p>
      </div>
      
      <div class="trial-info">
        ✅ <strong>Subscription Active</strong>
        <br><small>You have full access to all ConnectFlows features.</small>
      </div>
      
      <div class="card">
        <h3>🔗 Connect Your CRM Accounts</h3>
        <p>Connect both Salesforce and HubSpot to start syncing contacts automatically.</p>
        
        <a href="/auth/salesforce" class="btn">
          ⚡ Connect Salesforce
        </a>
        
        <a href="/auth/hubspot" class="btn">
          🧡 Connect HubSpot
        </a>
      </div>
      
      <div class="card">
        <h3>💰 Manage Your Subscription</h3>
        <p>Update your billing information or change your plan.</p>
        <a href="/pricing" class="btn">Manage Subscription</a>
        <a href="/logout" style="color: #64748b; text-decoration: none; margin-left: 20px;">Sign Out</a>
      </div> 
      <script>
        try {
          // Check URL parameters for connection status
          const urlParams = new URLSearchParams(window.location.search);
          const salesforceConnected = urlParams.get('salesforce') === 'connected';
          const message = urlParams.get('message');

          // Show success message
          if (message) {
            const alertDiv = document.createElement('div');
            alertDiv.style.cssText = 'background: #d1fae5; border: 1px solid #10b981; color: #065f46; padding: 15px; border-radius: 8px; margin-bottom: 20px; text-align: center;';
            alertDiv.innerHTML = '✅ ' + decodeURIComponent(message);
            document.body.insertBefore(alertDiv, document.body.firstChild);
          }

          // Update Salesforce button if connected
          if (salesforceConnected) {
            const sfButton = document.querySelector('a[href*="salesforce"]');
            if (sfButton) {
              sfButton.textContent = '✅ Salesforce Connected - Click to Sync';
              sfButton.style.background = '#10b981';
              sfButton.style.color = 'white';
              
              // Add working sync function
              sfButton.onclick = function(e) { 
                e.preventDefault();
                
                console.log('Starting sync...');
                sfButton.textContent = '🔄 Syncing...';
                sfButton.disabled = true;
                
                fetch('/api/sync/contacts', { 
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' }
                })
                .then(response => {
                  console.log('Response received:', response.status);
                  return response.json();
                })
                .then(data => {
                  console.log('Sync data:', data);
                  
                  if (data.success) {
                    sfButton.textContent = '✅ Sync Complete!';
                    
                    // Show results
                    const resultDiv = document.createElement('div');
                    resultDiv.style.cssText = 'background: #d1fae5; padding: 20px; border-radius: 8px; margin-top: 20px; color: #065f46; border: 1px solid #10b981;';
                    
                    let resultHTML = '<h4>✅ Real Sync Results!</h4>';
                    if (data.user_status === 'paid') {
                      resultHTML += '<p>💰 <strong>Paid Plan Results:</strong></p>';
                      resultHTML += '<p>📊 Salesforce Contacts: ' + (data.real_results?.salesforce?.contacts_found || 0) + '</p>';
                      resultHTML += '<p>🔄 HubSpot Sync: ' + (data.real_results?.hubspot?.total_synced || 0) + ' contacts</p>';
                      resultHTML += '<p>💸 Monthly Savings: ' + (data.real_results?.business_impact?.monthly_cost_savings || '$397') + '</p>';
                    } else {
                      resultHTML += '<p>🎭 <strong>Demo Mode Results:</strong></p>';
                      resultHTML += '<p>📊 Demo Contacts: ' + (data.demo_results?.salesforce?.contacts_found || 0) + '</p>';
                      resultHTML += '<p>⚠️ Limited to 5 contacts - upgrade for full sync</p>';
                    }
                    
                    resultDiv.innerHTML = resultHTML;
                    sfButton.parentNode.appendChild(resultDiv);
                  } else {
                    sfButton.textContent = '❌ Sync Failed';
                    alert('Sync failed: ' + (data.error || 'Unknown error'));
                  }
                })
                .catch(error => {
                  console.error('Sync error:', error);
                  sfButton.textContent = '❌ Network Error';
                  alert('Network error: ' + error.message);
                })
                .finally(() => {
                  setTimeout(() => {
                    sfButton.disabled = false;
                    sfButton.textContent = '✅ Salesforce Connected - Click to Sync';
                  }, 5000);
                });
              };
            }
          }
        } catch (error) {
          console.error('Dashboard script error:', error);
        }
      </script>
      
      
    </body>
    </html> 
  `);
});

console.log('➡️ Defining /demo route.');
// Demo page
// Demo page  
app.get('/demo', (req, res) => {
  res.sendFile(path.join(__dirname, 'demo.html'));
});

console.log('➡️ Defining /logout route.');
// Logout route
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/?message=You have been signed out');
});

console.log('➡️ Defining /upgrade route.');
// Upgrade page
app.get('/upgrade', (req, res) => {
  const message = req.query.message || 'Your trial has expired.';
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Upgrade - ConnectFlows</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
        .upgrade-box { background: #fef2f2; padding: 30px; border-radius: 10px; border: 2px solid #fecaca; }
        .btn { padding: 15px 30px; background: #3b82f6; color: white; text-decoration: none; border-radius: 8px; display: inline-block; margin: 10px; }
      </style>
    </head>
    <body>
      <div class="upgrade-box">
        <h2>⏰ ${message}</h2>
        <p>Continue syncing your Salesforce and HubSpot data with a paid plan.</p>
        <a href="/pricing" class="btn">View Pricing Plans</a>
        <a href="/signup" class="btn" style="background: #64748b;">Start New Trial</a>
      </div>
    </body>
    </html>
  `);
});
// Auth routes
// Salesforce OAuth initiation
console.log('➡️ Defining /auth/salesforce route.');
app.get('/auth/salesforce', (req, res) => {
  const { customer_id } = req.query;
  
  // Build proper authorization URL
  const authUrl = `${process.env.SF_LOGIN_URL}/services/oauth2/authorize?` +
    `response_type=code&` +
    `client_id=${process.env.SF_CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(process.env.SF_REDIRECT_URI)}&` +
    `state=${customer_id || 'test'}&` +
    `scope=api refresh_token`;
  
  console.log('🔗 Redirecting to Salesforce:', authUrl);
  res.redirect(authUrl);
});

console.log('➡️ Defining /auth/salesforce/callback route.');
// Salesforce OAuth callback - COMPLETE WORKING VERSION
app.get('/auth/salesforce/callback', async (req, res) => {
  const { code, error, state, error_description } = req.query;
  const customer_id = state;
  
  console.log('📥 Salesforce callback received:', { 
    hasCode: !!code, 
    error, 
    error_description,
    customer_id 
  });
  
  if (error) {
    return res.json({ 
      success: false,
      error: error,
      description: error_description,
      message: "Salesforce authorization failed",
      customer_id: customer_id
    });
  }
  
  if (!code) {
    return res.json({ 
      success: false,
      error: "missing_code",
      message: "No authorization code received from Salesforce",
      customer_id: customer_id
    });
  }
  
  try {
    console.log('🔄 Exchanging code for access token...');
    
    const tokenRequestData = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.SF_CLIENT_ID,
      client_secret: process.env.SF_CLIENT_SECRET,
      redirect_uri: process.env.SF_REDIRECT_URI,
      code: code
    });
    
    const tokenResponse = await fetch(`${process.env.SF_LOGIN_URL}/services/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: tokenRequestData
    });
    
    const tokenData = await tokenResponse.json();
    
    console.log('📥 Token response:', {
      success: tokenResponse.ok,
      status: tokenResponse.status,
      hasAccessToken: !!tokenData.access_token,
      error: tokenData.error
    });
    
    if (!tokenResponse.ok) {
      throw new Error(`Token exchange failed: ${tokenData.error_description || tokenData.error}`);
    }
    
    const { access_token, refresh_token, instance_url, id } = tokenData; req.session.salesforceToken = access_token;
    req.session.salesforceRefreshToken = refresh_token;
    req.session.salesforceInstanceUrl = instance_url;
    console.log('✅ Salesforce OAuth successful, tokens stored');
    
    // Test the access token
    console.log('👤 Testing access token...');
    const userInfoResponse = await fetch(`${instance_url}/services/oauth2/userinfo`, {
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Accept': 'application/json'
      }
    });
    
    if (!userInfoResponse.ok) {
      throw new Error('Failed to fetch user info with access token');
    }
    
    const userInfo = await userInfoResponse.json();
    
    console.log('✅ Salesforce OAuth successful for:', userInfo.email);
    
    // Success response
    res.redirect('/dashboard?salesforce=connected&message=' + encodeURIComponent('Salesforce connected successfully!'));
    
  } catch (error) {
    console.error('❌ Salesforce OAuth error:', error.message);
    
    res.status(500).json({
      success: false,
      error: error.message,
      message: "Failed to complete Salesforce authorization",
      customer_id: customer_id
    });
  }
});
console.log('➡️ Defining first /auth/hubspot route (old).');
app.get('/auth/hubspot', requireAuth, (req, res) => {
  const authUrl = `https://app.hubspot.com/oauth/authorize?` +
    `client_id=${process.env.HUBSPOT_CLIENT_ID}&` +
    `scope=crm.objects.contacts.read crm.objects.contacts.write crm.schemas.contacts.read crm.schemas.contacts.write oauth&` +
    `redirect_uri=${encodeURIComponent(process.env.HUBSPOT_REDIRECT_URI || 'https://rapid-mailbox-production.up.railway.app/auth/hubspot/callback')}`;
  
  console.log('🔄 Redirecting to HubSpot OAuth');
  res.redirect(authUrl);
});

console.log('➡️ Defining first /auth/hubspot/callback route (old).');
// HubSpot OAuth callback
app.get('/auth/hubspot/callback', requireAuth, async (req, res) => {
  const { code, error } = req.query;
  
  if (error) {
    console.error('❌ HubSpot OAuth error:', error);
    return res.redirect('/dashboard?error=HubSpot authorization failed');
  }
  
  if (!code) {
    return res.redirect('/dashboard?error=No authorization code received');
  }
  
  try {
    const tokenResponse = await fetch('https://api.hubapi.com/oauth/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.HUBSPOT_CLIENT_ID,
        client_secret: process.env.HUBSPOT_CLIENT_SECRET,
        redirect_uri: process.env.HUBSPOT_REDIRECT_URI || 'https://rapid-mailbox-production.up.railway.app/auth/hubspot/callback',
        code: code
      })
    });
    
    const tokenData = await tokenResponse.json();
    
    if (!tokenResponse.ok) {
      throw new Error(tokenData.message || 'Token exchange failed');
    }
    
    req.session.hubspotToken = tokenData.access_token;
    req.session.hubspotConnected = true;
    
    console.log('✅ HubSpot connected successfully');
    res.redirect('/dashboard?message=' + encodeURIComponent('HubSpot connected successfully!'));
    
  } catch (error) {
    console.error('❌ HubSpot callback error:', error);
    res.redirect('/dashboard?error=HubSpot connection failed');
  }
});
console.log('➡️ Defining second /auth/hubspot route (correct).');
app.get('/auth/hubspot',requireAuth,  (req, res) => {
  const { customer_id } = req.query;
  
  // Build proper authorization URL
  const authUrl = `https://app.hubspot.com/oauth/authorize?` +
    `client_id=${process.env.HUBSPOT_CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(process.env.HUBSPOT_REDIRECT_URI)}&` +
    `scope=crm.objects.contacts.read crm.objects.contacts.write crm.schemas.contacts.read crm.schemas.contacts.write oauth&` +
    `state=${customer_id || 'test'}&` +
    `response_type=code`;
  
  console.log('🔗 Redirecting to HubSpot:', authUrl);
  res.redirect(authUrl);
});

console.log('➡️ Defining second /auth/hubspot/callback route (correct).');
// HubSpot OAuth callback - COMPLETE WORKING VERSION
app.get('/auth/hubspot/callback', async (req, res) => {
  const { code, error, state, error_description } = req.query;
  const customer_id = state;
  
  console.log('📥 HubSpot callback received:', { 
    hasCode: !!code, 
    error, 
    error_description,
    customer_id 
  });
  
  if (error) {
    return res.json({ 
      success: false,
      error: error,
      description: error_description,
      message: "HubSpot authorization failed",
      customer_id: customer_id
    });
  }
  
  if (!code) {
    return res.json({ 
      success: false,
      error: "missing_code",
      message: "No authorization code received from HubSpot",
      customer_id: customer_id
    });
  }
  
  try {
    console.log('🔄 Exchanging code for access token...');
    
    const tokenRequestData = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.HUBSPOT_CLIENT_ID,
      client_secret: process.env.HUBSPOT_CLIENT_SECRET,
      redirect_uri: process.env.HUBSPOT_REDIRECT_URI,
      code: code
    });
    
    const tokenResponse = await fetch('https://api.hubapi.com/oauth/v1/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: tokenRequestData  
    });

    const tokenData = await tokenResponse.json();

    console.log('📥 HubSpot token response:', {
      success: tokenResponse.ok,
      status: tokenResponse.status,
      hasAccessToken: !!tokenData.access_token,
      error: tokenData.error
    });
    
    if (!tokenResponse.ok) {
      throw new Error(`Token exchange failed: ${tokenData.error_description || tokenData.error}`);
    }
    
    const { access_token, refresh_token, hub_id } = tokenData; req.session.hubspotToken = access_token;
    req.session.hubspotRefreshToken = refresh_token;
    req.session.hubspotHubId = hub_id;
    console.log('✅ HubSpot OAuth successful, tokens stored');
  
    
    // Test the access token by getting account info
    console.log('👤 Testing HubSpot access token...');
    const accountResponse = await fetch('https://api.hubapi.com/account-info/v3/details', {
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Accept': 'application/json'
      }
    });
    
    if (!accountResponse.ok) {
      throw new Error('Failed to fetch account info with access token');
    }
    
    const accountInfo = await accountResponse.json();
    
    console.log('✅ HubSpot OAuth successful for hub:', hub_id);
    
    // Success response
    res.redirect('/dashboard?hubspot=connected&message=' + encodeURIComponent('HubSpot connected successfully!'));
    
  } catch (error) {
    console.error('❌ HubSpot OAuth error:', error.message);
    
    res.status(500).json({
      success: false,
      error: error.message,
      message: "Failed to complete HubSpot authorization",
      customer_id: customer_id
    });
  }
});
// API routes
console.log('➡️ Defining /api/sync route.');
app.get('/api/sync', (req, res) => {
  res.json({ 
    message: 'Sync endpoint ready!',
    available_operations: [
      'start_sync',
      'stop_sync', 
      'sync_status',
      'sync_history'
    ]
  });
});

console.log('➡️ Defining /api/status route.');
app.get('/api/status', (req, res) => {
  res.json({ 
    message: 'Integration status',
    integrations: {
      salesforce: {
        configured: !!process.env.SF_CLIENT_ID,
        connected: false
      },
      hubspot: {
        configured: !!process.env.HUBSPOT_CLIENT_ID,
        connected: false
      }
    }
  });
});

// 💰 MONEY-MAKING SYNC ENDPOINTS 💰
console.log('➡️ Defining GET /api/sync/contacts route.');
app.get('/api/sync/contacts', (req, res) => {
  res.json({
    message: "💰 Contact Sync API Ready! 🚀",
    method: "Use POST to start sync",
    test_url: "POST /api/sync/contacts",
    status: "endpoint_available",
    demo_value: "This endpoint saves customers $50K+ annually",
    pricing: "$397/month subscription value"
  });
});

console.log('➡️ Defining POST /api/sync/contacts route.');
// REAL ENTERPRISE SYNC ENDPOINT FOR PAYING/TRIALING CUSTOMERS
app.post('/api/sync/contacts', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    console.log(`🚀 Sync request from user: ${user.email}`);

    // Accept 'trialing', 'active', or 'paid' as valid subscription statuses
    const isPaidUser = ['paid', 'active', 'trialing'].includes(user.subscription_status);
    const isTrialExpired = false; // Lemon Squeezy handles trial expiration
    
    console.log(`💰 User status: ${isPaidUser ? 'PAID/TRIALING' : 'TRIAL'}, Subscription status: ${user.subscription_status}`);

    // Validate customer has required connections
    if (!req.session.salesforceToken) {
      return res.status(400).json({
        success: false,
        error: 'Salesforce connection required',
        message: 'Please connect your Salesforce account first'
      });
    }

    // Use REAL sync for paid/trialing users, DEMO sync for others
    if (isPaidUser && !isTrialExpired) {
      // 💰 PAID/TRIALING USER - Use REAL enterprise sync engine
      console.log(`🚀 REAL: Enterprise sync for PAID/TRIALING customer: ${user.email}`);
      
      const syncEngine = new RealSyncEngine(
        user.id,
        req.session.salesforceToken,
        req.session.salesforceInstanceUrl,
        req.session.hubspotToken || null
      );
      
      const syncResults = await syncEngine.performEnterpriseBidirectionalSync();
      
      // Calculate real business value for paying customer
      const totalContacts = syncResults.salesforce_contacts_found;
      const timesSavedHours = Math.floor(totalContacts * 0.05);
      const monthlySavings = Math.max(197, totalContacts * 3);
      const annualSavings = monthlySavings * 12;

      return res.json({
        success: true,
        message: syncResults.message,
        sync_type: 'enterprise_bidirectional',
        user_status: user.subscription_status,
        real_results: {
          salesforce: {
            status: 'connected',
            contacts_found: syncResults.salesforce_contacts_found,
            sample_contacts: syncResults.real_sample_contacts
          },
          hubspot: {
            connected: !!req.session.hubspotToken,
            sync_status: syncResults.hubspot_sync_attempted ? 'completed' : 'ready_to_connect',
            contacts_created: syncResults.hubspot_created,
            contacts_updated: syncResults.hubspot_updated,
            total_synced: syncResults.hubspot_created + syncResults.hubspot_updated
          },
          business_impact: {
            total_records_processed: totalContacts,
            time_saved_hours: timesSavedHours,
            monthly_cost_savings: `$${monthlySavings}`,
            annual_savings: `$${annualSavings}`,
            roi_vs_connectflows_cost: `${Math.round((monthlySavings / 197) * 100)}%`,
            sync_efficiency: syncResults.hubspot_sync_attempted ? 'Real-time bidirectional' : 'Salesforce analysis complete'
          },
          enterprise_features: {
            data_source: 'Real customer CRM data',
            sync_method: 'API-based bidirectional',
            security: 'Enterprise OAuth',
            support: '24/7 monitoring'
          }
        },
        timestamp: new Date().toISOString()
      });
      
    } else {
      // 🎭 TRIAL USER - Use DEMO sync engine (limited functionality)
      console.log(`🎭 DEMO: Trial sync for user: ${user.email}`);
      
      // Demo sync with limited data and functionality
      const demoResults = await performDemoSync(user.id, req.session.salesforceToken);
      
      return res.json({
        success: true,
        message: 'Demo sync completed successfully! Upgrade to paid plan for full bidirectional sync.',
        sync_type: 'demo_limited',
        user_status: 'trial',
        demo_results: {
          salesforce: {
            status: 'connected',
            contacts_found: demoResults.contacts_found,
            sample_contacts: demoResults.sample_contacts,
            note: 'Demo mode - limited to 5 contacts'
          },
          hubspot: {
            connected: !!req.session.hubspotToken,
            sync_status: 'demo_mode',
            note: 'Upgrade to paid plan for HubSpot sync'
          },
          upgrade_prompt: {
            message: 'Unlock full bidirectional sync with paid plan',
            benefits: [
              'Unlimited contacts',
              'Real-time bidirectional sync',
              'HubSpot integration',
              'Advanced conflict resolution'
            ],
            pricing: '$197/month',
            upgrade_url: '/pricing'
          }
        },
        timestamp: new Date().toISOString()
      });
    }

  } catch (error) {
    console.error('❌ Sync failed:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Sync failed - please try again'
    });
  }
});

// Demo sync function for trial users
async function performDemoSync(userId, salesforceToken) {
  try {
    console.log('🎭 DEMO: Starting demo sync for trial user');
    
    // Get limited Salesforce contacts for demo
    const salesforceContacts = await fetchSalesforceContacts(salesforceToken);
    const demoContacts = salesforceContacts.slice(0, 5); // Limit to 5 contacts
    
    // Create demo sample contacts
    const sampleContacts = demoContacts.map(contact => ({
      name: contact.name || 'Demo Contact',
      email: contact.email || 'demo@example.com',
      company: contact.company || 'Demo Company',
      phone: contact.phone || '',
      status: 'demo_mode'
    }));
    
    console.log(`🎭 DEMO: Processed ${demoContacts.length} contacts for trial user`);
    
    return {
      contacts_found: salesforceContacts.length,
      sample_contacts: sampleContacts,
      message: 'Demo sync completed - upgrade for full functionality'
    };
    
  } catch (error) {
    console.error('❌ Demo sync failed:', error);
    throw error;
  }
}

// Update user subscription status after payment
async function updateUserSubscriptionStatus(userId, subscriptionStatus, planType = null) {
  try {
    const updateQuery = planType 
      ? 'UPDATE users SET subscription_status = $1, plan_type = $2, updated_at = NOW() WHERE id = $3'
      : 'UPDATE users SET subscription_status = $1, updated_at = NOW() WHERE id = $3';
    
    const params = planType 
      ? [subscriptionStatus, planType, userId]
      : [subscriptionStatus, userId];
    
    await pool.query(updateQuery, params);
    console.log(`✅ Updated user ${userId} subscription to: ${subscriptionStatus}`);
  } catch (error) {
    console.error('❌ Failed to update user subscription:', error);
    throw error;
  }
}

console.log('➡️ Defining /webhooks/lemonsqueezy route.');
// Lemon Squeezy webhook handler for payment confirmations
app.post('/webhooks/lemonsqueezy', async (req, res) => {
  try {
    console.log('📥 Webhook received:', JSON.stringify(req.body, null, 2));

    const { data, meta, event_name } = req.body;

    if (!data || !event_name) {
      console.log('⚠️ Invalid webhook payload');
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    console.log(`🔄 Processing webhook: ${event_name}`);

    // Handle different webhook events
    switch (event_name) {
      case 'order_created':
        await handleOrderCreated(data);
        break;
      case 'subscription_created':
        await handleSubscriptionCreated(data);
        break;
      case 'subscription_updated':
        await handleSubscriptionUpdated(data);
        break;
      case 'subscription_cancelled':
        await handleSubscriptionCancelled(data);
        break;
      default:
        console.log(`ℹ️ Unhandled webhook event: ${event_name}`);
    }

    res.status(200).json({ received: true, event: event_name });

  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Handle order created webhook
async function handleOrderCreated(data) {
  try {
    const order = data.attributes;
    const customerEmail = order.customer_email;
    const variantId = order.variant_id;
    const customData = order.custom || {};
    const status = order.status || 'trialing';

    console.log(`💰 Order created: ${customerEmail} for variant ${variantId}`);
    console.log('📋 Custom data:', customData);

    // Check if this is a new signup with payment
    if (customData.signup_email && customData.signup_password) {
      console.log('🆕 Creating new user account from payment');
      
      // Create the user account in database
      const passwordHash = await bcrypt.hash(customData.signup_password, 10);
      
      const newUser = await createUser(customData.signup_email, passwordHash);
      
      // Update user to paid/trialing status
      await updateUserSubscriptionStatus(newUser.id, status, customData.plan || 'starter');
      
      console.log(`✅ New paid/trialing user created: ${customData.signup_email}`);
      
    } else {
      // Existing user payment
      const user = await getUserByEmail(customerEmail);
      if (user) {
        // Update subscription status to paid/trialing
        await updateUserSubscriptionStatus(user.id, status, customData.plan || 'starter');
        console.log(`✅ User ${customerEmail} upgraded to paid/trialing plan`);
      } else {
        console.log(`⚠️ Payment received but user not found: ${customerEmail}`);
      }
    }
  } catch (error) {
    console.error('❌ Error handling order created:', error);
    throw error;
  }
}

// Handle subscription created webhook
async function handleSubscriptionCreated(data) {
  try {
    const subscription = data.attributes;
    const customerEmail = subscription.customer_email;
    const status = subscription.status || 'active';
    const customData = subscription.custom || {};

    console.log(`🆕 Subscription created: ${customerEmail} with status ${status}`);

    const user = await getUserByEmail(customerEmail);
    if (user) {
      await updateUserSubscriptionStatus(user.id, status, customData.plan || 'starter');
      console.log(`✅ User ${customerEmail} subscription activated`);
    }
  } catch (error) {
    console.error('❌ Error handling subscription created:', error);
    throw error;
  }
}

// Handle subscription updated webhook
async function handleSubscriptionUpdated(data) {
  try {
    const subscription = data.attributes;
    const customerEmail = subscription.customer_email;
    const status = subscription.status;
    const customData = subscription.custom || {};

    console.log(`🔄 Subscription updated: ${customerEmail} to status ${status}`);

    const user = await getUserByEmail(customerEmail);
    if (user) {
      await updateUserSubscriptionStatus(user.id, status, customData.plan || 'starter');
      console.log(`✅ User ${customerEmail} subscription updated to ${status}`);
    }
  } catch (error) {
    console.error('❌ Error handling subscription updated:', error);
    throw error;
  }
}

// Handle subscription cancelled webhook
async function handleSubscriptionCancelled(data) {
  try {
    const subscription = data.attributes;
    const customerEmail = subscription.customer_email;

    console.log(`❌ Subscription cancelled: ${customerEmail}`);

    const user = await getUserByEmail(customerEmail);
    if (user) {
      await updateUserSubscriptionStatus(user.id, 'cancelled');
      console.log(`✅ User ${customerEmail} subscription cancelled`);
    }
  } catch (error) {
    console.error('❌ Error handling subscription cancelled:', error);
    throw error;
  }
}

console.log('➡️ Defining /success route.');
// Success page after payment
app.get('/success', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Payment Successful - ConnectFlows</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          max-width: 600px; 
          margin: 50px auto; 
          padding: 20px;
          background: #f8fafc;
          text-align: center;
        }
        .success-card {
          background: white;
          padding: 40px;
          border-radius: 15px;
          box-shadow: 0 4px 6px rgba(0,0,0,0.1);
          border: 2px solid #10b981;
        }
        .success-icon {
          font-size: 4rem;
          margin-bottom: 20px;
        }
        .btn { 
          padding: 15px 30px; 
          background: #10b981; 
          color: white; 
          text-decoration: none; 
          border-radius: 8px; 
          display: inline-block; 
          margin: 20px 10px;
          font-weight: 500;
          font-size: 1.1rem;
        }
        .btn:hover { background: #059669; }
        h1 { color: #1e293b; margin-bottom: 10px; }
        p { color: #64748b; margin-bottom: 20px; }
      </style>
    </head>
    <body>
      <div class="success-card">
        <div class="success-icon">🎉</div>
        <h1>Payment Successful!</h1>
        <p>Welcome to ConnectFlows! Your subscription is now active.</p>
        <p>You can now access all premium features including unlimited Salesforce ↔ HubSpot sync.</p>
        
        <a href="/dashboard" class="btn">🚀 Go to Dashboard</a>
        <a href="/pricing" class="btn" style="background: #6b7280;">💰 Manage Subscription</a>
      </div>
    </body>
    </html>
  `);
});

console.log('➡️ Defining error handling middleware.');
// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err.stack);
  res.status(500).json({ 
    error: 'Something went wrong!',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
  });
});

console.log('➡️ Defining 404 handler.');
// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Route not found',
    path: req.originalUrl,
    available_endpoints: [
      '/health',
      '/api/sync/contacts',
      '/api/sync/trigger',
      '/api/status'
    ]
  });
});

// Start server
console.log('🚀 ConnectFlows Express App - Server Start Call');
app.listen(PORT, () => {
  console.log('🚀 SF-HubSpot Sync Server Starting...');
  console.log(`📱 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 Server URL: http://localhost:${PORT}`);
  console.log(`📊 Health Check: http://localhost:${PORT}/health`);
  console.log(`💰 Sync API: http://localhost:${PORT}/api/sync/contacts`);
  console.log(`🎯 Trigger: http://localhost:${PORT}/api/sync/trigger`);
  console.log('✅ Server ready for connections!');
  console.log('💸 Ready to make money from customer subscriptions!');
  
  if (!process.env.SF_CLIENT_ID) {
    console.log('⚠️  Warning: SF_CLIENT_ID not set');
  }
  if (!process.env.HUBSPOT_CLIENT_ID) {
    console.log('⚠️  Warning: HUBSPOT_CLIENT_ID not set');
  }
});

module.exports = app;